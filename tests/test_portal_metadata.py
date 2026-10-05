import hashlib
import json
import time
from datetime import datetime,timedelta,timezone as utc
from unittest.mock import patch
from django.contrib.auth.models import User
from django.db import connection,transaction
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import Document,Profile,PortalSession,Store,LedgerLock,PromotionCampaign,PromotionPrice
from server.erp.portal_api import summary

class PortalMetadataTests(TransactionTestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.a=Store.objects.create(name='A');self.b=Store.objects.create(name='B')
        self.user=User.objects.create(username='portal')
        self.profile=Profile.objects.create(user=self.user,role='owner')
        PortalSession.objects.create(token_hash=hashlib.sha256(b'portal-token').hexdigest(),user=self.user,csrf='portal-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='portal-token'
        Document.objects.create(path='settings/main',data={'defaultMarkup':30,'rounding':.5,'staleDays':30,'private':'secret'})
        Document.objects.bulk_create([Document(path='products/p'+str(i),data={'name':'P'+str(i),'cost':10,'markup':30,'priceAt':'2026-09-01'}) for i in range(500)])
    def role(self,role,store=None):
        Profile.objects.filter(pk=self.profile.pk).update(role=role,store=store);self.user.profile.refresh_from_db()
    def test_metadata_changed_no_product_payload_scan_and_legacy_compatibility(self):
        Document.objects.create(path='import_runs/private',data={'private':'input'})
        with CaptureQueriesContext(connection) as queries:r=self.client.get('/api/v1/portal/state')
        self.assertEqual(r.status_code,200);data=r.json();self.assertNotIn('products',data['data']);self.assertEqual(data['contract'],'portal-metadata-v1')
        sql=' '.join(q['sql'].lower() for q in queries)
        self.assertNotIn('erp_promotionprice',sql);self.assertNotIn("like 'products/",sql)
        self.assertEqual(len(self.client.get('/api/state').json()['data']['products']),500)
        Document.objects.filter(pk='products/p0').update(data={'name':'changed','cost':20})
        changed=self.client.get('/api/v1/portal/state',HTTP_IF_NONE_MATCH=r['ETag']);self.assertEqual(changed.status_code,200);self.assertNotIn('products',changed.json()['data'])
        with CaptureQueriesContext(connection) as queries:unchanged=self.client.get('/api/v1/portal/state',HTTP_IF_NONE_MATCH=changed['ETag'])
        self.assertEqual(unchanged.status_code,304);self.assertLessEqual(len(queries),4)
        self.assertNotRegex(' '.join(q['sql'].lower() for q in queries),r'\b(insert|update|delete)\b')
    def test_metadata_scope_privacy_and_readonly(self):
        self.role('cashier',self.a);r=self.client.get('/api/v1/portal/state');self.assertNotIn('private',r.json()['data']['settings/main'])
        token=r['ETag'];Document.objects.create(path='expenses/e',data={'amount':40})
        Document.objects.create(path='tasks/foreign',data={'scope':'operations','store':self.b.pk,'title':'foreign'})
        self.assertEqual(self.client.get('/api/v1/portal/state',HTTP_IF_NONE_MATCH=token).status_code,304)
        self.assertEqual(self.client.get('/api/v1/portal/catalogue-model').status_code,403)
        self.role('owner',self.a);self.assertEqual(self.client.get('/api/v1/portal/catalogue-model').status_code,403)
        self.role('manager',self.a);self.assertEqual(self.client.get('/api/v1/portal/catalogue-model').status_code,403)
    def test_summary_equal_weight_decimal_legacy_promotion_and_stale_exact_boundary(self):
        Document.objects.filter(path__startswith='products/').delete()
        now=datetime(2026,10,4,0,0,tzinfo=utc.utc)
        values=[{'name':'Valid','cost':10,'manualPrice':True,'price':20,'promotion':True,'promotionPrice':'15.00','priceAt':'2026-09-04'},
                {'name':'At boundary','cost':10,'manualPrice':True,'price':20,'priceAt':'2026-09-04'},
                {'name':'No cost','cost':0,'manualPrice':True,'price':30,'priceAt':'bad'},
                {'name':'No price','cost':10,'manualPrice':True,'price':0},
                {'name':'Example','cost':10,'example':True},{'name':'Hidden example','cost':10,'example':True,'hidden':True}]
        for i,value in enumerate(values):Document.objects.create(path='products/x'+str(i),data=value)
        Document.objects.create(path='expenses/a',data={'amount':100,'group':'fixed'});Document.objects.create(path='expenses/b',data={'amount':25,'group':'variable'})
        # A lower campaign price must NOT silently change the legacy equal-weight model.
        campaign=PromotionCampaign.objects.create(name='Campaign',scope='network',starts_on=now.date(),ends_on=now.date(),author=self.user)
        PromotionPrice.objects.create(campaign=campaign,product_id='products/x0',price=1)
        with patch('server.erp.portal_api.timezone.now',return_value=now):s=summary(self.user,model=True)
        self.assertEqual((s['catalogCount'],s['exampleCount'],s['allExampleCount']),(4,1,2));self.assertEqual((s['noPriceCount'],s['stalePriceCount']),(1,1));self.assertEqual(s['coverage'],2)
        self.assertEqual(s['fixed'],'100.00');self.assertEqual(s['variable'],'25.00');self.assertEqual(s['equalWeightMargin'],'0.4166666666666666666666666666666666666666');self.assertEqual(s['basis'],'legacy_catalogue_equal_weight')
        with patch('server.erp.portal_api.timezone.now',return_value=now+timedelta(milliseconds=1)):self.assertEqual(summary(self.user)['stalePriceCount'],3)
    def test_examples_paged_hidden_revision_and_exact_cleanup_retry(self):
        for i in range(35):Document.objects.create(path='products/example'+str(i),data={'name':'Example'+str(i),'example':True,'hidden':i%2==0})
        r=self.client.get('/api/v1/portal/examples?page=2').json();self.assertEqual((r['total'],r['page'],len(r['items'])),(35,2,5))
        payload={'items':r['items'] and [{'id':p['id'],'revision':p['revision']} for p in r['items']],'idempotencyKey':'11111111-1111-4111-8111-111111111111'}
        first=self.client.post('/api/v1/portal/examples/delete',data=json.dumps(payload),content_type='application/json',HTTP_X_CSRF_TOKEN='portal-csrf',HTTP_ORIGIN='http://testserver');self.assertEqual(first.status_code,200);self.assertTrue(all(p['status']=='deleted' for p in first.json()['items']))
        again=self.client.post('/api/v1/portal/examples/delete',data=json.dumps(payload),content_type='application/json',HTTP_X_CSRF_TOKEN='portal-csrf',HTTP_ORIGIN='http://testserver');self.assertEqual(first.json(),again.json());self.assertEqual(self.client.get('/api/v1/portal/examples').json()['total'],30)
        self.role('manager',self.a);self.assertEqual(self.client.get('/api/v1/portal/examples').status_code,403)
    def test_export_role_formula_guard_snapshot_and_no_full_json(self):
        Document.objects.filter(pk='products/p0').update(data={'name':'=2+2','cost':10,'barcode':'00123'})
        r=self.client.get('/api/v1/portal/catalogue.csv');self.assertTrue(r.streaming);value=b''.join(r.streaming_content)
        self.assertEqual(len(value),int(r['Content-Length']));self.assertIn('Закупівля'.encode(),value);self.assertIn(b'\t=2+2',value);self.assertIn(b'00123',value);r.close()
        self.role('cashier',self.a);r=self.client.get('/api/v1/portal/catalogue.csv');value=b''.join(r.streaming_content);self.assertNotIn('Закупівля'.encode(),value);self.assertNotIn('Націнка'.encode(),value)
        self.assertEqual(self.client.get('/api/v1/portal/catalogue.csv?includeHidden=true').status_code,403)
    def post(self,path,payload):
        return self.client.post(path,data=json.dumps(payload),content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='portal-csrf')
    def test_full_filter_pricing_and_campaign_scope_review_recheck(self):
        from server.erp.promotion_prices import kyiv_day
        import uuid
        payload={'kind':'markup','selection':{'q':'P','type':'','category':'','pack':'','promotion':'','store':''},'markup':'40','resetManualPrices':False,'updateDefault':False}
        with CaptureQueriesContext(connection) as q:r=self.post('/api/v1/catalog/pricing/preview',payload)
        self.assertEqual(r.status_code,200);self.assertEqual(r.json()['scope']['count'],500)
        # The new preview owns READ ONLY RR. Measure its bounded data reads,
        # excluding BEGIN/SET/COMMIT, whose count differs across backends.
        reads=[item for item in q if item['sql'].lstrip().upper().startswith('SELECT')]
        self.assertLess(len(reads),20)
        self.assertFalse(any('SELECT "erp_document"."data"' in item['sql'] for item in reads))
        frozen={**payload,'snapshot':r.json()['snapshot'],'idempotencyKey':str(uuid.uuid4())}
        Document.objects.filter(pk='products/p0').update(data={'name':'P0','cost':11})
        self.assertEqual(self.post('/api/v1/catalog/pricing/commit',frozen).status_code,409)
        campaign=PromotionCampaign.objects.create(name='Own',scope='stores',starts_on=kyiv_day(),ends_on=kyiv_day(),author=self.user);campaign.stores.add(self.a)
        price=PromotionPrice.objects.create(campaign=campaign,product_id='products/p1',price=5)
        payload['selection'].update(store=str(self.a.pk),promotion='yes')
        r=self.post('/api/v1/catalog/pricing/preview',payload);self.assertEqual(r.status_code,200);self.assertEqual(r.json()['scope']['count'],1);self.assertEqual(r.json()['scope']['storeName'],'A')
        frozen={**payload,'snapshot':r.json()['snapshot'],'idempotencyKey':str(uuid.uuid4())};price.price=4;price.save()
        self.assertEqual(self.post('/api/v1/catalog/pricing/commit',frozen).status_code,409)
        r=self.post('/api/v1/catalog/pricing/preview',payload);frozen={**payload,'snapshot':r.json()['snapshot'],'idempotencyKey':str(uuid.uuid4())}
        committed=self.post('/api/v1/catalog/pricing/commit',frozen);self.assertEqual(committed.status_code,200);self.assertEqual(committed.json(),self.post('/api/v1/catalog/pricing/commit',frozen).json())
        self.assertEqual(Document.objects.get(pk='products/p1').data['markup'],40)
    def test_filter_limit_validation_and_cleanup_revision_conflict(self):
        Document.objects.bulk_create([Document(path='products/m'+str(i),data={'name':'M','cost':10}) for i in range(501)])
        payload={'kind':'markup','selection':{'q':'','type':'','category':'','pack':'','promotion':'','store':''},'markup':'40','resetManualPrices':False,'updateDefault':False}
        self.assertEqual(self.post('/api/v1/catalog/pricing/preview',payload).status_code,400)
        payload['selection']['category']=[];self.assertEqual(self.post('/api/v1/catalog/pricing/preview',payload).status_code,400)
        p=Document.objects.create(path='products/example',data={'name':'Example','example':True})
        item=self.client.get('/api/v1/portal/examples').json()['items'][0];p.data['name']='Updated';p.save()
        result=self.post('/api/v1/portal/examples/delete',{'items':[{'id':item['id'],'revision':item['revision']}],'idempotencyKey':'11111111-1111-4111-8111-111111111112'})
        self.assertEqual(result.status_code,200);self.assertEqual(result.json()['items'][0]['status'],'conflicted');self.assertTrue(Document.objects.filter(pk=p.pk).exists())
    def test_export_rechecks_role_before_preparation_and_snapshot(self):
        from server.erp.services import current_actor
        from contextlib import contextmanager
        from server.erp.historical_reports import read_snapshot
        @contextmanager
        def revoke_before_snapshot():
            # Revoke after HTTP authentication, before READ ONLY starts.
            self.role('cashier',self.a)
            with read_snapshot():yield
        def fresh_actor(cached_user):
            self.assertTrue(connection.in_atomic_block)
            self.assertEqual(cached_user.profile.role,'owner')
            actor=current_actor(cached_user)
            self.assertEqual(actor.profile.role,'cashier')
            return actor
        with patch('server.erp.catalog_export.read_snapshot',side_effect=revoke_before_snapshot),patch('server.erp.catalog_export.current_actor',side_effect=fresh_actor) as fresh:
            response=self.client.get('/api/v1/portal/catalogue.csv')
        fresh.assert_called_once()
        content=b''.join(response.streaming_content)
        self.assertNotIn('Закупівля'.encode(),content)
        self.assertNotIn('Націнка'.encode(),content)
        self.assertEqual(len(content),int(response['Content-Length']))
        response.close();self.assertFalse(connection.in_atomic_block)
    def test_postgres_export_snapshot_survives_concurrent_edit_and_close(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL RR snapshot proof')
        from concurrent.futures import ThreadPoolExecutor
        from django.db import close_old_connections
        response=self.client.get('/api/v1/portal/catalogue.csv');iterator=iter(response.streaming_content);next(iterator)
        def writer():
            close_old_connections()
            try:
                Document.objects.filter(pk='products/p499').update(data={'name':'NEW499','cost':30})
                Document.objects.create(path='products/future',data={'name':'FUTURE','cost':40})
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=1) as pool:pool.submit(writer).result(10)
        content=b''.join(iterator);self.assertIn(b'P499',content);self.assertNotIn(b'NEW499',content);self.assertNotIn(b'FUTURE',content);self.assertFalse(connection.in_atomic_block)
        response=self.client.get('/api/v1/portal/catalogue.csv');next(iter(response.streaming_content));response.close();self.assertFalse(connection.in_atomic_block)

    def test_paged_catalogue_uses_same_full_filter_helper(self):
        response=self.client.get('/api/v1/catalog/products?q=P&limit=20&page=2')
        self.assertEqual(response.status_code,200)
        value=response.json();self.assertEqual((value['total'],value['page'],len(value['items'])),(500,2,20))
        self.assertEqual(value['facets'],{'type':[],'category':[],'pack':[]})

    def test_sales_margin_uses_accounting_period_reversal_and_exact_money(self):
        from datetime import date
        from server.erp.models import Voucher
        end=date(2026,10,1)
        def voucher(kind,day,total,cost,status='posted',reversed_at=None):
            return Voucher.objects.create(kind=kind,date=day,store=self.a,created_by=self.user,total=total,cost=cost,status=status,reversed_at=reversed_at)
        voucher('sale',date(2026,9,30),'100.00','20.00')
        voucher('customer_return',date(2026,9,30),'20.00','5.00')
        # Original predates the 30-day window, cancellation in Kyiv falls within it.
        voucher('sale',date(2026,9,1),'40.00','12.00','reversed',datetime(2026,9,30,22,0,tzinfo=utc.utc))
        voucher('sale',date(2026,10,2),'1000.00','600.00')
        Document.objects.create(path='expenses/rent',data={'amount':100,'group':'fixed'})
        with patch('server.erp.promotion_prices.kyiv_day',return_value=end):response=self.client.get('/api/v1/portal/sales-margin')
        self.assertEqual(response.status_code,200);result=response.json()
        self.assertEqual((result['from'],result['to']),('2026-09-02','2026-10-01'))
        self.assertEqual((result['revenue'],result['gross'],result['dailyRevenue']),('40.00','37.00','1.33'))
        self.assertEqual((result['needDaily'],result['gapDaily'],result['reason']),('3.60','2.27','ready'))
        self.role('owner',self.a);self.assertEqual(self.client.get('/api/v1/portal/sales-margin').status_code,403)

    def test_cleanup_protected_history_and_retry_does_not_duplicate_audit(self):
        from server.erp.models import Voucher,VoucherLine,AuditEvent
        from datetime import date
        protected=Document.objects.create(path='products/example_used',data={'name':'Used example','example':True})
        free=Document.objects.create(path='products/example_free',data={'name':'Free example','example':True})
        voucher=Voucher.objects.create(kind='receipt',date=date(2026,10,1),store=self.a,created_by=self.user)
        VoucherLine.objects.create(voucher=voucher,product=protected,quantity=1,price=1,amount=1)
        items=[{'id':p['id'],'revision':p['revision']} for p in self.client.get('/api/v1/portal/examples').json()['items']]
        payload={'idempotencyKey':'11111111-1111-4111-8111-111111111113','items':items}
        first=self.post('/api/v1/portal/examples/delete',payload);self.assertEqual(first.status_code,200)
        results={p['id']:p['status'] for p in first.json()['items']}
        self.assertEqual(results,{'example_free':'deleted','example_used':'rejected'})
        count=AuditEvent.objects.count();self.assertGreater(count,0)
        self.assertEqual(first.json(),self.post('/api/v1/portal/examples/delete',payload).json());self.assertEqual(AuditEvent.objects.count(),count)
        self.assertTrue(Document.objects.filter(pk=protected.pk).exists());self.assertFalse(Document.objects.filter(pk=free.pk).exists())

    def test_summary_preserves_grandfather_legacy_read_numbers_and_nullable_stale(self):
        Document.objects.filter(path__startswith='products/').delete()
        Document.objects.create(path='products/legacy_promo',data={'name':'Legacy','manualPrice':True,'price':200000000,'cost':'10,00 old','promotion':True,'promotionPrice':'100000000.00 old','priceAt':'2026-09-04'})
        settings=Document.objects.get(pk='settings/main');settings.data['staleDays']=None;settings.save()
        now=datetime(2026,10,4,0,0,tzinfo=utc.utc)
        with patch('server.erp.portal_api.timezone.now',return_value=now):result=summary(self.user,model=True)
        self.assertEqual(result['coverage'],1);self.assertEqual(result['equalWeightMargin'],'0.9999999');self.assertEqual(result['stalePriceCount'],0)
        settings.data['staleDays']=10**20;settings.save()
        with patch('server.erp.portal_api.timezone.now',return_value=now):self.assertEqual(summary(self.user)['stalePriceCount'],0)
