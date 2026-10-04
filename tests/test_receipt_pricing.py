"""Invoice source never implies a catalogue write; exact review receipts survive later edits."""
import copy
import uuid
from decimal import Decimal
from unittest.mock import patch
from django.test import TransactionTestCase, Client
from django.db import connection, close_old_connections
from server.erp.models import Document, Warehouse, Counterparty, Voucher, StockEntry, AuditEvent, Profile
from server.erp.services import save_voucher, post_voucher, ledger_lock
from tests import test_catalog_price_results as fixtures

class ReceiptPricingTests(TransactionTestCase):
    setUp=fixtures.PriceResultsTests.setUp
    attach=fixtures.PriceResultsTests.attach
    product=fixtures.PriceResultsTests.product
    def create_source(self,price='12.5000',second=True):
        self.p=self.product('Цукерки',category='unchanged',manualPrice=False)
        wh=Warehouse.objects.create(store=self.store,name='Склад');party=Counterparty.objects.create(name='QA постачальник',kind='supplier')
        lines=[{'product':self.p.path.split('/')[1],'quantity':'2','price':price,'lot':'FIRST'}]
        if second:lines.append({'product':self.p.path.split('/')[1],'quantity':'1','price':'13','lot':'SECOND'})
        self.source=save_voucher(self.user,{'kind':'receipt','date':'2026-10-04','store':self.store.pk,'warehouse':wh.pk,'party':party.pk,'lines':lines,'payload':{'additional_cost':'0.03'}})
        return self.source
    def url(self,action=''):return '/api/v1/receipt-pricing/'+str(self.source.pk)+('/'+action if action else '')
    def post(self,action,body):return self.client.post(self.url(action),body,content_type='application/json',**self.headers)
    def body(self,cost='12.50',bound=True):
        current=self.client.get(self.url()).json();row=current['source']['lines'][0];p=next(p for p in current['products'] if p['id']==self.p.path.split('/')[1])
        return {'sourceRevision':current['source']['revision'],'sourceSnapshot':current['sourceSnapshot'],'priceContext':{'storeId':self.store.pk},'reason':'Після надходження, явний вибір ціни','entries':[{'id':p['id'],'revision':p['revision'],'sourceLine':{'id':row['id'],'lineKey':row['lineKey']} if bound else None,'values':{'cost':cost,'markup':'30','manualPrice':False,'price':None,'priceReviewed':False}}]}
    def reviewed(self,body=None):
        body=body or self.body();r=self.post('preview',body);self.assertEqual(r.status_code,200,r.content);self.assertTrue(r.json()['valid'],r.content)
        return {**body,'snapshot':r.json()['snapshot'],'idempotencyKey':str(uuid.uuid4())}
    def test_actual_posting_no_catalog_change_readonly_preview_then_explicit_atomic_receipt(self):
        self.create_source();before=copy.deepcopy(self.p.data);post_voucher(self.user,self.source.pk);self.p.refresh_from_db();self.assertEqual(self.p.data,before)
        count=AuditEvent.objects.count();movements=list(StockEntry.objects.values_list('quantity','value'))
        def trace(execute,sql,params,many,context):
            if connection.vendor=='postgresql' and sql.startswith('SELECT') and 'erp_document' in sql:
                with connection.cursor() as cursor:cursor.execute('SHOW transaction_read_only');self.assertEqual(cursor.fetchone()[0],'on')
            return execute(sql,params,many,context)
        with connection.execute_wrapper(trace):
            current=self.client.get(self.url());self.assertEqual(current.status_code,200,current.content)
            frozen=self.reviewed()
        self.assertEqual(AuditEvent.objects.count(),count)
        self.assertEqual(current.json()['source']['status'],'posted');self.assertEqual(current.json()['source']['lines'][0]['price'],'12.5000');self.assertEqual(current.json()['source']['additionalCost'],'0.03')
        result=self.post('commit',frozen);self.assertEqual(result.status_code,200,result.content);receipt=result.json();self.p.refresh_from_db()
        self.assertEqual(Decimal(str(self.p.data['cost'])),Decimal('12.50'));self.assertEqual(self.p.data['category'],'unchanged');self.assertEqual(list(StockEntry.objects.values_list('quantity','value')),movements)
        count=AuditEvent.objects.count();self.p.data['cost']=99;self.p.save();Voucher.objects.filter(pk=self.source.pk).update(revision=20,status='reversed')
        repeated=self.post('commit',frozen);self.assertEqual(repeated.status_code,200,repeated.content);self.assertEqual(repeated.json(),receipt);self.assertEqual(AuditEvent.objects.count(),count);self.p.refresh_from_db();self.assertEqual(self.p.data['cost'],99)
        read=self.client.get(self.url('results/'+frozen['idempotencyKey']));self.assertEqual(read.json(),receipt)
        journal=self.client.get('/api/v1/catalog/price-results/import/'+frozen['idempotencyKey']);self.assertEqual(journal.status_code,200,journal.content);self.assertEqual(journal.json()['items'][0],receipt['entries'][0]['priceResult'])
    def test_fractional_cent_source_is_refused_manual_proposal_is_explicit(self):
        self.create_source('12.3456');count=AuditEvent.objects.count();current=self.client.get(self.url()).json();self.assertIsNone(current['source']['lines'][0]['landedAmount'])
        response=self.post('preview',self.body('12.35'));self.assertEqual(response.status_code,200);self.assertFalse(response.json()['valid']);self.assertIn('знаків',response.json()['entries'][0]['error'])
        self.assertTrue(self.post('preview',self.body('12.35',False)).json()['valid']);self.assertEqual(AuditEvent.objects.count(),count)
    def test_source_and_campaign_change_after_review_no_partial_write(self):
        self.create_source();body=self.reviewed();before=copy.deepcopy(self.p.data);count=AuditEvent.objects.count();Voucher.objects.filter(pk=self.source.pk).update(revision=2)
        result=self.post('commit',body);self.assertEqual(result.status_code,409,result.content);self.p.refresh_from_db();self.assertEqual(self.p.data,before);self.assertEqual(AuditEvent.objects.count(),count)
        body=self.reviewed();from server.erp.models import PromotionCampaign,PromotionPrice
        campaign=PromotionCampaign.objects.create(name='Точна чинна акція',starts_on='2026-01-01',ends_on='2099-12-31',scope='network',author=self.user,reason='QA',request_fingerprint='test')
        PromotionPrice.objects.create(campaign=campaign,product=self.p,price='5')
        result=self.post('commit',body);self.assertEqual(result.status_code,409,result.content);self.assertEqual(AuditEvent.objects.count(),count)
    def test_manual_and_lower_promotion_exclude_phantom_retail_deltas(self):
        self.create_source();self.p.data.update(manualPrice=True,price=20,promotion=True,promotionPrice=5);self.p.save();body=self.body(bound=False);body['entries'][0]['values'].update(manualPrice=True,price='20')
        preview=self.post('preview',body).json();self.assertTrue(preview['valid']);self.assertFalse(preview['entries'][0]['comparison']['retailChanged']);self.assertFalse(preview['entries'][0]['comparison']['displayChanged'])
        body['entries'][0]['values'].update(price='21');preview=self.post('preview',body).json();self.assertFalse(preview['entries'][0]['comparison']['retailChanged']);self.assertTrue(preview['entries'][0]['comparison']['displayChanged'])
    def test_fresh_actor_after_lock_and_result_current_scope(self):
        self.create_source();body=self.reviewed();count=AuditEvent.objects.count()
        def wait():ledger_lock();Profile.objects.filter(user=self.user).update(store=self.other)
        with patch('server.erp.receipt_pricing.ledger_lock',side_effect=wait):self.assertEqual(self.post('commit',body).status_code,403)
        self.assertEqual(AuditEvent.objects.count(),count);Profile.objects.filter(user=self.user).update(store=None)
        self.assertEqual(self.post('commit',body).status_code,200)
        Profile.objects.filter(user=self.user).update(role='cashier');self.assertEqual(self.client.get(self.url('results/'+body['idempotencyKey'])).status_code,403)
    def test_semantic_bindings_hidden_and_malformed_context_no_writes(self):
        self.create_source();before=AuditEvent.objects.count();body=self.body();body['entries'][0]['sourceLine']['lineKey']=str(uuid.uuid4());self.assertFalse(self.post('preview',body).json()['valid'])
        for bad in ([],{'storeId':True},{'storeId':None,'storeName':'forged'}):
            body=self.body();body['priceContext']=bad;self.assertEqual(self.post('preview',body).status_code,400)
        self.p.data['hidden']=True;self.p.save();body=self.body(bound=False);self.assertFalse(self.post('preview',body).json()['valid']);self.assertEqual(AuditEvent.objects.count(),before)
    def test_receipt_csv_allows_distinct_lots_other_purposes_keep_duplicate_guard(self):
        self.create_source();text='ID;Кількість;Ціна;Партія;Придатний до\n'+self.p.path.split('/')[1]+';1;12.3456;A;\n'+self.p.path.split('/')[1]+';2;13;B;\n'
        url='/api/erp/import-preview';response=self.client.post(url,{'csv':text,'purpose':'receipt'},content_type='application/json',**self.headers);self.assertEqual(response.status_code,200,response.content);self.assertEqual(response.json()['lines'][0]['price'],'12.3456')
        for purpose in ('legacy','inventory','sale'):
            self.assertEqual(self.client.post(url,{'csv':text,'purpose':purpose},content_type='application/json',**self.headers).status_code,400)
        self.assertEqual(self.client.post(url,{'csv':text.replace(';B;',';A;'),'purpose':'receipt'},content_type='application/json',**self.headers).status_code,400)
    def test_concurrent_exact_repeats_create_one_operation(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL ledger serialization')
        self.create_source();body=self.reviewed();from concurrent.futures import ThreadPoolExecutor
        cookies=self.client.cookies.copy();headers=self.headers.copy();url=self.url('commit')
        def run():
            close_old_connections();client=Client();client.cookies=cookies.copy()
            try:r=client.post(url,body,content_type='application/json',**headers);return r.status_code,r.json()
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:responses=list(pool.map(lambda _:run(),range(2)))
        self.assertEqual([r[0] for r in responses],[200,200]);self.assertEqual(responses[0][1],responses[1][1]);self.assertEqual(Document.objects.filter(pk='import_runs/'+body['idempotencyKey']).count(),1)
    def test_real_ledger_wait_refreshes_revoked_role_before_comparison_or_receipt(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL lock wait')
        self.create_source();body=self.reviewed();from threading import Event
        from concurrent.futures import ThreadPoolExecutor
        from django.db import transaction
        waiting=Event();cookies=self.client.cookies.copy();headers=self.headers.copy();url=self.url('commit');before=AuditEvent.objects.count()
        def run():
            close_old_connections();client=Client();client.cookies=cookies.copy()
            def trace(execute,sql,params,many,context):
                if 'erp_ledgerlock' in sql and 'FOR UPDATE' in sql:waiting.set()
                return execute(sql,params,many,context)
            try:
                with connection.execute_wrapper(trace):r=client.post(url,body,content_type='application/json',**headers)
                return r.status_code
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with transaction.atomic():
                ledger_lock();future=pool.submit(run);self.assertTrue(waiting.wait(5));Profile.objects.filter(user=self.user).update(role='cashier')
            self.assertEqual(future.result(timeout=10),403)
        self.assertEqual(AuditEvent.objects.count(),before);self.assertFalse(Document.objects.filter(pk='import_runs/'+body['idempotencyKey']).exists())
    def test_price_history_observes_selected_batch_once_before_and_once_after(self):
        self.create_source();from server.erp.models import VoucherLine
        other=self.product('Інший товар');VoucherLine.objects.create(voucher=self.source,product=other,name='Інший товар',unit='шт',quantity=1,price=2,amount=2)
        self.source.total+=2;self.source.save(update_fields=['total'])
        body=self.body(bound=False);current=self.client.get(self.url()).json();product=next(p for p in current['products'] if p['id']==other.path.split('/')[1]);body['entries'].append({'id':product['id'],'revision':product['revision'],'sourceLine':None,'values':{'cost':'15','markup':'30','manualPrice':False,'price':None,'priceReviewed':False}})
        frozen=self.reviewed(body);from server.erp.promotion_history import observe_prices
        with patch('server.erp.promotion_history.observe_prices',wraps=observe_prices) as observe:
            response=self.post('commit',frozen);self.assertEqual(response.status_code,200,response.content)
        self.assertEqual(observe.call_count,2);self.assertEqual([len(call.args[1]) for call in observe.call_args_list],[2,2]);self.assertEqual(response.json()['counts']['updated'],2)
    def test_current_authorization_precedes_changed_or_foreign_receipt_collision(self):
        self.create_source();body=self.reviewed();self.assertEqual(self.post('commit',body).status_code,200);before=AuditEvent.objects.count()
        changed=copy.deepcopy(body);changed['reason']='Змінений зміст';absent={**changed,'idempotencyKey':str(uuid.uuid4())}
        for update in ({'role':'cashier'},{'role':'owner','store_id':self.other.pk}):
            Profile.objects.filter(user=self.user).update(**update)
            for request in (body,changed,absent):self.assertEqual(self.post('commit',request).status_code,403)
            self.assertEqual(self.client.get(self.url('results/'+str(uuid.uuid4()))).status_code,403)
        self.assertEqual(AuditEvent.objects.count(),before)
    def test_historical_oversized_source_fetch_is_bounded_before_rejection(self):
        self.create_source();from server.erp.models import VoucherLine
        VoucherLine.objects.bulk_create([VoucherLine(voucher=self.source,product=self.p,name='QA',unit='шт',quantity=1,price=1,amount=1,lot=str(i)) for i in range(220)])
        queries=[]
        def trace(execute,sql,params,many,context):
            if 'erp_voucherline' in sql and sql.startswith('SELECT'):queries.append(sql)
            return execute(sql,params,many,context)
        with connection.execute_wrapper(trace):response=self.client.get(self.url())
        self.assertEqual(response.status_code,400);self.assertTrue(any('LIMIT 201' in sql for sql in queries),queries)
    def test_source_unit_mismatch_never_implies_conversion_manual_cent_input_remains_explicit(self):
        self.create_source();self.source.lines.filter(lot='FIRST').update(unit='кг');count=AuditEvent.objects.count()
        response=self.post('preview',self.body());self.assertEqual(response.status_code,200,response.content);self.assertFalse(response.json()['valid']);self.assertIn('Одиниця рядка відрізняється',response.json()['entries'][0]['error'])
        response=self.post('preview',self.body(bound=False));self.assertEqual(response.status_code,200,response.content);self.assertTrue(response.json()['valid']);self.assertEqual(AuditEvent.objects.count(),count)
