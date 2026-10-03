"""B25 read-only reconciliation command: a consistent ledger passes, one corrupted row gives its exact ID. Isolated data only."""
import json
from decimal import Decimal
from django.db.models import F
from django.utils import timezone
from io import StringIO
from django.core.management import call_command
from django.core.management.base import CommandError
from server.erp.models import *
from server.erp.reconcile import reconcile
from server.erp.services import *
from tests.test_erp import AccountingFixture


class ReconcileTests(AccountingFixture):
    def setUp(self):
        super().setUp()
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
        self.assertEqual((x['expected'], x['actual']), ('20.00', '40.00'))

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
