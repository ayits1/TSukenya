"""Actual bounded ERP bootstrap/directory reads; isolated snapshots and privacy."""
import hashlib
import time
from decimal import Decimal
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext

from server.erp import directories
from server.erp.models import *
from server.erp.services import cash_balance, payroll_debt
from tests.test_erp import AccountingFixture


class TradingDirectoryTests(TransactionTestCase):
    v=AccountingFixture.v
    sale=AccountingFixture.sale

    def setUp(self):
        AccountingFixture.setUp(self)
        PortalSession.objects.create(token_hash=hashlib.sha256(b'trading-directory-qa').hexdigest(),user=self.u,csrf='isolated-directory-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='trading-directory-qa'
        self.headers={'HTTP_ORIGIN':'http://testserver','HTTP_X_CSRF_TOKEN':'isolated-directory-csrf'}
        Document.objects.create(path='settings/main',data={'defaultMarkup':30,'rounding':.5})

    def get(self,path):return self.client.get('/api/v1/trading/'+path)
    def details(self,value):return self.client.post('/api/v1/trading/directories/details',value,content_type='application/json',**self.headers)

    def test_every_actual_directory_is_paged_and_selected_offpage_is_hydrated(self):
        for i in range(66):
            ExpenseCategory.objects.create(name=f'QA category {i:03}')
            s=Store.objects.create(name=f'QA store {i:03}')
            Warehouse.objects.create(store=s,name=f'QA warehouse {i:03}')
            account=CashAccount.objects.create(store=s,name=f'QA account {i:03}')
            CashShift.objects.create(store=s,account=account,opened_by=self.u,opening_cash=0)
            Employee.objects.create(store=s,name=f'QA employee {i:03}')
            Counterparty.objects.create(name=f'QA party {i:03}',kind='supplier',active=i!=65)
            Document.objects.create(path=f'products/qa_{i:03}',data={'name':f'QA product {i:03}','cost':10,'markup':30,'unit':'шт','hidden':i==65})
        for resource in directories.MODELS:
            response=self.get('directories/'+resource+'?q=QA&page=1').json()
            self.assertEqual((len(response['items']),response['total'],response['pages'],response['limit']),(30,66,3,30))
            last=self.get('directories/'+resource+'?q=QA&page=3').json()['items'][-1]
            detail=self.details({'ids':[{'type':resource,'id':last['id']}]}).json()['items'][0]
            self.assertEqual(detail['id'],last['id']);self.assertEqual(detail['name'],last['name'])
        bootstrap=self.get('bootstrap').json()
        self.assertNotIn('products',bootstrap);self.assertNotIn('employees',bootstrap);self.assertNotIn('accounts',bootstrap)
        self.assertEqual(bootstrap['csrf'],'isolated-directory-csrf')

    def test_purpose_scope_and_private_terms_use_current_read_role(self):
        self.u.profile.role='manager';self.u.profile.store=self.store;self.u.profile.save()
        foreign_store=Store.objects.create(name='Foreign isolated store')
        foreign=Employee.objects.create(store=foreign_store,name='Foreign private',shift_rate=123,bonus_percent=9)
        own=Employee.objects.create(store=self.store,name='Own former',active=False,shift_rate=345)
        supplier=Counterparty.objects.create(name='Shared inactive',kind='supplier',active=False)
        page=self.get('directories/employees').json()
        self.assertTrue(all('shift_rate' not in row and 'bonus_percent' not in row and 'payroll_debt' not in row for row in page['items']))
        self.assertNotIn(str(foreign.pk),[row['id'] for row in page['items']])
        result=self.details({'ids':[{'type':'employees','id':str(foreign.pk)},{'type':'employees','id':str(own.pk)},{'type':'parties','id':str(supplier.pk)}]}).json()
        self.assertEqual(result['unavailable'],[{'type':'employees','id':str(foreign.pk)}]);self.assertEqual(len(result['items']),2)
        self.assertNotIn(str(supplier.pk),[row['id'] for row in self.get('directories/parties?purpose=receipt').json()['items']])
        self.assertIn(str(supplier.pk),[row['id'] for row in self.get('directories/parties?purpose=supplier_return').json()['items']])
        self.assertEqual(self.get(f'directories/accounts?store={foreign_store.pk}').status_code,403)
        self.u.profile.role='cashier';self.u.profile.save()
        product=self.details({'ids':[{'type':'products','id':'p'}],'store':self.store.pk}).json()['items'][0]
        self.assertNotIn('cost',product);self.assertIn('salePrice',product)

    def test_batch_malformed_request_readonly_and_streamed_full_template(self):
        for bad in [{'ids':[{'type':[],'id':'p'}]},{'ids':[{'type':'employees','id':[]}]},{'ids':[{'type':'employees','id':'-1'}]},{'ids':[{'type':'products','id':'p'}]*2},{'ids':[{'type':'products','id':'p'}]*201},{'ids':[], 'revision':'mutation'}]:
            self.assertEqual(self.details(bad).status_code,400,bad)
        self.assertEqual(self.client.post('/api/v1/trading/directories/details',{'ids':[]},content_type='application/json').status_code,403)
        before=(AuditEvent.objects.count(),Document.objects.count())
        self.details({'ids':[{'type':'products','id':'p'},{'type':'products','id':'missing'}]})
        self.assertEqual((AuditEvent.objects.count(),Document.objects.count()),before)
        for i in range(67):Document.objects.create(path=f'products/qa_{i:03}',data={'name':'QA','cost':'1.2345'})
        response=self.get('products/template.csv?purpose=opening');self.assertTrue(response.streaming)
        from server.erp.csv_format import read_rows
        _,rows=read_rows(b''.join(response.streaming_content).decode())
        self.assertEqual(len(rows),68);self.assertEqual(rows[-1][1]['Ціна'],'1.2345')

    def test_page_money_is_authoritative_and_query_count_independent_of_page_size(self):
        self.v('cash_opening',amount=Decimal('11.25'),account=self.cash.pk)
        employees=[Employee.objects.create(store=self.store,name=f'Employee {i:03}') for i in range(65)]
        for i,e in enumerate(employees):
            Voucher.objects.create(kind='payroll',status='posted',date=self.today,store=self.store,employee=e,total=Decimal('10.01'),created_by=self.u)
            Voucher.objects.create(kind='payroll_payment',status='posted',date=self.today,store=self.store,employee=e,total=Decimal('3.25'),created_by=self.u)
        with CaptureQueriesContext(connection) as queries:
            result=directories.page(self.u,'employees',{'purpose':'manage','page':'2'})
        self.assertEqual(len(result['items']),30);self.assertLessEqual(len(queries),7)
        for row in result['items']:self.assertEqual(Decimal(row['payroll_debt']),payroll_debt(Employee(pk=int(row['id']))))
        accounts=directories.page(self.u,'accounts',{'purpose':'finance'})
        for row in accounts['items']:self.assertEqual(Decimal(row['balance']),cash_balance(CashAccount(pk=int(row['id']))))

    def test_pos_exact_lookup_returns_ambiguity_and_current_server_price(self):
        for i in range(2):Document.objects.create(path=f'products/pos{i}',data={'name':'Точна назва','barcode':f'QA-{i}','unit':'шт','cost':10,'markup':30})
        self.u.profile.role='cashier';self.u.profile.store=self.store;self.u.profile.save()
        result=self.get(f'products/lookup?mode=name&q=Точна%20назва&store={self.store.pk}').json()
        self.assertEqual(result['total'],2);self.assertTrue(all('cost' not in row for row in result['items']))
        exact=self.get(f'products/lookup?mode=barcode&q=QA-1&store={self.store.pk}').json()
        self.assertEqual(exact['total'],1);self.assertEqual(exact['items'][0]['salePrice'],'13.00')
        self.assertEqual(self.get('products/lookup?mode=fuzzy&q=QA').status_code,400)

    def test_archived_store_historical_selection_and_stock_labels_remain_readable(self):
        self.store.active=False;self.store.save()
        self.u.profile.role='manager';self.u.profile.store=self.store;self.u.profile.save()
        result=self.details({'ids':[{'type':'products','id':'p'}],'store':self.store.pk,'purpose':'sale'})
        self.assertEqual(result.status_code,200);self.assertEqual(result.json()['items'][0]['id'],'p')
        self.assertEqual(self.get(f'directories/products?store={self.store.pk}&purpose=filter').status_code,200)
        self.assertEqual(self.get(f'directories/products?store={self.store.pk}&purpose=sale').status_code,400)
        self.assertEqual(self.get(f'products/lookup?store={self.store.pk}&mode=barcode&q=QA').status_code,400)
        self.u.profile.role='warehouse';self.u.profile.save()
        self.assertEqual(self.get('directories/cash_shifts').status_code,403)

    def test_pg_page_count_and_rows_share_readonly_snapshot(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL snapshot interleaving')
        for i in range(31):Counterparty.objects.create(name=f'QA snapshot {i:03}',kind='customer')
        original=directories.page_bounds
        def writer():
            try:Counterparty.objects.filter(name='QA snapshot 000').delete()
            finally:connections['default'].close()
        def between(*args,**kwargs):
            with connection.cursor() as cursor:cursor.execute('SHOW transaction_read_only');self.assertEqual(cursor.fetchone()[0],'on')
            with ThreadPoolExecutor(max_workers=1) as pool:pool.submit(writer).result(timeout=10)
            return original(*args,**kwargs)
        with patch.object(directories,'page_bounds',side_effect=between):result=directories.page(self.u,'parties',{'q':'QA snapshot'})
        self.assertEqual((result['total'],len(result['items'])),(31,30));self.assertEqual(result['items'][0]['name'],'QA snapshot 000')
        self.assertEqual(directories.page(self.u,'parties',{'q':'QA snapshot'})['total'],30)
