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
        result=self.patch({'revision':original['revision'],'cost':'20.00'})
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
                result=client.patch('/api/v1/catalog/products/one',{'revision':current['revision'],'cost':amount},content_type='application/json',**self.headers)
                return result.status_code
            finally:connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:statuses=list(pool.map(update,['20.00','30.00']))
        self.assertCountEqual(statuses,[200,409]);self.assertEqual(AuditEvent.objects.count(),1)
