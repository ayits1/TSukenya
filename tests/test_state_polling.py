import hashlib
import time
import json
from datetime import timedelta
from unittest.mock import patch
from django.contrib.auth.models import User
from django.db import connection, transaction
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import Document, Profile, PortalSession, Store, StateVersion, PromotionCampaign, PromotionPrice
from server.erp.promotion_prices import kyiv_day


class StatePollingTests(TransactionTestCase):
    def setUp(self):
        self.a=Store.objects.create(name='A');self.b=Store.objects.create(name='B')
        self.user=User.objects.create(username='polling')
        Profile.objects.create(user=self.user,role='cashier',store=self.a)
        PortalSession.objects.create(token_hash=hashlib.sha256(b'polling-token').hexdigest(),user=self.user,csrf='polling-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='polling-token'
        Document.objects.create(path='settings/main',data={'chainName':'Demo','defaultMarkup':30,'rounding':.5,'budgetStores':3})
        Document.objects.bulk_create([Document(path='products/p'+str(i),data={'name':'P'+str(i),'cost':10,'markup':30}) for i in range(500)])

    def get(self, token=None):return self.client.get('/api/state',**({'HTTP_IF_NONE_MATCH':token} if token else {}))
    def role(self,role,store):
        Profile.objects.filter(user=self.user).update(role=role,store=store)
    def task(self,key,store,finance=False,scope='operations'):
        return Document.objects.create(path='tasks/'+key,data={'title':key,'scope':scope,'store':store.pk if store else None,**({'_alertKey':'due:'+key} if finance else {})})

    def test_unchanged_is_cheap_no_scan_and_no_get_writes(self):
        first=self.get();self.assertEqual(first.status_code,200);token=first['ETag'];self.assertEqual(len(first.json()['data']['products']),500)
        with CaptureQueriesContext(connection) as queries:
            second=self.get(token)
        self.assertEqual(second.status_code,304);self.assertEqual(second.content,b'');self.assertEqual(second['ETag'],token)
        self.assertLessEqual(len(queries),4)
        sql=' '.join(q['sql'].lower() for q in queries)
        self.assertNotIn('erp_document',sql);self.assertNotIn('erp_promotionprice',sql)
        self.assertNotRegex(sql,r'\b(insert|update|delete)\b')

    def test_bulk_rollback_delete_and_counter_absence(self):
        before=self.get()['ETag']
        with transaction.atomic():
            Document.objects.filter(pk='products/p1').update(data={'name':'Changed','cost':15})
            self.assertNotEqual(self.get()['ETag'] if connection.vendor!='postgresql' else 'inherited-no-etag',before)
            transaction.set_rollback(True)
        self.assertEqual(self.get(before).status_code,304)
        StateVersion.objects.filter(pk='catalog').delete()
        before=self.get()['ETag']
        Document.objects.filter(pk='products/p1').delete()
        self.assertEqual(StateVersion.objects.get(pk='catalog').revision,1)
        self.assertEqual(self.get(before).status_code,200)

    def test_privacy_tasks_financial_settings_and_auth(self):
        before=self.get()['ETag']
        self.task('foreign',self.b);self.task('due',self.a,True);self.task('development',self.a,scope='development')
        Document.objects.create(path='expenses/e',data={'amount':15})
        doc=Document.objects.get(pk='settings/main');doc.data['budgetStores']=7;doc.save()
        Document.objects.create(path='import_runs/x',data={'private':'x'})
        self.assertEqual(self.get(before).status_code,304)
        own=self.task('own',self.a);self.assertEqual(self.get(before).status_code,200)
        before=self.get()['ETag'];own.data['title']='new';own.save();self.assertEqual(self.get(before).status_code,200)
        before=self.get()['ETag'];self.role('manager',self.a);changed=self.get(before)
        self.assertEqual(changed.status_code,200);self.assertEqual(changed.json()['role'],'manager')
        before=changed['ETag'];self.task('ownfinance',self.a,True);self.assertEqual(self.get(before).status_code,200)
        before=self.get()['ETag'];self.task('foreignfinance',self.b,True);self.assertEqual(self.get(before).status_code,304)
        self.role('owner',self.a);before=self.get()['ETag'];self.task('ownervis_foreignmanual',self.b)
        self.assertEqual(self.get(before).status_code,200,'preserve current owner manual task visibility')
        before=self.get()['ETag'];doc.data['budgetStores']=8;doc.save();self.assertEqual(self.get(before).status_code,304)
        self.role('owner',None);before=self.get()['ETag'];doc.data['budgetStores']=9;doc.save();self.assertEqual(self.get(before).status_code,200)
        before=self.get()['ETag'];PortalSession.objects.filter(user=self.user).update(csrf='new-csrf');self.assertEqual(self.get(before).status_code,200)
        self.user.is_active=False;self.user.save();self.assertNotEqual(self.get(before).status_code,304)

    def test_current_campaign_scope_dates_bulk_and_day_boundary(self):
        today=kyiv_day();before=self.get()['ETag']
        c=PromotionCampaign.objects.create(name='Foreign',scope='stores',starts_on=today,ends_on=today+timedelta(days=1),author=self.user)
        c.stores.add(self.b)
        PromotionPrice.objects.create(campaign=c,product_id='products/p0',price=5)
        self.assertEqual(self.get(before).status_code,304)
        c.stores.add(self.a);r=self.get(before);self.assertEqual(r.status_code,200)
        self.assertEqual(r.json()['data']['products'][0]['data']['salePrice'],'5.00')
        before=r['ETag'];PromotionPrice.objects.filter(campaign=c).update(price=4);self.assertEqual(self.get(before).status_code,200)
        before=self.get()['ETag'];c.stores.remove(self.a);self.assertEqual(self.get(before).status_code,200)
        before=self.get()['ETag'];PromotionCampaign.objects.filter(pk=c.pk).update(name='still foreign');self.assertEqual(self.get(before).status_code,304)
        c.stores.add(self.a);before=self.get()['ETag']
        with patch('server.erp.state_polling.kyiv_day',return_value=today+timedelta(days=2)):
            r=self.get(before);self.assertEqual(r.status_code,200)
            self.assertEqual(r.json()['data']['products'][0]['data']['salePrice'],'13.00')
        c.delete();self.assertEqual(self.get(before).status_code,200)

    def test_labels_references_pricing_store_and_bootstrap_paths(self):
        before=self.get()['ETag']
        Document.objects.bulk_create([Document(path='catalog_refs/g',data={'kind':'group','name':'G'})])
        response=self.get(before);self.assertEqual(response.status_code,200)
        self.assertNotEqual(response.json()['stateVersions']['references'],self.get().json()['stateVersions']['products'])
        for field,value in [('tag',{'w':50}),('chainName','Changed'),('storeNames',['A']),('staleDays',10),('defaultMarkup',40),('rounding',1)]:
            before=self.get()['ETag'];doc=Document.objects.get(pk='settings/main');doc.data[field]=value
            Document.objects.bulk_update([doc],['data'])
            self.assertEqual(self.get(before).status_code,200,field)
        before=self.get()['ETag'];Store.objects.filter(pk=self.b.pk).update(name='Hidden foreign store')
        self.assertEqual(self.get(before).status_code,304)
        Store.objects.filter(pk=self.a.pk).update(name='My renamed store');self.assertEqual(self.get(before).status_code,200)
        self.role('cashier',None);before=self.get()['ETag'];Store.objects.filter(pk=self.b.pk).update(active=False)
        self.assertEqual(self.get(before).status_code,200)
        before=self.get()['ETag'];doc=Document.objects.get(pk='settings/main');doc.data['gsUrl']='private url';doc.save()
        self.assertEqual(self.get(before).status_code,304)
        self.role('owner',self.a);before=self.get()['ETag'];doc.data['gsUrl']='changed owner url';doc.save()
        self.assertEqual(self.get(before).status_code,200)

    def test_project_links_permissions_and_no_financial_activity_token(self):
        from server.erp.models import IdeaProject, ProjectTask, PriceObservation, Setting
        self.role('owner',self.a)
        idea=Document.objects.create(path='ideas/i',data={'title':'Idea'})
        task=self.task('projecttask',self.b)
        project=IdeaProject.objects.create(idea=idea,store=self.b,title='Foreign',created_by=self.user)
        before=self.get()['ETag']
        IdeaProject.objects.filter(pk=project.pk).update(planned_budget=999,title='Private project detail')
        PriceObservation.objects.create(key='private',product_path='products/p0',store=self.b,terms={'price':'1'})
        Setting.objects.create(key='owner_password',value='synthetic-password-hash')
        self.assertEqual(self.get(before).status_code,304)
        link=ProjectTask.objects.create(project=project,document=task)
        response=self.get(before);self.assertEqual(response.status_code,200)
        item=next(i for i in response.json()['data']['tasks'] if i['id']=='projecttask')
        self.assertFalse(item['permissions']['canEdit']);self.assertNotIn('initiative',item)
        before=response['ETag'];ProjectTask.objects.filter(pk=link.pk).update(phase='Private phase')
        self.assertEqual(self.get(before).status_code,304)
        IdeaProject.objects.filter(pk=project.pk).update(store=self.a)
        response=self.get(before);self.assertEqual(response.status_code,200)
        self.assertEqual(next(i for i in response.json()['data']['tasks'] if i['id']=='projecttask')['initiative'],str(project.pk))
        before=response['ETag'];link.delete();response=self.get(before);self.assertEqual(response.status_code,200)
        self.assertTrue(next(i for i in response.json()['data']['tasks'] if i['id']=='projecttask')['permissions']['canEdit'])

    def test_pg_snapshot_and_concurrent_absent_counter(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL snapshot/concurrency')
        from concurrent.futures import ThreadPoolExecutor
        from django.db import connections
        from django.test import RequestFactory
        from server.erp.state_polling import state_response
        from server.erp.views import legacy_state
        user=User.objects.select_related('profile').get(pk=self.user.pk)
        request=RequestFactory().get('/api/state');request.portal_session=PortalSession.objects.get(user=user)
        expected=self.get()['ETag']
        def write(index):
            try:
                Document.objects.filter(pk='products/p'+str(index)).update(data={'name':'New'+str(index),'cost':20})
            finally:connections['default'].close()
        def build(user,effective_day):
            with ThreadPoolExecutor(max_workers=1) as pool:pool.submit(write,0).result(timeout=10)
            return legacy_state(user,effective_day)
        response=state_response(request,user,build)
        self.assertEqual(response['ETag'],expected,'200 validator is same snapshot as body')
        self.assertEqual(json.loads(response.content)['data']['products'][0]['data']['name'],'P0')
        self.assertEqual(self.get(expected).status_code,200)
        StateVersion.objects.filter(pk='catalog').delete()
        with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(write,[1,2]))
        self.assertEqual(StateVersion.objects.get(pk='catalog').revision,2,'absent row UPSERT cannot lose simultaneous increments')

    def test_inherited_pg_transaction_keeps_legacy_without_validator(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL caller isolation')
        with transaction.atomic():
            response=self.get('"fake-validator"')
            self.assertEqual(response.status_code,200);self.assertNotIn('ETag',response)
            self.assertNotIn('stateVersions',response.json());self.assertIn('data',response.json())

    def test_strong_validator_noop_reordering_and_numeric_spelling(self):
        self.role('owner',self.a)
        first=self.get();before=first['ETag']
        doc=Document.objects.get(pk='products/p0');doc.data=dict(reversed(list(doc.data.items())));doc.save()
        same=self.get()
        self.assertEqual(same['ETag'],before);self.assertEqual(same.content,first.content,'strong validator preserves complete bytes on no-op')
        old_revision=next(i for i in same.json()['data']['products'] if i['id']=='p0')['revision']
        doc.data['cost']=10.0;doc.save()
        changed=self.get(before);self.assertEqual(changed.status_code,200)
        self.assertNotEqual(next(i for i in changed.json()['data']['products'] if i['id']=='p0')['revision'],old_revision)
        before=changed['ETag'];settings=Document.objects.get(pk='settings/main');settings.data['staleDays']=30;settings.save()
        before=self.get()['ETag'];settings.data['staleDays']=30.0;settings.save();self.assertEqual(self.get(before).status_code,200)
        self.role('manager',self.a);task=self.task('int-store',self.a);before=self.get()['ETag']
        task.data['store']=float(self.a.pk);task.save()
        response=self.get(before);self.assertEqual(response.status_code,200)
        self.assertNotIn('int-store',[i['id'] for i in response.json()['data']['tasks']])

    def test_scope_reassignment_and_expired_session_cannot_304(self):
        self.task('A',self.a);self.task('B',self.b);self.role('manager',self.a)
        before=self.get()['ETag'];self.role('manager',self.b)
        response=self.get(before);self.assertEqual(response.status_code,200)
        self.assertEqual([i['id'] for i in response.json()['data']['tasks']],['B'])
        before=response['ETag'];PortalSession.objects.filter(user=self.user).update(expires=int(time.time())-1)
        self.assertNotEqual(self.get(before).status_code,304)
