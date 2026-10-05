"""Catalogue frozen receipts and read policy, over existing mutation services."""
import copy
import uuid
from types import SimpleNamespace
from unittest.mock import patch
from django.db import transaction
from django.test import RequestFactory, TransactionTestCase
from server.erp.models import AuditEvent, Document
import tests.test_catalog as catalog_fixture


class CatalogRecoveryTests(TransactionTestCase):
    setUp = catalog_fixture.CatalogTests.setUp
    detail = catalog_fixture.CatalogTests.detail
    # Reuse fixture only; the new scope does not rerun the parent test family.
    def action(self, operation='product_create', target=None, request=None):
        return {'key': str(uuid.uuid4()), 'operation': operation, 'target': target,
                'store': None, 'request': request or {'name': 'Receipt coffee', 'cost': '2.00'}}
    def send(self, value, endpoint='execute'):
        return self.client.post('/api/v1/catalog/recovery/' + endpoint, value, content_type='application/json', **self.headers)
    def test_create_identity_replays_original_after_edit_delete_without_writes_and_prefix_is_private(self):
        value=self.action();first=self.send(value);self.assertEqual(first.status_code,200)
        ack=first.json();self.assertEqual(ack['outcome'],'created')
        self.assertEqual(set(ack),{'confirmed','key','operation','target','requestHash','outcome'})
        path='products/'+ack['target'];product=Document.objects.get(pk=path)
        product.data['name']='Edited elsewhere';product.save()
        audits=AuditEvent.objects.count()
        self.assertEqual(self.send(value).json(),ack)
        self.assertEqual(self.send(value,'identity').json(),ack)
        self.assertEqual(AuditEvent.objects.count(),audits)
        product.delete();self.assertEqual(self.send(value).json(),ack);self.assertFalse(Document.objects.filter(pk=path).exists())
        receipt_path='catalog_action_receipts/'+value['key']
        protected=Document.objects.get(pk=receipt_path).data
        refused=self.client.delete('/api/docs/'+receipt_path,{},content_type='application/json',**self.headers)
        self.assertEqual(refused.status_code,400)
        self.assertEqual(Document.objects.get(pk=receipt_path).data,protected)
    def test_changed_body_and_other_author_cannot_reuse_uuid_current_role_precedes_receipt(self):
        value=self.action();self.assertEqual(self.send(value).status_code,200)
        changed=copy.deepcopy(value);changed['request']['cost']='3.00'
        self.assertEqual(self.send(changed).json()['code'],'idempotency_conflict')
        from django.contrib.auth.models import User
        from server.erp.models import Profile
        from server.erp.catalog_recovery import identity
        other=User.objects.create(username='other-catalog-author');Profile.objects.create(user=other,role='owner')
        request=RequestFactory().post('/api/v1/catalog/recovery/identity',value,content_type='application/json')
        from server.erp.services import Conflict
        with self.assertRaises(Conflict):identity(request,other)
        self.user.profile.role='cashier';self.user.profile.save()
        self.assertEqual(self.send(value).status_code,403)
        self.assertEqual(self.send(value,'identity').status_code,403)
        self.assertEqual(self.client.get('/api/v1/catalog/recovery/context?operation=product_create').status_code,403)
    def test_existing_update_visibility_delete_confirm_original_without_adopting_current_revision(self):
        original=self.detail();value=self.action('product_update','one',{'revision':original['revision'],'promotion':False,'cost':'14.00'})
        ack=self.send(value).json();self.assertEqual(ack['outcome'],'saved')
        fresh=self.detail();self.assertNotEqual(fresh['revision'],original['revision'])
        hidden=self.action('product_visibility','one',{'revision':fresh['revision'],'hidden':True})
        self.assertEqual(self.send(hidden).status_code,200)
        self.assertEqual(self.send(value,'identity').json(),ack)
        deleting=self.action('product_delete','one',{'revision':self.client.get('/api/v1/catalog/products/one?includeHidden=true').json()['revision']})
        receipt=self.send(deleting).json();self.assertEqual(receipt['outcome'],'deleted')
        self.assertEqual(self.send(deleting).json(),receipt)
        self.assertFalse(Document.objects.filter(pk='products/one').exists())
    def test_inline_reference_and_reviewed_whole_b30_replay_keep_one_audit(self):
        value=self.action('reference_create',request={'field':'type','value':'New group'})
        ack=self.send(value).json();self.assertEqual(self.send(value).json(),ack)
        from server.erp.catalog_reference_index import ReferenceIndex
        from server.erp.catalog_reference_management import item_revision
        with ReferenceIndex() as records:revision=item_revision(records[ack['target']])
        proposal={'sourceId':ack['target'],'revision':revision,'operation':'rename','value':'Renamed group'}
        preview=self.client.post('/api/v1/catalog/references/preview',proposal,content_type='application/json',**self.headers).json()
        key=str(uuid.uuid4());body={**proposal,'snapshot':preview['snapshot'],'idempotencyKey':key}
        commit={'key':key,'operation':'reference_commit','target':ack['target'],'store':None,'request':body}
        result=self.send(commit);self.assertEqual(result.status_code,200)
        count=AuditEvent.objects.count();self.assertEqual(self.send(commit).json(),result.json());self.assertEqual(AuditEvent.objects.count(),count)
        self.assertEqual(Document.objects.get(pk='catalog_refs/'+ack['target']).data['value'],'Renamed group')
    def test_live_refusal_is_bound_and_rolled_back_but_postcommit_failure_has_no_proof(self):
        original=self.detail();value=self.action('product_update','one',{'revision':'stale','name':'Never saved'})
        refused=self.send(value);self.assertEqual(refused.status_code,409)
        self.assertTrue(refused.json()['write_rejected']);self.assertEqual(refused.json()['key'],value['key'])
        self.assertEqual(self.detail()['revision'],original['revision'])
        self.assertFalse(Document.objects.filter(pk='catalog_action_receipts/'+value['key']).exists())
        self.assertFalse(self.send(value,'identity').json()['confirmed'])
        invalid=self.action(request={'name':'Bad','manualPrice':True,'price':'1.001'})
        self.assertEqual(self.send(invalid).status_code,400)
        self.assertFalse(Document.objects.filter(path='catalog_action_receipts/'+invalid['key']).exists())
        from server.erp.catalog_recovery import execute,perform
        valid=self.action();request=RequestFactory().post('/api/v1/catalog/recovery/execute',valid,content_type='application/json')
        request.portal_session=SimpleNamespace(csrf='catalog-csrf')
        def fail():raise RuntimeError('postcommit transport boundary')
        def operation(*args):
            result=perform(*args);transaction.on_commit(fail);return result
        with patch('server.erp.catalog_recovery.perform',side_effect=operation),self.assertRaisesRegex(RuntimeError,'postcommit'):
            execute(request,self.user)
        self.assertTrue(self.send(valid,'identity').json()['confirmed'])
    def test_context_scalar_queries_duplicates_and_illegal_mode_parameters_refused(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext
        with CaptureQueriesContext(connection) as captured:
            result=self.client.get('/api/v1/catalog/recovery/context?operation=product_update&target=one')
        self.assertEqual(result.status_code,200);self.assertTrue(result.json()['exists'])
        self.assertFalse(any('"erp_document"."data"' in q['sql'] for q in captured))
        for query in ('operation=product_create&target=one','operation=product_create&operation=product_delete','operation=product_create&store=0','operation=product_create&unknown=1'):
            self.assertEqual(self.client.get('/api/v1/catalog/recovery/context?'+query).status_code,400)


class CatalogRecoveryConcurrencyTests(CatalogRecoveryTests):
    def test_parallel_replay_is_one_create_and_cached_actor_is_rechecked_after_wait(self):
        from django.db import connection, close_old_connections, connections
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL ledger serialization only')
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from server.erp.catalog_recovery import execute
        from django.contrib.auth.models import User
        def invoke(value):
            close_old_connections()
            try:
                actor=User.objects.select_related('profile').get(pk=self.user.pk)
                request=RequestFactory().post('/api/v1/catalog/recovery/execute',value,content_type='application/json')
                request.portal_session=SimpleNamespace(csrf='catalog-csrf')
                return execute(request,actor)
            finally:connections.close_all()
        value=self.action(request={'name':'Concurrent receipt product','cost':'1.00'})
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(invoke,[value,value]))
        self.assertEqual(results[0].json() if hasattr(results[0],'json') else __import__('json').loads(results[0].content),__import__('json').loads(results[1].content))
        self.assertEqual(Document.objects.filter(path__startswith='products/',data__name='Concurrent receipt product').count(),1)
        self.assertEqual(Document.objects.filter(pk='catalog_action_receipts/'+value['key']).count(),1)
        entered,release=Event(),Event()
        from server.erp.services import ledger_lock
        def wait():entered.set();self.assertTrue(release.wait(5));ledger_lock()
        with ThreadPoolExecutor(max_workers=1) as pool,patch('server.erp.catalog_recovery.ledger_lock',side_effect=wait):
            future=pool.submit(invoke,value);self.assertTrue(entered.wait(5))
            self.user.profile.role='cashier';self.user.profile.save();release.set()
            with self.assertRaisesRegex(Exception,'прав'):future.result(timeout=10)
        self.assertEqual(Document.objects.filter(path__startswith='products/',data__name='Concurrent receipt product').count(),1)

# Only the added PostgreSQL scenario belongs to this subclass.
for _name in tuple(vars(CatalogRecoveryTests)):
    if _name.startswith('test_'):setattr(CatalogRecoveryConcurrencyTests,_name,None)
