"""Recipe read guards and durable approved receipt stay authoritative; no business formula change."""
import hashlib,time,uuid
from unittest.mock import patch
from django.contrib.auth.models import User
from django.test import TransactionTestCase
from server.erp.models import Document,Profile,PortalSession,LedgerLock,RecipeVersion,AuditEvent
from server.erp.catalog import revision
class RecipeRecoveryTests(TransactionTestCase):
 def setUp(self):
  LedgerLock.objects.create(pk=1);self.user=User.objects.create(username='recipe-recovery');Profile.objects.create(user=self.user,role='owner')
  PortalSession.objects.create(user=self.user,token_hash=hashlib.sha256(b'recipe-recovery').hexdigest(),csrf='qa-csrf',expires=int(time.time())+3600)
  self.client.cookies['ts_session']='recipe-recovery';self.headers={'HTTP_ORIGIN':'http://testserver','HTTP_X_CSRF_TOKEN':'qa-csrf'}
  self.raw=Document.objects.create(path='products/raw',data={'name':'Сировина','unit':'кг'});self.output=Document.objects.create(path='products/output',data={'name':'Кекс','unit':'шт','recipe':[{'product':'raw','quantity':'2'}]})
 def test_exact_recipe_reads_current_actor_and_do_not_write(self):
  from contextlib import contextmanager
  from server.erp.historical_reports import read_snapshot
  @contextmanager
  def downgraded():
   Profile.objects.filter(user=self.user).update(role='warehouse')
   with read_snapshot():yield
  with patch('server.erp.historical_reports.read_snapshot',side_effect=downgraded):r=self.client.get('/api/erp/recipes/versions',{'product':'output'})
  self.assertEqual(r.status_code,200);self.assertFalse(r.json()['canApprove']);self.assertEqual(r.json()['product']['id'],'output')
  legacy=self.client.get('/api/erp/recipes',{'product':'output'});self.assertEqual(legacy.status_code,200);self.assertTrue(legacy.json()['canEdit']);self.assertEqual(legacy.json()['revision'],revision(self.output));self.assertFalse(AuditEvent.objects.exists())
  Profile.objects.filter(user=self.user).update(role='accountant');self.assertEqual(self.client.get('/api/erp/recipes',{'product':'output'}).status_code,403);self.assertEqual(self.client.get('/api/erp/recipes/versions',{'product':'output'}).status_code,403)
 def test_legacy_lost_ack_read_current_and_stale_replay_do_not_repeat_write(self):
  payload={'product':'output','recipe':[{'product':'raw','quantity':'3.000'}],'revision':revision(self.output)}
  saved=self.client.post('/api/erp/recipes',payload,content_type='application/json',**self.headers);self.assertEqual(saved.status_code,200);self.assertEqual(saved.json()['product'],'output')
  retry=self.client.post('/api/erp/recipes',payload,content_type='application/json',**self.headers);self.assertEqual(retry.status_code,409);self.assertEqual(AuditEvent.objects.filter(action='recipe_saved').count(),1)
  read=self.client.get('/api/erp/recipes',{'product':'output'}).json();self.assertEqual(read['recipe'],payload['recipe']);self.assertEqual(read['revision'],saved.json()['revision'])
 def test_approved_receipt_exact_identity_role_recheck_and_no_rewrite(self):
  payload={'idempotencyKey':str(uuid.uuid4()),'product':'output','expectedVersion':None,'catalogRevision':revision(self.output),'outputQuantity':'1.000','components':[{'product':'raw','quantity':'2.000'}],'expiryPolicy':'unspecified','shelfLifeDays':None,'reason':'QA початкові умови'}
  first=self.client.post('/api/erp/recipes/versions',payload,content_type='application/json',**self.headers);self.assertEqual(first.status_code,201)
  Profile.objects.filter(user=self.user).update(role='warehouse');self.assertEqual(self.client.post('/api/erp/recipes/versions',payload,content_type='application/json',**self.headers).status_code,403)
  Profile.objects.filter(user=self.user).update(role='owner');replay=self.client.post('/api/erp/recipes/versions',payload,content_type='application/json',**self.headers);self.assertEqual(replay.status_code,200);self.assertEqual(replay.json(),first.json())
  current=self.client.get('/api/erp/recipes/versions/'+payload['idempotencyKey']).json();self.assertEqual(current['product'],'output');self.assertEqual(current['id'],payload['idempotencyKey']);self.assertEqual(RecipeVersion.objects.count(),1);self.assertEqual(AuditEvent.objects.filter(action='recipe_version_approved').count(),1)
