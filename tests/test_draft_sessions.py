import hashlib
import time
from django.contrib.auth.models import User
from django.db import connection
from django.test import TransactionTestCase,RequestFactory
from django.test.utils import CaptureQueriesContext
from server.erp.models import Profile,PortalSession,Store
from server.erp.draft_sessions import session_reply

class DraftSessionTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create(username='draft-session-owner');Profile.objects.create(user=self.user,role='owner')
        self.session=PortalSession.objects.create(pk=hashlib.sha256(b'isolated-draft-login').hexdigest(),user=self.user,csrf='isolated-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='isolated-draft-login'
    def test_http_binding_stability_and_current_scope_no_write(self):
        with CaptureQueriesContext(connection) as queries:first=self.client.get('/api/v1/session')
        data=first.json();self.assertEqual(first.status_code,200);self.assertEqual(data['role'],'owner');self.assertTrue(data['networkOwner']);self.assertIsNone(data['storeId'])
        self.assertEqual(len(data['draftSession']),64);self.assertNotEqual(data['draftSession'],self.session.pk);self.assertNotIn(self.session.pk,first.content.decode())
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        self.assertEqual(self.client.get('/api/v1/session').json(),data)
        other=PortalSession.objects.create(pk=hashlib.sha256(b'new-draft-login').hexdigest(),user=self.user,csrf='other',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='new-draft-login';new=self.client.get('/api/v1/session').json();self.assertEqual(new['draftOwner'],data['draftOwner']);self.assertNotEqual(new['draftSession'],data['draftSession'])
        store=Store.objects.create(name='Own');Profile.objects.filter(user=self.user).update(role='cashier',store=store)
        new=self.client.get('/api/v1/session').json();self.assertEqual((new['role'],new['storeId'],new['networkOwner']),('cashier',store.pk,False))
    def test_cached_principal_revalidation_and_readonly_snapshot(self):
        request=RequestFactory().get('/api/v1/session');request.portal_session=self.session
        Profile.objects.filter(user=self.user).update(role='manager')
        with CaptureQueriesContext(connection) as queries:r=session_reply(request,self.user)
        self.assertEqual(__import__('json').loads(r.content)['role'],'manager')
        if connection.vendor=='postgresql':
            sql=' '.join(q['sql'].upper() for q in queries);self.assertIn('REPEATABLE READ, READ ONLY',sql)
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        User.objects.filter(pk=self.user.pk).update(is_active=False);self.assertEqual(session_reply(request,self.user).status_code,401)
    def test_revoked_session_missing_profile_and_other_actor(self):
        request=RequestFactory().get('/api/v1/session');request.portal_session=self.session
        other=User.objects.create(username='other');Profile.objects.create(user=other,role='owner')
        self.assertEqual(session_reply(request,other).status_code,401)
        Profile.objects.filter(user=self.user).delete();self.assertEqual(session_reply(request,self.user).status_code,401)
        self.session.delete();self.assertEqual(session_reply(request,self.user).status_code,401)
