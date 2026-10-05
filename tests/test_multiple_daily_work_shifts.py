"""B04 separate till participation, exact create retry and immutable payroll terms."""
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
from threading import Barrier
from unittest import skipUnless

from django.db import IntegrityError, close_old_connections, connection, connections, transaction
from django.test import TransactionTestCase
from django.utils import timezone

from server.erp.models import AuditEvent, CashShift, Employee, Profile, Store, User, Voucher, WorkShift, WorkShiftCreateReceipt
from server.erp.services import BusinessError, Conflict, post_voucher, record_revision, save_voucher
from server.erp.views import work_shift_save
from tests.test_unit_and_drafts import TransactionApiFixture


class MultipleDailyWorkShiftTests(TransactionApiFixture):
    def setUp(self):
        super().setUp()
        self.employee = Employee.objects.create(name='Працівник двох змін', store=self.store,
                                                shift_rate=100, bonus_percent=10)
        self.shifts = [CashShift.objects.create(store=self.store, account=self.cash, employee=self.employee,
                       opened_by=self.u, closed_at=timezone.now(), opening_cash=0,
                       counted_cash=0, expected_cash=0) for _ in range(2)]

    def body(self, shift=0, **extra):
        return {'employee': self.employee.pk, 'date': self.today, 'cash_shift': self.shifts[shift].pk,
                'units': '1', 'shift_rate': '100', 'bonus_percent': '10', 'bonus_basis': 'store', **extra}

    def save(self, body):
        response = self.call('post', '/api/erp/work-shifts', body)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()['id']

    def test_two_same_day_tills_keep_independent_units_rates_percent_and_payroll(self):
        self.v('receipt', qty=20, price=5)
        for shift, total in zip(self.shifts, [100, 300]):
            CashShift.objects.filter(pk=shift.pk).update(closed_at=None)
            self.v('sale', qty=1, price=total, shift=shift.pk, employee=self.employee.pk,
                   payload={'payments': [{'account': self.bank.pk, 'amount': str(total)}]})
            CashShift.objects.filter(pk=shift.pk).update(closed_at=timezone.now())
        first = self.save(self.body())
        second = self.save(self.body(1, units='2', shift_rate='200', bonus_percent='5'))
        Employee.objects.filter(pk=self.employee.pk).update(shift_rate=999, bonus_percent=99)
        rows = self.client.get('/api/erp/work-shifts', {'employee': self.employee.pk}).json()['items']
        self.assertEqual({(r['id'], r['cash_shift_id']) for r in rows}, {(first, self.shifts[0].pk), (second, self.shifts[1].pk)})
        payroll = self.v('payroll', employee=self.employee.pk, payload={'shift_ids': [first, second]})
        self.assertEqual(payroll.total, Decimal('525.00'))  # 100+10%*100 + 2*200+5%*300.
        calculation = payroll.payload['calculation']
        terms = {r['id']: r for r in calculation}
        self.assertEqual((terms[first]['rate'], terms[first]['percent'], terms[first]['basis_amount']), ('100.00', '10.000', '100.00'))
        self.assertEqual((terms[second]['units'], terms[second]['rate'], terms[second]['percent'], terms[second]['accrued']), ('2.00', '200.00', '5.000', '415.00'))
        self.assertEqual({r['cash_shift'] for r in calculation}, {s.pk for s in self.shifts})
        audit_calculation = AuditEvent.objects.get(action='posted', subject=f'voucher/{payroll.pk}').detail['after']['payload']['calculation']
        self.assertEqual({(r['id'], r['cash_shift']) for r in audit_calculation}, {(first, self.shifts[0].pk), (second, self.shifts[1].pk)})
        self.assertEqual(post_voucher(self.u, payroll.pk).payload['calculation'], calculation)
        edit = self.call('post', '/api/erp/work-shifts', self.body(id=first, shift_rate='999', revision=rows[0]['revision']))
        self.assertEqual(edit.status_code, 400)
        self.assertIn('включено в нарахування', edit.json()['error'])
        self.assertEqual(WorkShift.objects.get(pk=first).shift_rate, 100)

    def test_same_till_day_conflicts_but_one_unlinked_rate_row_and_other_till_are_allowed(self):
        first = self.save(self.body(bonus_percent='0'))
        response = self.call('post', '/api/erp/work-shifts', self.body(bonus_percent='0', shift_rate='200'))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()['code'], 'work_shift_exists')
        self.assertEqual(response.json()['id'], first)
        self.save(self.body(1))
        self.save(self.body(cash_shift=None, bonus_percent='0'))
        self.assertEqual(self.call('post', '/api/erp/work-shifts', self.body(cash_shift=None, bonus_percent='0')).status_code, 409)
        self.assertEqual(WorkShift.objects.count(), 3)
        # Database constraints protect direct/import writes too; legacy rows are never coalesced.
        for shift in (self.shifts[0], None):
            with self.assertRaises(IntegrityError), transaction.atomic():
                WorkShift.objects.create(employee=self.employee, store=self.store, date=self.today,
                    cash_shift=shift, shift_rate=100, bonus_percent=0, bonus_basis='store')

    def test_exact_uuid_retry_returns_initial_id_after_edit_without_audit_and_changed_request_conflicts(self):
        body = self.body(idempotency_key=str(uuid.uuid4()))
        first = self.save(body)
        row = WorkShift.objects.get(pk=first)
        self.save(self.body(id=first, revision=record_revision(row), shift_rate='150'))
        audit_count = AuditEvent.objects.count()
        self.assertEqual(self.save(body), first)
        self.assertEqual(AuditEvent.objects.count(), audit_count)
        self.assertEqual((WorkShift.objects.count(), WorkShiftCreateReceipt.objects.count()), (1, 1))
        self.assertEqual(WorkShift.objects.get(pk=first).shift_rate, 150)
        changed = self.call('post', '/api/erp/work-shifts', {**body, 'shift_rate': '999'})
        self.assertEqual(changed.status_code, 409)
        self.assertEqual(changed.json()['code'], 'idempotency_conflict')
        another = User.objects.create(username='other-owner'); Profile.objects.create(user=another, role='owner')
        with self.assertRaises(Conflict):
            work_shift_save(another, body)
        actor = User.objects.select_related('profile').get(pk=self.u.pk)
        foreign = Store.objects.create(name='Чужий магазин')
        Profile.objects.filter(user=self.u).update(store=foreign)
        with self.assertRaises(BusinessError):
            work_shift_save(actor, body)
        self.assertEqual(AuditEvent.objects.count(), audit_count)

    def test_stale_second_row_edit_never_overwrites_first_or_newer_terms(self):
        first = self.save(self.body())
        second = self.save(self.body(1))
        stale_revision = record_revision(WorkShift.objects.get(pk=second))
        self.save(self.body(1, id=second, revision=stale_revision, shift_rate='250'))
        stale = self.call('post', '/api/erp/work-shifts', self.body(1, id=second, revision=stale_revision, shift_rate='999'))
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()['code'], 'revision_conflict')
        self.assertEqual([WorkShift.objects.get(pk=key).shift_rate for key in (first, second)], [100, 250])

    def test_current_role_and_activity_guard_both_creation_and_exact_receipt(self):
        body = self.body(idempotency_key=str(uuid.uuid4()))
        first = self.save(body)
        audit_count = AuditEvent.objects.count()
        for retry in (body, self.body(1, idempotency_key=str(uuid.uuid4()))):
            for change in ('role', 'inactive'):
                Profile.objects.filter(user=self.u).update(role='owner')
                User.objects.filter(pk=self.u.pk).update(is_active=True)
                actor = User.objects.select_related('profile').get(pk=self.u.pk)
                if change == 'role':
                    Profile.objects.filter(user=self.u).update(role='cashier')
                else:
                    User.objects.filter(pk=self.u.pk).update(is_active=False)
                with self.assertRaises(BusinessError):
                    work_shift_save(actor, retry)
        self.assertEqual((WorkShift.objects.count(), WorkShiftCreateReceipt.objects.count(), AuditEvent.objects.count()), (1, 1, audit_count))
        Profile.objects.filter(user=self.u).update(role='owner')
        User.objects.filter(pk=self.u.pk).update(is_active=True)
        self.assertEqual(self.save(body), first)


@skipUnless(connection.vendor == 'postgresql', 'Requires PostgreSQL ledger serialization.')
class MultipleDailyWorkShiftConcurrencyTests(TransactionTestCase):
    def setUp(self):
        from server.erp.models import CashAccount, LedgerLock
        self.user = User.objects.create(username='isolated-workshift-concurrency')
        Profile.objects.create(user=self.user, role='owner')
        LedgerLock.objects.create(pk=1)
        self.store = Store.objects.create(name='Конкурентний магазин')
        account = CashAccount.objects.create(store=self.store, name='Каса', kind='cash')
        self.employee = Employee.objects.create(store=self.store, name='Працівник', shift_rate=100, bonus_percent=10)
        self.shifts = [CashShift.objects.create(store=self.store, account=account, opened_by=self.user,
                          opening_cash=0, closed_at=timezone.now()) for _ in range(2)]

    def parallel(self, bodies):
        barrier = Barrier(len(bodies))
        def worker(body):
            close_old_connections()
            try:
                user = User.objects.select_related('profile').get(pk=self.user.pk)
                barrier.wait(5)
                try:
                    return json.loads(work_shift_save(user, body).content)
                except BusinessError as error:
                    return error
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=len(bodies)) as pool:
            return list(pool.map(worker, bodies))

    def body(self, index=0):
        return {'employee': self.employee.pk, 'date': timezone.localdate().isoformat(),
                'cash_shift': self.shifts[index].pk, 'idempotency_key': str(uuid.uuid4())}

    def test_two_different_tills_commit_and_parallel_exact_retries_write_once(self):
        bodies = [self.body(0), self.body(1)]
        results = self.parallel(bodies)
        self.assertTrue(all(isinstance(r, dict) for r in results), results)
        self.assertEqual(len({r['id'] for r in results}), 2)
        self.assertEqual(self.parallel([bodies[0], bodies[0]]), [results[0], results[0]])
        self.assertEqual((WorkShift.objects.count(), WorkShiftCreateReceipt.objects.count(),
                          AuditEvent.objects.filter(action='work_shift_saved').count()), (2, 2, 2))

    def test_same_identity_different_keys_serialize_to_one_record(self):
        results = self.parallel([self.body(), self.body()])
        self.assertEqual(sum(isinstance(r, dict) for r in results), 1)
        conflict = next(r for r in results if isinstance(r, Conflict))
        self.assertEqual(conflict.code, 'work_shift_exists')
        self.assertEqual((WorkShift.objects.count(), WorkShiftCreateReceipt.objects.count(), AuditEvent.objects.count()), (1, 1, 1))

    def test_cross_midnight_positive_bonus_still_serializes_to_one_day(self):
        shift = self.shifts[0]
        CashShift.objects.filter(pk=shift.pk).update(opened_at=timezone.now()-timedelta(days=1))
        first, second = self.body(), self.body()
        first['date'] = (timezone.localdate()-timedelta(days=1)).isoformat()
        results = self.parallel([first, second])
        self.assertEqual(sum(isinstance(r, dict) for r in results), 1)
        self.assertIn('уже враховано в табелі', str(next(r for r in results if isinstance(r, BusinessError))))
        self.assertEqual(WorkShift.objects.count(), 1)

    def test_parallel_payrolls_cannot_accrue_the_two_participations_twice(self):
        rows = [json.loads(work_shift_save(self.user, {**self.body(index), 'bonus_percent': '0'}).content)['id'] for index in (0, 1)]
        drafts = [save_voucher(self.user, {'kind': 'payroll', 'date': timezone.localdate().isoformat(),
                   'store': self.store.pk, 'employee': self.employee.pk, 'payload': {'shift_ids': rows}}) for _ in range(2)]
        barrier = Barrier(2)
        def post(identifier):
            close_old_connections()
            try:
                actor = User.objects.select_related('profile').get(pk=self.user.pk)
                barrier.wait(5)
                try:
                    return post_voucher(actor, identifier).pk
                except BusinessError as error:
                    return error
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(post, [draft.pk for draft in drafts]))
        posted = next(result for result in results if type(result) is int)
        self.assertEqual(sum(type(result) is int for result in results), 1)
        self.assertEqual(Voucher.objects.filter(status='posted', kind='payroll').count(), 1)
        self.assertEqual(Voucher.objects.get(pk=posted).total, Decimal('200.00'))
        self.assertEqual(set(WorkShift.objects.values_list('payroll_id', flat=True)), {posted})
        self.assertEqual(post_voucher(self.user, posted).total, Decimal('200.00'))
