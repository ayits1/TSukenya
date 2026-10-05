"""Whole campaign receipt/provenance/private read protocol on isolated data."""
import copy
import json
import uuid
from unittest.mock import patch
from django.db import transaction
from django.test import RequestFactory
from server.erp.models import Document, Store, PromotionCampaign, AuditEvent, PriceChange, User, Profile
from server.erp.services import current_actor
from server.erp.promotion_prices import kyiv_day
from tests.test_unit_and_drafts import TransactionApiFixture

ROOT = '/api/v1/promotions/recovery/'

class CampaignRecoveryTests(TransactionApiFixture):
    def setUp(self):
        super().setUp()
        self.other = Store.objects.create(name='Інший')
        self.p.data = {'name':'Кава','unit':'шт','cost':10,'manualPrice':True,'price':30}
        self.p.save()
        self.today = kyiv_day().isoformat()

    def payload(self, **extra):
        return {'idempotencyKey':str(uuid.uuid4()),'name':'Тиждень кави','startsOn':self.today,'endsOn':self.today,'active':True,'scope':'network','stores':[],'prices':[{'product':'p','price':'25.00'}],'reason':'Сезонна пропозиція',**extra}

    def action(self, operation='create', target=None, body=None, key=None):
        key = key or str(uuid.uuid4())
        return {'key':key,'operation':operation,'target':target,'request':body or self.payload(idempotencyKey=key)}

    def send(self, value, endpoint='execute'):
        return self.call('post',ROOT+endpoint,value)

    def test_compact_create_update_archive_replay_ignores_changed_current_and_keeps_audit_once(self):
        initial=self.action();created=self.send(initial)
        self.assertEqual(created.status_code,200,created.content);ack=created.json()
        self.assertEqual(set(ack),{'confirmed','key','operation','target','requestHash','outcome'})
        identifier=ack['target'];original=PromotionCampaign.objects.get(pk=identifier)
        immutable=(original.author_id,original.request_fingerprint)
        input={k:v for k,v in initial['request'].items() if k!='idempotencyKey'}
        update=self.action('update',identifier,{**input,'revision':1,'name':'Нові умови','active':False})
        self.assertEqual(self.send(update).status_code,200)
        archive=self.action('archive',identifier,{'revision':2,'reason':'Архівування'})
        archived=self.send(archive);self.assertEqual(archived.json()['outcome'],'archived')
        counts=(AuditEvent.objects.count(),PriceChange.objects.count(),Document.objects.filter(path__startswith='campaign_action_receipts/').count())
        for intent in (initial,update,archive):
            replay=self.send(intent);self.assertEqual(replay.status_code,200,replay.content)
            self.assertEqual(self.send(intent,'identity').json(),replay.json())
        self.assertEqual(counts,(AuditEvent.objects.count(),PriceChange.objects.count(),Document.objects.filter(path__startswith='campaign_action_receipts/').count()))
        current=PromotionCampaign.objects.get(pk=identifier)
        self.assertEqual((current.author_id,current.request_fingerprint),immutable)
        self.assertEqual((current.revision,current.archived,current.active),(3,True,False))
        self.assertEqual(self.call('delete','/api/docs/campaign_action_receipts/'+initial['key'],{}).status_code,400)
        current.delete()
        self.assertEqual(self.send(initial).json(),ack)
        self.assertFalse(PromotionCampaign.objects.exists())

    def test_legacy_creator_fingerprint_proves_original_after_patch_archive_without_current_terms(self):
        initial=self.action();legacy=self.call('post','/api/v1/promotions/campaigns',initial['request']);self.assertEqual(legacy.status_code,200)
        identifier=initial['key'];input={k:v for k,v in initial['request'].items() if k!='idempotencyKey'}
        before=PromotionCampaign.objects.get(pk=identifier);immutable=(before.author_id,before.request_fingerprint)
        self.assertEqual(self.call('patch','/api/v1/promotions/campaigns/'+identifier,{**input,'revision':1,'name':'Змінено пізніше'}).status_code,200)
        self.assertEqual(self.call('delete','/api/v1/promotions/campaigns/'+identifier,{'revision':2,'reason':'Архів'}).status_code,200)
        counts=(AuditEvent.objects.count(),PriceChange.objects.count(),Document.objects.count())
        with patch('server.erp.promotions.validate',side_effect=AssertionError('Historical replay must skip current product validation')):
            identity=self.send(initial,'identity');self.assertTrue(identity.json()['confirmed'])
            self.assertEqual(identity.json()['target'],identifier)
            self.assertEqual(self.send(initial).json(),identity.json())
        self.assertEqual(counts,(AuditEvent.objects.count(),PriceChange.objects.count(),Document.objects.count()))
        current=PromotionCampaign.objects.get(pk=identifier)
        self.assertEqual((current.author_id,current.request_fingerprint),immutable)
        self.assertEqual(current.revision,3)
        self.assertNotIn('revision',identity.json())
        current.delete();self.assertFalse(self.send(initial,'identity').json()['confirmed'])

    def test_collision_and_fresh_current_role_scope_before_historical_receipt(self):
        initial=self.action();self.assertEqual(self.send(initial).status_code,200)
        changed=copy.deepcopy(initial);changed['request']['reason']='Інший намір'
        collision=self.send(changed);self.assertEqual(collision.status_code,409);self.assertNotIn('write_rejected',collision.json())
        actor=User.objects.get(pk=self.u.pk);actor.profile # deliberately cache before revocation
        from server.erp.campaign_recovery import identity
        request=RequestFactory().post(ROOT+'identity',initial,content_type='application/json')
        Profile.objects.filter(user=self.u).update(store=self.store)
        with self.assertRaisesRegex(Exception,'доступ'):identity(request,actor)
        self.assertEqual(self.send(initial).status_code,403)
        Profile.objects.filter(user=self.u).update(store=None,role='manager')
        for path in ('context?operation=create','current?id='+initial['key']):self.assertEqual(self.client.get(ROOT+path).status_code,403)
        self.assertEqual(self.client.get('/api/v1/promotions/campaigns').status_code,403)
        self.assertEqual(self.client.get('/api/v1/promotions/campaigns/'+initial['key']).status_code,403)

    def test_initial_rollback_proof_and_postcommit_failure_are_separate(self):
        invalid=self.action();invalid['request']['prices'][0]['price']='0'
        result=self.send(invalid);self.assertEqual(result.status_code,400);self.assertTrue(result.json()['write_rejected'])
        self.assertFalse(PromotionCampaign.objects.exists());self.assertFalse(Document.objects.filter(path__startswith='campaign_action_receipts/').exists())
        initial=self.action();self.assertEqual(self.send(initial).status_code,200)
        input={k:v for k,v in initial['request'].items() if k!='idempotencyKey'}
        stale=self.action('update',initial['key'],{**input,'revision':2})
        result=self.send(stale);self.assertEqual(result.status_code,409);self.assertTrue(result.json()['write_rejected'])
        self.assertEqual(PromotionCampaign.objects.get().revision,1)
        from server.erp.campaign_recovery import execute,perform
        value=self.action();request=RequestFactory().post(ROOT+'execute',value,content_type='application/json')
        def after_commit(*args):
            result=perform(*args)
            transaction.on_commit(lambda: (_ for _ in ()).throw(RuntimeError('postcommit failure')))
            return result
        with patch('server.erp.campaign_recovery.perform',side_effect=after_commit):
            with self.assertRaisesRegex(RuntimeError,'postcommit'):execute(request,self.u)
        self.assertEqual(PromotionCampaign.objects.count(),2)
        self.assertTrue(self.send(value,'identity').json()['confirmed'])

    def test_readonly_current_query_identity_completeness_and_duplicates(self):
        value=self.action();self.assertEqual(self.send(value).status_code,200)
        context=self.client.get(ROOT+'context?operation=create').json();self.assertIsNone(context['exists'])
        response=self.client.get(ROOT+'current?id='+value['key']);self.assertEqual(response.status_code,200,response.content)
        self.assertEqual(response.json()['campaign']['id'],value['key']);self.assertTrue(response.json()['editing']['canWrite'])
        for query in ['context?operation=create&operation=create','context?operation=create&store=1','current?id='+value['key']+'&id='+value['key'],'current?id='+value['key']+'&q=ignored']:
            self.assertEqual(self.client.get(ROOT+query).status_code,400,query)
        self.assertEqual(self.client.get(ROOT+'unknown/current').status_code,405)
        count=AuditEvent.objects.count()
        self.assertTrue(self.send(value,'identity').json()['confirmed']);self.assertEqual(AuditEvent.objects.count(),count)

    def test_scalar_caption_matches_original_dto_and_never_selects_product_payload(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext
        # Unknown graph deliberately large; reads only need name, not this field.
        self.p.data['unknown']={'recipe':['unchanged'*10000]};self.p.save()
        value=self.action();self.assertEqual(self.send(value).status_code,200)
        for name in ('Назва \"\\ слово', '', None, 0, True, False, 'true', 'false', 'null', '123', '1.00', '{}', '[]', {'ключ':'значення'}, ['а',2]):
            data=dict(self.p.data,name=name);Document.objects.filter(pk=self.p.pk).update(data=data)
            with CaptureQueriesContext(connection) as queries:
                response=self.client.get('/api/v1/promotions/campaigns/'+value['key'])
                current=self.client.get(ROOT+'current?id='+value['key'])
                listing=self.client.get('/api/v1/promotions/campaigns')
            self.assertEqual(response.status_code,200,response.content)
            self.assertEqual(response.json()['prices'],[{'product':'p','name':str(name or ''),'price':'25.00'}])
            self.assertEqual(current.json()['campaign'],response.json())
            self.assertEqual(listing.json()['items'][0],response.json())
            for query in queries.captured_queries:
                # JSON_EXTRACT / -> name mentions data, but direct full data SELECT is forbidden.
                self.assertNotRegex(query['sql'],r'(?:SELECT|,)\s*"erp_document"\."data"(?=\s*(?:,|AS\b|FROM\b))')

class CampaignRecoveryConcurrencyTests(CampaignRecoveryTests):
    def test_parallel_receipt_and_cached_actor_revocation_after_actual_ledger_wait(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from time import monotonic,sleep
        from django.db import connection,close_old_connections,connections
        from server.erp.campaign_recovery import execute
        from server.erp.services import ledger_lock
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL serialization only')
        def invoke(value):
            close_old_connections()
            try:
                actor=User.objects.select_related('profile').get(pk=self.u.pk)
                request=RequestFactory().post(ROOT+'execute',value,content_type='application/json')
                return execute(request,actor)
            finally:connections.close_all()
        value=self.action()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(invoke,[value,value]))
        self.assertEqual(json.loads(results[0].content),json.loads(results[1].content))
        self.assertEqual(PromotionCampaign.objects.count(),1)
        self.assertEqual(Document.objects.filter(path__startswith='campaign_action_receipts/').count(),1)
        entered=Event();pid=[]
        def wait():
            with connection.cursor() as cursor:
                cursor.execute('SELECT pg_backend_pid()');pid.append(cursor.fetchone()[0])
            entered.set();ledger_lock()
        with ThreadPoolExecutor(max_workers=1) as pool,patch('server.erp.campaign_recovery.ledger_lock',side_effect=wait):
            with transaction.atomic():
                ledger_lock();future=pool.submit(invoke,value);self.assertTrue(entered.wait(5))
                deadline=monotonic()+5;blocked=False
                while monotonic()<deadline:
                    with connection.cursor() as cursor:
                        cursor.execute('SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s',pid)
                        blocked=cursor.fetchone()[0]=='Lock'
                    if blocked:break
                    sleep(.02)
                self.assertTrue(blocked,'actual ledger wait')
                Profile.objects.filter(user=self.u).update(store=self.store)
            with self.assertRaisesRegex(Exception,'доступ'):future.result(timeout=10)
        self.assertEqual(PromotionCampaign.objects.count(),1)

for _name in tuple(vars(CampaignRecoveryTests)):
    if _name.startswith('test_'):setattr(CampaignRecoveryConcurrencyTests,_name,None)
