import hashlib
import time
from unittest.mock import patch
from django.contrib.auth.models import User
from django.db import connection
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import Document, Profile, PortalSession, LedgerLock, AuditEvent, Store
from server.erp.budget_template import revision
from server.erp.labels import revision as label_revision

class BudgetTemplateTests(TransactionTestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.user=User.objects.create(username='template-owner')
        self.profile=Profile.objects.create(user=self.user,role='owner')
        PortalSession.objects.create(token_hash=hashlib.sha256(b'template-token').hexdigest(),user=self.user,csrf='template-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='template-token'
        self.headers={'HTTP_ORIGIN':'http://testserver','HTTP_X_CSRF_TOKEN':'template-csrf'}
        self.data={'stores':['A','B'],'storeNames':['Label'],'private':{'keep':'original'},'tag':{'saved':'untouched'}}
        Document.objects.create(pk='settings/main',data=self.data)
    def read(self):return self.client.get('/api/v1/portal/budget-template')
    def write(self,count=3,token=None,extra=None):
        return self.client.patch('/api/v1/portal/budget-template',{'budgetStores':count,'revision':token or revision(self.data),**(extra or {})},content_type='application/json',**self.headers)
    def test_readonly_inference_and_independent_label_token(self):
        with CaptureQueriesContext(connection) as queries:r=self.read()
        self.assertEqual(r.status_code,200,r.content);self.assertEqual((r.json()['budgetStores'],r.json()['source']),(2,'legacy'))
        self.assertNotRegex(' '.join(q['sql'].lower() for q in queries),r'\b(insert|update|delete)\b')
        self.assertEqual(Document.objects.get(pk='settings/main').data,self.data)
        self.assertEqual(self.write().status_code,200)
        saved=Document.objects.get(pk='settings/main').data
        self.assertEqual(saved,{**self.data,'budgetStores':3});self.assertEqual(label_revision(saved),label_revision(self.data))
        self.assertNotEqual(revision(saved),revision(self.data));self.assertEqual(AuditEvent.objects.filter(action='budget_template_saved').count(),1)
        self.assertEqual(self.write(token=revision(saved)).status_code,200);self.assertEqual(AuditEvent.objects.filter(action='budget_template_saved').count(),1)
    def test_stale_second_conflict_and_malformed_inputs(self):
        initial=self.read().json()['revision'];self.assertEqual(self.write(4,initial).status_code,200)
        self.assertEqual(self.write(3,initial).status_code,409)
        fresh=self.read().json()['revision'];self.assertEqual(self.write(5,fresh).status_code,200);self.assertEqual(self.write(6,fresh).status_code,409)
        for value in [True,0,1001,'3',1.5,None,[],{}]:self.assertEqual(self.write(value).status_code,400)
        for token in ['bad',[],{},42]:
            r=self.client.patch('/api/v1/portal/budget-template',{'budgetStores':3,'revision':token},content_type='application/json',**self.headers);self.assertEqual(r.status_code,400)
        self.assertEqual(self.write(extra={'store':1}).status_code,400)
        self.assertEqual(self.client.patch('/api/v1/portal/budget-template',{'budgetStores':3},content_type='application/json',**self.headers).status_code,428)
    def test_legacy_bypass_put_omission_and_delete(self):
        url='/api/docs/settings/main'
        for method in ['patch','put']:
            r=getattr(self.client,method)(url,{'budgetStores':4},content_type='application/json',**self.headers);self.assertEqual(r.status_code,428)
        self.assertEqual(self.client.delete(url,**self.headers).status_code,428)
        token=self.read().json()['revision']
        r=self.client.patch(url,{'budgetStores':4},content_type='application/json',HTTP_X_BUDGET_TEMPLATE_REVISION=token,**self.headers);self.assertEqual(r.status_code,200,r.content)
        r=self.client.patch(url,{'budgetStores':5},content_type='application/json',HTTP_X_BUDGET_TEMPLATE_REVISION=token,**self.headers);self.assertEqual(r.status_code,409)
        # A replacing legacy label write cannot implicitly remove/reset the count.
        r=self.client.put(url,{'storeNames':['New']},content_type='application/json',**self.headers);self.assertEqual(r.status_code,200,r.content)
        self.assertEqual(Document.objects.get(pk='settings/main').data['budgetStores'],4)
    def test_role_scope_and_actor_changed_while_waiting(self):
        store=Store.objects.create(name='Scoped')
        for role,scope in [('owner',store),('manager',None),('accountant',None),('cashier',None),('warehouse',None)]:
            Profile.objects.filter(pk=self.profile.pk).update(role=role,store=scope)
            self.assertEqual(self.read().status_code,403);self.assertEqual(self.write().status_code,403)
        Profile.objects.filter(pk=self.profile.pk).update(role='owner',store=None)
        def revoke():Profile.objects.filter(pk=self.profile.pk).update(store=store)
        with patch('server.erp.budget_template.ledger_lock',side_effect=revoke):self.assertEqual(self.write().status_code,403)
        self.assertEqual(Document.objects.get(pk='settings/main').data,self.data);self.assertFalse(AuditEvent.objects.exists())
    def test_absent_settings_reads_default_without_create(self):
        Document.objects.all().delete();r=self.read();self.assertEqual(r.json()['budgetStores'],1);self.assertFalse(Document.objects.exists())
        self.assertEqual(self.write(7,r.json()['revision']).status_code,200);self.assertEqual(Document.objects.get(pk='settings/main').data,{'budgetStores':7})
    def test_postgres_two_observed_clients_have_one_winner(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL ledger serialization')
        from threading import Thread, Barrier
        from django.db import connections,close_old_connections
        from django.test import Client
        barrier=Barrier(2);results=[];token=self.read().json()['revision']
        def write(count):
            close_old_connections()
            try:
                client=Client();client.cookies['ts_session']='template-token'
                barrier.wait(timeout=10)
                r=client.patch('/api/v1/portal/budget-template',{'budgetStores':count,'revision':token},content_type='application/json',**self.headers)
                results.append(r.status_code)
            finally:connections.close_all()
        threads=[Thread(target=write,args=(count,)) for count in [3,4]]
        for t in threads:t.start()
        for t in threads:t.join(timeout=15)
        self.assertCountEqual(results,[200,409]);self.assertEqual(AuditEvent.objects.filter(action='budget_template_saved').count(),1)
        self.assertIn(Document.objects.get(pk='settings/main').data['budgetStores'],[3,4])
