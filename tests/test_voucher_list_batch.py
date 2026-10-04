"""Paged summaries reuse the authoritative obligation calculator with batched inputs."""
import hashlib
import time
from decimal import Decimal

from django.db import connection
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from tests.test_erp import AccountingFixture
from server.erp.models import PortalSession, Store, Voucher
from server.erp.reporting import voucher_json
from server.erp.services import obligation, reverse_voucher, save_voucher, post_voucher


class VoucherListBatchTests(TransactionTestCase):
    v = AccountingFixture.v

    def setUp(self):
        AccountingFixture.setUp(self)
        token = 'isolated-b24-list'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),
            user=self.u, csrf='b24-csrf', expires=int(time.time())+3600)
        self.client.cookies['ts_session'] = token

    def read(self, **params):
        with CaptureQueriesContext(connection) as queries:
            result = self.client.get('/api/erp/vouchers', params)
        self.assertEqual(result.status_code, 200, result.content)
        return result.json(), len(queries)

    def assert_unchanged(self, body):
        expected = {v.pk: voucher_json(v, user=self.u) for v in
                    Voucher.objects.filter(pk__in=[row['id'] for row in body['items']]).select_related('created_by')}
        self.assertEqual(body['items'], [expected[row['id']] for row in body['items']])

    def payment(self, amount, party=None, source=None):
        value = {'kind':'payment', 'date':self.today, 'store':self.store.pk,
                 'party':(party or self.party).pk, 'account':self.bank.pk, 'amount':str(amount)}
        if source is not None:value['allocations']=[{'source':source.pk, 'amount':str(amount)}]
        return post_voucher(self.u, save_voucher(self.u, value).pk)

    def test_one_and_thirty_paid_rows_use_fixed_chunk_queries(self):
        now = timezone.now()
        sales = Voucher.objects.bulk_create([Voucher(kind='sale', status='posted', store=self.store,
            date=self.today, total=100, cost=50, payload={'payments':[{'account':self.bank.pk,'amount':'100'}]},
            created_by=self.u, posted_at=now) for _ in range(31)])
        one, small_count = self.read(kind='sale', q=str(sales[0].pk))
        page, page_count = self.read(kind='sale')
        self.assertEqual(len(one['items']), 1)
        self.assertEqual(len(page['items']), 30)
        self.assertEqual(page['total'], 31)
        self.assertEqual(page['pages'], 2)
        self.assertEqual(small_count, page_count)
        self.assertLessEqual(page_count, 15)
        self.assertTrue(all(Decimal(row['outstanding']) == 0 for row in page['items']))
        self.assert_unchanged(one); self.assert_unchanged(page)
        tail, count = self.read(kind='sale', page='2')
        self.assertEqual(len(tail['items']), 1)
        self.assertLessEqual(count, 15)

    def test_paid_partial_embedded_and_unused_advance_use_existing_calculator(self):
        self.v('cash_opening', amount='1000', account=self.bank.pk)
        paid = self.v('receipt', qty=10, price=5)
        partial = self.v('receipt', qty=10, price=5)
        advanced = self.v('receipt', qty=10, price=5)
        self.payment(50, source=paid)
        self.payment(20, source=partial)
        self.payment(40)  # Explicitly unallocated; cannot pay any invoice by itself.
        embedded_paid = self.v('sale', qty=2, price=10, party=self.customer.pk,
            payload={'payments':[{'account':self.bank.pk,'amount':'20'}]})
        embedded_partial = self.v('sale', qty=2, price=10, party=self.customer.pk,
            payload={'payments':[{'account':self.bank.pk,'amount':'5'}]})
        body, count = self.read(kind='receipt,sale')
        self.assertLessEqual(count, 15)
        amounts = {row['id']: Decimal(row['outstanding']) for row in body['items']}
        self.assertEqual(amounts, {paid.pk:0, partial.pk:30, advanced.pk:50,
                                   embedded_paid.pk:0, embedded_partial.pk:15})
        self.assert_unchanged(body)

    def test_allocation_return_and_reversals_preserve_outstanding_and_status_dto(self):
        self.v('cash_opening', amount='1000', account=self.bank.pk)
        source = self.v('receipt', qty=10, price=5)
        payment = self.payment(40)
        allocation = post_voucher(self.u, save_voucher(self.u, {'kind':'advance_allocation',
            'date':self.today, 'store':self.store.pk, 'reference':payment.pk, 'amount':'15',
            'allocations':[{'source':source.pk,'amount':'15'}]}).pk)
        self.assertEqual(obligation(source), Decimal('35'))
        returned = self.v('supplier_return', qty=2, price=5, reference=source.pk,
            lines=[{'product':'p','quantity':'2','price':'5','reference_line':source.lines.get().pk}])
        self.assertEqual(obligation(source), Decimal('25'))
        for record, remaining in [(returned,35), (allocation,50), (payment,50)]:
            before, count = self.read(kind='receipt,supplier_return,payment,advance_allocation')
            self.assertLessEqual(count,15); self.assert_unchanged(before)
            reverse_voucher(self.u, record.pk, 'Ізольована перевірка B24')
            body, count = self.read(kind='receipt,supplier_return,payment,advance_allocation')
            self.assertLessEqual(count,15); self.assert_unchanged(body)
            self.assertEqual(Decimal(next(row for row in body['items'] if row['id']==source.pk)['outstanding']),remaining)
            reversed_row=next(row for row in body['items'] if row['id']==record.pk)
            self.assertEqual(reversed_row['status'],'reversed')
            self.assertNotIn('outstanding',reversed_row)
        reverse_voucher(self.u, source.pk, 'Ізольована перевірка B24')
        body, _ = self.read(kind='receipt')
        self.assertNotIn('outstanding',body['items'][0])
        self.assert_unchanged(body)

    def test_cashier_scope_role_and_cost_redaction_are_preserved(self):
        self.u.profile.role='cashier'; self.u.profile.store=self.store
        self.u.profile.save(update_fields=['role','store'])
        foreign=Store.objects.create(name='Інший магазин')
        for store in [self.store,foreign]:
            Voucher.objects.create(kind='sale', status='posted', store=store, date=self.today,
                total=10, cost=8, created_by=self.u, payload={'payments':[{'account':self.bank.pk,'amount':'10'}]})
            Voucher.objects.create(kind='payroll', status='posted', store=store, date=self.today,
                total=100, created_by=self.u)
        body, count=self.read()
        self.assertLessEqual(count,15)
        self.assertEqual(len(body['items']),1)
        self.assertEqual(body['items'][0]['store'],self.store.pk)
        self.assertEqual(body['items'][0]['kind'],'sale')
        self.assertNotIn('cost',body['items'][0])
        self.assert_unchanged(body)
        body, _ = self.read(store=str(foreign.pk))
        self.assertEqual(body['items'],[])

    def test_unbackfilled_legacy_single_payment_and_opening_debt_are_not_lost(self):
        source=Voucher.objects.create(kind='debt_opening', status='posted', store=self.store,
            party=self.customer, date=self.today, total=50, created_by=self.u)
        legacy=Voucher.objects.create(kind='payment', status='posted', store=self.store,
            party=self.customer, reference=source, account=self.bank, date=self.today,
            total=10, created_by=self.u)
        self.assertFalse(legacy.allocation_entries.exists())
        body, count=self.read(kind='debt_opening,payment')
        self.assertLessEqual(count,15)
        self.assertEqual(next(row for row in body['items'] if row['id']==source.pk)['outstanding'],'40.00')
        self.assert_unchanged(body)
