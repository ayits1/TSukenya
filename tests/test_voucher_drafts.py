from datetime import date, timedelta
from django.contrib.auth.models import User
from django.db import connection
from django.utils import timezone
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import Profile, Store, LedgerLock
from server.erp.services import BusinessError
from server.erp.voucher_drafts import recovery_context


class VoucherDraftContextTests(TransactionTestCase):
    def setUp(self):
        self.store=Store.objects.create(name='Own')
        self.other=Store.objects.create(name='Other')
        self.user=User.objects.create(username='draft-context')
        Profile.objects.create(user=self.user,role='manager',store=self.store)
        LedgerLock.objects.update_or_create(pk=1,defaults={'closed_through':date(2026,9,30)})
    def context(self,**values):
        return recovery_context(self.user,{'kind':'sale','store':str(self.store.pk),'date':'2026-10-01',**values})
    def test_fresh_scope_permissions_and_readonly_context(self):
        with CaptureQueriesContext(connection) as queries:
            result=self.context()
        self.assertTrue(result['editing']['canEdit'])
        self.assertEqual(result['editing']['storeId'],self.store.pk)
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        if connection.vendor=='postgresql':self.assertIn('REPEATABLE READ, READ ONLY',' '.join(q['sql'].upper() for q in queries))
        with self.assertRaises(BusinessError):self.context(store=str(self.other.pk))
        Profile.objects.filter(user=self.user).update(role='cashier')
        with self.assertRaises(BusinessError):self.context(kind='receipt')
        self.assertEqual(self.context()['editing']['role'],'cashier')
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        with self.assertRaises(BusinessError):self.context()
    def test_closed_inactive_invalidraw_and_network_expense_guards(self):
        self.assertFalse(self.context(date='2026-09-30')['editing']['canEdit'])
        self.assertFalse(self.context(date='not-a-date')['editing']['canEdit'])
        self.assertFalse(self.context(date=(timezone.localdate()+timedelta(days=1)).isoformat())['editing']['canEdit'])
        Store.objects.filter(pk=self.store.pk).update(active=False)
        self.assertFalse(self.context()['editing']['canEdit'])
        with self.assertRaises(BusinessError):self.context(kind='expense',expense_scope='network')
        with self.assertRaises(BusinessError):self.context(kind='cash_difference')
        with self.assertRaises(BusinessError):self.context(store='²')

    def test_first_create_validation_proof_is_bound_and_not_emitted_after_commit(self):
        import hashlib, time, uuid
        from unittest.mock import patch
        from server.erp.models import PortalSession, CashAccount, Voucher, AuditEvent
        PortalSession.objects.create(pk=hashlib.sha256(b'draft-create-token').hexdigest(),user=self.user,csrf='draft-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='draft-create-token'
        account=CashAccount.objects.create(store=self.store,name='Test',kind='cash')
        key=str(uuid.uuid4())
        body={'kind':'expense','date':timezone.localdate().isoformat(),'store':self.store.pk,'account':account.pk,'amount':'-1','lines':[],'payload':{},'idempotency_key':key}
        def create(value):
            return self.client.post('/api/erp/vouchers',value,content_type='application/json',HTTP_X_CSRF_TOKEN='draft-csrf',HTTP_ORIGIN='http://testserver')
        reply=create(body)
        self.assertEqual(reply.status_code,400)
        self.assertEqual({k:reply.json()[k] for k in ('write_rejected','request_key','kind')},{'write_rejected':True,'request_key':key,'kind':'expense'})
        self.assertFalse(Voucher.objects.exists());self.assertFalse(AuditEvent.objects.exists())
        forbidden=create({**body,'kind':'cash_opening'})
        self.assertEqual(forbidden.status_code,403);self.assertNotIn('write_rejected',forbidden.json())
        with patch('server.erp.views.voucher_json',side_effect=BusinessError('Серіалізація зірвана після commit')):
            committed=create({**body,'amount':'1.00'})
        self.assertEqual(committed.status_code,400)
        self.assertNotIn('write_rejected',committed.json())
        self.assertEqual(Voucher.objects.get().total,1)
        self.assertEqual(AuditEvent.objects.count(),1)
