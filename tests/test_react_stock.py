"""Actual React Stock transport: current policy/snapshot/parity and slim journal."""
import hashlib
import time
from decimal import Decimal
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from django.db import connection, connections
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import PortalSession, StockLot, Store, Warehouse
from server.erp.reporting import stock
from server.erp.stock_api import stock as stock_transport, documents
from server.erp.stock_browsing import stock_csv
from tests.test_erp import AccountingFixture


class ReactStockTests(TransactionTestCase):
    v = AccountingFixture.v

    def setUp(self):
        AccountingFixture.setUp(self)
        PortalSession.objects.create(token_hash=hashlib.sha256(b'react-stock-token').hexdigest(), user=self.u, csrf='react-stock-csrf', expires=int(time.time())+3600)
        self.client.cookies['ts_session']='react-stock-token'
        self.p.data['minStock']=5;self.p.save()

    def test_versioned_page_parity_and_bound_revision_ack(self):
        self.v('receipt',3,2)
        old=stock(self.u)['totals'][0]
        data=self.client.get('/api/v1/trading/stock',{'warehouse':self.wh.pk}).json()
        self.assertEqual(data['items'][0],{**{k:v for k,v in old.items() if k not in {'quantity','available','reserved','minimum','value'}},
                                         **{k:format(Decimal(old[k]),'.2f' if k=='value' else '.3f') for k in ('quantity','available','reserved','minimum','value')}})
        self.assertEqual(data['query'],{'q':'','store':None,'warehouse':self.wh.pk,'view':'totals'})
        self.assertTrue(data['policy']['canEditAssortment'])
        value={'warehouse':self.wh.pk,'product':'p','sold':False,'min_stock':'0','revision':None}
        ack=self.client.post('/api/v1/trading/assortment',value,content_type='application/json',HTTP_X_CSRF_TOKEN='react-stock-csrf',HTTP_ORIGIN='http://testserver')
        self.assertEqual(ack.status_code,200,ack.content);body=ack.json()
        self.assertEqual((body['warehouse'],body['row']['product'],body['row']['min_stock']),(self.wh.pk,'p','0.000'))
        conflict=self.client.post('/api/v1/trading/assortment',value,content_type='application/json',HTTP_X_CSRF_TOKEN='react-stock-csrf',HTTP_ORIGIN='http://testserver')
        self.assertEqual(conflict.status_code,409)
        current=self.client.get('/api/v1/trading/assortment',{'warehouse':self.wh.pk,'product':'p'}).json()
        self.assertEqual(current['rows'][0],body['row'])
        self.assertNotIn('original_request_confirmed',current)

    def test_cached_role_and_csv_generator_revalidate_private_policy(self):
        self.v('receipt',1,2)
        # Prime cached profile, then change the DB without updating the object.
        self.assertEqual(self.u.profile.role,'owner')
        type(self.u.profile).objects.filter(pk=self.u.profile.pk).update(role='cashier',store_id=self.store.pk)
        response=stock_transport(self.u,{})
        self.assertFalse(response['policy']['costVisible']);self.assertNotIn('value',response['summary']);self.assertNotIn('value',response['items'][0]);self.assertEqual(response['policy']['documentKinds'],[])
        type(self.u.profile).objects.filter(pk=self.u.profile.pk).update(role='owner')
        csv=stock_csv(self.u,{})
        type(self.u.profile).objects.filter(pk=self.u.profile.pk).update(role='cashier')
        self.assertNotIn('Вартість',b''.join(csv.streaming_content).decode())
        self.assertEqual(self.client.get('/api/v1/trading/assortment',{'warehouse':self.wh.pk}).status_code,403)

    def test_journal_scope_filters_and_no_children_or_payload_reads(self):
        receipt=self.v('receipt',1,2)
        opening=self.v('opening',1,2)
        foreign=Store.objects.create(name='Інший');Warehouse.objects.create(store=foreign,name='Інший склад')
        type(self.u.profile).objects.filter(pk=self.u.profile.pk).update(store_id=self.store.pk)
        with CaptureQueriesContext(connection) as queries: page=documents(self.u,{'status':'posted'})
        self.assertEqual([x['id'] for x in page['items']],[opening.pk]);self.assertNotIn('cost',page['items'][0]);self.assertNotIn(receipt.pk,[x['id'] for x in page['items']])
        select_sql=' '.join(x['sql'].lower() for x in queries if x['sql'].lstrip().upper().startswith('SELECT'))
        self.assertNotIn('erp_voucherline',select_sql);self.assertNotIn('"payload"',select_sql);self.assertNotIn('erp_paymentallocation',select_sql)
        self.assertEqual(documents(self.u,{'store':str(foreign.pk)})['total'],0)
        for path,params in [('stock',{'sort':'money'}),('stock/documents',{'status':'anything'}),('stock/documents',{'page':0})]:self.assertEqual(self.client.get('/api/v1/trading/'+path,params).status_code,400)
        self.u.is_active=False;self.u.save(update_fields=['is_active'])
        with self.assertRaisesRegex(ValueError,'доступ відкликано'):stock_transport(self.u,{})

    def test_pg_metadata_summary_items_share_real_readonly_snapshot(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL RR interleaving')
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
                with connection.cursor() as c:c.execute('SHOW transaction_read_only');self.assertEqual(c.fetchone()[0],'on')
                with ThreadPoolExecutor(max_workers=1) as pool:pool.submit(writer).result(timeout=10)
            return result
        with patch.object(stock_browsing,'rows',side_effect=between):response=stock_transport(self.u,{})
        self.assertTrue(response['policy']['costVisible']);self.assertEqual(response['summary']['value'],'10.00');self.assertEqual(response['items'][0]['quantity'],'2.000')
        self.assertEqual(stock_transport(self.u,{})['summary']['value'],'5.00')

    def test_frozen_day_and_unknown_versioned_query_keys(self):
        from datetime import date
        from server.erp import stock_browsing
        self.v('receipt',1,2)
        StockLot.objects.update(expiry=date(2026,10,4))
        with patch.object(stock_browsing.timezone,'localdate',side_effect=[date(2026,10,4),date(2026,10,5)]) as clock:
            result=stock_transport(self.u,{'view':'lots'})
        self.assertEqual(clock.call_count,1)
        self.assertEqual(result['asOf'],'2026-10-04')
        self.assertEqual(result['items'][0]['available'],'1.000')
        self.assertFalse(result['items'][0]['expired'])
        for path in ('stock','stock/documents','stock.csv','assortment'):
            self.assertEqual(self.client.get('/api/v1/trading/'+path,{'Store':self.store.pk,'warehouse':self.wh.pk}).status_code,400)
        from server.erp.models import Assortment, AuditEvent
        before=AuditEvent.objects.count()
        response=self.client.post('/api/v1/trading/assortment',{'warehouse':self.wh.pk,'product':'p','sold':True,'min_stock':'1','revision':None,'default_min':'9'},content_type='application/json',HTTP_X_CSRF_TOKEN='react-stock-csrf',HTTP_ORIGIN='http://testserver')
        self.assertEqual(response.status_code,400);self.assertEqual(Assortment.objects.count(),0);self.assertEqual(AuditEvent.objects.count(),before)
        # Legacy URLs retain their existing permissive parameter compatibility.
        self.assertEqual(self.client.get('/api/erp/stock',{'Store':self.store.pk}).status_code,200)
