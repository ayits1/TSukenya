import json
import uuid
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch
from django.db import connection,transaction,close_old_connections
from django.test.utils import CaptureQueriesContext
from django.core.exceptions import ValidationError
from django.utils import timezone
from server.erp.models import User,Profile,Setting,SettingActionReceipt,AuditEvent,LedgerLock,Voucher,Store
from server.erp.services import BusinessError,Conflict,ledger_lock,audit
from server.erp import setting_recovery as r
from tests.test_unit_and_drafts import TransactionApiFixture

class SettingRecoveryTests(TransactionApiFixture):
    def current(self,setting):return r.current(self.u,setting,{})
    def request(self,setting,**overrides):
        terms={'period':{'date':(timezone.localdate()-timedelta(days=1)).isoformat(),'reason':'Завершені дні'},'fiscal':{'required':True},'discount-limit':{'percent':'7,50'}}[setting]
        return {**terms,'revision':self.current(setting)['revision'],'idempotency_key':str(uuid.uuid4()),**overrides}
    def save(self,setting,value,user=None):return r.action(user or self.u,setting,value)
    def test_all_three_normalized_exact_replay_aba_and_collision(self):
        for setting in r.KINDS:
            body=self.request(setting);ack=self.save(setting,body);before=AuditEvent.objects.count()
            self.assertEqual(self.save(setting,body),ack);self.assertEqual(AuditEvent.objects.count(),before)
            self.assertTrue(r.identity(self.u,setting,{'request':body})['confirmed'])
            other=self.request(setting,**({'date':None,'reason':'Знову відкрито'} if setting=='period' else {'required':False} if setting=='fiscal' else {'percent':'0'}))
            self.save(setting,other);self.assertEqual(self.save(setting,body),ack)
            changed={**body,**({'reason':'Інша причина'} if setting=='period' else {'required':False} if setting=='fiscal' else {'percent':'8'})}
            with self.assertRaises(Conflict):self.save(setting,changed)
            u=User.objects.create(username='owner-'+setting);Profile.objects.create(user=u,role='owner')
            with self.assertRaises(Conflict):self.save(setting,body,u)
        self.assertEqual(SettingActionReceipt.objects.count(),6)
    def test_scalar_current_fresh_owner_scope_and_no_writes(self):
        with CaptureQueriesContext(connection) as queries:
            for setting in r.KINDS:
                self.assertTrue(r.recovery_context(self.u,setting,{})['canWrite']);self.current(setting)
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        for q in queries:
            # JSON member extraction may reference detail, but no whole JSON column is selected.
            self.assertNotRegex(q['sql'],r'(?:SELECT|,)\s*"erp_auditevent"\."detail"(?:\s*,|\s+FROM)')
        self.assertTrue(any('reason' in q['sql'] and 'erp_auditevent' in q['sql'] for q in queries))
        if connection.vendor=='postgresql':self.assertTrue(any('READ ONLY' in q['sql'] and 'REPEATABLE READ' in q['sql'] for q in queries))
        s=Store.objects.create(name='Прив’язка власника');Profile.objects.filter(user=self.u).update(store=s)
        self.assertEqual(r.recovery_context(self.u,'fiscal',{})['storeId'],s.pk)
        body=self.request('fiscal');self.save('fiscal',body)
        cached=User.objects.select_related('profile').get(pk=self.u.pk);Profile.objects.filter(user=self.u).update(role='manager')
        for fn in (lambda:r.current(cached,'fiscal',{}),lambda:r.identity(cached,'fiscal',{'request':body}),lambda:self.save('fiscal',body,cached)):
            with self.assertRaises(BusinessError):fn()
        Profile.objects.filter(user=self.u).update(role='owner');User.objects.filter(pk=self.u.pk).update(is_active=False)
        with self.assertRaises(BusinessError):r.current(self.u,'period',{})
    def test_revision_is_per_kind_and_observes_legacy_aba(self):
        old={kind:self.current(kind)['revision'] for kind in r.KINDS}
        audit(self.u,'unrelated_cash','cash',{'amount':'99'})
        self.assertEqual({kind:self.current(kind)['revision'] for kind in r.KINDS},old)
        self.assertEqual(self.call('post','/api/erp/fiscal',{'required':True}).json(),{'ok':True})
        self.assertEqual(self.call('post','/api/erp/fiscal',{'required':False}).json(),{'ok':True})
        self.assertFalse(self.current('fiscal')['value']['required']);self.assertNotEqual(self.current('fiscal')['revision'],old['fiscal'])
        self.assertEqual(self.current('period')['revision'],old['period']);self.assertEqual(self.current('discount-limit')['revision'],old['discount-limit'])
        self.assertEqual(self.call('post','/api/erp/discount-limit',{'percent':'7,5'}).json(),{'percent':'7.5'})
    def test_rollback_first_rejection_and_postcommit_has_no_proof(self):
        body=self.request('period');Voucher.objects.create(kind='expense',store=self.store,date=timezone.localdate()-timedelta(days=1),created_by=self.u)
        result=self.call('post','/api/erp/period',body);self.assertEqual(result.status_code,400);self.assertTrue(result.json()['write_rejected'])
        self.assertFalse(SettingActionReceipt.objects.exists());self.assertIsNone(LedgerLock.objects.get(pk=1).closed_through)
        body=self.request('fiscal',revision='0'*32);result=self.call('post','/api/erp/fiscal',body);self.assertEqual(result.status_code,409);self.assertTrue(result.json()['write_rejected'])
        body=self.request('fiscal');original=r.action
        def committed(*args):
            result=original(*args)
            def fail():raise ValidationError('Synthetic postcommit failure')
            transaction.on_commit(fail);return result
        with patch('server.erp.setting_recovery.action',side_effect=committed):result=self.call('post','/api/erp/fiscal',body)
        self.assertEqual(result.status_code,400);self.assertNotIn('write_rejected',result.json());self.assertTrue(SettingActionReceipt.objects.filter(pk=body['idempotency_key']).exists())
    def test_strict_keys_types_private_reason_and_actual_http(self):
        for setting in r.KINDS:
            self.assertEqual(self.client.get('/api/v1/trading/settings/'+setting+'/current').status_code,200)
            self.assertEqual(self.client.get('/api/v1/trading/settings/'+setting+'/recovery-context?q=x&q=y').status_code,400)
            body=self.request(setting);missing=self.call('post','/api/v1/trading/settings/'+setting+'/identity',{'request':body})
            self.assertEqual(missing.status_code,200);self.assertFalse(missing.json()['confirmed'])
            with self.assertRaises(BusinessError):self.save(setting,{**body,'password':'must-never-be-persisted'})
        for terms in ({'required':'false'},{'required':0}):
            with self.assertRaises(BusinessError):self.save('fiscal',self.request('fiscal',**terms))
        for raw in ('100.001','NaN','-1','1.234','1e1'):
            with self.assertRaises(BusinessError):self.save('discount-limit',self.request('discount-limit',percent=raw))
        audit(self.u,'period_changed','ledger',{'reason':{'invalid':'object'}})
        with self.assertRaises(BusinessError):self.current('period')
    def test_pg_concurrent_retry_and_wait_revalidates_author_before_receipt(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL ledger serialization')
        body=self.request('fiscal')
        def worker():
            close_old_connections()
            try:return self.save('fiscal',body,User.objects.get(pk=self.u.pk))
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:worker(),range(2)))
        self.assertEqual(results[0],results[1]);self.assertEqual(SettingActionReceipt.objects.count(),1)
        before=AuditEvent.objects.count();waiting=Event();original=ledger_lock
        def lock():waiting.set();return original()
        def replay():
            close_old_connections()
            try:
                cached=User.objects.select_related('profile').get(pk=self.u.pk)
                with patch('server.erp.setting_recovery.ledger_lock',side_effect=lock):
                    with self.assertRaises(BusinessError):self.save('fiscal',body,cached)
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with transaction.atomic():
                ledger_lock();f=pool.submit(replay);self.assertTrue(waiting.wait(5));Profile.objects.filter(user=self.u).update(role='manager')
            f.result(10)
        self.assertEqual(SettingActionReceipt.objects.count(),1);self.assertEqual(AuditEvent.objects.count(),before)
