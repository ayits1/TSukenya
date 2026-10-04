import hashlib
import time
from django.contrib.auth.models import User
from django.db import connection
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import Document,Profile,PortalSession,Store,LedgerLock
from server.erp.portal_collections import summary

class PortalCollectionsTests(TransactionTestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1);self.a=Store.objects.create(name='A');self.b=Store.objects.create(name='B')
        self.user=User.objects.create(username='collections');self.profile=Profile.objects.create(user=self.user,role='owner')
        PortalSession.objects.create(token_hash=hashlib.sha256(b'collections-token').hexdigest(),user=self.user,csrf='csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='collections-token'
        Document.objects.create(path='settings/main',data={'chainName':'Мережа','private':'secret'})
        docs=[]
        for i in range(65):
            docs.extend([Document(path=f'tasks/t{i:03}',data={'title':f'Задача {i}','scope':'operations','status':'todo','store':self.a.pk,'order':i}),Document(path=f'ideas/i{i:03}',data={'title':f'Ідея {i}','reaction':'yes','order':i}),Document(path=f'expenses/e{i:03}',data={'name':'Оренда '+str(i),'group':'fixed','amount':1.01,'order':i})])
        Document.objects.bulk_create(docs)
    def role(self,role,store=None):
        Profile.objects.filter(pk=self.profile.pk).update(role=role,store=store);self.user.profile.refresh_from_db()
    def get(self,name,**params):return self.client.get('/api/v1/portal/collections/'+name,params)
    def test_pages_clamp_search_summary_and_whole_category_decimal(self):
        r=self.get('tasks',page='2');self.assertEqual(r.status_code,200);v=r.json();self.assertEqual((v['total'],v['page'],v['pages'],len(v['items'])),(65,2,3,30));self.assertEqual(v['items'][0]['id'],'t030')
        self.assertEqual(self.get('tasks',page='99').json()['items'][0]['id'],'t060')
        self.assertEqual(self.get('ideas',q='Ідея 64').json()['total'],1)
        result=self.get('summary',section='budget').json();self.assertEqual(result['totals']['fixed'],'65.65');self.assertEqual(result['byCategory']['Оренда'],'65.65')
        result=self.get('summary').json();self.assertEqual(result['statuses']['todo'],65);self.assertEqual(len(result['nearest']),5)
        for bad in ('0','-1','²','1.2'):self.assertEqual(self.get('tasks',page=bad).status_code,400)
    def test_visibility_managed_permissions_and_legacy_development(self):
        Document.objects.create(path='tasks/old',data={'title':'Старий scope','scope':'unknown','stage':None})
        Document.objects.create(path='tasks/network',data={'title':'Мережа','scope':'operations'})
        Document.objects.create(path='tasks/due',data={'title':'Борг B','scope':'operations','store':self.b.pk,'_alertKey':'due:1'})
        Document.objects.create(path='tasks/auto_a',data={'title':'Умова','scope':'operations','store':self.a.pk,'_alertActive':True})
        self.assertEqual(self.get('tasks',space='development',stage='unknown').json()['total'],1)
        self.role('manager',self.a);v=self.get('tasks/network').json();self.assertEqual(v['permissions'],{'canEdit':False,'canDelete':False});self.assertEqual(self.get('tasks/auto_a').json()['permissions'],{'canEdit':True,'canDelete':False})
        self.assertEqual(self.get('tasks/due').status_code,403);self.assertEqual(self.get('tasks',space='development').status_code,403);self.assertEqual(self.get('ideas').json()['total'],0)
        self.role('owner',self.a);self.assertEqual(self.get('expenses').status_code,403);self.assertEqual(self.get('summary',section='budget').status_code,403)
        self.role('cashier',self.a);self.assertEqual(self.get('tasks/auto_a').json()['permissions']['canEdit'],False);self.assertEqual(self.get('tasks/due').status_code,403)
    def test_compact_metadata_no_collection_queries_and_legacy_compatibility(self):
        with CaptureQueriesContext(connection) as queries:r=self.client.get('/api/v1/portal/metadata')
        self.assertEqual(r.status_code,200);self.assertEqual(r.json()['contract'],'portal-metadata-v2');self.assertEqual(set(r.json()['data']),{'settings/main','project/state'})
        sql=' '.join(q['sql'].lower() for q in queries);self.assertNotIn('tasks/%',sql);self.assertNotIn('projecttask',sql);self.assertNotIn('ideaproject',sql)
        with CaptureQueriesContext(connection) as queries:unchanged=self.client.get('/api/v1/portal/metadata',HTTP_IF_NONE_MATCH=r['ETag'])
        self.assertEqual(unchanged.status_code,304);self.assertLessEqual(len(queries),4)
        self.assertEqual(len(self.client.get('/api/v1/portal/state').json()['data']['tasks']),65)
    def test_page_readonly_and_batched_links(self):
        with CaptureQueriesContext(connection) as queries:r=self.get('tasks')
        self.assertEqual(r.status_code,200)
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        self.assertLessEqual(sum('projecttask' in q['sql'].lower() for q in queries),1)

    def test_unknown_legacy_records_are_explicit_and_variable_group_parity(self):
        Document.objects.create(path='tasks/unknown',data={'title':'Невідомий','status':'legacy','scope':None,'stage':9})
        Document.objects.create(path='expenses/unknown',data={'name':'Старий сервіс','group':'legacy','amount':'2.25'})
        data=self.get('summary',section='development').json();self.assertEqual((data['total'],data['unfinished'],data['unknownStatus'],data['stages']['unknown']),(1,1,1,1))
        self.assertEqual(self.get('expenses',group='variable').json()['total'],1)
        data=self.get('summary',section='budget').json();self.assertEqual(data['totals']['variable'],'2.25');self.assertEqual(data['byCategory']['Обслуговування'],'2.25')

    def test_postgresql_page_snapshot_and_current_actor(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL RR proof')
        import threading
        from unittest.mock import patch
        from django.db import close_old_connections
        from server.erp import portal_collections as service
        original=service.items
        def inspect(user,collection,docs):
            with connection.cursor() as cursor:
                cursor.execute('SHOW transaction_isolation');self.assertEqual(cursor.fetchone()[0],'repeatable read')
                cursor.execute('SHOW transaction_read_only');self.assertEqual(cursor.fetchone()[0],'on')
            errors=[]
            def change():
                close_old_connections()
                try:Document.objects.filter(path='tasks/t000').update(data={'title':'Нова','scope':'operations','status':'done','order':0})
                except Exception as error:errors.append(error)
                finally:close_old_connections()
            thread=threading.Thread(target=change);thread.start();thread.join(5);self.assertFalse(thread.is_alive());self.assertFalse(errors)
            self.assertEqual(Document.objects.get(pk='tasks/t000').data['title'],'Задача 0')
            return original(user,collection,docs)
        with patch.object(service,'items',inspect):r=self.get('tasks')
        self.assertEqual(r.json()['items'][0]['data']['title'],'Задача 0');self.assertEqual(r.json()['total'],65)
        self.assertEqual(Document.objects.get(pk='tasks/t000').data['title'],'Нова')
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        self.assertEqual(self.get('tasks').status_code,401)
