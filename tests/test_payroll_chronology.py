"""B05 actual same-day posting, final terms, accounting period and serialized order."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
from threading import Event
from time import monotonic, sleep
from unittest import skipUnless

from django.db import close_old_connections, connection, connections, transaction
from django.test import TransactionTestCase
from django.utils import timezone

from server.erp.models import AuditEvent, CashShift, Employee, Profile, User, Voucher, WorkShift
from server.erp.reporting import report
from server.erp.services import BusinessError, cash_balance, ledger_lock, post_voucher, reverse_voucher, save_voucher
from tests.test_erp import AccountingFixture


class ChronologyFixture:
    v = AccountingFixture.v
    def setup_chronology(self):
        AccountingFixture.setUp(self)
        self.v('receipt', 20, 5)
        self.worker = Employee.objects.create(name='Chronology worker', store=self.store, shift_rate=100, bonus_percent=10)
        self.shift = CashShift.objects.create(store=self.store, account=self.cash, employee=self.worker,
                                            opened_by=self.u, opening_cash=0)
        self.sale = self.v('sale', 10, 100, shift=self.shift.pk, employee=self.worker.pk,
                          payload={'payments': [{'account': self.bank.pk, 'amount': '1000'}]})
        self.shift.closed_at = timezone.now()
        self.shift.expected_cash = self.shift.counted_cash = Decimal(0)
        self.shift.save()
        self.work = WorkShift.objects.create(store=self.store, employee=self.worker, date=self.today,
                                            cash_shift=self.shift, shift_rate=100, bonus_percent=10)
    def draft(self, kind, **extra):
        body = {'kind': kind, 'store': self.store.pk, 'warehouse': self.wh.pk, 'date': self.today, **extra}
        if kind == 'payroll':
            body.update(employee=self.worker.pk, payload={'shift_ids': [self.work.pk]})
        else:
            body.update(reference=self.sale.pk, lines=[{'product': 'p', 'quantity': 1, 'price': 100}],
                        payload={'payments': [{'account': self.bank.pk, 'amount': '100'}]})
        return save_voucher(self.u, body)
    def accrue(self):
        return post_voucher(self.u, self.draft('payroll').pk)
    def late_bonus(self, user=None):
        return report(user or self.u, {'from': self.today, 'to': self.today})['cashiers'][0]['late_return_bonus']


class PayrollChronologyTests(ChronologyFixture, AccountingFixture):
    def setUp(self):
        self.setup_chronology()
    def test_same_day_return_and_reversal_keep_final_terms_audit_and_balance(self):
        payroll = self.accrue()
        frozen = dict(payroll.payload)
        returned = post_voucher(self.u, self.draft('customer_return').pk)
        self.assertGreater(returned.posted_at, payroll.posted_at)
        self.assertEqual(self.late_bonus(), '10.00')
        self.work.refresh_from_db(); payroll.refresh_from_db()
        self.assertEqual((self.work.basis_amount, self.work.accrued, payroll.total), (Decimal('1000'), Decimal('200'), Decimal('200')))
        self.assertEqual(payroll.payload, frozen)
        before = cash_balance(self.bank)
        self.assertEqual(post_voucher(self.u, returned.pk).pk, returned.pk)
        self.assertEqual(cash_balance(self.bank), before)
        reverse_voucher(self.u, returned.pk, 'Товар повернення вилучено з обліку')
        self.assertEqual(self.late_bonus(), '0.00')
        self.assertEqual(cash_balance(self.bank), Decimal('1000'))
        payroll.refresh_from_db(); self.assertEqual((payroll.total, payroll.payload), (Decimal('200'), frozen))
        self.assertEqual(AuditEvent.objects.filter(action='posted', subject=f'voucher/{payroll.pk}').count(), 1)
    def test_return_included_before_accrual_cannot_be_reversed_but_later_one_can(self):
        before = post_voucher(self.u, self.draft('customer_return').pk)
        payroll = self.accrue()
        self.assertLess(before.posted_at, payroll.posted_at)
        self.assertEqual(payroll.total, Decimal('190'))
        self.assertEqual(self.late_bonus(), '0.00')
        with self.assertRaisesMessage(BusinessError, 'Спочатку скасуйте нарахування'):
            reverse_voucher(self.u, before.pk, 'Не дозволено')
        after = post_voucher(self.u, self.draft('customer_return').pk)
        self.assertEqual(self.late_bonus(), '10.00')
        reverse_voucher(self.u, after.pk, 'Дозволено')
        self.assertEqual(self.late_bonus(), '0.00')
    def test_unknown_or_future_payroll_time_does_not_infer_same_day_order(self):
        payroll = self.accrue()
        for instant in (None, timezone.now() + timedelta(days=1)):
            Voucher.objects.filter(pk=payroll.pk).update(posted_at=instant)
            with self.assertRaisesMessage(BusinessError, 'Зарплату за цей день'):
                post_voucher(self.u, self.draft('customer_return').pk)
        self.assertEqual(Voucher.objects.filter(kind='customer_return', status='posted').count(), 0)
    def test_equal_or_missing_return_time_does_not_allow_reversal_of_uncertain_same_day(self):
        payroll = self.accrue()
        returned = post_voucher(self.u, self.draft('customer_return').pk)
        for instant in (None, payroll.posted_at):
            Voucher.objects.filter(pk=returned.pk).update(posted_at=instant)
            self.assertEqual(self.late_bonus(), '0.00')
            with self.assertRaisesMessage(BusinessError, 'Спочатку скасуйте нарахування'):
                reverse_voucher(self.u, returned.pk, 'Невідомий порядок')
        self.assertEqual(Voucher.objects.get(pk=returned.pk).status, 'posted')

    def test_cap_uses_posting_order_while_report_period_remains_accounting_date(self):
        payroll = self.accrue()
        first = post_voucher(self.u, self.draft('customer_return').pk)
        second = post_voucher(self.u, self.draft('customer_return').pk)
        # Read-only historic example: ordering of IDs/dates differs from posting.
        yesterday = timezone.localdate() - timedelta(days=1)
        Voucher.objects.filter(pk=first.pk).update(date=yesterday, posted_at=payroll.posted_at + timedelta(seconds=2))
        Voucher.objects.filter(pk=second.pk).update(posted_at=payroll.posted_at + timedelta(seconds=1))
        WorkShift.objects.filter(pk=self.work.pk).update(basis_amount=100)
        self.assertEqual(self.late_bonus(), '10.00')  # today's earlier posting consumes the cap.
        self.assertEqual(report(self.u, {'from': yesterday.isoformat(), 'to': self.today})['cashiers'][0]['late_return_bonus'], '10.00')
        # Missing legacy chronology retains calendar fallback; no same-day guess.
        Voucher.objects.filter(pk=second.pk).update(posted_at=None)
        self.assertEqual(self.late_bonus(), '0.00')
    def test_scope_and_salary_redaction_preserved_for_same_day_late_returns(self):
        self.accrue(); post_voucher(self.u, self.draft('customer_return').pk)
        accountant = User.objects.create(username='chronology-accountant'); Profile.objects.create(user=accountant, role='accountant', store=self.store)
        manager = User.objects.create(username='chronology-manager'); Profile.objects.create(user=manager, role='manager', store=self.store)
        self.assertEqual(self.late_bonus(accountant), '10.00')
        self.assertNotIn('late_return_bonus', report(manager, {})['cashiers'][0])


@skipUnless(connection.vendor == 'postgresql', 'Requires real PostgreSQL ledger serialization.')
class PayrollChronologyConcurrencyTests(ChronologyFixture, TransactionTestCase):
    def setUp(self):
        self.setup_chronology()
    def check_order(self, first_kind):
        drafts = {kind: self.draft(kind) for kind in ('payroll', 'customer_return')}
        holding, release, second_connected = Event(), Event(), Event()
        backend_pids = {}
        def first():
            close_old_connections()
            try:
                actor = User.objects.select_related('profile').get(pk=self.u.pk)
                with transaction.atomic():
                    ledger_lock()
                    with connections['default'].cursor() as cursor:
                        cursor.execute('SELECT pg_backend_pid()'); backend_pids['first'] = cursor.fetchone()[0]
                    holding.set()
                    if not release.wait(5):
                        raise RuntimeError('Review ledger gate timed out')
                    return post_voucher(actor, drafts[first_kind].pk).pk
            finally:
                connections.close_all()
        def second():
            close_old_connections()
            try:
                actor = User.objects.select_related('profile').get(pk=self.u.pk)
                with connections['default'].cursor() as cursor:
                    cursor.execute('SELECT pg_backend_pid()'); backend_pids['second'] = cursor.fetchone()[0]
                second_connected.set()
                return post_voucher(actor, drafts['customer_return' if first_kind == 'payroll' else 'payroll'].pk).pk
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            one = pool.submit(first); self.assertTrue(holding.wait(5)); two = pool.submit(second)
            try:
                self.assertTrue(second_connected.wait(5))
                deadline, blocked = monotonic() + 4, False
                while monotonic() < deadline:
                    with connection.cursor() as cursor:
                        cursor.execute('SELECT pg_blocking_pids(%s)', [backend_pids['second']])
                        blocked = backend_pids['first'] in cursor.fetchone()[0]
                    if blocked:
                        break
                    sleep(.01)
                self.assertTrue(blocked, 'Second posting must actually wait on the first ledger transaction')
                self.assertFalse(two.done())
            finally:
                release.set()
            one.result(10); two.result(10)
        payroll = Voucher.objects.get(pk=drafts['payroll'].pk)
        returned = Voucher.objects.get(pk=drafts['customer_return'].pk)
        self.assertEqual(payroll.total, Decimal('200') if first_kind == 'payroll' else Decimal('190'))
        self.assertEqual(self.late_bonus(), '10.00' if first_kind == 'payroll' else '0.00')
        self.assertEqual(returned.posted_at > payroll.posted_at, first_kind == 'payroll')
    def test_payroll_lock_first_makes_return_late_and_leaves_bonus_final(self):
        self.check_order('payroll')
    def test_return_lock_first_is_included_once_in_final_bonus(self):
        self.check_order('customer_return')
