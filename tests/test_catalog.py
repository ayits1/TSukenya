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
    def detail(self,identifier='one'):return self.client.get('/api/v1/catalog/products/'+identifier).json()
    def patch(self,value,identifier='one'):return self.client.patch('/api/v1/catalog/products/'+identifier,value,content_type='application/json',**self.headers)
    def legacy(self,method,value=None,identifier='one',version=None):
        # The browser runtime sends the product revision from /api/state as If-Match.
        version=self.detail(identifier)['revision'] if version is None else version
        extra={'HTTP_IF_MATCH':version} if version else {}
        return getattr(self.client,method)('/api/docs/products/'+identifier,value if value is not None else {},content_type='application/json',**extra,**self.headers)
    def test_search_pagination_and_dependent_categories(self):
        result=self.client.get('/api/v1/catalog/products?type=Напої&limit=10').json()
        self.assertEqual(result['total'],2)
        self.assertEqual(set(result['facets']['category']),{'Кава','Вода'})
        self.assertEqual(self.client.get('/api/v1/catalog/products?q=Coffee&promotion=yes').json()['total'],0)
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
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),1)
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

    def test_legacy_writes_follow_badge_and_explicit_discount_rules(self):
        # Same rules as the v1 editor: a badge-only record keeps metadata edits, price changes need a discount.
        self.assertEqual(self.legacy('patch',{'promotion':True,'cost':11}).status_code,400)
        self.assertEqual(self.legacy('patch',{'name':'Coffee beans','promotion':True}).status_code,200)
        self.assertEqual(self.detail()['regularPrice'],'13.00');self.assertIsNone(self.detail()['promotionPrice'])
        for amount in [0,13,15,'NaN']:
            self.assertEqual(self.legacy('patch',{'promotionPrice':amount}).status_code,400)
        self.assertEqual(self.legacy('patch',{'promotionPrice':12.99}).status_code,200)
        self.assertEqual(self.detail()['salePrice'],'12.99')
        from django.utils import timezone
        self.assertEqual(self.detail()['priceAt'],timezone.localdate().isoformat())
        self.assertEqual(self.legacy('patch',{'cost':11}).status_code,200)
        self.assertEqual((self.detail()['regularPrice'],self.detail()['salePrice']),('14.50','12.99'))
        self.assertEqual(self.legacy('patch',{'promotion':False}).status_code,200)
        self.assertEqual(self.detail()['salePrice'],'14.50')
        self.assertEqual(Document.objects.get(pk='products/one').data['name'],'Coffee beans')

    def test_legacy_product_writes_require_current_revision(self):
        original=self.detail('two')
        for method in ('patch','delete'):
            result=self.legacy(method,{'cost':11} if method=='patch' else None,'two',version='')
            self.assertEqual(result.status_code,428);self.assertEqual(result.json()['code'],'revision_required')
        self.assertEqual(self.patch({'revision':original['revision'],'cost':'20'},'two').status_code,200)
        stale=self.legacy('patch',{'cost':11},'two',version=original['revision'])
        self.assertEqual(stale.status_code,409);self.assertEqual(stale.json()['code'],'revision_conflict')
        replaced=self.legacy('put',{'name':'Water'},'two')
        self.assertEqual(replaced.status_code,409);self.assertEqual(replaced.json()['code'],'product_exists')
        self.assertEqual(Document.objects.get(pk='products/two').data['cost'],20)
        self.assertEqual(Document.objects.get(pk='products/two').data['category'],'Вода')
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),1)
        self.assertEqual(self.legacy('delete',None,'two').status_code,200)
        self.assertFalse(Document.objects.filter(pk='products/two').exists())

    def test_legacy_product_writes_use_the_editor_validator(self):
        before=Document.objects.get(pk='products/two').data
        for value in [{'cost':'abc'},{'cost':-10},{'cost':True},{'manualPrice':True,'price':-5},{'manualPrice':'no','price':7},
                      {'markup':None},{'manualPrice':True,'price':12.345},{'manualPrice':True,'price':None},
                      {'priceAt':'20261001'},{'priceAt':'2999-01-01'},{'name':''},{'hidden':True},{'recipe':[]},{'barcode':5}]:
            with self.subTest(value=value):
                self.assertEqual(self.legacy('patch',value,'two').status_code,400)
        self.assertEqual(Document.objects.get(pk='products/two').data,before);self.assertEqual(AuditEvent.objects.count(),0)
        from django.utils import timezone
        result=self.legacy('patch',{'cost':20},'two')
        self.assertEqual(result.status_code,200);self.assertEqual(self.detail('two')['regularPrice'],'26.00')
        self.assertEqual(self.detail('two')['priceAt'],timezone.localdate().isoformat())
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),1)

    def test_legacy_patch_changes_only_sent_keys_and_null_text_means_empty(self):
        doc=Document.objects.get(pk='products/two');doc.data.update(pack='Пляшка',size='0,5 л',recipe=[],minStock=2,priceAt='2026-09-01');doc.save()
        result=self.legacy('patch',{'pack':None,'size':None,'type':None,'priceAt':None},'two')
        self.assertEqual(result.status_code,200)
        data=Document.objects.get(pk='products/two').data
        self.assertEqual((data['pack'],data['size'],data['type'],data['priceAt']),('','','',''))
        self.assertEqual((data['category'],data['cost'],data['minStock'],data['recipe']),('Вода',12,2,[]))

    def test_legacy_create_validates_and_keeps_portal_payloads(self):
        from django.utils import timezone
        today=timezone.localdate().isoformat()
        # The fallback editor and quick form send numbers and null text fields.
        portal={'barcode':'','minStock':0,'name':'Lemonade','type':'Напої','category':'','pack':None,'size':None,'unit':'шт','cost':8,'markup':30,'manualPrice':False,'price':None,'priceAt':today,'promotion':False,'promotionPrice':None}
        created=self.client.post('/api/products',portal,content_type='application/json',**self.headers)
        self.assertEqual(created.status_code,200)
        self.assertEqual(self.detail(created.json()['id'])['regularPrice'],'10.50')
        fixture={'name':'Seeded','type':'Напої','category':'Контроль','pack':'Штучно','unit':'шт','cost':0,'markup':30,'manualPrice':True,'promotion':False,'price':45,'priceAt':today}
        self.assertEqual(self.client.put('/api/docs/products/seeded',fixture,content_type='application/json',**self.headers).status_code,200)
        self.assertEqual(self.detail('seeded')['salePrice'],'45.00')
        for value in [{**portal,'name':'Bad','manualPrice':True,'price':-5},{**portal,'name':'Bad','promotion':True},{**portal,'name':'Bad','example':True}]:
            self.assertEqual(self.client.post('/api/products',value,content_type='application/json',**self.headers).status_code,400)
        self.assertFalse(Document.objects.filter(data__name='Bad').exists())

    def create(self,value):return self.client.post('/api/v1/catalog/products',value,content_type='application/json',**self.headers)

    def test_create_and_rename_reject_names_the_import_cannot_match(self):
        self.assertEqual(self.create({'name':'Cake'}).status_code,201)
        for name in ['Cake','  coffee ','COFFEE','water','Hidden',' cake\t','BISCUIT  ']:
            with self.subTest(name=name):
                result=self.create({'name':name})
                self.assertEqual(result.status_code,409);self.assertEqual(result.json()['code'],'duplicate_name')
        self.assertEqual(Document.objects.filter(data__name='Cake').count(),1)
        renamed=self.patch({'revision':self.detail('two')['revision'],'name':' Coffee'},'two')
        self.assertEqual(renamed.status_code,409);self.assertEqual(renamed.json()['code'],'duplicate_name')
        self.assertEqual(self.client.post('/api/products',{'name':'cake'},content_type='application/json',**self.headers).status_code,409)
        self.assertEqual(self.legacy('patch',{'name':'CAKE'},'two').status_code,409)
        self.assertEqual(Document.objects.get(pk='products/two').data['name'],'Water')
        preview=self.client.post('/api/v1/catalog/import/preview',{'entries':[{'line':2,'values':{'name':'cake','cost':'5'}}]},content_type='application/json',**self.headers).json()
        self.assertTrue(preview['valid']);self.assertEqual(preview['entries'][0]['action'],'update')
        Document.objects.create(path='products/numeric',data={'name':'123'})
        self.assertEqual(self.create({'name':' 123 '}).status_code,409)
        # Spelling changes of the same name and different names remain allowed.
        self.assertEqual(self.patch({'revision':self.detail()['revision'],'name':'coffee'}).status_code,200)
        self.assertEqual(self.create({'name':'Coffee cake'}).status_code,201)

    def test_existing_duplicate_names_stay_editable(self):
        Document.objects.create(path='products/copy',data={'name':' coffee ','cost':10})
        self.assertEqual(self.patch({'revision':self.detail('copy')['revision'],'barcode':'482'},'copy').status_code,200)
        self.assertEqual(self.patch({'revision':self.detail()['revision'],'name':'Coffee','cost':'11','promotion':False}).status_code,200)
        self.assertEqual(self.legacy('patch',{'minStock':2},'copy').status_code,200)
        self.assertEqual(self.patch({'revision':self.detail('copy')['revision'],'name':'Coffee 2'},'copy').status_code,200)

    def test_price_date_is_canonical_iso_or_empty(self):
        for value in ['20261001','2026-W40-4','2026-274','2026-1-1','2026-02-30','٢٠٢٦-٠٩-٠١',' 2026-09-01']:
            with self.subTest(value=value):
                self.assertEqual(self.patch({'revision':self.detail()['revision'],'priceAt':value}).status_code,400)
        self.assertEqual(self.patch({'revision':self.detail()['revision'],'priceAt':'2026-09-01'}).json()['priceAt'],'2026-09-01')
        self.assertEqual(self.patch({'revision':self.detail()['revision'],'priceAt':''}).json()['priceAt'],'')
        # Older documents are exposed with one date spelling or as missing.
        for stored,shown in [('20260915','2026-09-15'),('учора',''),(20260915,'')]:
            Document.objects.filter(pk='products/two').update(data={'name':'Water','priceAt':stored})
            self.assertEqual(self.detail('two')['priceAt'],shown)

    def test_metadata_edit_is_not_blocked_by_an_older_discount(self):
        doc=Document.objects.get(pk='products/one');doc.data.update(promotionPrice=12.5,markup=30);doc.save()
        self.assertEqual(self.detail()['salePrice'],'12.50')
        settings=Document.objects.get(pk='settings/main');settings.data['defaultMarkup']=20;settings.save()
        doc.data.pop('markup');doc.save()
        self.assertEqual((self.detail()['regularPrice'],self.detail()['salePrice']),('12.00','12.00'))
        rev=self.detail()['revision']
        self.assertEqual(self.patch({'revision':rev,'barcode':'4820000000001'}).status_code,200)
        rev=self.detail()['revision']
        # Changed price terms, a changed discount or a confirmed review still validate it.
        for value in [{'cost':'10.2'},{'promotionPrice':'12.4'},{'priceReviewed':True}]:
            with self.subTest(value=value):
                self.assertEqual(self.patch({'revision':rev,**value}).status_code,400)
        self.assertEqual(self.patch({'revision':rev,'promotionPrice':'11.5'}).status_code,200)
        self.assertEqual(self.detail()['salePrice'],'11.50')

    def test_contract_documents_product_statuses_and_request_formats(self):
        import json,re
        from django.conf import settings
        spec=json.loads((settings.BASE_DIR/'contracts/catalog.openapi.json').read_text())
        item=spec['paths']['/api/v1/catalog/products/{id}'];collection=spec['paths']['/api/v1/catalog/products']
        rev=self.detail()['revision']
        Document.objects.create(path='products/used',data={'name':'Cake','recipe':[{'product':'three','quantity':1}]})
        observed=[('patch',self.patch({'revision':'x'},'missing').status_code),('patch',self.patch({'revision':rev,'name':'Water'}).status_code),
                  ('delete',self.client.delete('/api/v1/catalog/products/missing',{'revision':'x'},content_type='application/json',**self.headers).status_code),
                  ('delete',self.client.delete('/api/v1/catalog/products/three',{'revision':self.detail('three')['revision']},content_type='application/json',**self.headers).status_code),
                  ('delete',self.client.delete('/api/v1/catalog/products/one',{'revision':'stale'},content_type='application/json',**self.headers).status_code)]
        self.assertEqual([status for _,status in observed],[404,409,404,400,409])
        self.user.profile.role='cashier';self.user.profile.save()
        observed.append(('delete',self.client.delete('/api/v1/catalog/products/one',{'revision':rev},content_type='application/json',**self.headers).status_code))
        self.assertEqual(observed[-1][1],403)
        for method,status in observed:
            response=item[method]['responses'].get(str(status))
            self.assertIsNotNone(response,(method,status))
            self.assertEqual(response['content']['application/json']['schema'],{'$ref':'#/components/schemas/Error'})
        self.assertIn('409',collection['post']['responses'])
        schemas=spec['components']['schemas']
        for name in ('ProductCreate','ProductPatch'):
            for key in ('cost','markup','price','minStock','promotionPrice'):
                field=schemas[name]['properties'][key];pattern=(field.get('oneOf') or [field])[0]['pattern']
                self.assertIsNone(re.search(pattern,'-1'),(name,key));self.assertIsNotNone(re.search(pattern,'12.50'))
            pattern=schemas[name]['properties']['priceAt']['pattern']
            self.assertIsNotNone(re.search(pattern,''));self.assertIsNone(re.search(pattern,'20261001'))
        self.assertEqual(schemas['Product']['properties']['priceAt']['pattern'],schemas['ProductPatch']['properties']['priceAt']['pattern'])

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
        self.assertCountEqual(statuses,[200,409]);self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),1)
