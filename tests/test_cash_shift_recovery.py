import json
import uuid
from decimal import Decimal
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from django.db import connection, transaction, close_old_connections
from django.test.utils import CaptureQueriesContext
from django.core.exceptions import ValidationError
from server.erp.models import CashShift, CashShiftActionReceipt, CashEntry, Voucher, AuditEvent, Employee, Profile, User, Store, LedgerLock
from server.erp.views import shift_action
from server.erp.cash_shift_recovery import identity, current, recovery_context
from server.erp.services import BusinessError, Conflict, record_revision, cash_balance
from tests.test_unit_and_drafts import TransactionApiFixture

class CashShiftRecoveryTests(TransactionApiFixture):
    def setUp(self):
        super().setUp();self.cash_start()
        self.person=Employee.objects.create(store=self.store,name='Касир без зарплатних даних у receipt',shift_rate=987)
        self.open={'action':'open','account':str(self.cash.pk),'employee':str(self.person.pk),'idempotency_key':str(uuid.uuid4())}
    def save(self,body,user=None):return json.loads(shift_action(user or self.u,body).content)
    def close(self,row,counted='990.00'):
        return {'action':'close','id':str(row.pk),'counted':counted,'note':'Пораховано вручну','revision':record_revision(row),'idempotency_key':str(uuid.uuid4())}
    def test_normalized_replay_after_close_inactive_employee_and_collisions(self):
        ack=self.save(self.open);row=CashShift.objects.get(pk=ack['id']);closing=self.close(row);closed=self.save(closing)
        before=(CashEntry.objects.count(),Voucher.objects.count(),AuditEvent.objects.count())
        Employee.objects.filter(pk=self.person.pk).update(active=False)
        LedgerLock.objects.filter(pk=1).update(closed_through=self.today)
        self.assertEqual(self.save({**self.open,'account':self.cash.pk,'employee':self.person.pk}),ack)
        self.assertEqual(self.save({**closing,'counted':'990,0','id':row.pk}),closed)
        self.assertEqual((CashEntry.objects.count(),Voucher.objects.count(),AuditEvent.objects.count()),before)
        self.assertEqual(CashShiftActionReceipt.objects.count(),2)
        self.assertEqual(cash_balance(self.cash),Decimal('990.00'))
        with self.assertRaises(Conflict):self.save({**closing,'note':'Інша примітка'})
        other=User.objects.create(username='other-owner');Profile.objects.create(user=other,role='owner')
        with self.assertRaises(Conflict):self.save(self.open,other)
        self.assertNotIn('987',json.dumps(ack));self.assertNotIn('revision',ack['original'])
        self.assertTrue(identity(self.u,{'request':closing})['confirmed'])
        self.assertEqual(identity(self.u,{'request':closing})['original'],closed['original'])
    def test_fresh_scope_before_receipt_and_scalar_readonly_closed_current(self):
        row=CashShift.objects.get(pk=self.save(self.open)['id']);self.save(self.close(row))
        with CaptureQueriesContext(connection) as queries:
            ctx=recovery_context(self.u,{'action':'close','id':str(row.pk)});now=current(self.u,{'id':str(row.pk)})
            found=identity(self.u,{'request':self.open})
        self.assertFalse(ctx['canWrite']);self.assertFalse(now['editing']['canWrite']);self.assertTrue(found['confirmed'])
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        if connection.vendor=='postgresql':self.assertTrue(any('READ ONLY' in q['sql'] and 'REPEATABLE READ' in q['sql'] for q in queries))
        self.assertEqual(self.client.get('/api/v1/trading/cash-shifts/recovery-context',{'action':'close','id':row.pk}).status_code,200)
        self.assertEqual(self.client.get('/api/v1/trading/cash-shifts/current',{'id':row.pk}).status_code,200)
        self.assertEqual(self.call('post','/api/v1/trading/cash-shifts/identity',{'request':self.open}).status_code,200)
        foreign=Store.objects.create(name='Інший')
        for fields in ({'role':'warehouse'},{'role':'owner','store_id':foreign.pk}):
            Profile.objects.filter(user=self.u).update(**fields)
            with self.assertRaises(BusinessError):self.save(self.open)
            with self.assertRaises(BusinessError):identity(self.u,{'request':self.open})
        Profile.objects.filter(user=self.u).update(role='owner',store_id=None);User.objects.filter(pk=self.u.pk).update(is_active=False)
        with self.assertRaises(BusinessError):current(self.u,{'id':str(row.pk)})
    def test_revision_ignores_cash_transactions_and_close_period_rollback_proof(self):
        row=CashShift.objects.get(pk=self.save(self.open)['id']);closing=self.close(row)
        CashEntry.objects.create(voucher=Voucher.objects.get(kind='cash_opening'),account=self.cash,amount=10)
        self.assertEqual(record_revision(CashShift.objects.get(pk=row.pk)),closing['revision'])
        LedgerLock.objects.filter(pk=1).update(closed_through=self.today)
        denied=self.call('post','/api/erp/shifts',closing)
        self.assertEqual(denied.status_code,400,denied.content);self.assertTrue(denied.json()['write_rejected'])
        row.refresh_from_db();self.assertIsNone(row.closed_at)
        self.assertEqual(CashShiftActionReceipt.objects.count(),1);self.assertFalse(Voucher.objects.filter(kind='cash_difference').exists())
        LedgerLock.objects.filter(pk=1).update(closed_through=None)
        self.assertEqual(self.call('post','/api/erp/shifts',closing).status_code,200)
    def test_first_validation_conflict_proof_and_postcommit_failure_not_rejected(self):
        self.save(self.open)
        key=str(uuid.uuid4());bad=self.call('post','/api/erp/shifts',{**self.open,'idempotency_key':key})
        self.assertEqual(bad.status_code,400);self.assertTrue(bad.json()['write_rejected']);self.assertEqual(CashShiftActionReceipt.objects.count(),1)
        collision=self.call('post','/api/erp/shifts',{**self.open,'employee':None})
        self.assertEqual(collision.status_code,409);self.assertNotIn('write_rejected',collision.json())
        row=CashShift.objects.get();stale=self.call('post','/api/erp/shifts',{**self.close(row),'revision':'0'*32})
        self.assertEqual(stale.status_code,409);self.assertTrue(stale.json()['write_rejected'])
        def callback():raise ValidationError('Synthetic postcommit failure')
        original=shift_action
        def save(user,value):
            result=original(user,value);transaction.on_commit(callback);return result
        with patch('server.erp.views.shift_action',side_effect=save):result=self.call('post','/api/erp/shifts',self.close(row))
        self.assertEqual(result.status_code,400);self.assertNotIn('write_rejected',result.json());row.refresh_from_db();self.assertIsNotNone(row.closed_at)
    def test_cashier_own_closure_and_legacy_no_key_unchanged(self):
        cashier=User.objects.create(username='cashier');Profile.objects.create(user=cashier,role='cashier',store=self.store)
        ack=self.save(self.open,cashier);row=CashShift.objects.get(pk=ack['id'])
        stranger=User.objects.create(username='other-cashier');Profile.objects.create(user=stranger,role='cashier',store=self.store)
        with self.assertRaises(BusinessError):self.save(self.close(row),stranger)
        self.save(self.close(row),cashier)
        no_key={'account':self.cash.pk};self.assertEqual(set(self.save(no_key)),{'id'})
    def test_concurrent_exact_open_and_close_and_waiting_revocation(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL ledger serialization')
        def run(body):
            close_old_connections()
            try:return self.save(body,User.objects.get(pk=self.u.pk))
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(run,[self.open,self.open]))
        self.assertEqual(results[0],results[1]);self.assertEqual(CashShift.objects.count(),1)
        closing=self.close(CashShift.objects.get())
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(run,[closing,closing]))
        self.assertEqual(results[0],results[1]);self.assertEqual(Voucher.objects.filter(kind='cash_difference').count(),1)
        cached=User.objects.select_related('profile').get(pk=self.u.pk)
        def revoked():
            Profile.objects.filter(user=cached).update(role='warehouse');return LedgerLock.objects.get(pk=1)
        with patch('server.erp.cash_shift_recovery.ledger_lock',side_effect=revoked):
            with self.assertRaises(BusinessError):self.save(self.open,cached)
        self.assertEqual(CashShiftActionReceipt.objects.count(),2)
    def test_real_ledger_wait_revalidates_cached_actor_before_replay(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL blocking ledger')
        from threading import Event
        from server.erp.services import ledger_lock
        self.save(self.open);before=(CashShift.objects.count(),CashShiftActionReceipt.objects.count(),AuditEvent.objects.count())
        waiting=Event();original=ledger_lock
        def marked():waiting.set();return original()
        def run():
            close_old_connections()
            try:
                actor=User.objects.select_related('profile').get(pk=self.u.pk)
                try:self.save(self.open,actor)
                except BusinessError:return 'refused'
                return 'ACK'
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with transaction.atomic():
                original()
                with patch('server.erp.cash_shift_recovery.ledger_lock',side_effect=marked):
                    pending=pool.submit(run);self.assertTrue(waiting.wait(5))
                    Profile.objects.filter(user=self.u).update(role='warehouse')
            self.assertEqual(pending.result(timeout=5),'refused')
        self.assertEqual((CashShift.objects.count(),CashShiftActionReceipt.objects.count(),AuditEvent.objects.count()),before)

    def test_http_context_query_is_unique_scalar_and_mode_specific(self):
        row=CashShift.objects.get(pk=self.save(self.open)['id'])
        for query in [f'action=close&id={row.pk}&id={row.pk}',f'action=open&account={self.cash.pk}&account={self.cash.pk}',
                      f'action=close&id={row.pk}&account={self.cash.pk}',f'action=open&id={row.pk}',
                      'action=open&action=close',f'action=close&id={row.pk}&store={self.store.pk}&store={self.store.pk}']:
            denied=self.client.get('/api/v1/trading/cash-shifts/recovery-context?'+query)
            self.assertEqual(denied.status_code,400,denied.content)
        for query in [f'id={row.pk}&id={row.pk}',f'id={row.pk}&account={self.cash.pk}']:
            self.assertEqual(self.client.get('/api/v1/trading/cash-shifts/current?'+query).status_code,400)
        self.assertEqual(CashShift.objects.count(),1);self.assertEqual(CashShiftActionReceipt.objects.count(),1)
