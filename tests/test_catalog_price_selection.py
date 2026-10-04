import uuid
from unittest.mock import patch
from django.test import TransactionTestCase,Client
from django.db import connection,transaction,close_old_connections
from server.erp.models import AuditEvent,Document,Profile,User
from tests.test_catalog_price_results import PriceResultsTests

class PriceSelectionTests(TransactionTestCase):
    setUp=PriceResultsTests.setUp
    attach=PriceResultsTests.attach
    post=PriceResultsTests.post
    product=PriceResultsTests.product
    payload=PriceResultsTests.payload
    commit=PriceResultsTests.commit
    def review(self,key,value,kind='pricing'):
        return self.post('price-results/'+kind+'/'+key+'/selection-preview',value)
    def test_current_comparison_is_readonly_and_stale_snapshot_refused(self):
        p=self.product();_,body,ack=self.commit('pricing',self.payload(p,priceContext={'storeId':self.store.pk}))
        count=(Document.objects.count(),AuditEvent.objects.count())
        first=self.review(body['idempotencyKey'],{'ordinals':[1]});self.assertEqual(first.status_code,200,first.content)
        self.assertTrue(first.json()['canApply']);self.assertFalse(first.json()['items'][0]['revisionChanged'])
        p.refresh_from_db();p.data['cost']=20;p.save()
        stale=self.review(body['idempotencyKey'],{'ordinals':[1],'snapshot':first.json()['snapshot']});self.assertEqual(stale.status_code,409)
        fresh=self.review(body['idempotencyKey'],{'ordinals':[1]}).json();row=fresh['items'][0]
        self.assertEqual(row['operationResult'],ack['entries'][0]['priceResult']);self.assertEqual(row['currentTerms']['salePrice'],'28.00')
        self.assertTrue(row['amountChanged']);self.assertTrue(row['revisionChanged']);self.assertEqual(fresh['counts']['changedAfterOperation'],1)
        self.assertEqual(count,(Document.objects.count(),AuditEvent.objects.count()))
    def test_hidden_missing_and_foreign_ordinals_never_become_printable(self):
        p=self.product();_,body,_=self.commit('pricing',self.payload(p));key=body['idempotencyKey']
        p.refresh_from_db();p.data['hidden']=True;p.save();hidden=self.review(key,{'ordinals':[1]}).json()
        self.assertFalse(hidden['canApply']);self.assertEqual(hidden['counts']['hidden'],1);self.assertTrue(hidden['items'][0]['current']['hidden'])
        p.delete();missing=self.review(key,{'ordinals':[1]}).json();self.assertFalse(missing['canApply']);self.assertIsNone(missing['items'][0]['current']);self.assertEqual(missing['counts']['missing'],1)
        for payload in ({'ordinals':[2]},{'ordinals':[1,1]},{'ordinals':[True]},{'ordinals':[]},{'ordinals':[1],'ids':['unrelated']},{'ordinals':[1],'snapshot':'fake'}):self.assertEqual(self.review(key,payload).status_code,400)
    def test_creator_current_permissions_and_frozen_scope(self):
        p=self.product();_,body,_=self.commit('pricing',self.payload(p,priceContext={'storeId':self.store.pk}));key=body['idempotencyKey']
        self.user.profile.store=self.other;self.user.profile.save();self.assertEqual(self.review(key,{'ordinals':[1]}).status_code,403)
        self.user.profile.store=None;self.user.profile.role='manager';self.user.profile.save();self.assertEqual(self.review(key,{'ordinals':[1]}).status_code,403)
        other=User.objects.create(username='other-price-reviewer');Profile.objects.create(user=other,role='owner');self.attach(other);self.assertEqual(self.review(key,{'ordinals':[1]}).status_code,404)
    def test_paged_large_batch_uses_one_snapshot_and_clamps_requested_page(self):
        products=[self.product('Позиція'+str(n)) for n in range(101)]
        _,body,_=self.commit('pricing',{'kind':'markup','ids':[p.path.split('/')[1] for p in products],'markup':'40','resetManualPrices':False,'updateDefault':False})
        def trace(execute,sql,params,many,context):
            if connection.vendor=='postgresql' and sql.startswith('SELECT') and 'erp_document' in sql:
                with connection.cursor() as cursor:
                    cursor.execute('SHOW transaction_read_only');self.assertEqual(cursor.fetchone()[0],'on')
                    cursor.execute('SHOW transaction_isolation');self.assertEqual(cursor.fetchone()[0],'repeatable read')
            return execute(sql,params,many,context)
        with connection.execute_wrapper(trace):response=self.review(body['idempotencyKey'],{'ordinals':list(range(1,102)),'page':9})
        data=response.json();self.assertEqual(response.status_code,200,response.content);self.assertEqual(data['page'],2);self.assertEqual(len(data['selection']),101);self.assertEqual(len(data['items']),1)
        self.assertEqual(self.review(body['idempotencyKey'],{'ordinals':list(range(1,102)),'snapshot':data['snapshot']}).json()['snapshot'],data['snapshot'])
    def test_prepare_real_ledger_wait_refreshes_disabled_actor_and_scope(self):
        if connection.vendor!='postgresql':self.skipTest('Requires real PostgreSQL lock wait')
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from server.erp.services import ledger_lock
        p=self.product();token=self.client.cookies['ts_session'].value
        for change in ('disabled','scope'):
            User.objects.filter(pk=self.user.pk).update(is_active=True);Profile.objects.filter(user=self.user).update(store_id=self.store.pk)
            reached=Event()
            def wait():reached.set();ledger_lock()
            def prepare():
                close_old_connections()
                try:
                    client=Client();client.cookies['ts_session']=token
                    return client.post('/api/v1/labels/prepare',{'selection':[{'id':p.path.split('/')[1],'quantity':1}],'store':self.store.pk},content_type='application/json',**self.headers).status_code
                finally:close_old_connections()
            with ThreadPoolExecutor(max_workers=1) as pool:
                with patch('server.erp.labels.ledger_lock',side_effect=wait):
                    with transaction.atomic():
                        ledger_lock();future=pool.submit(prepare);self.assertTrue(reached.wait(5));self.assertFalse(future.done())
                        if change=='disabled':User.objects.filter(pk=self.user.pk).update(is_active=False)
                        else:Profile.objects.filter(user=self.user).update(store_id=self.other.pk)
                    self.assertEqual(future.result(timeout=10),403)
