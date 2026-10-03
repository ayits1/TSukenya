"""B04 per-employee percent of one cash shift and B05 final bonus with the late-return report column. Isolated data only."""
import json
from datetime import timedelta
from decimal import Decimal
from django.utils import timezone
from server.erp.models import *
from server.erp.services import *
from server.erp.reporting import report
from server.erp.shift_browsing import work_shifts
from tests import test_erp
from tests.test_erp import AccountingFixture


class PayrollRuleTests(AccountingFixture):
    def setUp(self):
        super().setUp(); self.cash_start(); self.v('receipt', 10, 5)
        self.yesterday = (timezone.localdate() - timedelta(days=1)).isoformat()
    till = test_erp.PayrollAndCashControlTests.till
    cash_sale = test_erp.PayrollAndCashControlTests.cash_sale
    cash_return = test_erp.PayrollAndCashControlTests.cash_return
    save_work = test_erp.PayrollAndCashControlTests.save_work

    def close(self, shift):
        shift.closed_at = timezone.now(); shift.expected_cash = shift.counted_cash = cash_balance(self.cash); shift.save()

    def late_return(self, percent=10, basis='store', employee=None, personal_seller=None, rate=0):
        """Sale D1, accrual D1, return posted on a later date (the accrual date moved into the past)."""
        worker = employee or Employee.objects.create(name='Worker', store=self.store, shift_rate=0, bonus_percent=percent)
        shift = self.till(worker)
        sale = self.cash_sale(shift, 10, 100)
        if personal_seller is not None:
            Voucher.objects.filter(pk=sale.pk).update(employee=personal_seller)
        self.close(shift)
        ws = WorkShift.objects.create(employee=worker, store=self.store, date=self.today, cash_shift=shift, shift_rate=rate, bonus_percent=percent, bonus_basis=basis)
        payroll = self.v('payroll', employee=worker.pk, payload={'shift_ids': [ws.pk]})
        Voucher.objects.filter(pk=payroll.pk).update(date=timezone.localdate() - timedelta(days=1))
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

    def test_return_before_accrual_is_not_late(self):
        worker = Employee.objects.create(name='Worker', store=self.store, shift_rate=0, bonus_percent=10)
        shift = self.till(worker); sale = self.cash_sale(shift, 10, 100)
        self.cash_return(sale, shift, 1, 100); self.close(shift)
        ws = WorkShift.objects.create(employee=worker, store=self.store, date=self.today, cash_shift=shift, shift_rate=0, bonus_percent=10, bonus_basis='store')
        self.assertEqual(self.v('payroll', employee=worker.pk, payload={'shift_ids': [ws.pk]}).total, Decimal('90.00'))
        self.assertEqual(self.owner_report()['cashiers'][0]['late_return_bonus'], '0.00')

    def test_profit_and_personal_bases_and_multiple_percent_rows(self):
        worker, shift, sale, ws, payroll = self.late_return(basis='profit')
        # A second employee's percent row on the same cash shift also paid its own percent.
        partner = Employee.objects.create(name='Partner', store=self.store, shift_rate=0, bonus_percent=5)
        other = WorkShift.objects.create(employee=partner, store=self.store, date=self.today, cash_shift=shift, shift_rate=0, bonus_percent=5, bonus_basis='store')
        p2 = self.v('payroll', employee=partner.pk, payload={'shift_ids': [other.pk]})
        Voucher.objects.filter(pk=p2.pk).update(date=timezone.localdate() - timedelta(days=1))
        self.cash_return(sale, self.till(), 2, 100)
        # Return total 200, cost 10 (2 x 5): profit basis 190 x 10% = 19.00, store basis 200 x 5% = 10.00.
        self.assertEqual(self.owner_report()['cashiers'][0]['late_return_bonus'], '29.00')

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
        # Store scope and period filters.
        self.assertEqual(report(self.u, {'from': (timezone.localdate() + timedelta(days=1)).isoformat(), 'to': (timezone.localdate() + timedelta(days=1)).isoformat()})['cashiers'], [])

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
        # Both employees keep their own percent of the whole turnover.
        self.save_work(b, self.today, shift, '10')
        self.assertEqual(self.v('payroll', employee=a.pk, payload={'shift_ids': [WorkShift.objects.get(employee=a, bonus_percent=10).pk]}).total, Decimal('10.00'))
        cashier = User.objects.create(username='cashier'); Profile.objects.create(user=cashier, role='cashier', store=self.store)
        with self.assertRaisesMessage(BusinessError, 'Недостатньо прав для зарплати.'):work_shifts(cashier, {'cash_shift': str(shift.pk), 'percent': '1'})
        accountant = User.objects.create(username='acc'); Profile.objects.create(user=accountant, role='accountant')
        self.assertEqual(work_shifts(accountant, {'cash_shift': str(shift.pk), 'percent': '1'})['total'], 2)
