"""B25 technical journal and observed closure chronology; isolated fixtures, never repairs."""
import hashlib
import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import StringIO
from unittest import mock, skipUnless
from django.core.management import call_command, CommandError
from django.db import connection, transaction, close_old_connections, DatabaseError
from django.test import TransactionTestCase
from django.utils import timezone
from server.erp.models import *
from server.erp.reconcile import reconcile
from server.erp.reconcile_periods import check_periods
from server.erp import reconcile_journal as journal

class ReconcileJournalTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create(username='network');Profile.objects.create(user=self.user,role='owner')
        self.store=Store.objects.create(name='Синтетичний магазин');LedgerLock.objects.create(pk=1)
        self.now=timezone.now();self.today=timezone.localdate();self.old=self.today-timedelta(days=10)

    def event(self, at, boundary, detail=None):
        event=AuditEvent.objects.create(user=self.user, action='period_changed',subject='ledger',detail=detail if detail is not None else {'date':boundary.isoformat() if boundary else None,'reason':'Синтетична причина'})
        AuditEvent.objects.filter(pk=event.pk).update(at=at);return event

    def voucher(self, **values):
        return Voucher.objects.create(kind='customer_order',date=self.old,store=self.store,created_by=self.user,**values)

    def command(self,*args):
        output=StringIO();error=StringIO()
        try:call_command('reconcile','--json',*args,stdout=output,stderr=error);failed=False
        except CommandError:failed=True
        return failed,json.loads(output.getvalue()) if output.getvalue() else None

    def test_proven_protected_post_reverse_and_reopen_backdating(self):
        closed=self.now-timedelta(hours=3);reopened=self.now-timedelta(hours=1)
        self.event(closed,self.today-timedelta(days=1));self.event(reopened,None)
        forbidden=self.voucher(status='reversed',posted_at=closed+timedelta(minutes=1),reversed_at=closed+timedelta(minutes=2))
        valid=self.voucher(status='posted',posted_at=reopened+timedelta(minutes=1))
        found,c=check_periods();self.assertEqual([x['subject'] for x in found],[f'voucher/{forbidden.pk}']*2)
        self.assertEqual((c['known_operations'],c['unknown_operations']),(3,0))
        self.assertNotIn(f'voucher/{valid.pk}',[x['subject'] for x in found])

    def test_unknown_history_equal_missing_malformed_and_protected_draft(self):
        boundary=self.now-timedelta(hours=1);self.event(boundary,self.today-timedelta(days=1))
        self.voucher(status='posted',posted_at=boundary)
        self.voucher(status='posted',posted_at=boundary-timedelta(seconds=1))
        self.voucher(status='reversed')
        self.event(boundary+timedelta(minutes=1),None,{'date':'broken','reason':'synthetic'})
        self.voucher(status='posted',posted_at=boundary+timedelta(minutes=2))
        self.voucher(status='draft');LedgerLock.objects.filter(pk=1).update(closed_through=self.today-timedelta(days=1))
        found,c=check_periods();self.assertEqual(found,[])
        self.assertEqual((c['unknown_operations'],c['invalid_period_events'],c['protected_drafts']),(5,1,1))

    def test_period_audit_boundary_and_reason_are_observed_invariants(self):
        event=self.event(self.now-timedelta(hours=1),self.today-timedelta(days=1),{'date':str(self.today-timedelta(days=1))})
        found,_=check_periods()
        self.assertEqual({x['subject'] for x in found},{'ledger/1',f'audit/{event.pk}'})
        LedgerLock.objects.filter(pk=1).update(closed_through=self.today-timedelta(days=1))
        AuditEvent.objects.filter(pk=event.pk).update(detail={'date':str(self.today-timedelta(days=1)),'reason':'fixed'})
        self.assertEqual(check_periods()[0],[])

    def test_status_chronology_tampering_and_names_are_not_corruption(self):
        self.voucher(status='draft',posted_at=self.now)
        self.voucher(status='posted',posted_at=self.now,reversed_at=self.now)
        self.voucher(status='reversed',posted_at=self.now,reversed_at=self.now-timedelta(minutes=1))
        found,_=check_periods();self.assertEqual(len(found),3)
        Store.objects.filter(pk=self.store.pk).update(name='Перейменовано')
        self.assertEqual(check_periods()[0],found)

    def test_command_readonly_default_record_exact_retry_and_failed_result(self):
        before={m.__name__:m.objects.count() for m in [Voucher,AuditEvent,StockEntry,CashEntry,ReconciliationRun]}
        failed,plain=self.command();self.assertFalse(failed)
        self.assertEqual(before,{m.__name__:m.objects.count() for m in [Voucher,AuditEvent,StockEntry,CashEntry,ReconciliationRun]})
        key=str(uuid.uuid4());failed,recorded=self.command('--record','--run-id',key)
        self.assertFalse(failed);self.assertEqual(recorded,plain);self.assertEqual(ReconciliationRun.objects.count(),1)
        self.voucher(status='draft',posted_at=self.now)
        with mock.patch('server.erp.management.commands.reconcile.reconcile',side_effect=AssertionError('retry must not scan')):
            failed,retry=self.command('--record','--run-id',key)
        self.assertFalse(failed);self.assertEqual(retry,plain)
        self.assertTrue(self.command('--record','--run-id',key,'--source','scheduler')[0])
        failed_key=str(uuid.uuid4())
        with mock.patch('server.erp.management.commands.reconcile.reconcile',side_effect=RuntimeError('must not persist private detail')):
            self.assertTrue(self.command('--record','--run-id',failed_key)[0])
        run=ReconciliationRun.objects.get(pk=failed_key)
        self.assertEqual((run.status,run.error_code),('failed','snapshot_failed'))
        self.assertNotIn('private',json.dumps(run.summary))
        self.assertTrue(self.command('--record','--run-id',failed_key)[0])

    def test_text_report_discloses_unknown_history_coverage(self):
        self.voucher(status='posted')
        output=StringIO();call_command('reconcile',stdout=output)
        self.assertIn('невідомих 1',output.getvalue())
        self.assertIn('не доказ незаконного проведення',output.getvalue())

    def test_failed_local_snapshot_returns_successful_concurrent_receipt_winner(self):
        report=reconcile();winner=journal.record(uuid.uuid4(),'manual',report,self.now,self.now)
        # Another caller persisted clean result after our first receipt read but before our failed read completed.
        with mock.patch('server.erp.management.commands.reconcile.journal.previous',return_value=None), mock.patch('server.erp.management.commands.reconcile.reconcile',side_effect=RuntimeError('local failure')), mock.patch('server.erp.management.commands.reconcile.journal.record',return_value=winner):
            failed,result=self.command('--record','--run-id',str(winner.pk))
        self.assertFalse(failed);self.assertEqual(result,report)

    def test_findings_pagination_snapshot_unchanged_and_network_owner_guards(self):
        report={'issues':205,'counts':{},'coverage':{},'checks':{'test':{'title':'Synthetic','issues':[{'check':'test','subject':f'voucher/{n}','message':'Розбіжність','expected':'1.00','actual':'2.00'} for n in range(205)]}}}
        run=journal.record(uuid.uuid4(),'scheduler',report,self.now,self.now)
        self.assertEqual(journal.saved_report(run),report)
        self.assertEqual((journal.findings(self.user,run.pk,{'page':'9'})['page'],len(journal.findings(self.user,run.pk,{'page':'9'})['items'])),(3,5))
        for n in range(30):journal.record(uuid.uuid4(),'manual',{'issues':0,'counts':{},'checks':{}},self.now,self.now)
        self.assertEqual((journal.runs(self.user,{'page':'99'})['page'],len(journal.runs(self.user,{'page':'99'})['items'])),(2,1))
        for role,scope in [('owner',self.store),('manager',self.store),('accountant',None),('cashier',self.store),('warehouse',self.store)]:
            user=User.objects.create(username=f'{role}-{scope}');Profile.objects.create(user=user,role=role,store=scope)
            token=f'synthetic-{user.pk}';PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=user,csrf='test',expires=int(time.time())+3600);self.client.cookies['ts_session']=token
            for path in ['reconciliation-runs',f'reconciliation-runs/{run.pk}',f'reconciliation-runs/{run.pk}/issues']:
                self.assertEqual(self.client.get('/api/erp/'+path).status_code,403)
        token='synthetic-network-owner'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=self.user,csrf='test',expires=int(time.time())+3600);self.client.cookies['ts_session']=token
        before=ReconciliationRun.objects.count()
        self.assertEqual(self.client.get('/api/erp/reconciliation-runs').status_code,200)
        for method in ['post','put','delete']:
            self.assertEqual(getattr(self.client,method)('/api/erp/reconciliation-runs',data='{}',content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='test').status_code,403)
        self.assertEqual(ReconciliationRun.objects.count(),before)
        for values in [{'page':'0'},{'page':'²'},{'status':'bad'},{'source':'bad'},{'from':'2026-02-30'}]:
            with self.assertRaises(Exception):journal.runs(self.user,values)
        with transaction.atomic():
            with self.assertRaisesMessage(Exception,'після завершення'):journal.record(uuid.uuid4(),'manual',report,self.now,self.now)

    @skipUnless(connection.vendor=='postgresql','PostgreSQL RR and concurrency')
    def test_snapshot_and_technical_write_separate_and_readonly_enforced(self):
        original=reconcile;observed=[]
        def collector():
            with connection.cursor() as c:
                c.execute('SHOW transaction_isolation');observed.append(c.fetchone()[0]);c.execute('SHOW transaction_read_only');observed.append(c.fetchone()[0])
            count=Voucher.objects.count()
            def writer():
                close_old_connections()
                try:Voucher.objects.create(kind='customer_order',date=self.old,store_id=self.store.pk,created_by_id=self.user.pk)
                finally:connection.close()
            with ThreadPoolExecutor(max_workers=1) as p:p.submit(writer).result(timeout=10)
            self.assertEqual(Voucher.objects.count(),count)
            return original()
        with mock.patch('server.erp.management.commands.reconcile.reconcile',collector):
            failed,result=self.command('--record','--run-id',str(uuid.uuid4()))
        self.assertFalse(failed);self.assertEqual(observed,['repeatable read','on']);self.assertEqual(result['counts']['vouchers'],0)
        self.assertEqual((Voucher.objects.count(),ReconciliationRun.objects.count()),(1,1))
        def illegal():Voucher.objects.update(note='illegal')
        with mock.patch('server.erp.management.commands.reconcile.reconcile',illegal):
            with self.assertRaises(DatabaseError):call_command('reconcile',stdout=StringIO())
        self.assertFalse(Voucher.objects.filter(note='illegal').exists())
        with transaction.atomic():
            with self.assertRaisesMessage(CommandError,'іншої транзакції'):call_command('reconcile','--record',stdout=StringIO())

    @skipUnless(connection.vendor=='postgresql','PostgreSQL unique run receipt')
    def test_concurrent_same_id_is_one_immutable_receipt(self):
        from threading import Barrier
        barrier=Barrier(2);key=uuid.uuid4();report={'checks':{},'issues':0,'counts':{}}
        def worker():
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return journal.record(key,'manual',report,self.now,self.now).report_hash
            finally:connection.close()
        with ThreadPoolExecutor(max_workers=2) as p:results=list(p.map(lambda _:worker(),range(2)))
        self.assertEqual(results,[journal.digest(report)]*2);self.assertEqual(ReconciliationRun.objects.count(),1)
