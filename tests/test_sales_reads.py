"""Isolated sales workspace: scalar limits, current scope and authoritative cash values."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone as tz
from decimal import Decimal
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth.models import User
from django.db import connection, connections
from django.http import QueryDict
from django.test import TransactionTestCase, RequestFactory
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from server.erp.models import CashShift, Employee, Profile, Store, Voucher
from server.erp import sales_reads
from server.erp.shift_browsing import cash_shifts as legacy_shifts
from server.erp.services import BusinessError
from server.erp.views import handle, shift_action
from tests.test_erp import AccountingFixture


class SalesReadsTests(TransactionTestCase):
    v = AccountingFixture.v
    sale = AccountingFixture.sale

    def setUp(self):
        AccountingFixture.setUp(self)
        self.employee = Employee.objects.create(store=self.store, name='Employee private terms', shift_rate=999, bonus_percent=3)

    def cash_shift(self, **values):
        return CashShift.objects.create(store=self.store, account=self.cash, opened_by=self.u,
                                        employee=self.employee, opening_cash='12.34', **values)

    def test_document_pages_scalar_privacy_search_and_all_native_kinds(self):
        self.v('receipt', 100, 2)
        sale = self.sale(2, '12.3456')
        self.v('customer_order', 1, 3, party=self.customer.pk)
        self.v('customer_return', 1, 0, reference=sale.pk, party=self.customer.pk, payload={'payments':[{'account':self.bank.pk,'amount':'12.35'}]})
        Voucher.objects.bulk_create([Voucher(kind='sale', store=self.store, date=self.today, created_by=self.u,
                 party=self.customer, note='secret note', payload={'secret': 'large private data'}, total='1.23') for _ in range(65)])
        with patch.object(Voucher, 'from_db', side_effect=AssertionError('whole voucher materialized')):
            with CaptureQueriesContext(connection) as queries:
                result = sales_reads.documents(self.u, {})
        self.assertEqual((result['total'], len(result['items']), result['pages']), (68, 30, 3))
        self.assertFalse(any('"payload"' in q['sql'] or '"cost"' in q['sql'] or 'erp_voucherline' in q['sql'] for q in queries))
        self.assertLessEqual(len(queries), 9)
        found = sales_reads.documents(self.u, {'q': '№'+str(sale.pk)})
        self.assertEqual(found['items'][0]['total'], '24.69')
        self.assertEqual(found['items'][0]['partyName'], 'Customer')
        self.assertEqual(sales_reads.documents(self.u, {'kind':'customer_return'})['total'], 1)
        self.assertEqual(sales_reads.documents(self.u, {'q':'Customer','page':'3'})['page'], 3)
        self.assertEqual(set(result['items'][0]), {'id','number','kind','status','date','store','storeName','party','partyName','employee','employeeName','total','revision'})

    def test_shift_pages_kyiv_dates_exact_money_nullable_and_scalar(self):
        opened = self.cash_shift()
        large = connection.vendor == 'postgresql'
        expected, counted = ('10000000000000.12', '9999999999999.99') if large else ('100000000.12', '99999999.99')
        closed = self.cash_shift(closed_at=timezone.now(), expected_cash=expected, counted_cash=counted)
        CashShift.objects.filter(pk=opened.pk).update(opened_at=datetime(2026,1,1,22,30,tzinfo=tz.utc))
        CashShift.objects.bulk_create([CashShift(store=self.store, account=self.cash, opened_by=self.u, opening_cash=0) for _ in range(60)])
        with patch.object(CashShift, 'from_db', side_effect=AssertionError('whole shift materialized')):
            with CaptureQueriesContext(connection) as queries: result = sales_reads.cash_shifts(self.u, {})
        self.assertEqual((len(result['items']),result['total'],result['pages']), (30,62,3))
        self.assertFalse(any('"note"' in q['sql'] or '"password"' in q['sql'] or '"shift_rate"' in q['sql'] for q in queries if 'FROM "erp_cashshift"' in q['sql']))
        self.assertLessEqual(len(queries), 8)
        closed_row=sales_reads.cash_shifts(self.u, {'status':'closed'})['items'][0]
        self.assertEqual((closed_row['difference'],closed_row['canClose']), ('-0.13',False))
        self.assertEqual(closed_row['expectedCash'], expected)
        opened_row=sales_reads.cash_shifts(self.u, {'from':'2026-01-02','to':'2026-01-02','status':'open'})['items'][0]
        self.assertEqual((opened_row['id'],opened_row['openingCash'],opened_row['difference']), (opened.pk,'12.34',None))
        self.assertTrue(opened_row['canClose'])
        legacy=legacy_shifts(self.u, {'employee':str(self.employee.pk)})
        self.assertEqual({x['id'] for x in legacy['items']},{x['id'] for x in sales_reads.cash_shifts(self.u,{'employee':str(self.employee.pk)})['items']})
        self.assertEqual(closed_row['id'],closed.pk)

    def test_current_scope_cashier_own_shift_and_unchanged_close_authority(self):
        cashier=User.objects.create(username='Cashier');Profile.objects.create(user=cashier,role='cashier',store=self.store)
        own=CashShift.objects.create(store=self.store,account=self.cash,opened_by=cashier,opening_cash=0)
        other=self.cash_shift()
        foreign=Store.objects.create(name='Foreign private');CashShift.objects.create(store=foreign,account=self.cash,opened_by=self.u,opening_cash=0)
        rows=sales_reads.cash_shifts(cashier,{})['items']
        self.assertEqual({r['id']:r['canClose'] for r in rows},{own.pk:True,other.pk:False})
        self.assertEqual(sales_reads.cash_shifts(cashier,{'store':str(foreign.pk)})['total'],0)
        with self.assertRaises(BusinessError): shift_action(cashier,{'action':'close','id':other.pk,'counted':'0'})
        shift_action(cashier,{'action':'close','id':own.pk,'counted':'0.13'})
        row=sales_reads.cash_shifts(cashier,{'status':'closed'})['items'][0]
        self.assertEqual((row['expectedCash'],row['countedCash'],row['difference']),('0.00','0.13','0.13'))
        self.assertEqual(Voucher.objects.get(kind='cash_difference').total,Decimal('0.13'))
        Profile.objects.filter(user=cashier).update(role='warehouse')
        with self.assertRaises(BusinessError): sales_reads.documents(cashier,{})
        with self.assertRaises(BusinessError): sales_reads.cash_shifts(cashier,{})

    def test_strict_queries_readonly_routes_and_auth(self):
        for params in [{'unknown':'1'},{'store':['1']},{'status':'bogus'},{'from':'20260101'},{'to':'2026-02-30'},{'from':'2026-02-03','to':'2026-02-02'}, QueryDict('store=1&store=2')]:
            with self.assertRaises(BusinessError): sales_reads.cash_shifts(self.u,params)
        for route in ('documents','cash-shifts'):
            request=RequestFactory().get('/api/v1/trading/sales/'+route);request.portal_user=self.u
            self.assertEqual(handle(request).status_code,200)
            request=RequestFactory().post('/api/v1/trading/sales/'+route, HTTP_ORIGIN='http://testserver', HTTP_X_CSRF_TOKEN='synthetic');request.portal_user=self.u;request.portal_session=SimpleNamespace(csrf='synthetic')
            self.assertEqual(handle(request).status_code,405)
            request.portal_user=None
            with self.assertRaises(BusinessError):handle(request)

    def test_rr_count_and_rows_keep_one_snapshot(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL RR concurrency')
        self.cash_shift();entered,changed=Event(),Event();real=sales_reads.paged
        def writer():
            connections.close_all()
            try:
                self.assertTrue(entered.wait(5));self.cash_shift();changed.set()
            finally:connections.close_all()
        def delayed(*args):
            result=real(*args);entered.set();self.assertTrue(changed.wait(5));return result
        with ThreadPoolExecutor(max_workers=1) as pool:
            task=pool.submit(writer)
            with patch.object(sales_reads,'paged',side_effect=delayed):before=sales_reads.cash_shifts(self.u,{})
            task.result(timeout=5)
        self.assertEqual((before['total'],len(before['items'])),(1,1))
        self.assertEqual(sales_reads.cash_shifts(self.u,{})['total'],2)
