"""B24 actual bounded read contracts, authoritative stock parity and snapshot."""
import hashlib
import time
import uuid
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

from django.db import connection, connections
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from server.erp.models import Document, StockLot, Assortment, Store, Warehouse, PortalSession
from server.erp.reporting import stock
from server.erp.stock_browsing import stock_page, stock_csv
from server.erp.assortment import assortment
from server.erp.orders import mutate
from server.erp.csv_format import read_rows
from tests.test_erp import AccountingFixture


class StockBrowsingTests(TransactionTestCase):
    v = AccountingFixture.v
    sale = AccountingFixture.sale

    def setUp(self):
        AccountingFixture.setUp(self)
        PortalSession.objects.create(token_hash=hashlib.sha256(b'bounded-token').hexdigest(), user=self.u, csrf='bounded-csrf', expires=int(time.time())+3600)
        self.client.cookies['ts_session']='bounded-token'
        self.p.data['minStock']=5;self.p.save()

    def fixture(self, count=66):
        Document.objects.bulk_create([Document(path=f'products/z{i:03}',data={'name':f'Товар {i:03}','unit':'кг' if i%2 else 'шт','minStock':2}) for i in range(count)])
        StockLot.objects.bulk_create([StockLot(warehouse=self.wh,product_id=f'products/z{i:03}',code='lot',quantity=1,value=Decimal('0.01')) for i in range(count)])

    def all_pages(self, **params):
        first=stock_page(self.u,{key:str(value) for key,value in params.items()})
        values=list(first['items'])
        for page in range(2,first['pages']+1): values+=stock_page(self.u,{**{key:str(value) for key,value in params.items()},'page':str(page)})['items']
        return first,values

    def test_page30_and_whole_summary_match_authoritative_stock(self):
        self.fixture();self.v('receipt',3,'0.3333');self.sale(3,1)
        self.v('receipt',4,2,lines=[{'product':'p','quantity':4,'price':2,'lot':'fresh'}, {'product':'p','quantity':1,'price':3,'lot':'expired'}])
        StockLot.objects.filter(code='expired').update(expiry=timezone.localdate()-timedelta(days=1))
        order=self.v('customer_order',2,5,party=self.customer.pk)
        from server.erp.orders import order_json
        mutate(self.u,order.pk,{'action':'reserve','idempotencyKey':str(uuid.uuid4()),'revision':order_json(order,self.u)['revision'],'expires_on':self.today,
                              'lines':[{'line':order.lines.get().pk,'quantity':'2'}]})
        Assortment.objects.create(warehouse=self.wh,product=self.p,sold=False,min_stock=1)
        old=stock(self.u);first,items=self.all_pages()
        self.assertEqual(len(first['items']),30)
        self.assertEqual(first['total'],len(old['totals']))
        for row in items:
            expected=next(x for x in old['totals'] if (x['warehouse'],x['product'])==(row['warehouse'],row['product']))
            for key in ('quantity','available','reserved','value','minimum'):self.assertEqual(Decimal(row[key]),Decimal(expected[key]),(key,row,expected))
            for key in ('sold','low','name','unit'):self.assertEqual(row[key],expected[key])
        self.assertEqual(Decimal(first['summary']['value']),sum(Decimal(x['value']) for x in old['totals']))
        self.assertEqual(first['summary']['low'],sum(x['low'] for x in old['totals']))
        lots,rows=self.all_pages(view='lots')
        self.assertEqual(lots['total'],len(old['lots']))
        for row in rows:
            expected=next(x for x in old['lots'] if x['id']==row['id'])
            for key in ('quantity','available','reserved','value'):self.assertEqual(Decimal(row[key]),Decimal(expected[key]))
            self.assertEqual({key:value for key,value in row.items() if key not in {'quantity','available','reserved','value'}},
                             {key:value for key,value in expected.items() if key not in {'quantity','available','reserved','value'}})
        with CaptureQueriesContext(connection) as queries: measured=self.client.get('/api/erp/stock')
        self.assertEqual(measured.status_code,200,measured.content)
        self.assertLessEqual(len(queries),8)

    def test_server_search_scope_cashier_and_bad_filters(self):
        self.fixture();foreign=Store.objects.create(name='Foreign');wh=Warehouse.objects.create(store=foreign,name='Foreign warehouse')
        StockLot.objects.create(warehouse=wh,product=self.p,code='Foreign',quantity=1,value=999)
        self.u.profile.role='cashier';self.u.profile.store=self.store;self.u.profile.save()
        response=self.client.get('/api/erp/stock?q=ТОВАР&view=lots').json()
        self.assertEqual(response['total'],66);self.assertNotIn('value',response['summary'])
        self.assertTrue(all('value' not in row for row in response['items']))
        self.assertEqual(self.client.get(f'/api/erp/stock?store={foreign.pk}').json()['total'],0)
        for query in ('view=all','sort=value','page=0','warehouse=-1','q='+'x'*251):self.assertEqual(self.client.get('/api/erp/stock?'+query).status_code,400)
        selected=self.client.get(f'/api/erp/stock?q=Товар%20065&warehouse={self.wh.pk}').json();self.assertEqual(selected['total'],1)
        self.assertEqual(selected['items'][0]['product'],'z065')

    def test_assortment_search_pages_and_selected_detail(self):
        self.fixture();Assortment.objects.create(warehouse=self.wh,product_id='products/z065',sold=False,min_stock=Decimal('3.125'))
        first=assortment(self.u,{'warehouse':str(self.wh.pk)})
        self.assertEqual((len(first['rows']),first['total'],first['pages']),(30,67,3))
        selected=assortment(self.u,{'warehouse':str(self.wh.pk),'product':'z065'})
        self.assertEqual(selected['total'],1);self.assertEqual(selected['rows'][0]['minimum'],'3.125')
        filtered=assortment(self.u,{'warehouse':str(self.wh.pk),'q':'Товар 065'})
        self.assertEqual(filtered['rows'],selected['rows'])

    def test_csv_stream_exports_whole_filter_and_guards_formula(self):
        self.fixture();self.p.data['name']='=1+1';self.p.save()
        for role in ('owner','cashier'):
            self.u.profile.role=role;self.u.profile.save()
            response=stock_csv(self.u,{'warehouse':str(self.wh.pk)})
            self.assertTrue(response.streaming)
            content=b''.join(response.streaming_content).decode('utf-8');headers,records=read_rows(content)
            self.assertEqual(len(records),67)
            self.assertEqual(records[-1][1]['Товар'] if records[-1][1]['Товар']=='=1+1' else records[0][1]['Товар'],'=1+1')
            self.assertIn('"\t=1+1"',content)
            self.assertEqual('Вартість' in headers,role=='owner')
        selected=stock_csv(self.u,{'q':'Товар 065','warehouse':str(self.wh.pk)})
        _,records=read_rows(b''.join(selected.streaming_content).decode());self.assertEqual(len(records),1)

    def test_pg_summary_and_page_share_readonly_snapshot(self):
        if connection.vendor!='postgresql':self.skipTest('PG snapshot interleaving')
        self.v('receipt',2,5);lot=StockLot.objects.get()
        from server.erp import stock_browsing
        original=stock_browsing.rows;calls=0
        def writer():
            try:StockLot.objects.filter(pk=lot.pk).update(quantity=1,value=5)
            finally:connections['default'].close()
        def between(cursor):
            nonlocal calls
            result=original(cursor);calls+=1
            if calls==1:
                with connection.cursor() as check:
                    check.execute('SHOW transaction_read_only');self.assertEqual(check.fetchone()[0],'on')
                with ThreadPoolExecutor(max_workers=1) as pool:pool.submit(writer).result(timeout=10)
            return result
        with patch.object(stock_browsing,'rows',side_effect=between):response=stock_page(self.u,{'warehouse':str(self.wh.pk)})
        self.assertEqual(response['summary']['value'],'10.00');self.assertEqual(response['items'][0]['quantity'],'2.000')
        self.assertEqual(stock_page(self.u,{'warehouse':str(self.wh.pk)})['summary']['value'],'5.00')
