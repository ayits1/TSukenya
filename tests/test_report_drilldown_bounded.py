"""Narrow report-source bounds, privacy and exact old contribution parity."""
from contextlib import contextmanager
from decimal import Decimal
from unittest.mock import patch
from django.db import connection
from django.db.models import JSONField
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from server.erp import report_drilldown as reads
from server.erp.models import Voucher, CashEntry, Profile
from server.erp.services import BusinessError
from tests import test_erp as fixture


class BoundedSourceTests(TransactionTestCase):
    def setUp(self):
        fixture.AccountingFixture.setUp(self)
        self.today = timezone.localdate().isoformat()

    def voucher(self, kind, **values):
        return Voucher.objects.create(kind=kind, status='posted', date=self.today,
                                      store=self.store, created_by=self.u, **values)

    @contextmanager
    def no_payload(self):
        decode = JSONField.from_db_value
        refresh = Voucher.refresh_from_db
        def decoded(field, value, expression, conn):
            result = decode(field, value, expression, conn)
            if isinstance(result, dict) and 'private_fanout' in result:
                raise AssertionError('whole voucher payload materialized')
            return result
        def fetched(voucher, *args, **kwargs):
            if 'payload' in (kwargs.get('fields') or []):
                raise AssertionError('deferred whole voucher payload fetched')
            return refresh(voucher, *args, **kwargs)
        with patch.object(JSONField, 'from_db_value', decoded), patch.object(Voucher, 'refresh_from_db', fetched):
            yield

    def test_inventory_501_children_and_order_exact_without_payload(self):
        inventory = self.voucher('inventory', payload={'differences': [
            {'value': '0.01', 'product': {'ignored': list(range(20))}} for _ in range(501)
        ], 'private_fanout': list(range(501))})
        amount = Decimal('100000000000000.99' if connection.vendor == 'postgresql' else '10000.99')
        sale = self.voucher('sale', total=amount, cost=Decimal('0.01'),
                            payload={'private_fanout': list(range(501))})
        with self.no_payload(), CaptureQueriesContext(connection) as queries:
            data = reads.drilldown(self.u, {'from': self.today, 'to': self.today, 'metric': 'profit'})
        self.assertEqual(data['amount'], str(amount + Decimal('5.00')))
        self.assertEqual([(x['voucher'], x['metric'], x['amount']) for x in data['items']],
                         [(inventory.pk, 'inventory_adjustment', '5.01'),
                          (sale.pk, 'revenue', str(amount)), (sale.pk, 'cogs', '-0.01')])
        self.assertTrue(any('json_each' in x['sql'] or 'jsonb_array_elements' in x['sql'] for x in queries))
        self.assertEqual(Voucher.objects.count(), 2)
        Voucher.objects.filter(pk=inventory.pk).update(payload={'differences': [{'value': None}]})
        with self.assertRaisesMessage(BusinessError, f'Документ {inventory.pk}'):
            reads.drilldown(self.u, {'from': self.today, 'to': self.today, 'metric': 'profit'})

    def test_entry_fanout_page_clamp_salary_and_expense_scope(self):
        expense = self.voucher('expense', total=Decimal('20.07'),
                              payload={'expense_scope': [], 'private_fanout': list(range(501))})
        payroll = self.voucher('payroll', total=Decimal('10.00'),
                              payload={'private_fanout': list(range(501))})
        CashEntry.objects.bulk_create([CashEntry(voucher=expense, account=self.cash, amount=Decimal('0.01')) for _ in range(205)] +
                                     [CashEntry(voucher=payroll, account=self.cash, amount=Decimal('-10'))])
        Profile.objects.filter(user=self.u).update(role='manager', store=self.store)
        with self.no_payload():
            data = reads.drilldown(self.u, {'from': self.today, 'to': self.today, 'metric': 'cash_net', 'page': '999'})
            balance = reads.drilldown(self.u, {'mode': 'balances', 'as_of': self.today, 'metric': 'cash', 'source': str(self.cash.pk), 'page': '999'})
        for value in (data, balance):
            self.assertEqual(value['amount'], '-7.95')
            self.assertEqual((value['total'], value['page'], len(value['items'])), (206, 7, 26))
            self.assertEqual(value['items'][-1], {'type': 'aggregate', 'metric': 'cash_net' if value['mode'] == 'period' else 'cash',
                                               'amount': '-10.00', 'label': 'Зарплата — сукупна сума без персональних документів', 'canOpen': False})
            self.assertTrue(all(x['canOpen'] for x in value['items'][:-1]))
        with self.no_payload():
            period = reads.drilldown(self.u, {'from': self.today, 'to': self.today, 'metric': 'expenses'})
        self.assertEqual(period['amount'], '20.07')

    def test_cached_actor_rechecked_inside_readonly_snapshot(self):
        self.u.profile  # Prime the formerly accepted role.
        Profile.objects.filter(user=self.u).update(role='cashier')
        with self.assertRaises(BusinessError):
            reads.drilldown(self.u, {'from': self.today, 'to': self.today, 'metric': 'profit'})
        Profile.objects.filter(user=self.u).update(role='owner')
        original = reads.current_actor
        seen = []
        def actor(user):
            self.assertTrue(connection.in_atomic_block)
            if connection.vendor == 'postgresql':
                with connection.cursor() as cursor:
                    cursor.execute('SHOW transaction_isolation'); self.assertEqual(cursor.fetchone()[0], 'repeatable read')
                    cursor.execute('SHOW transaction_read_only'); self.assertEqual(cursor.fetchone()[0], 'on')
            seen.append(user.pk)
            return original(user)
        with patch.object(reads, 'current_actor', actor):
            self.assertEqual(reads.drilldown(self.u, {'from': self.today, 'to': self.today, 'metric': 'profit'})['amount'], '0.00')
        self.assertEqual(seen, [self.u.pk])
