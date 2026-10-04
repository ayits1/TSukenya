"""Versioned legacy edits do not bypass create receipts, financial scope or task lifecycle."""
import hashlib,time
from django.contrib.auth.models import User
from django.test import TransactionTestCase
from server.erp.models import Document,Profile,Store,PortalSession,LedgerLock,AuditEvent
from server.erp.managed_alerts import task_revision
class LegacyRecordTests(TransactionTestCase):
 def setUp(self):
  LedgerLock.objects.create(pk=1);self.store=Store.objects.create(name='QA store');self.foreign=Store.objects.create(name='QA foreign')
  self.user=User.objects.create(username='record-owner');Profile.objects.create(user=self.user,role='owner')
  PortalSession.objects.create(token_hash=hashlib.sha256(b'legacy-record').hexdigest(),user=self.user,csrf='record-csrf',expires=int(time.time())+3600)
  self.client.cookies['ts_session']='legacy-record';self.headers={'HTTP_ORIGIN':'http://testserver','HTTP_X_CSRF_TOKEN':'record-csrf'}
 def doc(self,col):return Document.objects.create(path=col+'/record',data={'tasks':{'title':'Task','scope':'operations','store':self.store.pk,'status':'todo','custom':'preserve'},'ideas':{'title':'Idea','text':'Original','reaction':None,'custom':'preserve'},'expenses':{'name':'Expense','group':'fixed','amount':21.99,'category':'Інше','custom':'preserve'}}[col])
 def mutate(self,doc,patch,revision=None,method='patch'):
  return getattr(self.client,method)('/api/docs/'+doc.pk,patch or {},content_type='application/json',**self.headers,**({'HTTP_IF_MATCH':revision} if revision else {}))
 def test_each_resource_required_stale_whitelist_and_preserved_unrelated_metadata(self):
  for col,patch in [('tasks',{'status':'doing'}),('ideas',{'reaction':'yes'}),('expenses',{'amount':'22.01'})]:
   d=self.doc(col);old=task_revision(d);self.assertEqual(self.mutate(d,patch).status_code,428)
   d.data={**d.data,'custom':'server-change'};d.save();self.assertEqual(self.mutate(d,patch,old).status_code,409)
   self.assertEqual(self.mutate(d,{'unknown':1},task_revision(d)).status_code,400)
   read=self.client.get('/api/v1/portal/records/'+d.pk);self.assertEqual(read.status_code,200);fresh=read.json();self.assertEqual(fresh['revision'],task_revision(d))
   self.assertEqual(self.mutate(d,patch,fresh['revision']).status_code,200);d.refresh_from_db();self.assertEqual(d.data['custom'],'server-change')
   self.assertEqual(AuditEvent.objects.filter(subject=d.pk).count(),1)
 def test_delete_stale_and_observed_put_do_not_resurrect_missing(self):
  d=self.doc('ideas');revision=task_revision(d);d.data['text']='Server';d.save()
  self.assertEqual(self.mutate(d,None,revision,'delete').status_code,409)
  self.assertEqual(self.mutate(d,None,task_revision(d),'delete').status_code,200)
  self.assertEqual(self.mutate(d,{'title':'Resurrect'},revision,'put').status_code,409)
  self.assertEqual(self.mutate(d,{'reaction':'yes'},revision).status_code,409)
  self.assertFalse(Document.objects.filter(pk=d.pk).exists())
 def test_create_receipt_exact_replay_unaffected(self):
  value={'title':'Created','text':'Idea','reaction':None};headers={**self.headers,'HTTP_IDEMPOTENCY_KEY':'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'}
  first=self.client.post('/api/ideas',value,content_type='application/json',**headers)
  second=self.client.post('/api/ideas',value,content_type='application/json',**headers)
  self.assertEqual((first.status_code,second.status_code),(200,200));self.assertEqual(first.json()['id'],second.json()['id']);self.assertEqual(Document.objects.filter(path__startswith='ideas/').count(),1)
 def test_current_scope_before_revision_and_read_does_not_write(self):
  t=self.doc('tasks');e=self.doc('expenses');self.user.profile.role='manager';self.user.profile.store=self.foreign;self.user.profile.save()
  self.assertEqual(self.mutate(t,{'status':'doing'},'stale').status_code,403)
  self.assertEqual(self.client.get('/api/v1/portal/records/'+t.pk).status_code,403)
  self.user.profile.role='owner';self.user.profile.save()
  self.assertEqual(self.client.get('/api/v1/portal/records/'+e.pk).status_code,403)
  self.assertEqual(self.mutate(e,{'amount':'99.00'},task_revision(e)).status_code,403)
  self.assertFalse(AuditEvent.objects.exists())
 def test_managed_read_is_not_generic_edit_and_expense_decimal_rejects_bad_input(self):
  d=Document.objects.create(path='tasks/auto_'+'a'*32,data={'title':'Alert','scope':'operations','status':'todo','_alertKey':'expiry:x','_alertActive':True})
  r=self.client.get('/api/v1/portal/records/'+d.pk).json();self.assertTrue(r['managed']);self.assertFalse(r['permissions']['canEdit']);self.assertEqual(self.mutate(d,None,task_revision(d),'delete').status_code,400)
  e=self.doc('expenses');self.assertEqual(self.client.get('/api/v1/portal/records/'+e.pk).json()['data']['amount'],'21.99')
  for amount in ['22.001','NaN','-1.00','100000000.00']:
   self.assertEqual(self.mutate(e,{'amount':amount},task_revision(e)).status_code,400)
  self.assertFalse(AuditEvent.objects.exists())

 def test_concurrent_original_revision_can_save_only_once(self):
  from concurrent.futures import ThreadPoolExecutor
  from threading import Barrier
  from django.db import connection,close_old_connections,connections
  from django.test import Client
  if connection.vendor!='postgresql':self.skipTest('PostgreSQL ledger serialization proof')
  d=self.doc('ideas');revision=task_revision(d);barrier=Barrier(2)
  def save(reaction):
   close_old_connections();client=Client();client.cookies['ts_session']='legacy-record';barrier.wait()
   try:return client.patch('/api/docs/'+d.pk,{'reaction':reaction},content_type='application/json',**self.headers,HTTP_IF_MATCH=revision).status_code
   finally:connections.close_all()
  with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(save,['yes','no']))
  self.assertEqual(sorted(results),[200,409]);d.refresh_from_db();self.assertIn(d.data['reaction'],['yes','no']);self.assertEqual(AuditEvent.objects.filter(subject=d.pk).count(),1)
