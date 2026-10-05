"""Readonly local portal draft authorization; mutation/receipt oracle remains unchanged."""
from django.contrib.auth.models import User
from django.db import connection
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import Profile, Store, Document, LedgerLock, AuditEvent, LegacyCreateReceipt
from server.erp.legacy_records import recovery_context
from server.erp.services import BusinessError

class PortalDraftContextTests(TransactionTestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.store = Store.objects.create(name='Own')
        self.foreign = Store.objects.create(name='Other')
        self.user = User.objects.create(username='draft-owner')
        Profile.objects.create(user=self.user, role='owner')

    def test_readonly_existing_missing_and_create_do_not_adopt_revision(self):
        Document.objects.create(path='tasks/task', data={'title':'Task','status':'todo','scope':'operations','store':self.store.pk})
        params={'collection':'tasks','id':'task','scope':'operations','store':str(self.store.pk)}
        with CaptureQueriesContext(connection) as queries:
            found=recovery_context(self.user,params)
            missing=recovery_context(self.user,{**params,'id':'absent'})
            new=recovery_context(self.user,{k:v for k,v in params.items() if k!='id'})
        self.assertEqual((found['exists'],missing['exists'],new['exists']),(True,False,None))
        self.assertEqual((found['canWrite'],missing['canWrite'],new['canWrite']),(True,False,True))
        self.assertNotIn('revision',found)
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        self.assertFalse(AuditEvent.objects.exists())

    def test_current_actor_scope_active_and_network_expense_boundary(self):
        _=self.user.profile
        Profile.objects.filter(user=self.user).update(role='manager',store=self.store)
        allowed={'collection':'tasks','scope':'operations','store':str(self.store.pk)}
        self.assertEqual(recovery_context(self.user,allowed)['role'],'manager')
        for params in [{**allowed,'store':str(self.foreign.pk)},{'collection':'tasks','scope':'development'},{'collection':'ideas'},{'collection':'expenses'}]:
            with self.assertRaises(BusinessError):recovery_context(self.user,params)
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        with self.assertRaises(BusinessError):recovery_context(self.user,allowed)

    def test_managed_current_record_is_readable_but_cannot_use_generic_write(self):
        path='auto_'+'a'*32
        Document.objects.create(path='tasks/'+path,data={'title':'Alert','scope':'operations','status':'todo','_alertKey':'expiry:x'})
        result=recovery_context(self.user,{'collection':'tasks','id':path,'scope':'operations'})
        self.assertTrue(result['exists']);self.assertFalse(result['canWrite'])
        for params in [{'collection':'tasks','unknown':'x'},{'collection':'ideas','store':'1'},{'collection':'tasks','store':'0'},{'collection':'tasks','id':'../escape'}]:
            with self.assertRaises(BusinessError):recovery_context(self.user,params)
        Profile.objects.filter(user=self.user).update(store=self.store)
        with self.assertRaises(BusinessError):recovery_context(self.user,{'collection':'expenses'})

    def test_missing_manager_uses_server_scope_witness_not_client_claim(self):
        Profile.objects.filter(user=self.user).update(role='manager',store=self.store)
        query={'collection':'tasks','id':'missing','scope':'operations','store':str(self.store.pk)}
        with self.assertRaises(BusinessError):recovery_context(self.user,query)
        receipt=LegacyCreateReceipt.objects.create(key='a'*32,author=self.user,collection='tasks',document_path='tasks/missing',request_fingerprint='a'*64,created_fingerprint='b'*64,original={'data':{'scope':'operations','store':self.foreign.pk}})
        with self.assertRaises(BusinessError):recovery_context(self.user,query)
        receipt.original={'data':{'scope':'operations','store':self.store.pk}};receipt.save(update_fields=['original'])
        self.assertFalse(recovery_context(self.user,query)['exists'])
