import hashlib
import time
from concurrent.futures import ThreadPoolExecutor
from django.contrib.auth.models import User
from django.db import connection, connections, close_old_connections
from django.test import TestCase, TransactionTestCase, Client
from server.erp.models import Document, Profile, PortalSession, LedgerLock, AuditEvent


def config():
    return {'size':'s','border':'dash','styleVersion':2,'chain':True,'store':True,'storeIdx':0,'name':True,'nameBig':False,'pack':True,'psize':True,'price':True,'kop':False,'unit':True,'per100':True,'category':True,'date':True,'custom':'','customEnabled':True,'promo':True,'styles':{}}


class LabelTests(TestCase):
    def setUp(self):
        self.user = User.objects.create(username='label-owner')
        Profile.objects.create(user=self.user, role='owner')
        LedgerLock.objects.create(pk=1)
        PortalSession.objects.create(token_hash=hashlib.sha256(b'isolated-label-token').hexdigest(), user=self.user, csrf='label-csrf', expires=int(time.time())+3600)
        self.client.cookies['ts_session']='isolated-label-token'
        self.headers={'HTTP_ORIGIN':'http://testserver','HTTP_X_CSRF_TOKEN':'label-csrf'}
        Document.objects.create(path='settings/main',data={'defaultMarkup':30,'rounding':.5,'chainName':'Цукерня','storeNames':['Київ'],'tag':{'size':'m','styles':{'price':{'size':22}}}})
        Document.objects.create(path='products/one',data={'name':'Кава','cost':10,'promotion':True})
        Document.objects.create(path='products/hidden',data={'name':'Прихований','hidden':True})
    def workspace(self): return self.client.get('/api/v1/labels/workspace').json()
    def patch(self, value): return self.client.patch('/api/v1/labels/workspace',value,content_type='application/json',**self.headers)
    def payload(self):
        result=self.workspace()
        return {'revision':result['revision'],'config':config(),'settings':result['settings']}
    def prepare(self, selection=None):
        return self.client.post('/api/v1/labels/prepare',{'selection':selection if selection is not None else [{'id':'one','quantity':2}]},content_type='application/json',**self.headers)
    def test_legacy_layout_read_and_scoped_versioned_save(self):
        current=self.workspace()
        self.assertEqual(current['config']['styles']['price']['size'],22)
        value=self.payload();value['config']['styles']={'price':{'size':27.5,'color':'#26624c','font':'georgia','weight':'700','align':'right'}}
        self.assertEqual(self.patch(value).status_code,200)
        saved=Document.objects.get(pk='settings/main').data
        self.assertEqual(saved['defaultMarkup'],30);self.assertEqual(saved['rounding'],.5)
        self.assertEqual(saved['tag']['styles']['price']['size'],27.5)
        self.assertEqual(AuditEvent.objects.count(),1)
        self.assertEqual(self.patch(value).status_code,409)
        self.assertEqual(AuditEvent.objects.count(),1)
    def test_external_identity_conflict_does_not_replace_draft(self):
        value=self.payload();doc=Document.objects.get(pk='settings/main');doc.data['chainName']='Інша мережа';doc.save()
        self.assertEqual(self.patch(value).status_code,409)
        self.assertEqual(self.workspace()['settings']['chainName'],'Інша мережа')
    def test_unrelated_settings_do_not_conflict_and_legacy_guard(self):
        value=self.payload();doc=Document.objects.get(pk='settings/main');doc.data['rounding']=1;doc.save()
        self.assertEqual(self.patch(value).status_code,200)
        self.assertEqual(Document.objects.get(pk='settings/main').data['rounding'],1)
        result=self.client.patch('/api/docs/settings/main',{'tag':{'size':'l'}},content_type='application/json',HTTP_IF_MATCH=value['revision'],**self.headers)
        self.assertEqual(result.status_code,409)
    def test_legacy_settings_saves_chain_from_the_returned_revision(self):
        legacy=lambda value,version:self.client.patch('/api/docs/settings/main',value,content_type='application/json',HTTP_IF_MATCH=version,**self.headers)
        first=legacy({'tag':{'size':'l'}},self.workspace()['revision'])
        self.assertEqual(first.status_code,200);self.assertEqual(first.json()['revision'],self.workspace()['revision'])
        second=legacy({'chainName':'Нова назва'},first.json()['revision'])
        self.assertEqual(second.status_code,200);self.assertEqual(second.json()['revision'],self.workspace()['revision'])
        doc=Document.objects.get(pk='settings/main');doc.data['tag']={'size':'s'};doc.save()
        conflict=legacy({'tag':{'size':'m'}},second.json()['revision'])
        self.assertEqual(conflict.status_code,409)
        self.assertEqual(conflict.json(),{'error':'Макет уже змінено. Оновіть дані перед повторним збереженням.','code':'revision_conflict'})
        self.assertEqual(Document.objects.get(pk='settings/main').data['tag'],{'size':'s'})
    def test_invalid_config_and_csrf_are_rejected(self):
        for patch in [{'styleVersion':3},{'styles':{'price':{'size':float('inf')}}},{'styles':{'unknown':{}}},{'promo':'yes'},{'size':'poster'},{'styles':{'price':{'color':'red'}}}]:
            value=self.payload();value['config'].update(patch)
            self.assertEqual(self.patch(value).status_code,400,patch)
        self.assertEqual(self.client.patch('/api/v1/labels/workspace',self.payload(),content_type='application/json').status_code,403)
        self.assertEqual(AuditEvent.objects.count(),0)
    def test_cashier_reads_and_prepares_but_cannot_edit(self):
        self.user.profile.role='cashier';self.user.profile.save()
        self.assertFalse(self.workspace()['canEdit'])
        self.assertEqual(self.patch(self.payload()).status_code,403)
        result=self.prepare();self.assertEqual(result.status_code,200)
        product=result.json()['products'][0]
        self.assertEqual(product['salePrice'],'13.00');self.assertTrue(product['promotion'])
        self.assertIsNone(product['cost']);self.assertIsNone(product['markup'])
    def test_snapshot_changes_on_price_layout_and_quantity(self):
        first=self.prepare().json()['snapshot'];self.assertEqual(first,self.prepare().json()['snapshot'])
        self.assertNotEqual(first,self.prepare([{'id':'one','quantity':3}]).json()['snapshot'])
        doc=Document.objects.get(pk='products/one');doc.data['cost']=20;doc.save()
        second=self.prepare().json();self.assertNotEqual(first,second['snapshot']);self.assertEqual(second['products'][0]['salePrice'],'26.00')
        self.patch(self.payload());self.assertNotEqual(second['snapshot'],self.prepare().json()['snapshot'])
        self.assertEqual(AuditEvent.objects.count(),1)  # preparing a label never posts money or stock
    def test_prepare_rejects_missing_hidden_duplicate_and_limit(self):
        for rows in [[{'id':'missing','quantity':1}],[{'id':'hidden','quantity':1}],[{'id':'one','quantity':True}],[{'id':'one','quantity':501}],[{'id':'one','quantity':1}]*2,[]]:
            self.assertEqual(self.prepare(rows).status_code,400,rows)
        for identifier in ['two','three']:
            Document.objects.create(path='products/'+identifier,data={'name':identifier,'cost':1})
        self.assertEqual(self.prepare([{'id':identifier,'quantity':500} for identifier in ['one','two','three']]).status_code,400)
        self.client.cookies.clear();self.assertEqual(self.client.get('/api/v1/labels/workspace').status_code,401)

    def test_print_order_uses_catalogue_groups_and_keeps_quantities(self):
        one=Document.objects.get(pk='products/one');one.data.update(type='Напої',category='Кава');one.save()
        Document.objects.create(path='products/two',data={'name':'Вода','cost':1,'type':'Напої','category':'Вода'})
        result=self.prepare([{'id':'one','quantity':2},{'id':'two','quantity':3}]).json()
        self.assertEqual([row['id'] for row in result['products']],['two','one'])
        self.assertEqual(result['selection'],[{'id':'two','quantity':3},{'id':'one','quantity':2}])

    def test_promotion_snapshot_contains_both_prices_and_tracks_discount(self):
        first=self.prepare().json()
        doc=Document.objects.get(pk='products/one');doc.data['promotionPrice']=9.99;doc.save()
        result=self.prepare().json()
        self.assertNotEqual(first['snapshot'],result['snapshot'])
        self.assertEqual((result['products'][0]['regularPrice'],result['products'][0]['promotionPrice'],result['products'][0]['salePrice']),('13.00','9.99','9.99'))
        doc.data['promotion']=False;doc.save()
        third=self.prepare().json();self.assertNotEqual(result['snapshot'],third['snapshot'])
        self.assertEqual(third['products'][0]['salePrice'],'13.00')

    def test_old_price_field_is_optional_for_legacy_v2_and_strict_when_present(self):
        value=self.payload();value['config']['oldPrice']=True;value['config']['styles']['oldPrice']={'size':9,'color':'#707070'}
        self.assertEqual(self.patch(value).status_code,200)
        self.assertTrue(self.workspace()['config']['oldPrice'])
        value=self.payload();value['config']['oldPrice']='yes'
        self.assertEqual(self.patch(value).status_code,400)

    def legacy_settings(self,value):
        return self.client.patch('/api/docs/settings/main',value,content_type='application/json',HTTP_IF_MATCH=self.workspace()['revision'],**self.headers)

    def test_legacy_stale_days_stays_decodable_by_label_studio(self):
        for days in [0,-1,3651,1.5,'30',True,None]:
            self.assertEqual(self.legacy_settings({'staleDays':days}).status_code,400,days)
        self.assertNotIn('staleDays',Document.objects.get(pk='settings/main').data)
        self.assertEqual(self.legacy_settings({'staleDays':14}).status_code,200)
        self.assertEqual(self.workspace()['settings']['staleDays'],14)
        # An older invalid term reads as the default and does not block unrelated saves.
        doc=Document.objects.get(pk='settings/main');doc.data['staleDays']=0;doc.save()
        self.assertEqual(self.workspace()['settings']['staleDays'],30)
        self.assertEqual(self.legacy_settings({'chainName':'Нова назва'}).status_code,200)
        value=self.payload();value['settings']['staleDays']=30
        self.assertEqual(self.patch(value).status_code,200)
        self.assertEqual(Document.objects.get(pk='settings/main').data['staleDays'],30)


class LabelConcurrencyTests(TransactionTestCase):
    def setUp(self): LabelTests.setUp(self)
    def test_only_one_parallel_layout_save_succeeds(self):
        if connection.vendor != 'postgresql': self.skipTest('Requires PostgreSQL row locks.')
        current=self.client.get('/api/v1/labels/workspace').json()
        def save(size):
            close_old_connections()
            try:
                client=Client();client.cookies['ts_session']='isolated-label-token'
                layout=config();layout['size']=size
                return client.patch('/api/v1/labels/workspace',{'revision':current['revision'],'config':layout,'settings':current['settings']},content_type='application/json',**self.headers).status_code
            finally: connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool: statuses=list(pool.map(save,['m','l']))
        self.assertCountEqual(statuses,[200,409]);self.assertEqual(AuditEvent.objects.count(),1)
