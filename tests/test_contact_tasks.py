import hashlib,time,uuid
from concurrent.futures import ThreadPoolExecutor
from django.contrib.auth.models import User
from django.db import transaction,connection,close_old_connections
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import *
from server.erp import contact_tasks as api
from server.erp.services import Conflict
from tests.test_erp import AccountingFixture

class ContactTasksTests(TransactionTestCase):
    def setUp(self):
        AccountingFixture.setUp(self)
        self.customer=Counterparty.objects.create(kind='customer',name='Synthetic contact')
        self.other=Store.objects.create(name='Other')
        self.session=PortalSession.objects.create(token_hash=hashlib.sha256(b'contact-task-session').hexdigest(),user=self.u,csrf='task-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='contact-task-session'
    def request(self,**changes):
        return {'id':str(uuid.uuid4()),'request_key':str(uuid.uuid4()),'customer':self.customer.pk,'store':self.store.pk,'terms':{'title':'Call back','note':'Synthetic note','due_on':None,'assignee':None,'status':'todo','archived':False},**changes}
    def role(self,role,store=None):Profile.objects.filter(user=self.u).update(role=role,store=store);self.u.refresh_from_db()
    def write(self,body,id=None):return self.client.patch('/api/v1/crm/contact-tasks/'+id,body,content_type='application/json',HTTP_X_CSRF_TOKEN='task-csrf',HTTP_ORIGIN='http://testserver') if id else self.client.post('/api/v1/crm/contact-tasks',body,content_type='application/json',HTTP_X_CSRF_TOKEN='task-csrf',HTTP_ORIGIN='http://testserver')
    def test_exact_create_update_archive_identity_and_audit(self):
        body=self.request();ack=api.save(self.u,body);self.assertEqual(api.save(self.u,body),ack);self.assertEqual(ContactTask.objects.count(),1)
        row=api.current(self.u,body['id'])['record'];updated={'request_key':str(uuid.uuid4()),'revision':1,'terms':{**row['terms'],'title':'New caption','archived':True,'status':'done'}}
        api.save(self.u,updated,body['id']);self.assertEqual(api.identity(self.u,{'action':'create','id':body['id'],'request':body})['original']['revision'],1)
        self.assertEqual(api.save(self.u,updated,body['id'])['original']['revision'],2)
        self.assertEqual(AuditEvent.objects.filter(action__startswith='contact_task_').count(),2)
        self.assertEqual(api.history(self.u,body['id'],{})['total'],2)
        with self.assertRaises(Conflict):api.save(self.u,{**body,'terms':{**body['terms'],'note':'Changed body'}})
        self.assertEqual(api.list_tasks(self.u,{})['total'],0)
        self.assertEqual(api.list_tasks(self.u,{'archived':'yes'})['total'],1)
    def test_roles_scope_rr_no_dml_and_no_cashier_token(self):
        body=self.request();api.save(self.u,body)
        for role in ('owner','manager','accountant'):
            self.role(role,self.store)
            with CaptureQueriesContext(connection) as queries:result=self.client.get('/api/v1/crm/contact-tasks',{'store':self.store.pk})
            self.assertEqual(result.status_code,200,result.content);self.assertEqual(result.json()['total'],1)
            self.assertNotRegex(' '.join(q['sql'] for q in queries).lower(),r'\b(insert|update|delete)\b')
            self.assertEqual(self.client.get('/api/v1/crm/contact-tasks',{'store':self.other.pk}).status_code,403)
        self.role('cashier',self.store)
        self.assertEqual(self.client.get('/api/v1/crm/contact-tasks').status_code,403)
        self.assertEqual(self.client.get('/api/v1/trading/versions',{'resources':'customers_tasks'}).status_code,403)
        self.assertEqual(self.client.get('/api/v1/crm/customers').status_code,200)
        self.assertEqual(self.client.get(f'/api/v1/crm/customers/{self.customer.pk}').json()['debt'],None)
        self.assertEqual(self.write(body).status_code,403)
        self.assertNotIn('write_rejected',self.write(body).json())
    def test_paging_full_summary_scalar_rejection_and_current_actor(self):
        ContactTask.objects.bulk_create([ContactTask(id=uuid.uuid4(),customer=self.customer,store=self.store,title=f'Task{i}',created_by=self.u,status='todo') for i in range(65)])
        value=api.list_tasks(self.u,{'page':'99'});self.assertEqual((len(value['items']),value['total'],value['page'],value['summary']['todo']),(5,65,3,65))
        for bad in ([],{},True,0,'²'):
            body=self.request(store=bad);r=self.write(body);self.assertEqual(r.status_code,400,r.content)
        for terms in ({'status':[]},{'due_on':'2026-02-30'},{'title':' '},{'assignee':False}):
            body=self.request();body['terms'].update(terms);self.assertEqual(self.write(body).status_code,400)
        self.assertEqual(ContactTaskOperation.objects.count(),0)
        self.assertEqual(self.client.get('/api/v1/crm/contact-tasks?store=1&store=2').status_code,400)
        User.objects.filter(pk=self.u.pk).update(is_active=False)
        with self.assertRaises(api.TaskDenied):api.save(self.u,self.request())
    def test_direct_bulk_rollback_caption_audience_and_revision_conflict(self):
        self.role('manager',self.store)
        def token(store=None):
            r=self.client.get('/api/v1/trading/versions',{'resources':'customers_tasks',**({'store':store.pk} if store else {})});self.assertEqual(r.status_code,200);return r['ETag']
        old=token();foreign=ContactTask.objects.create(customer=self.customer,store=self.other,title='Foreign',created_by=self.u)
        self.assertEqual(self.client.get('/api/v1/trading/versions',{'resources':'customers_tasks'},HTTP_IF_NONE_MATCH=old).status_code,304)
        body=self.request();api.save(self.u,body);old=token()
        with transaction.atomic():ContactTask.objects.filter(pk=body['id']).update(note='rolled back');transaction.set_rollback(True)
        self.assertEqual(self.client.get('/api/v1/trading/versions',{'resources':'customers_tasks'},HTTP_IF_NONE_MATCH=old).status_code,304)
        Counterparty.objects.filter(pk=self.customer.pk).update(name='Shared new name')
        self.assertEqual(self.client.get('/api/v1/trading/versions',{'resources':'customers_tasks'},HTTP_IF_NONE_MATCH=old).status_code,200)
        update={'request_key':str(uuid.uuid4()),'revision':1,'terms':{**body['terms'],'status':'doing'}};api.save(self.u,update,body['id'])
        with self.assertRaises(Conflict):api.save(self.u,{**update,'request_key':str(uuid.uuid4())},body['id'])
        self.assertFalse(TradingVersion.objects.filter(key__startswith='customers_tasks:cashier').exists())
    def test_parallel_same_revision_one_winner(self):
        if connection.vendor!='postgresql':self.skipTest('PG lock proof')
        body=self.request();api.save(self.u,body)
        def attempt(n):
            close_old_connections()
            try:return api.save(User.objects.get(pk=self.u.pk),{'request_key':str(uuid.uuid4()),'revision':1,'terms':{**body['terms'],'note':str(n)}},body['id'])['original']['revision']
            except Conflict:return 'conflict'
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(attempt,[1,2]))
        self.assertEqual(sorted(map(str,results)),['2','conflict']);self.assertEqual(ContactTaskOperation.objects.count(),2)

    def test_receipt_scope_snapshot_fresh_actor_and_assignee_caption(self):
        body=self.request();body['terms']['assignee']=self.u.pk;api.save(self.u,body)
        self.role('manager',self.store)
        token=self.client.get('/api/v1/trading/versions',{'resources':'customers_tasks'})['ETag']
        User.objects.filter(pk=self.u.pk).update(username='Renamed assignee')
        self.assertEqual(self.client.get('/api/v1/trading/versions',{'resources':'customers_tasks'},HTTP_IF_NONE_MATCH=token).status_code,200)
        op=ContactTaskOperation.objects.get(key=body['request_key'])
        self.assertEqual((op.store_id_snapshot,op.customer_id_snapshot),(self.store.pk,self.customer.pk))
        ContactTask.objects.filter(pk=body['id']).update(store=self.other)
        with self.assertRaises(api.TaskDenied):api.identity(self.u,{'action':'create','id':body['id'],'request':body})
        with self.assertRaises(api.TaskDenied):api.save(self.u,body)
        self.assertEqual(ContactTaskOperation.objects.count(),1)
        User.objects.filter(pk=self.u.pk).update(is_active=False)
        with CaptureQueriesContext(connection) as queries:
            with self.assertRaises(api.TaskDenied):api.current(self.u,body['id'])
        self.assertFalse(any('FROM "erp_contacttask"' in q['sql'] for q in queries))
    def test_history_actor_caption_routes_and_migration_reverse_reinstall(self):
        from django.db.migrations.executor import MigrationExecutor
        body=self.request();api.save(self.u,body)
        key=f'customers_tasks:manager:store:{self.store.pk}'
        before=TradingVersion.objects.get(key=key).revision
        User.objects.filter(pk=self.u.pk).update(username='Historical actor caption')
        self.assertGreater(TradingVersion.objects.get(key=key).revision,before)
        old=TradingVersion.objects.get(key=key).revision
        ContactTaskOperation.objects.filter(key=body['request_key']).update(action='update')
        self.assertGreater(TradingVersion.objects.get(key=key).revision,old)
        executor=MigrationExecutor(connection);latest=executor.loader.graph.leaf_nodes('erp')
        try:
            executor.migrate([('erp','0029_customer_report_versions')])
            with connection.cursor() as c:
                if connection.vendor=='postgresql':c.execute("SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'tsukenya_contact_%'")
                else:c.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'tsukenya_contact_%'")
                self.assertEqual(c.fetchone()[0],0)
            executor=MigrationExecutor(connection);executor.migrate(latest)
            old=TradingVersion.objects.get(key=key).revision
            ContactTask.objects.create(customer=self.customer,store=self.store,title='Reinstalled',created_by=self.u)
            self.assertGreater(TradingVersion.objects.get(key=key).revision,old)
        finally:MigrationExecutor(connection).migrate(latest)

    def test_fresh_role_after_real_ledger_wait_blocks_new_receipt(self):
        if connection.vendor!='postgresql':self.skipTest('PG lock proof')
        from server.erp.services import ledger_lock
        import threading
        body=self.request();started=threading.Event();backend=[]
        def attempt():
            close_old_connections()
            try:
                with connection.cursor() as c:c.execute('SELECT pg_backend_pid()');backend.append(c.fetchone()[0])
                started.set()
                try:api.save(self.u,body);return 'unexpected'
                except api.TaskDenied:return 'denied'
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with transaction.atomic():
                ledger_lock();pending=pool.submit(attempt);self.assertTrue(started.wait(3))
                deadline=time.monotonic()+3;waiting=False
                while time.monotonic()<deadline:
                    with connection.cursor() as c:c.execute("SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s",[backend[0]]);row=c.fetchone()
                    if row and row[0]=='Lock':waiting=True;break
                    time.sleep(.02)
                self.assertTrue(waiting,'actual ledger waiter')
                Profile.objects.filter(user=self.u).update(role='cashier')
            self.assertEqual(pending.result(timeout=5),'denied')
        self.assertEqual(ContactTask.objects.count(),0);self.assertEqual(ContactTaskOperation.objects.count(),0)
        self.assertFalse(AuditEvent.objects.filter(action__startswith='contact_task_').exists())

    def test_reclassified_contact_preserves_existing_history_and_exact_receipt(self):
        body=self.request();ack=api.save(self.u,body)
        Counterparty.objects.filter(pk=self.customer.pk).update(kind='supplier',active=False)
        self.assertEqual(api.save(self.u,body),ack)
        self.assertEqual(api.identity(self.u,{'id':body['id'],'action':'create','request':body})['original'],ack['original'])
        self.assertEqual(api.history(self.u,body['id'],{})['total'],1)
        self.assertFalse(api.current(self.u,body['id'])['record']['customerActive'])
        self.assertEqual(api.list_tasks(self.u,{})['total'],1)
        self.assertTrue(api.context(self.u,{'id':body['id'],'customer':str(self.customer.pk),'store':str(self.store.pk)})['exists'])
        with self.assertRaises(api.BusinessError):api.save(self.u,self.request())
        with self.assertRaises(api.BusinessError):api.context(self.u,{'id':str(uuid.uuid4()),'customer':str(self.customer.pk),'store':str(self.store.pk)})
        self.assertEqual(ContactTaskOperation.objects.count(),1)

    def test_creator_receipt_never_replays_for_another_allowed_owner(self):
        body=self.request();api.save(self.u,body)
        other=User.objects.create(username='Other task owner')
        Profile.objects.create(user=other,role='owner',store=self.store)
        self.assertEqual(api.current(other,body['id'])['record']['id'],body['id'])
        with self.assertRaises(Conflict):api.save(other,body)
        with self.assertRaises(Conflict):api.identity(other,{'action':'create','id':body['id'],'request':body})
        self.assertEqual(ContactTaskOperation.objects.count(),1)
        self.assertEqual(AuditEvent.objects.filter(action='contact_task_create').count(),1)

    def test_bound_first_rejections_only_after_rollback_and_scalar_assignees(self):
        from unittest.mock import patch
        body=self.request();invalid={**body,'terms':{**body['terms'],'title':''}}
        rejection=self.write(invalid)
        self.assertEqual(rejection.status_code,400)
        self.assertEqual({k:rejection.json()[k] for k in ('id','request_key','action','code','write_rejected')},{'id':body['id'],'request_key':body['request_key'],'action':'create','code':'validation_error','write_rejected':True})
        self.assertEqual(ContactTaskOperation.objects.count(),0)
        malformed=self.write({**invalid,'request_key':[]});self.assertEqual(malformed.status_code,400);self.assertNotIn('write_rejected',malformed.json())
        self.write(body)
        newer={'request_key':str(uuid.uuid4()),'revision':1,'terms':{**body['terms'],'title':'External'}}
        api.save(self.u,newer,body['id'])
        stale={'request_key':str(uuid.uuid4()),'revision':1,'terms':{**body['terms'],'title':'Mine'}}
        rejection=self.write(stale,body['id']);self.assertEqual(rejection.status_code,409)
        self.assertEqual(rejection.json()['code'],'revision_conflict');self.assertTrue(rejection.json()['write_rejected']);self.assertEqual(rejection.json()['id'],body['id'])
        self.assertFalse(ContactTaskOperation.objects.filter(key=stale['request_key']).exists())
        collision=self.write({**body,'terms':{**body['terms'],'note':'Collision'}})
        self.assertEqual(collision.status_code,409);self.assertNotIn('write_rejected',collision.json())
        with CaptureQueriesContext(connection) as queries:api.assignees(self.u,{'store':str(self.store.pk)})
        selected=' '.join(q['sql'] for q in queries if 'LIMIT 30' in q['sql'])
        self.assertIn('AS "username"',selected)
        self.assertNotIn('"auth_user"."password"',selected);self.assertNotIn('"auth_user"."email"',selected)
        committed=self.request()
        with patch('server.erp.views.response',side_effect=RuntimeError('Serialization after commit')):
            with self.assertRaises(RuntimeError):api.execute_response(self.u,committed)
        self.assertTrue(ContactTaskOperation.objects.filter(key=committed['request_key']).exists())
