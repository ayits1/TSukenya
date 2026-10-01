import hashlib
import time
from django.contrib.auth.models import User
from django.test import TestCase
from server.erp.models import Document, Profile, PortalSession, LedgerLock, AuditEvent

class CatalogTests(TestCase):
    def setUp(self):
        self.user = User.objects.create(username='catalog-owner')
        Profile.objects.create(user=self.user, role='owner')
        LedgerLock.objects.create(pk=1)
        token='isolated-catalog-token'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), user=self.user, csrf='catalog-csrf', expires=int(time.time())+3600)
        self.client.cookies['ts_session']=token
        self.headers={'HTTP_ORIGIN':'http://testserver','HTTP_X_CSRF_TOKEN':'catalog-csrf'}
        Document.objects.create(path='settings/main',data={'defaultMarkup':30,'rounding':.5})
        for identifier,data in [('one',{'name':'Coffee','type':'Напої','category':'Кава','cost':10,'promotion':True}),('two',{'name':'Water','type':'Напої','category':'Вода','cost':12}),('three',{'name':'Biscuit','type':'Печиво','category':'Печиво','cost':5}),('hidden',{'name':'Hidden','hidden':True})]:
            Document.objects.create(path='products/'+identifier,data=data)
    def detail(self):return self.client.get('/api/v1/catalog/products/one').json()
    def patch(self,value):return self.client.patch('/api/v1/catalog/products/one',value,content_type='application/json',**self.headers)
    def test_search_pagination_and_dependent_categories(self):
        result=self.client.get('/api/v1/catalog/products?type=Напої&limit=10').json()
        self.assertEqual(result['total'],2)
        self.assertEqual(set(result['facets']['category']),{'Кава','Вода'})
        self.assertEqual(self.client.get('/api/v1/catalog/products?q=Coffee&promotion=yes').json()['total'],1)
        self.assertEqual(self.client.get('/api/v1/catalog/products?q=absent').json()['items'],[])
        self.assertEqual(self.client.get('/api/v1/catalog/products?limit=999').status_code,400)
    def test_decimal_price_and_role_redaction(self):
        product=self.detail();self.assertEqual(product['salePrice'],'13.00');self.assertEqual(product['cost'],'10')
        self.user.profile.role='cashier';self.user.profile.save()
        product=self.detail();self.assertIsNone(product['cost']);self.assertIsNone(product['markup'])
        self.assertFalse(self.client.get('/api/v1/catalog/products').json()['canEdit'])
        self.assertEqual(self.patch({'revision':product['revision'],'cost':'50'}).status_code,403)
    def test_stale_revision_does_not_overwrite_and_logs_once(self):
        original=self.detail()
        result=self.patch({'revision':original['revision'],'cost':'20.00','promotion':False})
        self.assertEqual(result.status_code,200);self.assertEqual(result.json()['salePrice'],'26.00')
        stale=self.patch({'revision':original['revision'],'cost':'30.00'})
        self.assertEqual(stale.status_code,409)
        self.assertEqual(Document.objects.get(pk='products/one').data['cost'],20)
        self.assertEqual(AuditEvent.objects.count(),1)
    def test_metadata_keeps_price_date_and_preserves_other_fields(self):
        product=Document.objects.get(pk='products/one');product.data.update(priceAt='2026-09-15',minStock=3,recipe=[]);product.save()
        result=self.patch({'revision':self.detail()['revision'],'name':'Coffee updated','cost':'10','markup':'30','manualPrice':False,'price':None})
        self.assertEqual(result.status_code,200);self.assertEqual(result.json()['priceAt'],'2026-09-15')
        self.assertEqual(Document.objects.get(pk=product.pk).data['minStock'],3)
    def test_invalid_amount_csrf_and_unknown_fields_do_not_save(self):
        rev=self.detail()['revision']
        for value in [{'cost':'NaN'},{'price':'1.001'},{'hidden':True},{'promotion':'yes'}]:
            self.assertEqual(self.patch({'revision':rev,**value}).status_code,400)
        self.assertEqual(self.client.patch('/api/v1/catalog/products/one',{'revision':rev,'name':'Changed'},content_type='application/json').status_code,403)
        self.assertEqual(self.detail()['revision'],rev)
    def test_create_manual_price_and_existing_barcode(self):
        result=self.client.post('/api/v1/catalog/products',{'name':'New','manualPrice':True,'price':'19.50','barcode':'123'},content_type='application/json',**self.headers)
        self.assertEqual(result.status_code,201);self.assertEqual(result.json()['salePrice'],'19.50')
        duplicate=self.client.post('/api/v1/catalog/products',{'name':'Duplicate','barcode':'123'},content_type='application/json',**self.headers)
        self.assertEqual(duplicate.status_code,400)
    def test_unauthenticated_and_methods(self):
        self.assertEqual(self.client.delete('/api/v1/catalog/products/one',{'revision':'stale'},content_type='application/json',**self.headers).status_code,409)
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/v1/catalog/products').status_code,401)

    def test_legacy_import_honors_product_version(self):
        old=self.detail()['revision']
        self.patch({'revision':old,'promotion':False})
        result=self.client.patch('/api/docs/products/one',{'cost':99},content_type='application/json',HTTP_IF_MATCH=old,**self.headers)
        self.assertEqual(result.status_code,409)
        self.assertEqual(Document.objects.get(pk='products/one').data['cost'],10)
    def test_delete_is_versioned_and_audited(self):
        result=self.client.delete('/api/v1/catalog/products/one',{'revision':self.detail()['revision']},content_type='application/json',**self.headers)
        self.assertEqual(result.status_code,200)
        self.assertFalse(Document.objects.filter(pk='products/one').exists())
        self.assertEqual(AuditEvent.objects.last().subject,'products/one')

    def test_pricing_settings_change_invalidates_open_editor(self):
        old=self.detail()['revision']
        settings=Document.objects.get(pk='settings/main');settings.data['defaultMarkup']=40;settings.save()
        result=self.patch({'revision':old,'name':'Stale edit','markup':'30'})
        self.assertEqual(result.status_code,409)
        self.assertEqual(self.detail()['salePrice'],'14.00')

    def test_manual_promotion_retains_regular_and_disabling_restores_it(self):
        result=self.patch({'revision':self.detail()['revision'],'manualPrice':True,'price':'21.99','promotionPrice':'17.50','promotion':True})
        self.assertEqual(result.status_code,200)
        product=result.json()
        self.assertEqual((product['regularPrice'],product['promotionPrice'],product['salePrice']),('21.99','17.50','17.50'))
        self.assertEqual(product['price'],'21.99')
        result=self.patch({'revision':product['revision'],'promotion':False})
        self.assertEqual(result.status_code,200)
        self.assertEqual((result.json()['regularPrice'],result.json()['promotionPrice'],result.json()['salePrice']),('21.99','17.50','21.99'))
        self.assertEqual(Document.objects.get(pk='products/one').data['price'],21.99)

    def test_calculated_promotion_uses_server_rounding_and_price_date(self):
        doc=Document.objects.get(pk='products/one');doc.data.update(priceAt='2020-01-01',promotion=False);doc.save()
        result=self.patch({'revision':self.detail()['revision'],'promotion':True,'promotionPrice':'12.01'})
        self.assertEqual(result.status_code,200)
        self.assertEqual((result.json()['regularPrice'],result.json()['salePrice']),('13.00','12.01'))
        from django.utils import timezone
        self.assertEqual(result.json()['priceAt'],timezone.localdate().isoformat())
        doc.refresh_from_db();doc.data['priceAt']='2020-01-01';doc.save()
        result=self.patch({'revision':self.detail()['revision'],'promotionPrice':'11.99'})
        self.assertEqual(result.status_code,200);self.assertEqual(result.json()['priceAt'],timezone.localdate().isoformat())
        result=self.patch({'revision':result.json()['revision'],'name':'New name'})
        self.assertEqual(result.status_code,200);self.assertEqual(result.json()['salePrice'],'11.99')

    def test_legacy_badge_is_not_given_an_invented_regular_price(self):
        product=self.detail()
        self.assertEqual(product['regularPrice'],'13.00');self.assertIsNone(product['promotionPrice']);self.assertEqual(product['salePrice'],'13.00')
        self.assertEqual(self.patch({'revision':product['revision'],'promotion':True,'promotionPrice':None,'name':'Metadata only'}).status_code,200)
        rev=self.detail()['revision']
        self.assertEqual(self.patch({'revision':rev,'cost':'11'}).status_code,400)
        self.assertEqual(self.patch({'revision':rev,'promotionPrice':None,'priceReviewed':True}).status_code,200)
        create=self.client.post('/api/v1/catalog/products',{'name':'New promotion','manualPrice':True,'price':'20','promotion':True},content_type='application/json',**self.headers)
        self.assertEqual(create.status_code,400)
        self.assertEqual(self.patch({'revision':self.detail()['revision'],'promotion':False}).status_code,200)
        self.assertEqual(self.patch({'revision':self.detail()['revision'],'promotion':True}).status_code,400)

    def test_invalid_discount_is_atomic_and_checked_when_regular_price_changes(self):
        rev=self.detail()['revision']
        for amount in ['0','-1','13','14','NaN','11.999']:
            self.assertEqual(self.patch({'revision':rev,'promotionPrice':amount}).status_code,400,amount)
        self.assertEqual(self.detail()['revision'],rev);self.assertEqual(AuditEvent.objects.count(),0)
        current=self.patch({'revision':rev,'promotionPrice':'12'}).json()
        self.assertEqual(self.patch({'revision':current['revision'],'manualPrice':True,'price':'10'}).status_code,400)
        self.assertEqual(self.detail()['salePrice'],'12.00')
        self.assertEqual(self.patch({'revision':current['revision'],'manualPrice':True,'price':'10','promotion':False}).status_code,200)
        self.assertEqual(self.detail()['salePrice'],'10.00')

    def test_cashier_public_prices_and_legacy_state_do_not_leak_cost(self):
        self.assertEqual(self.patch({'revision':self.detail()['revision'],'promotionPrice':'9.99'}).status_code,200)
        self.user.profile.role='cashier';self.user.profile.save()
        current=self.detail();self.assertEqual(current['regularPrice'],'13.00');self.assertEqual(current['salePrice'],'9.99');self.assertEqual(current['promotionPrice'],'9.99')
        self.assertIsNone(current['cost']);self.assertIsNone(current['markup'])
        state=self.client.get('/api/state').json()['data']
        # Legacy trading adapters receive the regular and discounted prices separately.
        product=next(item['data'] for item in state['products'] if item['id']=='one')
        self.assertEqual(product['regularPrice'],13);self.assertEqual(product['price'],13);self.assertEqual(product['promotionPrice'],9.99)
        self.assertNotIn('cost',product);self.assertNotIn('markup',product)

    def test_legacy_import_accepts_badge_only_and_validates_explicit_discount(self):
        path='/api/docs/products/one'
        self.assertEqual(self.client.patch(path,{'promotion':True,'cost':11},content_type='application/json',**self.headers).status_code,200)
        self.assertEqual(self.detail()['regularPrice'],'14.50');self.assertIsNone(self.detail()['promotionPrice'])
        for amount in [0,14.5,15,'NaN']:
            self.assertEqual(self.client.patch(path,{'promotionPrice':amount},content_type='application/json',**self.headers).status_code,400)
        self.assertEqual(self.client.patch(path,{'promotionPrice':12.99},content_type='application/json',**self.headers).status_code,200)
        self.assertEqual(self.detail()['salePrice'],'12.99')
        from django.utils import timezone
        self.assertEqual(self.detail()['priceAt'],timezone.localdate().isoformat())
        self.assertEqual(self.client.patch(path,{'promotion':False},content_type='application/json',**self.headers).status_code,200)
        self.assertEqual(self.detail()['salePrice'],'14.50')

from django.test import TransactionTestCase, Client
from django.db import connection, connections, close_old_connections
from concurrent.futures import ThreadPoolExecutor

class CatalogConcurrencyTests(TransactionTestCase):
    def setUp(self):
        CatalogTests.setUp(self)
    def test_parallel_edits_accept_one_revision_once(self):
        if connection.vendor != 'postgresql':self.skipTest('Requires PostgreSQL row locks.')
        current=self.client.get('/api/v1/catalog/products/one').json()
        def update(amount):
            close_old_connections()
            try:
                client=Client();client.cookies['ts_session']='isolated-catalog-token'
                result=client.patch('/api/v1/catalog/products/one',{'revision':current['revision'],'cost':amount,'promotion':False},content_type='application/json',**self.headers)
                return result.status_code
            finally:connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:statuses=list(pool.map(update,['20.00','30.00']))
        self.assertCountEqual(statuses,[200,409]);self.assertEqual(AuditEvent.objects.count(),1)
