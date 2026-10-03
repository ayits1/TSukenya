"""B04 per-employee percent of one cash shift and B05 final bonus with the late-return report column. Isolated data only."""
import json
from datetime import timedelta
from decimal import Decimal
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from server.erp.models import *
from server.erp.services import *
from server.erp.reporting import late_return_bonus, report
from server.erp.shift_browsing import work_shifts
from tests import test_erp
from tests.test_erp import AccountingFixture


class PayrollRuleTests(AccountingFixture):
    def setUp(self):
        super().setUp()
        day = lambda n: (timezone.localdate() - timedelta(days=n)).isoformat()
        self.d3, self.d2, self.yesterday = day(3), day(2), day(1)  # stock and cash, sale and shift, accrual; the return is posted today
        self.v('cash_opening', amount=1000, account=self.cash.pk, date=self.d3); self.v('receipt', 20, 5, date=self.d3)
    till = test_erp.PayrollAndCashControlTests.till
    def cash_sale(self, shift, qty=1, price=10, date=None, **extra):
        return self.v('sale', qty, price, shift=shift.pk, date=date or self.d2, payload={'payments': [{'account': self.cash.pk, 'amount': str(money(Decimal(qty) * Decimal(price)))}]}, **extra)
    def cash_return(self, sale, shift, qty=1, price=10, date=None):
        return self.v('customer_return', qty, price, reference=sale.pk, shift=shift.pk, date=date or self.today, payload={'payments': [{'account': self.cash.pk, 'amount': str(money(Decimal(qty) * Decimal(price)))}]})
    save_work = test_erp.PayrollAndCashControlTests.save_work

    def close(self, shift):
        shift.closed_at = timezone.now(); shift.expected_cash = shift.counted_cash = cash_balance(self.cash); shift.save()

    def late_return(self, percent=10, basis='store', employee=None, personal_seller=None, rate=0):
        """Sale and shift two days ago, accrual yesterday, the return is posted by the test later (today)."""
        worker = employee or Employee.objects.create(name='Worker', store=self.store, shift_rate=0, bonus_percent=percent)
        shift = self.till(worker)
        sale = self.cash_sale(shift, 10, 100)
        if personal_seller is not None:
            Voucher.objects.filter(pk=sale.pk).update(employee=personal_seller)
        self.close(shift)
        ws = WorkShift.objects.create(employee=worker, store=self.store, date=self.d2, cash_shift=shift, shift_rate=rate, bonus_percent=percent, bonus_basis=basis)
        payroll = self.v('payroll', employee=worker.pk, date=self.yesterday, payload={'shift_ids': [ws.pk]})
        return worker, shift, sale, ws, payroll

    def owner_report(self):
        return report(self.u, {})

    def test_bonus_is_final_and_report_shows_percent_of_late_return(self):
        worker, shift, sale, ws, payroll = self.late_return()
        self.assertEqual((ws.pk and WorkShift.objects.get(pk=ws.pk).accrued), Decimal('100.00'))
        returned = self.cash_return(sale, self.till(), 2, 100)
        ws.refresh_from_db(); payroll.refresh_from_db()
        self.assertEqual((ws.accrued, ws.basis_amount, payroll.total), (Decimal('100.00'), Decimal('1000.00'), Decimal('100.00')))
        (row,) = self.owner_report()['cashiers']
        self.assertEqual((row['name'], row['late_return_bonus']), ('Worker', '20.00'))
        # Repeating the report does not duplicate or change anything.
        self.assertEqual(self.owner_report()['cashiers'][0]['late_return_bonus'], '20.00')
        self.assertEqual(WorkShift.objects.get(pk=ws.pk).accrued, Decimal('100.00'))
        self.assertEqual(Voucher.objects.filter(kind='payroll').count(), 1)
        # A reversed return leaves no late bonus.
        reverse_voucher(self.u, returned.pk, 'test')
        self.assertEqual(self.owner_report()['cashiers'][0]['late_return_bonus'], '0.00')

    def test_rate_only_payroll_with_cash_shift_does_not_block_return(self):
        worker, shift, sale, ws, payroll = self.late_return(percent=0, rate=100)
        # Same accrual date remains allowed because no percent depends on sales.
        returned = self.cash_return(sale, self.till(), 1, 100, date=self.yesterday)
        self.assertEqual(returned.status, 'posted')
        ws.refresh_from_db()
        payroll.refresh_from_db()
        self.assertEqual((ws.accrued, payroll.total), (Decimal('100.00'), Decimal('100.00')))
        self.assertEqual(self.owner_report()['cashiers'][0]['late_return_bonus'], '0.00')

    def test_percent_payroll_still_blocks_return_on_accrual_date(self):
        worker, shift, sale, ws, payroll = self.late_return(percent=10)
        with self.assertRaisesMessage(BusinessError, 'Зарплату за цей день уже нараховано'):
            self.cash_return(sale, self.till(), 1, 100, date=self.yesterday)

    def test_return_before_accrual_is_not_late(self):
        worker = Employee.objects.create(name='Worker', store=self.store, shift_rate=0, bonus_percent=10)
        shift = self.till(worker); sale = self.cash_sale(shift, 10, 100)
        self.cash_return(sale, shift, 1, 100, date=self.d2); self.close(shift)
        ws = WorkShift.objects.create(employee=worker, store=self.store, date=self.d2, cash_shift=shift, shift_rate=0, bonus_percent=10, bonus_basis='store')
        self.assertEqual(self.v('payroll', employee=worker.pk, date=self.yesterday, payload={'shift_ids': [ws.pk]}).total, Decimal('90.00'))
        self.assertEqual(self.owner_report()['cashiers'][0]['late_return_bonus'], '0.00')

    def test_profit_and_personal_bases_and_multiple_percent_rows(self):
        worker, shift, sale, ws, payroll = self.late_return(basis='profit')
        # A second employee's percent row on the same cash shift also paid its own percent.
        partner = Employee.objects.create(name='Partner', store=self.store, shift_rate=0, bonus_percent=5)
        other = WorkShift.objects.create(employee=partner, store=self.store, date=self.d2, cash_shift=shift, shift_rate=0, bonus_percent=5, bonus_basis='store')
        self.v('payroll', employee=partner.pk, date=self.yesterday, payload={'shift_ids': [other.pk]})
        self.cash_return(sale, self.till(), 2, 100)
        # Return total 200, cost 10 (2 x 5): profit basis 190 x 10% = 19.00, store basis 200 x 5% = 10.00.
        self.assertEqual(self.owner_report()['cashiers'][0]['late_return_bonus'], '29.00')

    def test_late_amount_is_capped_by_the_accrued_basis(self):
        # Loss-making profit shift: basis 0 although 100 was accrued as the rate; a later return adds no bonus.
        worker = Employee.objects.create(name='Worker', store=self.store, shift_rate=100, bonus_percent=10)
        shift = self.till(worker); a = self.cash_sale(shift, 5, 1); b = self.cash_sale(shift, 5, 6); self.close(shift)
        ws = WorkShift.objects.create(employee=worker, store=self.store, date=self.d2, cash_shift=shift, shift_rate=100, bonus_percent=10, bonus_basis='profit')
        self.v('payroll', employee=worker.pk, date=self.yesterday, payload={'shift_ids': [ws.pk]})
        ws.refresh_from_db(); self.assertEqual((ws.basis_amount, ws.accrued), (Decimal('0.00'), Decimal('100.00')))
        self.cash_return(b, self.till(), 5, 6)
        self.assertEqual(self.owner_report()['cashiers'][0]['late_return_bonus'], '0.00')

    def test_query_count_does_not_grow_with_returns(self):
        worker, shift, sale, ws, payroll = self.late_return()
        self.cash_return(sale, self.till(), 1, 100)
        with CaptureQueriesContext(connection) as one: late_return_bonus(self.u, timezone.localdate(), timezone.localdate())
        for _ in range(9): self.cash_return(sale, self.till(), 1, 100)
        with CaptureQueriesContext(connection) as ten: result = late_return_bonus(self.u, timezone.localdate(), timezone.localdate())
        self.assertEqual(len(one), len(ten))
        self.assertEqual(list(result.values())[0][0], Decimal('100.00'))

    def test_reversed_or_reposted_payroll_is_not_counted(self):
        worker, shift, sale, ws, payroll = self.late_return()
        self.cash_return(sale, self.till(), 1, 100)
        self.assertEqual(self.owner_report()['cashiers'][0]['late_return_bonus'], '10.00')
        reverse_voucher(self.u, payroll.pk, 'test')
        self.assertEqual(self.owner_report()['cashiers'][0]['late_return_bonus'], '0.00')
        # Re-posted on the return date: the accrual already saw the return, so it is not late.
        self.v('payroll', employee=worker.pk, date=self.today, payload={'shift_ids': [ws.pk]})
        self.assertEqual(self.owner_report()['cashiers'][0]['late_return_bonus'], '0.00')

    def test_return_in_period_of_sale_from_earlier_closed_shift(self):
        worker, shift, sale, ws, payroll = self.late_return()
        CashShift.objects.filter(pk=shift.pk).update(closed_at=timezone.now() - timedelta(days=2))
        self.cash_return(sale, self.till(), 1, 100)
        (row,) = report(self.u, {'from': self.today, 'to': self.today})['cashiers']
        self.assertEqual((row['name'], row['shifts'], row['late_return_bonus']), ('Worker', 0, '10.00'))
        # The same return is outside a period that ends before it was posted.
        self.assertEqual(report(self.u, {'from': self.d3, 'to': self.yesterday})['cashiers'][0]['late_return_bonus'], '0.00')

    def test_store_bound_accountant_sees_only_own_store(self):
        worker, shift, sale, ws, payroll = self.late_return()
        self.cash_return(sale, self.till(), 1, 100)
        mine = User.objects.create(username='acc1'); Profile.objects.create(user=mine, role='accountant', store=self.store)
        foreign = Store.objects.create(name='Foreign'); acc2 = User.objects.create(username='acc2'); Profile.objects.create(user=acc2, role='accountant', store=foreign)
        self.assertEqual(report(mine, {})['cashiers'][0]['late_return_bonus'], '10.00')
        self.assertEqual(report(acc2, {})['cashiers'], [])

    def test_personal_basis_counts_only_own_sales(self):
        stranger = Employee.objects.create(name='Stranger', store=self.store, shift_rate=0)
        worker, shift, sale, ws, payroll = self.late_return(basis='personal', personal_seller=stranger, rate=100)
        self.cash_return(sale, self.till(), 1, 100)
        self.assertEqual(self.owner_report()['cashiers'][0]['late_return_bonus'], '0.00')

    def test_late_bonus_is_hidden_from_roles_without_salary_access(self):
        worker, shift, sale, ws, payroll = self.late_return()
        self.cash_return(sale, self.till(), 1, 100)
        manager = User.objects.create(username='manager'); Profile.objects.create(user=manager, role='manager')
        accountant = User.objects.create(username='acc'); Profile.objects.create(user=accountant, role='accountant')
        self.assertNotIn('late_return_bonus', report(manager, {})['cashiers'][0])
        self.assertEqual(report(accountant, {})['cashiers'][0]['late_return_bonus'], '10.00')
        # A period that does not contain the late return excludes it (the shift itself closed earlier than the range too).
        self.assertEqual(report(self.u, {'from': self.d3, 'to': self.yesterday})['cashiers'], [])

    def test_timesheet_hint_lists_other_employees_percent_rows_for_owner_and_accountant_only(self):
        a = Employee.objects.create(name='A', store=self.store, shift_rate=0, bonus_percent=10)
        b = Employee.objects.create(name='B', store=self.store, shift_rate=0, bonus_percent=10)
        c = Employee.objects.create(name='C', store=self.store, shift_rate=0, bonus_percent=0)
        shift = self.till(a); self.cash_sale(shift, 1, 100); self.close(shift)
        for e, percent in [(a, 10), (c, 0)]:
            self.save_work(e, self.today, shift, str(percent), '300' if percent == 0 else '0')
        ask = lambda **q: work_shifts(self.u, {'cash_shift': str(shift.pk), 'percent': '1', 'exclude_employee': str(b.pk), **q})
        self.assertEqual([x['employee_id'] for x in ask()['items']], [a.pk])
        self.assertEqual(ask(exclude_employee=str(a.pk))['total'], 0)
        with self.assertRaises(BusinessError):ask(cash_shift='x')
        with self.assertRaisesMessage(BusinessError, 'Невідомий режим відбору відсотків табеля.'):ask(percent='2')
        with self.assertRaisesMessage(BusinessError, 'ID виключеного працівника'):ask(exclude_employee='x')
        # Both employees keep their own percent of the whole turnover.
        self.save_work(b, self.today, shift, '10')
        self.assertEqual(self.v('payroll', employee=a.pk, payload={'shift_ids': [WorkShift.objects.get(employee=a, bonus_percent=10).pk]}).total, Decimal('10.00'))
        cashier = User.objects.create(username='cashier'); Profile.objects.create(user=cashier, role='cashier', store=self.store)
        with self.assertRaisesMessage(BusinessError, 'Недостатньо прав для зарплати.'):work_shifts(cashier, {'cash_shift': str(shift.pk), 'percent': '1'})
        accountant = User.objects.create(username='acc'); Profile.objects.create(user=accountant, role='accountant')
        self.assertEqual(work_shifts(accountant, {'cash_shift': str(shift.pk), 'percent': '1'})['total'], 2)
