"""B17 historical accounting dates, reversals, transfers, scope and read snapshot. Isolated data."""
import hashlib
import time
from datetime import date, datetime, timezone as utc
from decimal import Decimal
from unittest import mock, skipUnless
from threading import Thread
from django.db import connection, connections, close_old_connections, transaction, DatabaseError
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import *
from server.erp.services import *
from server.erp.reporting import report
from server.erp.historical_reports import read_snapshot
from tests.test_erp import AccountingFixture


class HistoricalReportTests(TransactionTestCase):
    v = AccountingFixture.v
    sale = AccountingFixture.sale
    cash_start = AccountingFixture.cash_start

    def setUp(self):
        AccountingFixture.setUp(self)
        self.today = '2026-09-29'
        self.receipt = self.v('receipt', 10, 5)
        self.today = '2026-09-30'
        self.sold = self.v('sale', 2, 10, party=self.customer.pk)
        self.today = '2026-10-01'
        self.payment = self.v('payment', amount=10, account=self.bank.pk, reference=self.sold.pk)
        reverse_voucher(self.u, self.payment.pk, 'Скасування платежу')
        # 21:30 UTC is the next day in Kyiv: reversal belongs to Oct 2, never Sep 30/Oct 1.
        Voucher.objects.filter(pk=self.payment.pk).update(reversed_at=datetime(2026, 10, 1, 21, 30, tzinfo=utc.utc))
        reverse_voucher(self.u, self.sold.pk, 'Скасування продажу')
        Voucher.objects.filter(pk=self.sold.pk).update(reversed_at=datetime(2026, 10, 3, 9, tzinfo=utc.utc))

    def balance(self, date, user=None, **params):
        return report(user or self.u, {'mode': 'balances', 'as_of': date, **params})

    def user(self, role, store=None):
        user = User.objects.create(username=role + str(User.objects.count()))
        Profile.objects.create(user=user, role=role, store=store)
        return user

    def test_future_payment_does_not_change_old_debt_and_kyiv_reversal_reinstates_it(self):
        for cutoff, owed, cash, stock in [('2026-09-30', '20.00', '0.00', '8.000'),
                                          ('2026-10-01', '10.00', '10.00', '8.000'),
                                          ('2026-10-02', '20.00', '0.00', '8.000'),
                                          ('2026-10-03', '0.00', '0.00', '10.000')]:
            result = self.balance(cutoff)
            self.assertEqual(result['debt_totals']['owed_to_us'], owed, cutoff)
            self.assertEqual(result['debt_totals']['owed_by_us'], '50.00', cutoff)
            self.assertEqual(result['cash_total'], cash, cutoff)
            self.assertEqual(result['stock'][0]['quantity'], stock, cutoff)
        self.assertEqual(StockLot.objects.get().quantity, 10)  # Current balance differs from Sep 30.

    def test_period_storno_is_in_cancellation_month_and_products_match(self):
        september = report(self.u, {'mode': 'period', 'from': '2026-09-01', 'to': '2026-09-30'})
        october = report(self.u, {'mode': 'period', 'from': '2026-10-01', 'to': '2026-10-03'})
        self.assertEqual((september['revenue'], september['cogs'], september['profit']), ('20.00', '10.00', '10.00'))
        self.assertEqual((october['revenue'], october['cogs'], october['profit'], october['cash_net']), ('-20.00', '-10.00', '-10.00', '0.00'))
        self.assertEqual(october['products'][0]['quantity'], '-2.000')
        self.assertEqual(october['products'][0]['revenue'], '-20.00')
        self.assertEqual(september['debts_basis'], 'current')

    def test_return_and_refund_after_cutoff_do_not_change_historical_debt(self):
        self.today = '2026-10-03'
        sale = self.v('sale', 2, 10, party=self.customer.pk, payload={'payments': [{'account': self.bank.pk, 'amount': '10'}]})
        self.today = '2026-10-04'
        self.v('customer_return', 1, 10, reference=sale.pk, party=self.customer.pk)
        self.assertEqual(self.balance('2026-10-03')['debt_totals']['owed_to_us'], '10.00')
        self.assertEqual(self.balance('2026-10-04')['debt_totals']['owed_to_us'], '0.00')

    def test_network_expenses_are_unallocated_and_store_totals_reconcile(self):
        self.today = '2026-10-03'; self.cash_start()
        local = self.v('expense', amount=10, account=self.cash.pk, payload={'category': 'Оренда'})
        network = self.v('expense', amount=20, account=self.cash.pk, payload={'category': 'Мережа', 'expense_scope': 'network'})
        result = report(self.u, {'mode': 'period', 'from': self.today, 'to': self.today})
        self.assertEqual(result['unallocated_expenses'], '20.00')
        self.assertEqual(result['expenses'], '30.00')
        self.assertEqual(sum(Decimal(row['profit']) for row in result['by_store']) - Decimal(result['unallocated_expenses']), Decimal(result['profit']))
        store_result = report(self.u, {'mode': 'period', 'from': self.today, 'to': self.today, 'store': str(self.store.pk)})
        self.assertEqual(store_result['expenses'], '10.00')
        self.assertEqual(store_result['cash_net'], '-30.00')  # The paying account remains authoritative.
        self.assertEqual(local.payload['expense_scope'], 'store')
        self.assertEqual(AuditEvent.objects.filter(subject=f'voucher/{network.pk}', action='draft_saved').get().detail['expense_scope'], 'network')
        manager = self.user('manager', self.store)
        draft = save_voucher(self.u, {'kind': 'expense', 'store': self.store.pk, 'date': self.today, 'account': self.cash.pk, 'amount': 5, 'payload': {'expense_scope': 'network'}})
        for operation in (lambda: post_voucher(manager, draft.pk), lambda: save_voucher(manager, {'kind': 'expense', 'store': self.store.pk, 'date': self.today, 'account': self.cash.pk, 'amount': 5, 'revision': draft.revision}, draft.pk)):
            with self.assertRaises(BusinessError): operation()
        with self.assertRaises(BusinessError):
            save_voucher(manager, {'kind': 'expense', 'store': self.store.pk, 'date': self.today, 'account': self.cash.pk, 'amount': 5, 'payload': {'expense_scope': 'network'}})

    def test_target_transfer_is_visible_in_own_store_cash_and_stock(self):
        other_store = Store.objects.create(name='Target'); target = Warehouse.objects.create(store=other_store, name='Target')
        bank = CashAccount.objects.create(store=other_store, name='Target bank', kind='bank')
        self.today = '2026-10-03'; self.cash_start()
        self.v('cash_transfer', amount=50, account=self.cash.pk, payload={'target_account': bank.pk})
        self.v('transfer', 3, target=target.pk)
        manager = self.user('manager', other_store)
        result = self.balance(self.today, manager)
        self.assertEqual(result['cash_total'], '50.00')
        self.assertEqual(result['stock'][0]['quantity'], '3.000')
        self.assertEqual(result['stock_value'], '15.00')
        self.assertTrue(all(row['store'] == other_store.pk for row in result['cash'] + result['stock']))
        self.assertEqual(report(manager, {'mode': 'period', 'from': self.today, 'to': self.today})['cash_net'], '50.00')
        with self.assertRaises(BusinessError): self.balance(self.today, manager, store=self.store.pk)

    def test_roles_read_only_snapshot_and_salary_privacy(self):
        for role in ('cashier', 'warehouse'):
            with self.assertRaises(BusinessError): self.balance('2026-09-30', self.user(role, self.store))
        manager = self.user('manager', self.store)
        self.assertNotIn('payroll_debts', self.balance('2026-09-30', manager))
        with CaptureQueriesContext(connection) as queries: self.balance('2026-09-30')
        writes = [q['sql'] for q in queries if q['sql'].lstrip().split(' ', 1)[0].upper() in {'INSERT', 'UPDATE', 'DELETE'}]
        self.assertEqual(writes, [])
        for bad in ({'mode': 'bad'}, {'mode': 'balances', 'as_of': 'bad'}, {'mode': 'period', 'from': '2026-10-04', 'to': '2026-10-01'}):
            with self.assertRaises(BusinessError): report(self.u, bad)

    @skipUnless(connection.vendor == 'postgresql', 'PostgreSQL snapshot semantics')
    def test_postgres_report_keeps_snapshot_when_concurrent_payment_commits(self):
        self.today = '2026-10-01'; self.cash_start()
        with read_snapshot():
            before = Voucher.objects.count()
            errors = []
            def write():
                close_old_connections()
                try:
                    actor = User.objects.get(pk=self.u.pk)
                    saved = save_voucher(actor, {'kind': 'payment', 'store': self.store.pk, 'date': self.today,
                        'account': self.cash.pk, 'reference': self.receipt.pk, 'amount': 5})
                    post_voucher(actor, saved.pk)
                except Exception as error: errors.append(str(error))
                finally: connections.close_all()
            thread = Thread(target=write); thread.start(); thread.join(5)
            self.assertFalse(thread.is_alive()); self.assertEqual(errors, [])
            self.assertEqual(Voucher.objects.count(), before)
            same_snapshot = self.balance('2026-10-01')
            self.assertEqual(same_snapshot['debt_totals']['owed_by_us'], '50.00')
            self.assertEqual(same_snapshot['cash_total'], '1010.00')
        after = self.balance('2026-10-01')
        self.assertEqual(after['debt_totals']['owed_by_us'], '45.00')
        self.assertEqual(after['cash_total'], '1005.00')

    def test_by_store_includes_payroll_writeoff_inventory_and_signed_cash_difference(self):
        from unittest.mock import patch
        self.today = '2026-10-03'; self.cash_start()
        self.v('writeoff', 1)
        self.v('inventory', 8, 5)
        employee = Employee.objects.create(name='Працівник', store=self.store, shift_rate=100)
        work = WorkShift.objects.create(employee=employee, store=self.store, date=self.today, shift_rate=100, bonus_percent=0, bonus_basis='store')
        self.v('payroll', employee=employee.pk, payload={'shift_ids': [work.pk]})
        shift = CashShift.objects.create(store=self.store, account=self.cash, opened_by=self.u, opening_cash=1000, expected_cash=1000, counted_cash=998)
        with patch('server.erp.services.timezone.localdate', return_value=date(2026, 10, 3)):
            post_cash_difference(self.u, shift)
        result = report(self.u, {'mode': 'period', 'from': self.today, 'to': self.today})
        store = result['by_store'][0]
        self.assertEqual((store['payroll'], store['writeoffs'], store['inventory_adjustment'], store['cash_difference']), ('100.00', '5.00', '-5.00', '-2.00'))
        self.assertEqual(store['profit'], result['profit'])
        manager = self.user('manager', self.store)
        self.assertEqual(report(manager, {'mode': 'period', 'from': self.today, 'to': self.today})['by_store'][0]['payroll'], '100.00')
        self.assertNotIn('payroll_debts', self.balance(self.today, manager))

    def test_api_roles_and_allocation_reverse_delete_guard(self):
        self.today = '2026-10-03'; self.cash_start()
        draft = save_voucher(self.u, {'kind': 'expense', 'store': self.store.pk, 'date': self.today, 'account': self.cash.pk, 'amount': 5, 'payload': {'expense_scope': 'network'}})
        posted = self.v('expense', amount=5, account=self.cash.pk, payload={'expense_scope': 'network'})
        manager = self.user('manager', self.store)
        with self.assertRaises(BusinessError): reverse_voucher(manager, posted.pk, 'Ні')
        for role in ('cashier', 'manager', 'accountant'):
            user = self.user(role, self.store)
            token = 'b17-isolated-' + role
            PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), user=user, csrf='b17-csrf', expires=int(time.time()) + 3600)
            self.client.cookies['ts_session'] = token
            result = self.client.get('/api/erp/report?mode=balances&as_of=2026-10-03')
            self.assertEqual(result.status_code, 403 if role == 'cashier' else 200, result.content)
            if role == 'manager':
                self.assertNotIn('payroll_debts', result.json())
                deleted = self.client.delete(f'/api/erp/vouchers/{draft.pk}', {'revision': draft.revision}, content_type='application/json', HTTP_ORIGIN='http://testserver', HTTP_X_CSRF_TOKEN='b17-csrf')
                self.assertEqual(deleted.status_code, 403)
            if role == 'accountant':
                self.assertEqual(post_voucher(user, draft.pk).status, 'posted')

    def test_foreign_store_filter_is_empty_in_both_report_modes(self):
        manager = self.user('manager', self.store)
        foreign = Store.objects.create(name='Недоступний магазин')
        for selected in (foreign.pk, foreign.pk + 100000):
            for mode in ('period', 'balances'):
                result = report(manager, {'mode': mode, 'store': str(selected)})
                if mode == 'period':
                    self.assertEqual(result['revenue'], '0.00')
                    for field in ('by_store', 'products', 'cashiers', 'debts'):
                        self.assertEqual(result[field], [])
                else:
                    for field in ('stock', 'cash', 'debts'):
                        self.assertEqual(result[field], [])
                    self.assertEqual(result['cash_total'], '0.00')
                self.assertEqual(result['debt_totals'], {'owed_to_us': '0.00', 'owed_by_us': '0.00'})

    def test_ledger_filter_and_display_use_kyiv_storno_date(self):
        from server.erp.financial_browsing import ledger
        october1 = ledger(self.u, {'from': '2026-10-01', 'to': '2026-10-01'})
        october2 = ledger(self.u, {'from': '2026-10-02', 'to': '2026-10-02'})
        self.assertEqual([(row['date'].isoformat(), row['amount'], row['reversal']) for row in october1['entries']], [('2026-10-01', '10.00', False)])
        self.assertEqual([(row['date'].isoformat(), row['amount'], row['reversal']) for row in october2['entries']], [('2026-10-02', '-10.00', True)])

    def test_missing_reversal_timestamp_refuses_invented_historical_date(self):
        Voucher.objects.filter(pk=self.sold.pk).update(reversed_at=None)
        with self.assertRaisesMessage(BusinessError, 'без дати скасування'):
            self.balance('2026-09-30')
        with self.assertRaisesMessage(BusinessError, 'без дати скасування'):
            report(self.u, {'mode': 'period', 'from': '2026-09-01', 'to': '2026-09-30'})
        # A cutoff before the original document remains determinable.
        self.assertEqual(self.balance('2026-09-29')['stock_value'], '50.00')

    @skipUnless(connection.vendor == 'postgresql', 'PostgreSQL snapshot contract')
    def test_explicit_modes_require_nested_readonly_snapshot_legacy_caller_stays_compatible(self):
        with transaction.atomic():
            with self.assertRaisesMessage(BusinessError, 'REPEATABLE READ'):
                self.balance('2026-09-30')
            legacy = report(self.u, {'from': '2026-09-01', 'to': '2026-09-30'})
            self.assertEqual(legacy['revenue'], '20.00')
        with read_snapshot():
            with self.assertRaises(DatabaseError):
                with transaction.atomic():
                    Document.objects.create(path='products/forbidden', data={'name': 'No write'})
            self.assertFalse(Document.objects.filter(pk='products/forbidden').exists())
