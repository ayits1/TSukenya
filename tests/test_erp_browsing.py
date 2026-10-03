import hashlib
import time
from decimal import Decimal

from django.contrib.auth.models import User
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from server.erp.models import (
    CashAccount, Counterparty, Document, LedgerLock, PortalSession, Profile,
    Store, Voucher, VoucherLine, Warehouse,
)
from server.erp.services import obligation, post_voucher, save_voucher


class BrowsingTests(TestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.store = Store.objects.create(name='Магазин A')
        self.other_store = Store.objects.create(name='Магазин B')
        self.warehouse = Warehouse.objects.create(store=self.store, name='Склад A')
        self.other_warehouse = Warehouse.objects.create(store=self.other_store, name='Склад B')
        self.party = Counterparty.objects.create(name='Постачальник сонце', kind='supplier')
        self.customer = Counterparty.objects.create(name='Клієнт сонце', kind='customer')
        self.product = Document.objects.create(path='products/test', data={'name': 'Товар', 'unit': 'шт'})
        self.owner = self.user('owner', 'owner')
        self.accountant = self.user('accountant', 'accountant', self.store)
        self.cashier = self.user('cashier', 'cashier', self.store)
        self.today = timezone.localdate()
        self.bank = CashAccount.objects.create(store=self.store, name='Банк', kind='bank')
        self.sign_in(self.owner)

    def user(self, name, role, store=None):
        user = User.objects.create(username=name)
        Profile.objects.create(user=user, role=role, store=store)
        return user

    def sign_in(self, user):
        token = f'isolated-browsing-{user.pk}'
        PortalSession.objects.update_or_create(
            token_hash=hashlib.sha256(token.encode()).hexdigest(),
            defaults={'user': user, 'csrf': 'isolated-csrf', 'expires': int(time.time()) + 3600},
        )
        self.client.cookies['ts_session'] = token

    def request(self, method, path, body=None):
        return getattr(self.client, method)(
            path, body or {}, content_type='application/json',
            HTTP_ORIGIN='http://testserver', HTTP_X_CSRF_TOKEN='isolated-csrf',
        )

    def voucher(self, kind='purchase_order', status='posted', store=None, party=None, quantity='10', **values):
        store = store or self.store
        voucher = Voucher.objects.create(
            kind=kind, status=status, store=store,
            warehouse=self.warehouse if store == self.store else self.other_warehouse,
            party=party or self.party, date=self.today, created_by=self.owner,
            total=Decimal('100.00'), payload={}, **values,
        )
        VoucherLine.objects.create(voucher=voucher, product=self.product, name='Товар', unit='шт',
                                   quantity=quantity, price='10', amount='100', cost='50')
        return voucher

    def consume(self, original, kind, quantity, status='posted'):
        child = self.voucher(kind, status=status, reference=original, quantity=quantity)
        child.lines.update(reference_line=original.lines.get())
        return child

    def sources(self, purpose, **params):
        result = self.client.get('/api/erp/references', {'purpose': purpose, **params})
        self.assertEqual(result.status_code, 200, result.content)
        return result.json()

    def test_old_sources_are_paginated_searchable_and_exactly_retrievable(self):
        vouchers = [self.voucher() for _ in range(65)]
        first = self.sources('receipt')
        self.assertEqual((first['total'], first['page'], first['pages']), (65, 1, 3))
        self.assertEqual(len(first['items']), 30)
        last = self.sources('receipt', page='999')
        self.assertEqual((last['page'], len(last['items'])), (3, 5))
        oldest = vouchers[0]
        self.assertEqual(self.sources('receipt', q=f'№ {oldest.pk:06d}')['items'][0]['id'], oldest.pk)
        self.assertEqual(self.sources('receipt', id=str(oldest.pk))['items'][0]['id'], oldest.pk)
        self.assertEqual(self.sources('receipt', q='Постачальник')['total'], 65)
        self.assertEqual(set(first['items'][0]), {'id', 'number', 'kind', 'date', 'store', 'party', 'total', 'outstanding', 'warehouse'})
        self.assertIsNone(first['items'][0]['outstanding'])

    def test_remaining_quantities_ignore_drafts_and_reversals(self):
        full = self.voucher()
        self.consume(full, 'receipt', '10')
        partial = self.voucher()
        self.consume(partial, 'receipt', '7')
        self.consume(partial, 'receipt', '10', status='draft')
        self.consume(partial, 'receipt', '10', status='reversed')
        draft = self.voucher(status='draft')
        reversed_source = self.voucher(status='reversed')
        found = self.sources('receipt')
        self.assertEqual([x['id'] for x in found['items']], [partial.pk])
        for voucher in [full, draft, reversed_source]:
            self.assertEqual(self.sources('receipt', id=str(voucher.pk))['items'], [])

    def test_source_types_are_fixed_by_destination_purpose(self):
        mapping = {'receipt': 'purchase_order', 'sale': 'customer_order',
                   'customer_return': 'sale', 'supplier_return': 'receipt'}
        for purpose, kind in mapping.items():
            source = self.voucher(kind)
            self.assertEqual(self.sources(purpose, id=str(source.pk))['items'][0]['kind'], kind)
            self.consume(source, purpose, '10')
            self.assertEqual(self.sources(purpose, id=str(source.pk))['items'], [])

    def test_accountant_can_select_debts_without_receipt_or_sale_mutation_rights(self):
        receipt = self.voucher('receipt')
        sale = self.voucher('sale', party=self.customer)
        debt = self.voucher('debt_opening', party=self.customer)
        self.sign_in(self.accountant)
        result = self.sources('payment')
        self.assertEqual({x['id'] for x in result['items']}, {receipt.pk, sale.pk, debt.pk})
        self.assertTrue(all(x['outstanding'] == '100.00' for x in result['items']))
        self.assertEqual(self.client.get(f'/api/erp/vouchers/{receipt.pk}').status_code, 403)
        self.assertEqual(self.request('post', f'/api/erp/vouchers/{sale.pk}/post').status_code, 403)
        self.assertEqual(self.client.get('/api/erp/vouchers?kind=sale,receipt').json()['items'], [])
        self.assertEqual(self.client.get('/api/erp/references?purpose=receipt').status_code, 403)
        payment = self.request('post', '/api/erp/vouchers', {
            'kind': 'payment', 'store': self.store.pk, 'reference': sale.pk,
            'date': self.today.isoformat(), 'account': self.bank.pk, 'amount': '20.00',
        })
        self.assertEqual(payment.status_code, 201, payment.content)
        posted = self.request('post', f"/api/erp/vouchers/{payment.json()['id']}/post")
        self.assertEqual(posted.status_code, 200, posted.content)
        self.assertEqual(self.sources('payment', id=str(sale.pk))['items'][0]['outstanding'], '80.00')

    def test_paid_sources_excluded_and_store_party_constraints_preserved(self):
        receipt = self.voucher('receipt')
        payment = self.voucher('payment', reference=receipt)
        fully_paid = self.voucher('sale', party=self.customer)
        fully_paid.payload = {'payments': [{'account': self.bank.pk, 'amount': '100.00'}]}
        fully_paid.save(update_fields=['payload'])
        open_sale = self.voucher('sale', party=self.customer)
        foreign = self.voucher('receipt', store=self.other_store)
        self.sign_in(self.accountant)
        found = self.sources('payment')
        self.assertEqual([x['id'] for x in found['items']], [open_sale.pk])
        self.assertEqual(self.sources('payment', id=str(foreign.pk))['items'], [])
        self.assertEqual(self.sources('payment', party=str(self.party.pk))['items'], [])
        self.assertEqual(self.sources('payment', store=str(self.other_store.pk))['items'], [])
        self.assertEqual(self.sources('payment', id=str(payment.pk))['items'], [])

    def test_retail_sales_are_not_loaded_as_payment_sources(self):
        # Posting requires a retail sale (no customer) to be paid in full, so the
        # query skips it before obligations are computed in Python.
        retail = self.voucher('sale')
        Voucher.objects.filter(pk=retail.pk).update(party=None)
        credit = self.voucher('sale', party=self.customer)
        found = self.sources('payment')
        self.assertEqual([x['id'] for x in found['items']], [credit.pk])
        self.assertEqual(self.sources('payment', id=str(retail.pk))['items'], [])

    def test_bad_query_values_are_user_errors(self):
        for query in ['purpose=bogus', 'purpose=receipt&page=0', 'purpose=receipt&page=-1',
                      'purpose=receipt&page=1.5', 'purpose=receipt&page=²',
                      'purpose=receipt&page=99999999999999999999', 'purpose=receipt&id=abc',
                      'purpose=receipt&store=nan', 'purpose=receipt&from=2026-99-99',
                      'purpose=receipt&from=2026-10-02&to=2026-10-01']:
            with self.subTest(query=query):
                self.assertEqual(self.client.get('/api/erp/references?' + query).status_code, 400)
        self.sign_in(self.cashier)
        self.assertEqual(self.client.get('/api/erp/references?purpose=payment').status_code, 403)

    def test_reference_date_filters_and_empty_page(self):
        voucher = self.voucher()
        voucher.date = self.today.replace(year=self.today.year - 1)
        voucher.save(update_fields=['date'])
        result = self.sources('receipt', **{'from': self.today.isoformat(), 'page': '99'})
        self.assertEqual(result, {'items': [], 'total': 0, 'page': 1, 'pages': 1})
        self.assertEqual(self.sources('receipt', **{'to': voucher.date.isoformat()})['total'], 1)

    def test_report_store_scope_for_accountant_and_manager_uses_store_primary_key(self):
        self.voucher('sale', party=self.customer)
        foreign_sale = self.voucher('sale', store=self.other_store, party=self.customer)
        foreign_sale.total = Decimal('900.00')
        foreign_sale.save(update_fields=['total'])
        manager = self.user('manager', 'manager', self.store)
        for user in [self.accountant, manager]:
            with self.subTest(role=user.profile.role):
                self.sign_in(user)
                result = self.client.get('/api/erp/report')
                self.assertEqual(result.status_code, 200, result.content)
                report = result.json()
                self.assertEqual(report['revenue'], '100.00')
                self.assertEqual([x['store'] for x in report['by_store']], [self.store.pk])
                self.assertEqual(report['by_store'][0]['revenue'], '100.00')
                foreign_filter = self.client.get('/api/erp/report', {'store': str(self.other_store.pk)})
                self.assertEqual(foreign_filter.status_code, 200)
                self.assertEqual(foreign_filter.json()['revenue'], '0.00')
                self.assertNotIn(self.other_store.pk, [x['store'] for x in foreign_filter.json()['by_store']])

    def test_batch_obligations_equal_ledger_without_per_source_queries(self):
        sources = [self.voucher('receipt') for _ in range(65)]
        sale = self.voucher('sale', party=self.customer)
        sale.payload = {'payments': [{'account': self.bank.pk, 'amount': '30.00'}]}
        sale.save(update_fields=['payload'])
        returned = self.voucher('customer_return', party=self.customer, reference=sale)
        returned.total = Decimal('20.00')
        returned.payload = {'payments': [{'account': self.bank.pk, 'amount': '5.00'}]}
        returned.save(update_fields=['total', 'payload'])
        payment = self.voucher('payment', reference=sale)
        payment.total = Decimal('10.00')
        payment.save(update_fields=['total'])
        self.voucher('payment', status='reversed', reference=sale)
        supplier_return = self.voucher('supplier_return', reference=sources[0])
        supplier_return.total = Decimal('25.00')
        supplier_return.payload = {'payments': [{'account': self.bank.pk, 'amount': '10.00'}]}
        supplier_return.save(update_fields=['total', 'payload'])
        expected = {voucher.pk: str(obligation(voucher)) for voucher in [sale, sources[0]]}
        with CaptureQueriesContext(connection) as queries:
            result = self.sources('payment')
        self.assertLessEqual(len(queries), 5, [query['sql'] for query in queries])
        self.assertEqual(result['total'], 66)
        for voucher in [sale, sources[0]]:
            found = self.sources('payment', id=str(voucher.pk))['items'][0]
            self.assertEqual(found['outstanding'], expected[voucher.pk])
        self.assertEqual(expected[sale.pk], '45.00')
        self.assertEqual(expected[sources[0].pk], '85.00')

    def test_main_vouchers_page_clamps_after_delete_and_searches_old_records(self):
        vouchers = [self.voucher(status='draft') for _ in range(31)]
        page = self.client.get('/api/erp/vouchers?page=2').json()
        self.assertEqual((page['page'], page['pages'], len(page['items'])), (2, 2, 1))
        self.request('delete', f'/api/erp/vouchers/{vouchers[0].pk}')
        page = self.client.get('/api/erp/vouchers?page=2').json()
        self.assertEqual((page['page'], page['pages'], len(page['items'])), (1, 1, 30))
        found = self.client.get('/api/erp/vouchers', {'q': f'{vouchers[1].pk:06d}'}).json()
        self.assertEqual([x['id'] for x in found['items']], [vouchers[1].pk])
        self.assertEqual(self.client.get('/api/erp/vouchers?q=сонце').json()['total'], 30)
        for invalid in ['-1', '0', '1.5', '²']:
            self.assertEqual(self.client.get('/api/erp/vouchers', {'page': invalid}).status_code, 400)

    def assert_no_cost(self, result):
        self.assertNotIn('cost', result)
        for line in result.get('lines', []):
            self.assertNotIn('cost', line)
        for movement in result.get('movements', []):
            self.assertNotIn('value', movement)

    def test_cashier_cost_redaction_in_create_update_post_list_detail(self):
        opening = save_voucher(self.owner, {
            'kind': 'opening', 'store': self.store.pk, 'warehouse': self.warehouse.pk,
            'date': self.today.isoformat(), 'lines': [{'product': 'test', 'quantity': '10', 'price': '5'}],
        })
        post_voucher(self.owner, opening.pk)
        self.sign_in(self.cashier)
        data = {
            'kind': 'sale', 'store': self.store.pk, 'warehouse': self.warehouse.pk,
            'date': self.today.isoformat(), 'party': self.customer.pk,
            'lines': [{'product': 'test', 'quantity': '2', 'price': '10'}],
            'payload': {'payments': [{'account': self.bank.pk, 'amount': '20'}]},
        }
        created = self.request('post', '/api/erp/vouchers', data)
        self.assertEqual(created.status_code, 201, created.content)
        self.assert_no_cost(created.json())
        pk = created.json()['id']
        updated = self.request('put', f'/api/erp/vouchers/{pk}', {**data, 'revision': created.json()['revision']})
        self.assertEqual(updated.status_code, 200, updated.content)
        self.assert_no_cost(updated.json())
        posted = self.request('post', f'/api/erp/vouchers/{pk}/post')
        self.assertEqual(posted.status_code, 200, posted.content)
        self.assert_no_cost(posted.json())
        self.assertTrue(posted.json()['movements'])
        self.assert_no_cost(self.client.get(f'/api/erp/vouchers/{pk}').json())
        for item in self.client.get('/api/erp/vouchers').json()['items']:
            self.assert_no_cost(item)
        self.assertEqual(self.request('post', f'/api/erp/vouchers/{pk}/reverse', {'reason': 'test'}).status_code, 403)
        self.sign_in(self.owner)
        full = self.client.get(f'/api/erp/vouchers/{pk}').json()
        self.assertEqual(full['cost'], '10.00')
        self.assertEqual(full['lines'][0]['cost'], '10.00')
        self.assertEqual(full['movements'][0]['value'], '-10.00')
        reversed_result = self.request('post', f'/api/erp/vouchers/{pk}/reverse', {'reason': 'Ізольована перевірка'})
        self.assertEqual(reversed_result.status_code, 200, reversed_result.content)
        self.assertEqual(reversed_result.json()['cost'], '10.00')
