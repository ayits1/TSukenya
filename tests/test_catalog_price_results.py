"""Operation deltas are immutable evidence, never a replacement for a fresh print proof."""
import hashlib
import time
import uuid
from unittest.mock import patch
from django.test import TransactionTestCase
from django.db import connection
from django.utils import timezone
from server.erp.models import Document, Store, Profile, User, PortalSession, LedgerLock, AuditEvent, PromotionCampaign, PromotionPrice
from server.erp.import_models import CatalogImportRun, CatalogImportRow
from server.erp.import_jobs import process_one
from server.erp.catalog_price_results import compare_terms, terms
from server.erp.promotion_prices import PriceResolver, kyiv_day
from server.erp.catalog import defaults


class PriceResultsTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create(username='isolated-price-result-author');Profile.objects.create(user=self.user,role='owner')
        self.store=Store.objects.create(name='Ізольований магазин');self.other=Store.objects.create(name='Інший магазин')
        LedgerLock.objects.get_or_create(pk=1)
        Document.objects.create(path='settings/main',data={'defaultMarkup':30,'rounding':.5})
        self.attach(self.user)
    def attach(self,user):
        token=str(uuid.uuid4());csrf=str(uuid.uuid4())
        PortalSession.objects.create(user=user,token_hash=hashlib.sha256(token.encode()).hexdigest(),csrf=csrf,expires=int(time.time())+3600)
        self.client.cookies['ts_session']=token;self.headers={'HTTP_ORIGIN':'http://testserver','HTTP_X_CSRF_TOKEN':csrf}
    def post(self,path,payload):return self.client.post('/api/v1/catalog/'+path,payload,content_type='application/json',**self.headers)
    def product(self,name='Кава',**fields):return Document.objects.create(path='products/'+str(uuid.uuid4()).replace('-','_'),data={'name':name,'unit':'шт','cost':10,'markup':30,'manualPrice':False,**fields})
    def payload(self,product,**extra):return {'kind':'markup','ids':[product.path.split('/',1)[1]],'markup':'40','resetManualPrices':False,'updateDefault':False,**extra}
    def commit(self,kind,payload):
        preview=self.post(kind+'/preview',payload);self.assertEqual(preview.status_code,200,preview.content)
        body={**payload,'snapshot':preview.json()['snapshot'],'idempotencyKey':str(uuid.uuid4())}
        result=self.post(kind+'/commit',body);self.assertEqual(result.status_code,200,result.content)
        return preview.json(),body,result.json()
    def read(self,kind,key,query=''):return self.client.get('/api/v1/catalog/price-results/'+kind+'/'+key+query)
    def drain(self,key):
        for _ in range(30):
            if not process_one(uuid.UUID(key)):return
        self.fail('isolated bounded worker did not finish')
    def job(self,entries,**extra):
        key=str(uuid.uuid4());r=self.post('import/runs',{'idempotencyKey':key,'fileName':'Ізольований.csv','expectedRows':len(entries),**extra});self.assertEqual(r.status_code,200,r.content)
        for offset in range(0,len(entries),200):
            self.assertEqual(self.post('import/runs/'+key+'/chunks',{'offset':offset,'entries':entries[offset:offset+200]}).status_code,200)
        self.assertEqual(self.post('import/runs/'+key+'/seal',{}).status_code,200);self.drain(key)
        run=self.client.get('/api/v1/catalog/import/runs/'+key).json();self.assertEqual(run['status'],'ready',run)
        self.assertEqual(self.post('import/runs/'+key+'/apply',{'planRevision':run['planRevision']}).status_code,200)
        return key
    def test_rounded_manual_metadata_and_new_are_not_retail_changes(self):
        rounded=self.product('Округлення');manual=self.product('Ручна',manualPrice=True,price=20)
        payload={'entries':[{'line':1,'values':{'name':'Округлення','cost':'10.01'}},{'line':2,'values':{'name':'Ручна','cost':'15'}},{'line':3,'values':{'name':'Новий','cost':'10'}}]}
        # Change remains inside the same .5 rounded step: 10.01*1.3 ->13.5; baseline needs13.5 too.
        rounded.data['cost']=10.02;rounded.save()
        preview,body,result=self.commit('import',payload)
        rows=[e['priceResult'] for e in result['entries']]
        self.assertEqual([x['retailChanged'] for x in rows],[False,False,False]);self.assertIsNone(rows[2]['before']);self.assertTrue(rows[2]['created'])
        self.assertEqual(self.read('import',body['idempotencyKey'],'?group=retail').json()['items'],[])
        self.assertEqual(self.read('import',body['idempotencyKey'],'?group=new').json()['total'],1)
        self.assertFalse(rows[0]['displayChanged']);self.assertFalse(rows[1]['displayChanged'])
        meta_body={'entries':[{'line':1,'values':{'name':'Округлення','barcode':'123'}}]}
        _,_,meta=self.commit('import',meta_body);self.assertFalse(meta['entries'][0]['priceResult']['retailChanged'])
    def test_same_campaign_price_regular_only_display_and_numeric_spelling(self):
        p=self.product();today=kyiv_day();campaign=PromotionCampaign.objects.create(author=self.user,name='Акція',scope='stores',starts_on=today,ends_on=today)
        campaign.stores.add(self.store);PromotionPrice.objects.create(campaign=campaign,product=p,price='11.00')
        preview,body,result=self.commit('pricing',self.payload(p,priceContext={'storeId':self.store.pk}))
        row=result['entries'][0]['priceResult'];self.assertEqual(row['before']['salePrice'],row['after']['salePrice']);self.assertFalse(row['retailChanged']);self.assertTrue(row['displayChanged'])
        self.assertEqual(row['before']['display']['oldPrice'],'13.00');self.assertEqual(row['after']['display']['oldPrice'],'14.00')
        self.assertEqual(self.read('pricing',body['idempotencyKey'],'?group=display').json()['total'],1)
        self.assertEqual(self.read('pricing',body['idempotencyKey'],'?group=retail').json()['total'],0)
        old=terms(p,defaults(),PriceResolver(store=self.store,product_paths=[p.path]));latest={**old,'salePrice':'11.0','effectivePromotion':{**old['effectivePromotion'],'revision':999,'name':'Інша назва'}}
        self.assertFalse(compare_terms(old,latest)['retailChanged']);self.assertFalse(compare_terms(old,latest)['displayChanged'])
    def test_immutable_retry_after_edit_and_price_read_is_rr_readonly(self):
        p=self.product();_,body,ack=self.commit('pricing',self.payload(p))
        p.data['cost']=50;p.save();counts=(Document.objects.count(),AuditEvent.objects.count())
        self.assertEqual(self.post('pricing/commit',body).json(),ack)
        with connection.execute_wrapper(self.trace_isolation):
            result=self.read('pricing',body['idempotencyKey'])
        self.assertEqual(result.status_code,200,result.content);self.assertEqual(result.json()['items'][0],ack['entries'][0]['priceResult'])
        self.assertEqual(result.json()['items'][0]['after']['salePrice'],'14.00');self.assertEqual(counts,(Document.objects.count(),AuditEvent.objects.count()))
    def trace_isolation(self,execute,sql,params,many,context):
        if connection.vendor=='postgresql' and sql.startswith('SELECT') and 'pricing_runs/' in str(params):
            with connection.cursor() as c:
                c.execute('SHOW transaction_isolation');self.assertEqual(c.fetchone()[0],'repeatable read')
                c.execute('SHOW transaction_read_only');self.assertEqual(c.fetchone()[0],'on')
        return execute(sql,params,many,context)
    def test_explicit_context_and_creator_permissions_and_fresh_scope(self):
        p=self.product();_,body,ack=self.commit('import',{'priceContext':{'storeId':self.store.pk},'entries':[{'line':1,'values':{'name':'Кава','cost':'12'}}]})
        self.user.profile.store=self.other;self.user.profile.save();audits=AuditEvent.objects.count()
        self.assertEqual(self.post('import/commit',body).status_code,403);self.assertEqual(self.read('import',body['idempotencyKey']).status_code,403)
        self.assertEqual(AuditEvent.objects.count(),audits)
        self.user.profile.store=self.store;self.user.profile.role='warehouse';self.user.profile.save()
        self.assertEqual(self.read('import',body['idempotencyKey']).status_code,200)
        self.assertEqual(self.post('import/preview',{'priceContext':{'storeId':None},'entries':[{'line':1,'values':{'name':'Кава'}}]}).status_code,403)
        foreign=User.objects.create(username='other-creator');Profile.objects.create(user=foreign,role='owner');self.attach(foreign)
        self.assertEqual(self.read('import',body['idempotencyKey']).status_code,404)
        self.attach(self.user);self.user.profile.role='cashier';self.user.profile.save();self.assertEqual(self.read('import',body['idempotencyKey']).status_code,403)
    def test_role_and_store_revocation_while_waiting_does_not_return_receipt(self):
        p=self.product();_,body,ack=self.commit('pricing',self.payload(p,priceContext={'storeId':self.store.pk}));before=AuditEvent.objects.count()
        from server.erp.services import ledger_lock
        for change in ({'role':'manager'},{'role':'owner','store_id':self.other.pk}):
            self.user.profile.role='owner';self.user.profile.store=self.store;self.user.profile.save()
            def wait():
                ledger_lock();Profile.objects.filter(user=self.user).update(**change)
            with patch('server.erp.catalog_pricing.ledger_lock',side_effect=wait):
                self.assertEqual(self.post('pricing/commit',body).status_code,403)
        self.assertEqual(AuditEvent.objects.count(),before)
    def test_malformed_context_and_filter_disagreement_no_writes(self):
        p=self.product();before=AuditEvent.objects.count()
        for context in (None,[],{'storeId':True},{'storeId':'1'},{'storeId':-1},{'storeId':1,'extra':True}):
            self.assertEqual(self.post('pricing/preview',self.payload(p,priceContext=context)).status_code,400)
        payload=self.payload(p,priceContext={'storeId':self.store.pk});payload.pop('ids');payload['selection']={'q':'','type':'','category':'','pack':'','promotion':'','store':str(self.other.pk)}
        self.assertEqual(self.post('pricing/preview',payload).status_code,400)
        self.assertEqual(AuditEvent.objects.count(),before)
    def test_legacy_receipts_are_comparison_unavailable_without_backfill(self):
        key=str(uuid.uuid4());Document.objects.create(path='pricing_runs/'+key,data={'owner':self.user.pk,'result':{'entries':[{'id':'old','action':'update','revision':'a'*64}]}})
        result=self.read('pricing',key).json();self.assertTrue(result['comparisonUnavailable']);self.assertIsNone(result['priceContext']);self.assertEqual(result['items'],[])
        run=CatalogImportRun.objects.create(owner=self.user,expected_rows=1,mode='atomic',status='completed')
        CatalogImportRow.objects.create(run=run,ordinal=1,status='updated',product_path='products/old')
        result=self.read('import',str(run.pk)).json();self.assertTrue(result['comparisonUnavailable']);self.assertEqual(result['items'],[])
        self.assertFalse(AuditEvent.objects.exists())
    def test_worker_successful_rows_only_partial_cancel_and_pagination(self):
        existing=self.product('Змінений');manual=self.product('Ручна',manualPrice=True,price=20)
        entries=[{'line':1,'values':{'name':'Змінений','cost':'12'}},{'line':2,'values':{'name':'Ручна','cost':'15'}}]+[{'line':i+3,'values':{'name':f'Новий {i}','cost':'10'}} for i in range(101)]
        key=self.job(entries,priceContext={'storeId':self.store.pk})
        # Dirty-name drain is a bounded technical step; stop after exactly first successful application batch.
        for _ in range(10):
            process_one(uuid.UUID(key))
            if CatalogImportRow.objects.filter(run_id=key,price_result__isnull=False).exists():break
        self.assertEqual(CatalogImportRow.objects.filter(run_id=key,price_result__isnull=False).count(),100)
        response=self.post('import/runs/'+key+'/cancel',{});self.assertEqual(response.status_code,200,response.content)
        result=self.read('import',key).json();self.assertEqual(result['status'],'cancelled');self.assertEqual(result['total'],100);self.assertEqual(len(result['items']),100)
        self.assertEqual(self.read('import',key,'?group=retail').json()['total'],1)
        # A separate >100 successful result must remain paged, not download all outcomes.
        other=self.job([{'line':i+1,'values':{'name':f'Друга партія {i}','cost':'10'}} for i in range(101)]);self.drain(other)
        result=self.read('import',other,'?page=2&group=new').json();self.assertEqual((result['total'],result['pages'],len(result['items'])),(101,2,1))
        original=CatalogImportRow.objects.get(run_id=key,ordinal=1).price_result
        existing.data['cost']=99;existing.save();self.assertEqual(self.read('import',key,'?group=retail').json()['items'][0],original)
    def test_worker_scope_change_blocks_before_catalog_and_receipt_writes(self):
        p=self.product();key=self.job([{'line':1,'values':{'name':'Кава','cost':'12'}}],priceContext={'storeId':self.store.pk})
        self.user.profile.store=self.other;self.user.profile.save();self.drain(key)
        run=CatalogImportRun.objects.get(pk=key);self.assertEqual(run.status,'blocked');self.assertEqual(run.error['code'],'access_revoked')
        self.assertFalse(run.rows.filter(price_result__isnull=False).exists());p.refresh_from_db();self.assertEqual(p.data['cost'],10)
    def test_failed_chunk_rolls_back_price_receipt_with_product(self):
        p=self.product();key=self.job([{'line':1,'values':{'name':'Кава','cost':'12'}}])
        from server.erp import import_jobs
        original=import_jobs.apply_row
        def failing(*args,**kwargs):
            original(*args,**kwargs);raise RuntimeError('isolated injected failure after result')
        for _ in range(10):
            with patch('server.erp.import_jobs.apply_row',side_effect=failing):process_one(uuid.UUID(key))
            if CatalogImportRun.objects.get(pk=key).status=='failed':break
        self.assertEqual(CatalogImportRun.objects.get(pk=key).status,'failed');self.assertFalse(CatalogImportRow.objects.filter(run_id=key,price_result__isnull=False).exists())
        p.refresh_from_db();self.assertEqual(p.data['cost'],10);self.assertFalse(AuditEvent.objects.filter(action='catalog_changed').exists())

    def test_context_is_frozen_in_reviewed_snapshot_and_operation_not_current_day(self):
        p=self.product();payload=self.payload(p,priceContext={'storeId':self.store.pk})
        preview=self.post('pricing/preview',payload).json();key=str(uuid.uuid4());body={**payload,'snapshot':preview['snapshot'],'idempotencyKey':key}
        changed={**body,'priceContext':{'storeId':self.other.pk}}
        self.assertEqual(self.post('pricing/commit',changed).status_code,409)
        self.assertFalse(Document.objects.filter(path='pricing_runs/'+key).exists())
        ack=self.post('pricing/commit',body);self.assertEqual(ack.status_code,200,ack.content)
        from datetime import timedelta
        with patch('server.erp.promotion_prices.kyiv_day',return_value=kyiv_day()+timedelta(days=1)):
            self.assertEqual(self.post('pricing/commit',body).json(),ack.json())
            result=self.read('pricing',key).json()
        row=result['items'][0];self.assertEqual(row['context']['effectiveDay'],preview['effectiveDay']);self.assertEqual(row['context']['storeId'],self.store.pk)
        self.assertEqual(row['after']['productRevision'],ack.json()['entries'][0]['revision'])
        for query in ('?page=0','?page=-1','?group=update','?store='+str(self.other.pk)):
            self.assertEqual(self.read('pricing',key,query).status_code,400)

    def test_real_postgres_ledger_wait_rechecks_role_and_store_before_exact_receipt(self):
        if connection.vendor!='postgresql':self.skipTest('Requires actual PostgreSQL row-lock wait')
        from threading import Event
        from concurrent.futures import ThreadPoolExecutor
        from django.db import transaction,close_old_connections
        from django.test import Client
        from server.erp.services import ledger_lock
        p=self.product();_,body,ack=self.commit('pricing',self.payload(p,priceContext={'storeId':self.store.pk}))
        token=self.client.cookies['ts_session'].value;headers=dict(self.headers);before=AuditEvent.objects.count()
        for changed in ({'role':'manager'},{'role':'owner','store_id':self.other.pk}):
            Profile.objects.filter(user=self.user).update(role='owner',store_id=self.store.pk)
            entered=Event()
            def signal_wait():entered.set();ledger_lock()
            def client_retry():
                close_old_connections()
                try:
                    client=Client();client.cookies['ts_session']=token
                    return client.post('/api/v1/catalog/pricing/commit',body,content_type='application/json',**headers).status_code
                finally:close_old_connections()
            with ThreadPoolExecutor(max_workers=1) as pool:
                with patch('server.erp.catalog_pricing.ledger_lock',side_effect=signal_wait):
                    with transaction.atomic():
                        ledger_lock();future=pool.submit(client_retry)
                        self.assertTrue(entered.wait(5),'request did not reach real ledger wait')
                        self.assertFalse(future.done(),'receipt returned before ledger wait resolved')
                        Profile.objects.filter(user=self.user).update(**changed)
                    self.assertEqual(future.result(timeout=10),403)
        self.assertEqual(AuditEvent.objects.count(),before)
        self.assertEqual(Document.objects.filter(path__startswith='pricing_runs/').count(),1)

    def test_parallel_exact_pricing_commit_stores_one_immutable_delta(self):
        if connection.vendor!='postgresql':self.skipTest('Requires PostgreSQL ledger serialization')
        from concurrent.futures import ThreadPoolExecutor
        from django.db import close_old_connections
        from django.test import Client
        from threading import Barrier
        p=self.product();payload=self.payload(p);preview=self.post('pricing/preview',payload).json()
        body={**payload,'snapshot':preview['snapshot'],'idempotencyKey':str(uuid.uuid4())};token=self.client.cookies['ts_session'].value;barrier=Barrier(2)
        def commit():
            close_old_connections()
            try:
                client=Client();client.cookies['ts_session']=token;barrier.wait(timeout=5)
                response=client.post('/api/v1/catalog/pricing/commit',body,content_type='application/json',**self.headers)
                return response.status_code,response.json()
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:commit(),range(2)))
        self.assertEqual([x[0] for x in results],[200,200]);self.assertEqual(results[0][1],results[1][1])
        self.assertTrue(results[0][1]['entries'][0]['priceResult']['retailChanged'])
        self.assertEqual(Document.objects.filter(path__startswith='pricing_runs/').count(),1)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),1)

    def test_preview_reloads_cached_actor_inside_readonly_snapshot(self):
        from django.test import RequestFactory
        from server.erp import catalog_import, catalog_pricing
        from server.erp.services import BusinessError
        factory=RequestFactory();p=self.product()
        scenarios=[(catalog_import.preview_import,{'entries':[{'line':1,'values':{'name':'Кава','cost':'12'}}]}),
                   (catalog_pricing.preview_pricing,self.payload(p))]
        for preview,payload in scenarios:
            for change in ({'role':'cashier'}, {'store_id':self.other.pk}):
                Profile.objects.filter(user=self.user).update(role='owner',store_id=self.store.pk)
                cached=User.objects.select_related('profile').get(pk=self.user.pk)
                Profile.objects.filter(user=self.user).update(**change)
                request=factory.post('/',{**payload,'priceContext':{'storeId':self.store.pk}},content_type='application/json')
                with self.assertRaises(BusinessError):preview(request,cached)
        self.assertEqual(AuditEvent.objects.count(),0)

    def test_preview_campaign_comparison_uses_one_real_postgres_snapshot(self):
        if connection.vendor!='postgresql':self.skipTest('Requires PostgreSQL MVCC snapshot')
        from concurrent.futures import ThreadPoolExecutor
        from django.db import close_old_connections
        from server.erp.promotion_prices import PriceResolver
        p=self.product();today=kyiv_day()
        campaign=PromotionCampaign.objects.create(author=self.user,name='Акція',scope='stores',starts_on=today,ends_on=today)
        campaign.stores.add(self.store)
        candidate=PromotionPrice.objects.create(campaign=campaign,product=p,price='11.00')
        original=PriceResolver.__init__
        def update():
            close_old_connections()
            try:PromotionPrice.objects.filter(pk=candidate.pk).update(price='12.00')
            finally:close_old_connections()
        cases=[('pricing',self.payload(p)),('import',{'entries':[{'line':1,'values':{'name':'Кава','cost':'12'}}]})]
        for kind,payload in cases:
            PromotionPrice.objects.filter(pk=candidate.pk).update(price='11.00')
            payload={**payload,'priceContext':{'storeId':self.store.pk}};calls=[]
            def interleaved(resolver,*args,**kwargs):
                original(resolver,*args,**kwargs);calls.append(resolver)
                if len(calls)==1:
                    with connection.cursor() as c:
                        c.execute('SHOW transaction_isolation');self.assertEqual(c.fetchone()[0],'repeatable read')
                        c.execute('SHOW transaction_read_only');self.assertEqual(c.fetchone()[0],'on')
                    with ThreadPoolExecutor(max_workers=1) as pool:pool.submit(update).result(timeout=10)
            before=(Document.objects.count(),AuditEvent.objects.count())
            with patch.object(PriceResolver,'__init__',interleaved):response=self.post(kind+'/preview',payload)
            self.assertEqual(response.status_code,200,response.content)
            first=response.json();row=first['entries'][0]['priceComparison']
            self.assertEqual(row['before']['salePrice'],'11.00');self.assertEqual(row['after']['salePrice'],'11.00')
            self.assertFalse(row['retailChanged'])
            latest=self.post(kind+'/preview',payload).json()
            self.assertEqual(latest['entries'][0]['priceComparison']['after']['salePrice'],'12.00')
            self.assertNotEqual(first['snapshot'],latest['snapshot'])
            self.assertEqual(before,(Document.objects.count(),AuditEvent.objects.count()))

    def test_preview_snapshot_and_tuples_keep_one_day_across_midnight(self):
        from datetime import timedelta
        today=kyiv_day();p=self.product()
        campaign=PromotionCampaign.objects.create(author=self.user,name='Сьогодні',scope='network',starts_on=today,ends_on=today)
        PromotionPrice.objects.create(campaign=campaign,product=p,price='11.00')
        for kind,payload in [('pricing',self.payload(p)),('import',{'entries':[{'line':1,'values':{'name':'Кава','cost':'12'}}]})]:
            with patch('server.erp.promotion_prices.kyiv_day',return_value=today):expected=self.post(kind+'/preview',payload).json()
            with patch('server.erp.promotion_prices.kyiv_day',side_effect=[today,*([today+timedelta(days=1)]*20)]) as day:
                response=self.post(kind+'/preview',payload)
            self.assertEqual(response.status_code,200,response.content);actual=response.json()
            self.assertEqual(actual['snapshot'],expected['snapshot']);self.assertEqual(actual['effectiveDay'],today.isoformat())
            self.assertEqual(actual['entries'][0]['priceComparison']['after']['salePrice'],'11.00');self.assertEqual(day.call_count,1)
