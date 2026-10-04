"""B26 customer facts from isolated posted documents, directory paging and role scope."""
from datetime import timedelta
import hashlib
import time

from django.db import connection
from django.test import RequestFactory, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from server.erp.customers import handle_customers, list_customers, profile
from server.erp.models import Counterparty, PortalSession, Profile, Store, User, Voucher
from server.erp.services import BusinessError, reverse_voucher
from tests.test_erp import AccountingFixture


class CustomerFactsTests(TransactionTestCase):
    v = AccountingFixture.v
    sale = AccountingFixture.sale

    def setUp(self):
        AccountingFixture.setUp(self)
        self.v('receipt', 100, 5)

    def user(self, role, store=None):
        user = User.objects.create(username=f'{role}{User.objects.count()}')
        Profile.objects.create(user=user, role=role, store=store)
        return user

    def facts(self, user=None, **params):
        return profile(user or self.u, self.customer.pk, params)

    def test_checks_returns_average_and_current_reversal(self):
        first = self.sale(2, 10)
        second = self.sale(1, 30)
        returned = self.v('customer_return', 1, 10, reference=first.pk, party=self.customer.pk,
                          payload={'payments': [{'account': self.bank.pk, 'amount': '10'}]})
        # Source decides identity even for old returns without a party.
        Voucher.objects.filter(pk=returned.pk).update(party=None)
        result = self.facts()
        self.assertEqual(result['purchases'], {'checks': 2, 'gross': '50.00', 'returned': '10.00',
                         'net': '40.00', 'averageCheck': '25.00', 'first': self.today,
                         'last': self.today, 'segment': 'repeat'})
        reverse_voucher(self.u, returned.pk, 'Виправлення')
        reverse_voucher(self.u, second.pk, 'Виправлення')
        current = self.facts()['purchases']
        self.assertEqual((current['checks'], current['net'], current['segment']), (1, '20.00', 'single'))

    def test_posting_calculator_includes_embedded_payment_advance_and_return(self):
        yesterday = (timezone.localdate() - timedelta(days=1)).isoformat()
        sale = self.v('sale', 10, 10, party=self.customer.pk,
                      payload={'due_date': yesterday, 'payments': [{'account': self.bank.pk, 'amount': '20'}]})
        advance = self.v('payment', amount=15, account=self.bank.pk, party=self.customer.pk,
                         payload={'allocations': []})
        allocation = self.v('advance_allocation', amount=15, reference=advance.pk, party=self.customer.pk,
                            allocations=[{'source': sale.pk, 'amount': '15'}])
        self.v('customer_return', 1, 10, reference=sale.pk, party=self.customer.pk)
        due_today = self.v('debt_opening', amount=7, party=self.customer.pk, payload={'due_date': self.today})
        result = self.facts()['debt']
        self.assertEqual(result, {'outstanding': '62.00', 'overdue': '55.00', 'documents': 2,
                                 'overdueDocuments': 1, 'unknownDueDocuments': 0})
        reverse_voucher(self.u, allocation.pk, 'Виправлення')
        self.assertEqual(self.facts()['debt']['outstanding'], '77.00')
        # A corrupt legacy due date is explicitly unknown, not lexically overdue.
        Voucher.objects.filter(pk=due_today.pk).update(payload={'due_date': '01.01.2020'})
        self.assertEqual(self.facts()['debt']['unknownDueDocuments'], 1)

    def test_role_scope_and_cashier_redaction(self):
        self.sale(1, 10)
        other = Store.objects.create(name='Інший магазин')
        # Isolated legacy invoice: no stock movements, read contract only.
        Voucher.objects.create(kind='sale', store=other, party=self.customer, status='posted', created_by=self.u,
                               date=self.today, total=999, payload={})
        for role in ['owner', 'manager', 'accountant', 'cashier']:
            user = self.user(role, self.store)
            result = self.facts(user)
            self.assertEqual((result['purchases']['checks'], result['purchases']['gross']), (1, '10.00'))
            self.assertEqual(result['scope']['store'], self.store.pk)
            if role == 'cashier':
                self.assertIsNone(result['debt'])
                self.assertFalse(result['canEdit'])
            with self.assertRaisesMessage(BusinessError, 'Магазин недоступний.'):
                self.facts(user, store=str(other.pk))
        self.assertEqual(self.facts()['purchases']['gross'], '1009.00')
        self.assertEqual(self.facts(store=str(other.pk))['purchases']['gross'], '999.00')
        with self.assertRaises(BusinessError):
            self.facts(self.user('warehouse', self.store))

    def test_paging_search_and_new_inactive_contacts_do_not_require_sales(self):
        Counterparty.objects.bulk_create([Counterparty(name=f'Клієнт {i:03}', kind='customer') for i in range(65)])
        self.customer.phone = '+380991234567'
        self.customer.email = 'Search@sample.invalid'
        self.customer.active = False
        self.customer.save()
        self.assertEqual(len(list_customers(self.u, {})['items']), 30)
        last = list_customers(self.u, {'page': '99'})
        self.assertEqual((last['total'], last['page'], last['pages'], len(last['items'])), (66, 3, 3, 6))
        for search in ['1234567', 'search@sample.invalid', 'Customer']:
            found = list_customers(self.u, {'q': search, 'active': 'no'})
            self.assertEqual([row['id'] for row in found['items']], [self.customer.pk])
        empty = self.facts()
        self.assertEqual((empty['purchases']['checks'], empty['purchases']['averageCheck'],
                          empty['purchases']['segment']), (0, None, 'none'))
        self.assertEqual(empty['debt']['outstanding'], '0.00')

    def test_invalid_filters_missing_supplier_and_method_are_rejected(self):
        for params in [{'page': '0'}, {'q': 'x' * 251}, {'active': 'unknown'}, {'store': 'x'}]:
            with self.assertRaises(BusinessError):
                list_customers(self.u, params)
        with self.assertRaises(BusinessError):
            profile(self.u, self.party.pk, {})
        response = handle_customers(RequestFactory().post('/api/v1/crm/customers'), self.u)
        self.assertEqual(response.status_code, 405)
        self.assertEqual(handle_customers(RequestFactory().get('/api/v1/crm/unknown'), self.u).status_code, 404)

    def test_queries_are_batched_and_reads_do_not_mutate(self):
        # One <=200 source batch, fresh actor and scalar child streams; no per-invoice SQL.
        Voucher.objects.bulk_create([Voucher(kind='sale', store=self.store, party=self.customer, created_by=self.u,
                                             status='posted', date=self.today, total=1, payload={}) for _ in range(100)])
        with CaptureQueriesContext(connection) as queries:
            result = self.facts()
        self.assertEqual((result['purchases']['checks'], result['debt']['outstanding']), (100, '100.00'))
        selects = [row['sql'] for row in queries if row['sql'].lstrip().upper().startswith(('SELECT', 'DECLARE'))]
        self.assertLessEqual(len(selects), 12, selects)
        if connection.vendor == 'postgresql':
            self.assertTrue(any('REPEATABLE READ, READ ONLY' in row['sql'] for row in queries))
        self.assertFalse(any(row['sql'].lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for row in queries))

    def test_future_and_draft_records_are_not_purchase_facts(self):
        future = (timezone.localdate() + timedelta(days=1)).isoformat()
        for status, day in [('draft', self.today), ('posted', future), ('reversed', self.today)]:
            Voucher.objects.create(kind='sale', store=self.store, party=self.customer, status=status, created_by=self.u,
                                   date=day, total=100, payload={})
        self.assertEqual(self.facts()['purchases']['checks'], 0)

    def test_history_includes_source_linked_returns_and_keeps_scope(self):
        sale = self.sale(2, 10)
        returned = self.v('customer_return', 1, 10, party=self.customer.pk, reference=sale.pk,
                          payload={'payments': [{'account': self.bank.pk, 'amount': '10'}]})
        Voucher.objects.filter(pk=returned.pk).update(party=None)
        other = Store.objects.create(name='Недоступний магазин')
        foreign = Voucher.objects.create(kind='customer_return', store=other, party=None, reference=sale,
                                         status='posted', created_by=self.u, date=self.today, total=999)
        user = self.user('cashier', self.store)
        token = 'isolated-customer-history'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), user=user,
                                     csrf='isolated', expires=int(time.time()) + 3600)
        self.client.cookies['ts_session'] = token
        response = self.client.get(f'/api/erp/vouchers?party={self.customer.pk}')
        self.assertEqual(response.status_code, 200)
        items = response.json()['items']
        self.assertEqual({row['id'] for row in items}, {sale.pk, returned.pk})
        self.assertTrue(all('cost' not in row for row in items))
        facts = self.facts(user)
        self.assertEqual(facts['purchases']['returned'], '10.00')
        self.assertNotIn(foreign.pk, {row['id'] for row in items})
