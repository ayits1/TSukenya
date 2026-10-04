"""Focused isolated purchase reads: old replenishment oracle and real bounds."""
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from threading import Event
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth.models import User
from django.db import connection, connections
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from server.erp.models import Document, StockLot, Profile, Store, Warehouse, Voucher, VoucherLine
from server.erp.purchases_reads import documents, replenishment, lines, draft
from server.erp.replenishment import replenishment as old_replenishment
from server.erp.services import BusinessError, Conflict
from tests.test_erp import AccountingFixture


class PurchasesReadsTests(TransactionTestCase):
    v = AccountingFixture.v
    sale = AccountingFixture.sale

    def setUp(self):
        AccountingFixture.setUp(self)
        self.other.delete()
        self.p.data['minStock'] = '10'; self.p.save()

    def request(self, group, **extra):
        return {'warehouse': str(group['warehouse']), 'party': str(group['party'] or 0),
                'binding': group['binding'], **extra}

    def test_oracle_fefo_open_orders_latest_supplier_cost_and_unknown_zero(self):
        self.v('receipt', 10, '0.3333'); self.sale(7)
        order = self.v('purchase_order', 4, '0.3333')
        self.v('receipt', 1, '0.1250', reference=order.pk)
        Document.objects.create(path='products/unknown', data={'name': 'Новий', 'unit': 'кг', 'minStock': '2.5'})
        old = old_replenishment(self.u)
        value = replenishment(self.u, {})
        self.assertEqual(value['summary']['covered'], old['covered'])
        for group in value['items']:
            oracle = next(g for g in old['groups'] if (g['warehouse'], g['party']) == (group['warehouse'], group['party']))
            self.assertEqual(Decimal(group['total']), Decimal(oracle['total']))
            prepared = draft(self.u, self.request(group))
            self.assertEqual(len(prepared['lines']), len(oracle['lines']))
            for row in prepared['lines']:
                expected = next(r for r in oracle['lines'] if r['product'] == row['product'])
                for current, legacy in [('quantity', 'quantity'), ('price', 'price'), ('available', 'available'), ('minimum', 'minimum'), ('onOrder', 'on_order')]:
                    self.assertEqual(Decimal(row[current]), Decimal(expected[legacy]))
                self.assertEqual(row['costKnown'], row['product'] != 'unknown')
        self.party.active = False; self.party.save()
        updated = replenishment(self.u, {})
        self.assertEqual(len(updated['items']), 1)
        self.assertIsNone(updated['items'][0]['party'])
        self.assertEqual(updated['summary']['total'], value['summary']['total'])

    def test_group_paging_preview_whole_search_and_complete205_parts(self):
        Document.objects.bulk_create([Document(path=f'products/z{i:03}', data={'name': f'Товар {i:03}', 'unit': 'шт', 'minStock': '1'}) for i in range(204)])
        group = replenishment(self.u, {})['items'][0]
        self.assertEqual((group['linesCount'], group['parts'], len(group['preview'])), (205, 2, 3))
        selected = replenishment(self.u, {'q': 'Товар 020'})
        self.assertEqual(selected['items'][0]['linesCount'], 205)
        self.assertEqual(selected['summary']['lines'], 205)
        selected_group = selected['items'][0]
        prepared = [draft(self.u, self.request(selected_group, q='Товар 020', part=str(part))) for part in (1, 2)]
        self.assertEqual([len(x['lines']) for x in prepared], [200, 5])
        ids = [row['product'] for part in prepared for row in part['lines']]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(set(ids), {'p', *(f'z{i:03}' for i in range(204))})
        page = lines(self.u, self.request(group, page='7'))
        self.assertEqual((page['total'], page['pages'], len(page['items'])), (205, 7, 25))
        self.v('purchase_order', 1, 1, lines=[{'product': 'z203', 'quantity': 1, 'price': 1}])
        with self.assertRaises(Conflict) as caught: draft(self.u, self.request(group, part='2'))
        self.assertEqual(caught.exception.code, 'replenishment_changed')

    def test_thirty_group_headers_no_whole_models_and_bounded_query_count(self):
        Warehouse.objects.bulk_create([Warehouse(store=self.store, name=f'Склад {i:02}') for i in range(35)])
        with patch.object(Document, 'from_db', side_effect=AssertionError('whole catalogue')), patch.object(VoucherLine, 'from_db', side_effect=AssertionError('whole lines')):
            with CaptureQueriesContext(connection) as queries:
                result = replenishment(self.u, {})
        self.assertEqual((result['total'], len(result['items']), result['pages']), (36, 30, 2))
        self.assertLessEqual(len(queries), 10)
        self.assertTrue(all(len(g['preview']) == 1 for g in result['items']))
        # Header fetchall is SQL-bounded; all-line digests must use a chunked
        # server cursor on PG and fetchmany(100), rather than hidden fetchall.
        self.assertTrue(any('LIMIT 30' in q['sql'] for q in queries))

    def test_actual_cursor_materialization_bound_not_just_page_count(self):
        Document.objects.bulk_create([Document(path=f'products/z{i:03}', data={'name': f'Товар {i:03}', 'unit': 'шт', 'minStock': '1'}) for i in range(204)])
        batches, fetched = [], []
        cursor_factory = connection.cursor
        chunk_factory = connection.chunked_cursor
        class CursorProbe:
            def __init__(self, cursor): self.cursor = cursor; self.sql = ''
            def __getattr__(self, name): return getattr(self.cursor, name)
            def __enter__(self): self.cursor.__enter__(); return self
            def __exit__(self, *args): return self.cursor.__exit__(*args)
            def execute(self, sql, args=None): self.sql = sql; return self.cursor.execute(sql, args)
            def fetchall(self):
                result = self.cursor.fetchall()
                fetched.append(len(result))
                return result
            def fetchmany(self, size):
                result = self.cursor.fetchmany(size)
                if 'SELECT r.* FROM required r WHERE' in self.sql:
                    batches.append((size, len(result)))
                return result
        with patch.object(connection, 'cursor', side_effect=lambda: CursorProbe(cursor_factory())), patch.object(connection, 'chunked_cursor', side_effect=lambda: CursorProbe(chunk_factory())):
            result = replenishment(self.u, {})
        self.assertEqual(result['items'][0]['linesCount'], 205)
        self.assertEqual(sum(count for _, count in batches), 205)
        self.assertTrue(all(size == 100 and count <= 100 for size, count in batches))
        self.assertTrue(all(count <= 30 for count in fetched))

    def test_current_actor_scope_queries_journal_scalar_and_permission(self):
        self.v('receipt', 1, 2)
        foreign = Store.objects.create(name='Foreign')
        Warehouse.objects.create(store=foreign, name='Secret')
        Profile.objects.filter(user=self.u).update(role='manager', store=self.store)
        with patch.object(Voucher, 'from_db', side_effect=AssertionError('whole journal')):
            result = documents(self.u, {})
        self.assertEqual(result['policy']['store'], self.store.pk)
        self.assertEqual(result['items'][0]['storeName'], 'Test')
        self.assertNotIn('payload', result['items'][0])
        Voucher.objects.bulk_create([Voucher(kind='receipt', store=self.store, warehouse=self.wh, date=self.today,
                                           created_by=self.u, total=Decimal('1.23'), payload={'private': 'never selected'}) for _ in range(35)])
        with patch.object(Voucher, 'from_db', side_effect=AssertionError('whole journal')):
            paged = documents(self.u, {})
        self.assertEqual((paged['total'], paged['pages'], len(paged['items'])), (36, 2, 30))
        self.assertEqual(replenishment(self.u, {'store': str(foreign.pk)})['items'], [])
        for query in ({'kind': 'sale'}, {'status': 'oops'}, {'store': '0'}, {'unknown': '1'}):
            with self.assertRaises(BusinessError): documents(self.u, query)
        Profile.objects.filter(user=self.u).update(role='accountant')
        with self.assertRaises(BusinessError): replenishment(self.u, {})
        Profile.objects.filter(user=self.u).update(role='owner')
        User.objects.filter(pk=self.u.pk).update(is_active=False)
        with self.assertRaises(BusinessError): documents(self.u, {})

    def test_exact_money_rounding_and_no_missing_cost_as_free_claim(self):
        self.v('receipt', '1.000', '0.0050')
        self.p.data['minStock'] = '2'; self.p.save()
        result = replenishment(self.u, {})
        self.assertEqual(result['summary']['total'], '0.01')
        self.assertEqual(result['items'][0]['preview'][0]['price'], '0.0050')
        self.assertTrue(result['items'][0]['preview'][0]['costKnown'])
        self.v('receipt', 1, '999999999998.1234')
        self.p.data['minStock'] = '3'; self.p.save()
        expected = old_replenishment(self.u)['groups'][0]['lines'][0]['price']
        actual = replenishment(self.u, {})['items'][0]['preview'][0]['price']
        self.assertEqual(Decimal(actual), Decimal(expected))

    def test_expiry_reserve_closed_order_and_warehouse_first_last_cost(self):
        from server.erp.order_models import OrderControl, StockReservation
        other = Warehouse.objects.create(store=self.store, name='Other')
        self.v('receipt', 4, 2)
        self.v('receipt', 1, 99, warehouse=other.pk)
        lot = StockLot.objects.get(warehouse=self.wh)
        lot.expiry = timezone.localdate() - timedelta(days=1); lot.save()
        self.v('receipt', 3, 2, lines=[{'product': 'p', 'quantity': 3, 'price': 2, 'lot': 'live'}])
        order = self.v('customer_order', 1, 2, party=self.customer.pk)
        StockReservation.objects.create(order_line=order.lines.get(), lot=StockLot.objects.get(code='live'), owner=self.u,
                                        expires_on=timezone.localdate(), quantity=1)
        closed = self.v('purchase_order', 100, 2)
        OrderControl.objects.filter(order=closed).update(closed_at=timezone.now())
        value = replenishment(self.u, {})
        oracle = old_replenishment(self.u)
        for row in value['items']:
            expected = next(g for g in oracle['groups'] if g['warehouse'] == row['warehouse'])
            actual = draft(self.u, self.request(row))['lines'][0]
            self.assertEqual(Decimal(actual['quantity']), Decimal(expected['lines'][0]['quantity']))
            self.assertEqual(Decimal(actual['price']), Decimal(expected['lines'][0]['price']))
        primary = next(g for g in value['items'] if g['warehouse'] == self.wh.pk)
        self.assertEqual(primary['preview'][0]['available'], '2.000')
        self.assertEqual(primary['preview'][0]['quantity'], '8.000')
        self.assertEqual(primary['preview'][0]['price'], '2.0000')

    def test_covered_whole_group_search_summary_not_page_or_partial_line(self):
        self.v('purchase_order', 10, 1)
        result = replenishment(self.u, {'q': 'Product'})
        self.assertEqual(result['summary'], {'groups': 0, 'lines': 0, 'covered': 1, 'total': '0.00'})
        self.assertEqual(result['items'], [])
        self.assertEqual(replenishment(self.u, {'q': 'no match'})['summary']['covered'], 0)

    def test_repeatable_read_change_during_group_digest(self):
        if connection.vendor != 'postgresql':
            self.skipTest('PostgreSQL RR snapshot')
        from server.erp import purchases_reads
        entered, changed = Event(), Event()
        real = purchases_reads.projections
        def writer():
            connections.close_all()
            try:
                self.assertTrue(entered.wait(5))
                Document.objects.filter(pk=self.p.pk).update(data={'name': 'Product', 'unit': 'шт', 'minStock': '20'})
                changed.set()
            finally: connections.close_all()
        def delayed(*args, **kwargs):
            entered.set(); self.assertTrue(changed.wait(5))
            return real(*args, **kwargs)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(writer)
            with patch.object(purchases_reads, 'projections', side_effect=delayed): before = replenishment(self.u, {})
            future.result(timeout=5)
        self.assertEqual(before['items'][0]['preview'][0]['quantity'], '10.000')
        after = replenishment(self.u, {})
        self.assertEqual(after['items'][0]['preview'][0]['quantity'], '20.000')
        with self.assertRaises(Conflict): draft(self.u, self.request(before['items'][0]))
