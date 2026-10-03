"""B09 activity of customers, suppliers and employees is enforced at save and at posting. Isolated data only."""
import json
from datetime import timedelta
from django.utils import timezone
from server.erp.models import *
from server.erp.services import *
from server.erp.views import shift_action, work_shift_save
from tests.test_erp import AccountingFixture


class InactiveParticipantTests(AccountingFixture):
    def setUp(self):
        super().setUp(); self.cash_start(); self.worker = Employee.objects.create(name='Іван', store=self.store, shift_rate=100)

    def off(self, obj):
        obj.active = False; obj.save()

    def draft(self, kind, **extra):
        d = {'kind': kind, 'store': self.store.pk, 'warehouse': self.wh.pk, 'date': self.today, 'lines': [{'product': 'p', 'quantity': 1, 'price': 10}], 'payload': {}}
        d.update(extra); return save_voucher(self.u, d)

    def refuses(self, fn, *needles):
        with self.assertRaises(BusinessError) as ctx: fn()
        for n in needles: self.assertIn(n, str(ctx.exception))

    def test_new_documents_need_an_active_counterparty_at_save(self):
        self.off(self.customer); self.off(self.party)
        for kind in ('sale', 'customer_order'): self.refuses(lambda: self.draft(kind, party=self.customer.pk), 'Покупець «Customer» неактивний')
        for kind in ('purchase_order', 'receipt'): self.refuses(lambda: self.draft(kind, party=self.party.pk), 'Постачальник «Supplier» неактивний')
        self.assertEqual(Voucher.objects.filter(status='draft').count(), 0)

    def test_deactivation_between_save_and_post_blocks_posting(self):
        self.v('receipt', 10, 5)
        sale = self.draft('sale', party=self.customer.pk, payload={'payments': [{'account': self.bank.pk, 'amount': '10.00'}]})
        order = self.draft('purchase_order', party=self.party.pk)
        receipt = self.draft('receipt', party=self.party.pk)
        seller = self.draft('sale', employee=self.worker.pk, payload={'payments': [{'account': self.bank.pk, 'amount': '10.00'}]})
        for obj in (self.customer, self.party, self.worker): self.off(obj)
        self.refuses(lambda: post_voucher(self.u, sale.pk), 'Customer')
        self.refuses(lambda: post_voucher(self.u, order.pk), 'Supplier')
        self.refuses(lambda: post_voucher(self.u, receipt.pk), 'Supplier')
        self.refuses(lambda: post_voucher(self.u, seller.pk), 'Іван')
        self.assertEqual(Voucher.objects.filter(status='posted', kind__in=['sale', 'purchase_order']).count(), 0)
        self.assertEqual(StockLot.objects.get().quantity, 10)
        # Reactivation makes the very same drafts postable again.
        self.customer.active = True; self.customer.save(); self.assertEqual(post_voucher(self.u, sale.pk).status, 'posted')

    def test_returns_and_debt_payment_stay_allowed_for_inactive_counterparties(self):
        receipt = self.v('receipt', 10, 5); sale = self.sale(3)
        debt = self.v('sale', 1, 10, party=self.customer.pk)
        later_return = self.draft('customer_return', reference=sale.pk, party=self.customer.pk, payload={'payments': [{'account': self.bank.pk, 'amount': '10.00'}]}, lines=[{'product': 'p', 'quantity': 1, 'price': 10}])
        self.off(self.customer); self.off(self.party)
        self.assertEqual(post_voucher(self.u, later_return.pk).status, 'posted')
        self.assertEqual(self.v('customer_return', 1, 10, reference=sale.pk, party=self.customer.pk, payload={'payments': [{'account': self.bank.pk, 'amount': '10.00'}]}).status, 'posted')
        self.assertEqual(self.v('supplier_return', 1, 5, reference=receipt.pk, party=self.party.pk).status, 'posted')
        self.assertEqual(self.v('payment', reference=debt.pk, account=self.bank.pk, amount=10, lines=[]).status, 'posted')
        self.assertEqual(obligation(debt), 0)
        # Historical documents stay readable.
        self.assertEqual(Voucher.objects.get(pk=debt.pk).party.name, 'Customer')

    def test_shift_open_requires_an_active_employee_but_close_still_works(self):
        opened = json.loads(shift_action(self.u, {'action': 'open', 'account': self.cash.pk, 'employee': self.worker.pk}).content)['id']
        self.off(self.worker)
        shift_action(self.u, {'action': 'close', 'id': opened, 'counted': str(cash_balance(self.cash))})
        self.assertIsNotNone(CashShift.objects.get(pk=opened).closed_at)
        self.refuses(lambda: shift_action(self.u, {'action': 'open', 'account': self.cash.pk, 'employee': self.worker.pk}), 'Працівник «Іван» неактивний')
        self.assertEqual(CashShift.objects.filter(closed_at__isnull=True).count(), 0)
        shift_action(self.u, {'action': 'open', 'account': self.cash.pk})  # no named employee: unchanged

    def test_new_timesheet_row_needs_active_employee_but_accrual_and_payout_do_not(self):
        worked = WorkShift.objects.create(employee=self.worker, store=self.store, date=self.today, shift_rate=100, bonus_percent=0, bonus_basis='store')
        self.off(self.worker)
        row = {'employee': self.worker.pk, 'date': self.today, 'shift_rate': '100', 'bonus_percent': '0'}
        self.refuses(lambda: work_shift_save(self.u, {**row, 'date': (timezone.localdate() - timedelta(days=1)).isoformat()}), 'Працівник «Іван» неактивний')
        self.assertEqual(WorkShift.objects.count(), 1)
        payroll = self.v('payroll', employee=self.worker.pk, lines=[], payload={'shift_ids': [worked.pk]})
        self.assertEqual(payroll.total, 100)
        pay = self.v('payroll_payment', employee=self.worker.pk, account=self.cash.pk, amount=100, lines=[])
        self.assertEqual((pay.status, payroll_debt(self.worker)), ('posted', 0))

    def test_only_one_unrelated_inactive_party_does_not_block_others(self):
        self.off(Counterparty.objects.create(name='Old', kind='customer'))
        self.assertEqual(self.v('receipt', 5, 5).status, 'posted')
        self.assertEqual(self.sale(1).status, 'posted')
