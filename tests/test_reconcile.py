"""B25 read-only reconciliation command: a consistent ledger passes, one corrupted row gives its exact ID. Isolated data only."""
import json
from decimal import Decimal
from django.db.models import F
from django.db import connection, transaction, DatabaseError
from django.test import TransactionTestCase
from unittest import mock, skipUnless
from django.utils import timezone
from io import StringIO
from django.core.management import call_command
from django.core.management.base import CommandError
from server.erp.models import *
from server.erp.reconcile import reconcile
from server.erp.services import *
from tests.test_erp import AccountingFixture


class ReconcileTests(TransactionTestCase):
    # Command tests need committed fixtures; PostgreSQL TestCase's READ WRITE outer
    # transaction deliberately cannot satisfy the command's snapshot contract.
    v = AccountingFixture.v
    cash_start = AccountingFixture.cash_start
    sale = AccountingFixture.sale

    def setUp(self):
        self.u=User.objects.create(username='owner');Profile.objects.create(user=self.u,role='owner');LedgerLock.objects.create(pk=1)
        self.store=Store.objects.create(name='Test');self.wh=Warehouse.objects.create(store=self.store,name='Stock');self.other=Warehouse.objects.create(store=self.store,name='Other')
        self.cash=CashAccount.objects.create(store=self.store,name='Cash',kind='cash');self.bank=CashAccount.objects.create(store=self.store,name='Bank',kind='bank')
        self.party=Counterparty.objects.create(name='Supplier',kind='supplier');self.customer=Counterparty.objects.create(name='Customer',kind='customer')
        self.p=Document.objects.create(path='products/p',data={'name':'Product','unit':'шт'})
        self.today=timezone.localdate().isoformat()
        self.cash_start(); self.v('cash_opening', amount=100, account=self.bank.pk) if False else None
        self.receipt = self.v('receipt', 20, 5, payload={'additional_cost': '10'})
        d = self.v('debt_opening', amount=80, party=self.party.pk)
        self.v('payment', amount=30, account=self.cash.pk, reference=d.pk)
        self.sale_doc = self.sale(3)
        self.v('customer_return', 1, 10, reference=self.sale_doc.pk, party=self.customer.pk, payload={'payments': [{'account': self.bank.pk, 'amount': '10'}]})
        self.v('supplier_return', 1, 5, reference=self.receipt.pk)
        self.v('payment', amount=40, account=self.cash.pk, reference=self.receipt.pk)
        self.v('transfer', 2, target=self.other.pk); self.v('writeoff', 1); self.v('inventory', 12, 5)
        Document.objects.create(path='products/out', data={'name': 'Ready', 'unit': 'шт', 'recipe': [{'product': 'p', 'quantity': '2'}]})
        post_voucher(self.u, save_voucher(self.u, {'kind': 'production', 'store': self.store.pk, 'warehouse': self.wh.pk, 'date': self.today, 'lines': [{'product': 'out', 'quantity': 2}]}).pk)
        self.v('expense', amount=20, account=self.cash.pk); self.v('cash_transfer', amount=100, account=self.cash.pk, payload={'target_account': self.bank.pk})
        self.v('purchase_order', 4, 5); self.v('customer_order', 2, 7, party=self.customer.pk)
        worker = Employee.objects.create(name='Worker', store=self.store, shift_rate=300, bonus_percent=5)
        self.till = CashShift.objects.create(store=self.store, account=self.cash, employee=worker, opened_by=self.u, opening_cash=cash_balance(self.cash))
        self.v('sale', 2, 10, shift=self.till.pk, employee=worker.pk, payload={'payments': [{'account': self.cash.pk, 'amount': '20'}]})
        self.till.closed_at = timezone.now(); self.till.save()
        ws = WorkShift.objects.create(employee=worker, store=self.store, date=self.today, cash_shift=self.till, shift_rate=300, bonus_percent=5, bonus_basis='store')
        self.payroll = self.v('payroll', employee=worker.pk, payload={'shift_ids': [ws.pk]}); self.ws = ws
        self.v('payroll_payment', amount=50, account=self.bank.pk, employee=worker.pk)
        self.reversed = self.v('expense', amount=7, account=self.cash.pk); reverse_voucher(self.u, self.reversed.pk, 'test')
        self.reversed_receipt = self.v('receipt', 3, 4, payload={'additional_cost': '1'}); reverse_voucher(self.u, self.reversed_receipt.pk, 'test')

    def issues(self, name=None):
        found = reconcile()['checks']
        return [x for k, c in found.items() if name in (None, k) for x in c['issues']]

    def run_command(self, *args):
        out = StringIO()
        try: call_command('reconcile', *args, stdout=out); code = 0
        except CommandError: code = 1
        return code, out.getvalue()

    def test_consistent_ledger_passes_and_command_exits_zero(self):
        self.assertEqual(self.issues(), [])
        code, text = self.run_command()
        self.assertEqual(code, 0); self.assertIn('Розбіжностей не знайдено', text)
        code, text = self.run_command('--json')
        self.assertEqual((code, json.loads(text)['issues']), (0, 0))

    def test_command_never_writes(self):
        before = [(m, m.objects.count()) for m in (Voucher, StockLot, StockEntry, CashEntry, WorkShift, AuditEvent)]
        snapshot = list(StockLot.objects.values_list('pk', 'quantity', 'value'))
        StockLot.objects.filter(pk=StockLot.objects.first().pk).update(quantity=999)
        self.run_command(); self.run_command('--json')
        self.assertEqual([(m, m.objects.count()) for m in (Voucher, StockLot, StockEntry, CashEntry, WorkShift, AuditEvent)], before)
        self.assertEqual(StockLot.objects.get(pk=StockLot.objects.first().pk).quantity, 999)

    def test_lot_quantity_and_value_mismatch_names_the_lot(self):
        lot = StockLot.objects.filter(quantity__gt=0).first()
        StockLot.objects.filter(pk=lot.pk).update(quantity=lot.quantity + 1)
        (x,) = self.issues(); self.assertEqual((x['check'], x['subject']), ('lot_balance', f'stocklot/{lot.pk}'))
        self.assertEqual((Decimal(x['expected']), Decimal(x['actual'])), (lot.quantity, lot.quantity + 1))
        StockLot.objects.filter(pk=lot.pk).update(quantity=lot.quantity, value=lot.value + 1)
        (x,) = self.issues(); self.assertEqual(x['subject'], f'stocklot/{lot.pk}'); self.assertIn('вартість', x['message'])
        code, text = self.run_command(); self.assertEqual(code, 1); self.assertIn(f'stocklot/{lot.pk}', text)
        code, text = self.run_command('--json'); self.assertEqual(code, 1); self.assertEqual(json.loads(text)['checks']['lot_balance']['issues'][0]['subject'], f'stocklot/{lot.pk}')

    def test_voucher_total_mismatch_including_additional_cost_and_zero_kinds(self):
        Voucher.objects.filter(pk=self.receipt.pk).update(total=F('total') - 10)
        (x,) = self.issues(); self.assertEqual((x['check'], x['subject']), ('voucher_total', f'voucher/{self.receipt.pk}'))
        Voucher.objects.filter(pk=self.receipt.pk).update(total=F('total') + 10)
        inventory = Voucher.objects.get(kind='inventory'); Voucher.objects.filter(pk=inventory.pk).update(total=5)
        (x,) = self.issues(); self.assertEqual(x['subject'], f'voucher/{inventory.pk}')
        Voucher.objects.filter(pk=inventory.pk).update(total=0)
        line = self.sale_doc.lines.get(); VoucherLine.objects.filter(pk=line.pk).update(amount=line.amount + 1)
        (x,) = self.issues(); self.assertEqual(x['subject'], f'voucher/{self.sale_doc.pk}')

    def test_duplicate_posting_on_another_lot_is_found_by_quantities(self):
        for kind in ('writeoff', 'transfer'):
            doc = Voucher.objects.get(kind=kind); entry = StockEntry.objects.filter(voucher=doc, quantity__lt=0).first()
            other = StockLot.objects.create(warehouse=entry.lot.warehouse, product=entry.lot.product, code=f'DUP-{kind}', quantity=0, value=0)
            StockEntry.objects.create(voucher=doc, lot=other, quantity=entry.quantity, value=entry.value)
            # per-lot checks stay green for the voucher itself (one main entry per lot); only the quantity comparison catches it
            (x,) = self.issues('double_posting'); self.assertEqual(x['subject'], f'voucher/{doc.pk}'); self.assertGreater(Decimal(x['actual']), Decimal(x['expected']))
            StockEntry.objects.filter(voucher=doc, lot=other).delete(); StockLot.objects.filter(pk=other.pk).delete()
            self.assertEqual(self.issues(), [])

    def test_changed_production_ingredient_movement_is_found(self):
        prod = Voucher.objects.get(kind='production'); e = StockEntry.objects.filter(voucher=prod, quantity__lt=0).first()
        StockEntry.objects.filter(pk=e.pk).update(quantity=e.quantity + 1); self.assertTrue(any(x['subject'] == f'voucher/{prod.pk}' for x in self.issues('double_posting')))
        StockEntry.objects.filter(pk=e.pk).update(quantity=e.quantity); self.assertEqual(self.issues(), [])

    def test_postgres_snapshot_contract_and_nested_guard(self):
        calls = []
        class Cursor:
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def execute(s, sql): calls.append(sql)
            def fetchone(s): return ('repeatable read' if calls[-1].endswith('isolation') else 'on',)
        fake = mock.Mock(vendor='postgresql', in_atomic_block=False, cursor=lambda: Cursor())
        with mock.patch('server.erp.management.commands.reconcile.connection', fake): self.run_command()
        self.assertEqual(calls, ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'])
        calls.clear(); fake.in_atomic_block = True
        with mock.patch('server.erp.management.commands.reconcile.connection', fake):
            with mock.patch('server.erp.management.commands.reconcile.reconcile') as runner:
                runner.return_value = {'checks': {}, 'issues': 0, 'counts': {'lots': 0, 'vouchers': 0, 'stock_entries': 0, 'cash_entries': 0}}
                self.assertEqual(self.run_command()[0], 0); runner.assert_called_once()
        self.assertEqual(calls, ['SHOW transaction_isolation', 'SHOW transaction_read_only'])
        for isolation, read_only in [('read committed', 'on'), ('repeatable read', 'off')]:
            calls.clear()
            cursor = mock.MagicMock(); cursor.__enter__.return_value = cursor
            cursor.fetchone.side_effect = [(isolation,), (read_only,)]
            fake.cursor = mock.Mock(return_value=cursor)
            with mock.patch('server.erp.management.commands.reconcile.connection', fake):
                with mock.patch('server.erp.management.commands.reconcile.reconcile') as runner:
                    self.assertEqual(self.run_command()[0], 1); runner.assert_not_called()

    def test_double_posting_of_stock_and_cash_is_found(self):
        entry = StockEntry.objects.filter(voucher=self.receipt).first()
        StockEntry.objects.create(voucher=self.receipt, lot=entry.lot, quantity=entry.quantity, value=entry.value)
        found = self.issues('double_posting'); self.assertEqual({x['subject'] for x in found}, {f'voucher/{self.receipt.pk}'})
        StockLot.objects.filter(pk=entry.lot_id).update(quantity=F('quantity') + entry.quantity, value=F('value') + entry.value)
        self.assertEqual(self.issues('lot_balance'), [])
        StockEntry.objects.filter(voucher=self.receipt).order_by('-pk').first().delete()
        StockLot.objects.filter(pk=entry.lot_id).update(quantity=F('quantity') - entry.quantity, value=F('value') - entry.value)
        self.assertEqual(self.issues(), [])
        expense = Voucher.objects.filter(kind='expense', status='posted').first(); original = expense.cash_entries.get()
        CashEntry.objects.create(voucher=expense, account=original.account, amount=original.amount)
        (x,) = self.issues(); self.assertEqual((x['check'], x['subject']), ('double_posting', f'voucher/{expense.pk}'))
        self.assertEqual((x['expected'], x['actual']), ('-20.00', '-40.00'))

    def test_draft_with_movements_and_posted_without_stock(self):
        draft = save_voucher(self.u, {'kind': 'receipt', 'store': self.store.pk, 'warehouse': self.wh.pk, 'party': self.party.pk, 'date': self.today, 'lines': [{'product': 'p', 'quantity': 1, 'price': 1}]})
        CashEntry.objects.create(voucher=draft, account=self.cash, amount=1)
        (x,) = self.issues(); self.assertEqual(x['subject'], f'voucher/{draft.pk}')
        CashEntry.objects.filter(voucher=draft).delete(); self.assertEqual(self.issues(), [])
        writeoff = Voucher.objects.get(kind='writeoff'); StockEntry.objects.filter(voucher=writeoff).update(voucher=self.receipt)
        self.assertIn(f'voucher/{writeoff.pk}', {x['subject'] for x in self.issues('double_posting')})

    def test_payroll_total_and_calculation_must_match_shifts(self):
        Voucher.objects.filter(pk=self.payroll.pk).update(total=F('total') + 1)
        (x,) = self.issues(); self.assertEqual((x['check'], x['subject']), ('payroll', f'voucher/{self.payroll.pk}'))
        Voucher.objects.filter(pk=self.payroll.pk).update(total=F('total') - 1); self.assertEqual(self.issues(), [])
        WorkShift.objects.filter(pk=self.ws.pk).update(accrued=F('accrued') + 1)
        found = self.issues('payroll'); self.assertEqual({x['subject'] for x in found}, {f'voucher/{self.payroll.pk}', f'workshift/{self.ws.pk}'})
        WorkShift.objects.filter(pk=self.ws.pk).update(accrued=F('accrued') - 1)
        payload = Voucher.objects.get(pk=self.payroll.pk).payload; payload['calculation'][0]['accrued'] = '1.00'
        Voucher.objects.filter(pk=self.payroll.pk).update(payload=payload)
        (x,) = self.issues(); self.assertEqual(x['subject'], f'voucher/{self.payroll.pk}'); self.assertIn(f'зміна № {self.ws.pk}', x['message'])
        payload['calculation'] = []; Voucher.objects.filter(pk=self.payroll.pk).update(payload=payload)
        (x,) = self.issues(); self.assertEqual(x['subject'], f'voucher/{self.payroll.pk}')

    def test_unpaid_shift_must_not_keep_an_accrual(self):
        free = WorkShift.objects.create(employee=self.ws.employee, store=self.store, date='2000-01-01', shift_rate=1, bonus_percent=0, bonus_basis='store', accrued=5)
        (x,) = self.issues(); self.assertEqual(x['subject'], f'workshift/{free.pk}')

    def test_reversed_voucher_must_net_to_zero(self):
        entry = StockEntry.objects.get(voucher=self.reversed_receipt, is_reversal=True)
        StockEntry.objects.filter(pk=entry.pk).update(quantity=entry.quantity + 1)
        found = self.issues('reversal'); self.assertEqual({x['subject'] for x in found}, {f'voucher/{self.reversed_receipt.pk}'})
        StockEntry.objects.filter(pk=entry.pk).update(quantity=entry.quantity)
        centry = CashEntry.objects.get(voucher=self.reversed, is_reversal=True); centry.delete()
        (x,) = self.issues('reversal'); self.assertEqual(x['subject'], f'voucher/{self.reversed.pk}')
        self.assertEqual(self.issues('double_posting'), [])

    def test_wrong_cash_sign_and_wrong_account_are_found(self):
        expense = Voucher.objects.get(kind='expense', status='posted'); entry = expense.cash_entries.get()
        original = entry.amount
        CashEntry.objects.filter(pk=entry.pk).update(amount=-original)
        self.assertEqual({x['subject'] for x in self.issues('double_posting')}, {f'voucher/{expense.pk}'})
        CashEntry.objects.filter(pk=entry.pk).update(amount=original, account=self.bank)
        self.assertEqual({x['subject'] for x in self.issues('double_posting')}, {f'voucher/{expense.pk}'})

    def test_transfer_cannot_credit_source_account_or_reverse_both_legs(self):
        transfer = Voucher.objects.get(kind='cash_transfer'); credit = transfer.cash_entries.get(amount__gt=0)
        CashEntry.objects.filter(pk=credit.pk).update(account=transfer.account)
        self.assertEqual({x['subject'] for x in self.issues('double_posting')}, {f'voucher/{transfer.pk}'})
        CashEntry.objects.filter(pk=credit.pk).update(account=self.bank)
        for entry in transfer.cash_entries.all(): CashEntry.objects.filter(pk=entry.pk).update(amount=-entry.amount)
        self.assertEqual({x['subject'] for x in self.issues('double_posting')}, {f'voucher/{transfer.pk}'})

    def test_extra_opposite_cash_entries_do_not_cancel_out_of_the_check(self):
        expense = Voucher.objects.get(kind='expense', status='posted')
        CashEntry.objects.create(voucher=expense, account=expense.account, amount=3)
        CashEntry.objects.create(voucher=expense, account=expense.account, amount=-3)
        self.assertEqual({x['subject'] for x in self.issues('double_posting')}, {f'voucher/{expense.pk}'})

    def test_payment_direction_depends_on_reference_and_party(self):
        debt = self.v('debt_opening', amount=10, party=self.customer.pk)
        payment = self.v('payment', amount=5, account=self.bank.pk, reference=debt.pk)
        self.assertEqual(self.issues(), [])
        entry = payment.cash_entries.get(); CashEntry.objects.filter(pk=entry.pk).update(amount=-entry.amount)
        self.assertEqual({x['subject'] for x in self.issues('double_posting')}, {f'voucher/{payment.pk}'})

    def test_same_account_split_payments_are_valid(self):
        sale = self.v('sale', 1, 10, party=self.customer.pk, payload={'payments': [{'account': self.bank.pk, 'amount': '3'}, {'account': self.bank.pk, 'amount': '7'}]})
        self.assertEqual(sale.cash_entries.count(), 2); self.assertEqual(self.issues(), [])

    def test_missing_cash_difference_and_sign_are_found(self):
        for difference in [Decimal('-10'), Decimal('10')]:
            shift = CashShift.objects.create(store=self.store, account=self.cash, opened_by=self.u, opening_cash=100, expected_cash=100, counted_cash=100+difference)
            voucher = post_cash_difference(self.u, shift)
            self.assertEqual(self.issues(), [])
            entry = voucher.cash_entries.get(); original = entry.amount
            CashEntry.objects.filter(pk=entry.pk).update(amount=-original)
            self.assertEqual({x['subject'] for x in self.issues('double_posting')}, {f'voucher/{voucher.pk}'})
            CashEntry.objects.filter(pk=entry.pk).delete()
            self.assertEqual({x['subject'] for x in self.issues('double_posting')}, {f'voucher/{voucher.pk}'})
            CashEntry.objects.create(voucher=voucher, account=self.cash, amount=original)

    def test_posted_document_cannot_have_cash_reversal(self):
        expense = Voucher.objects.get(kind='expense', status='posted'); entry = expense.cash_entries.get()
        CashEntry.objects.create(voucher=expense, account=entry.account, amount=-entry.amount, is_reversal=True)
        (found,) = self.issues('double_posting')
        self.assertEqual(found['subject'], f'voucher/{expense.pk}'); self.assertIn('сторнувальні грошові', found['message'])

    def test_receipt_on_wrong_warehouse_is_found_even_when_lot_balances_match(self):
        StockLot.objects.filter(stockentry__voucher=self.receipt).update(warehouse=self.other, code='WRONG-WAREHOUSE')
        self.assertEqual(self.issues('lot_balance'), [])
        found = [x for x in self.issues('double_posting') if x['subject'] == f'voucher/{self.receipt.pk}']
        self.assertEqual(len(found), 2); self.assertTrue(all('на складі №' in x['message'] for x in found))

    def test_transfer_same_warehouse_both_legs_is_found(self):
        voucher = Voucher.objects.get(kind='transfer'); credit = voucher.stock_entries.get(quantity__gt=0)
        StockLot.objects.filter(pk=credit.lot_id).update(warehouse=self.wh, code='TRANSFER-WRONG')
        self.assertEqual(self.issues('lot_balance'), [])
        self.assertEqual({x['subject'] for x in self.issues('double_posting')}, {f'voucher/{voucher.pk}'})

    def test_malformed_payloads_report_voucher_and_continue_other_checks(self):
        bad = [
            (self.receipt, {'additional_cost': 'NaN'}),
            (self.receipt, {'additional_cost': '1e10000000'}),
            (self.sale_doc, {'payments': 123}),
            (Voucher.objects.get(kind='production'), {'consumed': [{'product': 'p', 'quantity': 'Infinity'}]}),
            (Voucher.objects.get(kind='inventory'), {'differences': [{'product': ['p'], 'difference': 'NaN'}]}),
            (self.payroll, {'calculation': [{'id': [self.ws.pk]}]}),
        ]
        for voucher, payload in bad:
            with self.subTest(kind=voucher.kind):
                original = voucher.payload
                Voucher.objects.filter(pk=voucher.pk).update(payload=payload)
                found = self.issues()
                self.assertIn(f'voucher/{voucher.pk}', {x['subject'] for x in found})
                code, output = self.run_command('--json'); self.assertEqual(code, 1); self.assertGreater(json.loads(output)['issues'], 0)
                Voucher.objects.filter(pk=voucher.pk).update(payload=original)
        Voucher.objects.filter(pk=self.sale_doc.pk).update(payload=['not-a-dict'])
        StockLot.objects.filter(pk=StockLot.objects.first().pk).update(quantity=999)
        found = self.issues()
        self.assertIn(f'voucher/{self.sale_doc.pk}', {x['subject'] for x in found})
        self.assertTrue(any(x['check']=='lot_balance' for x in found))

    @skipUnless(connection.vendor == 'postgresql', 'PostgreSQL snapshot semantics')
    def test_real_postgres_read_only_rejects_a_write_and_nested_default_transaction(self):
        from django.core.management.base import CommandError
        def accidental_write():
            Voucher.objects.filter(pk=self.receipt.pk).update(note='must never commit')
        with mock.patch('server.erp.management.commands.reconcile.reconcile', accidental_write):
            with self.assertRaises(DatabaseError): call_command('reconcile', stdout=StringIO())
        self.receipt.refresh_from_db(); self.assertNotEqual(self.receipt.note, 'must never commit')
        with transaction.atomic():
            with self.assertRaisesMessage(CommandError, 'потребує REPEATABLE READ'): call_command('reconcile', stdout=StringIO())
            self.assertEqual(Voucher.objects.count() > 0, True)  # the caller's transaction remains usable
        with transaction.atomic():
            with connection.cursor() as cursor: cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
            call_command('reconcile', stdout=StringIO())

    @skipUnless(connection.vendor == 'postgresql', 'PostgreSQL snapshot semantics')
    def test_real_postgres_report_keeps_one_snapshot_while_another_connection_commits(self):
        from concurrent.futures import ThreadPoolExecutor
        from django.db import close_old_connections
        observed = []
        original_reconcile = reconcile
        def committed_write():
            close_old_connections()
            try:
                Voucher.objects.filter(pk=self.receipt.pk).update(note='committed during snapshot')
            finally:
                connection.close()
        def read_snapshot():
            with connection.cursor() as cursor:
                cursor.execute('SHOW transaction_isolation'); observed.append(cursor.fetchone()[0])
                cursor.execute('SHOW transaction_read_only'); observed.append(cursor.fetchone()[0])
            before = Voucher.objects.get(pk=self.receipt.pk).note
            with ThreadPoolExecutor(max_workers=1) as pool: pool.submit(committed_write).result(timeout=10)
            self.assertEqual(Voucher.objects.get(pk=self.receipt.pk).note, before)
            return original_reconcile()
        with mock.patch('server.erp.management.commands.reconcile.reconcile', read_snapshot): call_command('reconcile', stdout=StringIO())
        self.assertEqual(observed, ['repeatable read', 'on'])
        self.receipt.refresh_from_db(); self.assertEqual(self.receipt.note, 'committed during snapshot')
