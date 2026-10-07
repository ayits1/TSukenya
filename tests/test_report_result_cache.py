"""Complete derived images: actual PG endpoints plus isolated private-file limits."""
import csv
import fcntl
import io
import os
import sqlite3
import tempfile
import time
from contextlib import nullcontext
from datetime import date
from pathlib import Path
from threading import Thread, Event
from types import SimpleNamespace
from unittest import mock, skipUnless
from django.db import connection, connections, close_old_connections, transaction
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.contrib.auth.models import User
from server.erp import bounded_reports as reports, abc_reports as abc, report_result_cache as cache
from server.erp.models import Profile, Voucher, VoucherLine, Store, Document, TradingVersion
from server.erp.services import BusinessError
from tests.test_erp import AccountingFixture
from tests import test_bounded_reports as report_fixtures


class ImageFileTests(SimpleTestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.override=override_settings(REPORT_RESULT_CACHE_DIR=self.temp.name);self.override.enable();self.addCleanup(self.override.disable)
        for target,value in [('key',lambda *args:'a'*64),('statement_deadline',nullcontext)]:
            patch=mock.patch.object(cache,target,value);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(cache.connection,'vendor','postgresql');patch.start();self.addCleanup(patch.stop)
    def image(self,build):return cache.image(None,'period',{},[],date.today(),build)
    def build(self,spool):
        for k,amount in [('a','99999999999999.98'),('b','99999999999999.99'),('c','-1.01')]:
            spool.put('products',k,{'name':'100%_\\ '+k,'result':amount})
        return {'sum':'199999999999998.96'}
    def test_complete_exact_order_indexed_reads_cancel_and_reopen(self):
        with self.image(self.build) as (spool,data):
            path=cache.root()/('a'*64+'.sqlite3')
            self.assertEqual(os.stat(path).st_mode & 0o777,0o600)
            self.assertEqual([k for k,_ in spool.rows('products')],['b','a','c'])
            where,args=spool.query('products','%_\\')
            plan=spool.db.execute("EXPLAIN QUERY PLAN SELECT key,value FROM rows WHERE "+where+" ORDER BY json_extract(value,'$.result') COLLATE decimal DESC,COALESCE(json_extract(value,'$.name'),json_extract(value,'$.party'),json_extract(value,'$.category'),''),key",args).fetchall()
            self.assertNotIn('TEMP B-TREE',str(plan));self.assertEqual(spool.count('products','%_\\'),3)
            handle=open(path,'rb')
            try:
                with self.assertRaises(BlockingIOError):fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:handle.close()
        with open(path,'rb') as handle:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        with self.image(mock.Mock(side_effect=AssertionError('must be hit'))) as (_,again):self.assertEqual(again,data)
    def test_capacity_reservation_refusal_active_lease_and_peak(self):
        with override_settings(REPORT_RESULT_CACHE_IMAGE_BYTES=65536,REPORT_RESULT_CACHE_TOTAL_BYTES=65536):
            with self.image(self.build) as (_,data):
                with mock.patch.object(cache,'key',return_value='b'*64):
                    called=mock.Mock(side_effect=AssertionError('reservation must precede build'))
                    with self.assertRaises(cache.Unavailable):
                        with self.image(called):pass
                    called.assert_not_called()
            sizes=[]
            def large(spool):
                for i in range(1000):
                    spool.put('products',str(i),{'name':'x'*2000,'result':'0'})
                    sizes.append(sum(p.stat().st_size for p in cache.root().iterdir() if p.is_file()))
                return {}
            with mock.patch.object(cache,'key',return_value='b'*64):
                with self.assertRaises(cache.Unavailable):
                    with self.image(large):pass
            self.assertLessEqual(max(sizes),65536);self.assertFalse(list(cache.root().glob('.build-*')))
            self.assertFalse((cache.root()/('b'*64+'.sqlite3')).exists())
    def test_failed_cancelled_build_no_partial_and_ttl_lease_refusal(self):
        def cancelled(spool):self.build(spool);raise GeneratorExit()
        with self.assertRaises(GeneratorExit):
            with self.image(cancelled):pass
        self.assertFalse(list(cache.root().glob('*.sqlite3')));self.assertFalse(list(cache.root().glob('.build-*')))
        with self.image(self.build) as (_,_):
            path=cache.root()/('a'*64+'.sqlite3');os.utime(path,(0,0))
            with self.assertRaises(cache.Unavailable):
                with self.image(self.build):pass
        with self.image(self.build) as (_,_):pass
    def test_deadline_interrupt_and_corrupt_image_never_partial(self):
        with override_settings(REPORT_RESULT_CACHE_ACTION_SECONDS=.000001):
            with self.assertRaises(cache.Unavailable):
                with self.image(self.build):pass
        self.assertFalse(list(cache.root().glob('.build-*')))
        with self.image(self.build) as (_,_):pass
        path=cache.root()/('a'*64+'.sqlite3');path.write_bytes(b'invalid complete image')
        with self.assertRaises(cache.Unavailable):
            with self.image(self.build):pass
        self.assertFalse(list(cache.root().glob('.build-*')))
        os.utime(path,(0,0))
        with self.image(self.build) as (spool,data):self.assertEqual(spool.count('products'),3)


@skipUnless(connection.vendor=='postgresql','Durable report cache requires PostgreSQL RR/counters')
class ReportCachePGTests(TransactionTestCase):
    v=AccountingFixture.v;cash_start=AccountingFixture.cash_start;sale=AccountingFixture.sale
    wide=report_fixtures.BoundedReportsTests.wide;login=report_fixtures.BoundedReportsTests.login
    def setUp(self):
        AccountingFixture.setUp(self)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.override=override_settings(REPORT_RESULT_CACHE_DIR=self.temp.name);self.override.enable();self.addCleanup(self.override.disable)
    def user(self,role,store=None):
        user=User.objects.create(username=role+str(User.objects.count()));Profile.objects.create(user=user,role=role,store=store);return user
    def get(self,path,params,csv_output=False):
        response=self.client.get(path,params);self.assertEqual(response.status_code,200,getattr(response,'content',b'') if not response.streaming else '')
        if csv_output:
            try:return list(csv.reader(io.StringIO(b''.join(response.streaming_content).decode('utf-8-sig')),delimiter=';'))
            finally:response.close()
        return response.json()
    def test_actual_endpoint_period_balances_abc_pages_search_full_csv_hits_and_oracle(self):
        self.wide();self.login(self.u)
        for mode,section,moneyfield in [('period','products','revenue'),('balances','stock','value')]:
            params={'mode':mode,'section':section};path='/api/v1/trading/reports/rows'
            with override_settings(REPORT_RESULT_CACHE_ENABLED=False):oracle=self.get(path,params)
            cold=self.get(path,params);self.assertEqual(cold['items'],oracle['items']);self.assertEqual(cold['summary']['counts'],oracle['summary']['counts'])
            with mock.patch.object(reports,'period',side_effect=AssertionError('source period rescan')),mock.patch.object(reports,'balances',side_effect=AssertionError('source balances rescan')),CaptureQueriesContext(connection) as queries:
                second=self.get(path,{**params,'page':'2'});filtered=self.get(path,{**params,'q':'Товар0'})
                exported=self.get('/api/v1/trading/reports/export.csv',{**params,'q':'Товар0'},True)
                self.assertEqual(len(second['items']),30);self.assertEqual(len(exported)-2,filtered['total']);self.assertGreater(filtered['total'],30)
                from decimal import Decimal
                column=[key for key,_ in reports.CSV_FIELDS[section]].index(moneyfield)
                self.assertEqual(sum((Decimal(row[column]) for row in exported[2:]),Decimal(0)),sum((Decimal(row[moneyfield]) for page in (1,2,3) for row in self.get(path,{**params,'q':'Товар0','page':str(page)})['items']),Decimal(0)))
                summary=self.get('/api/v1/trading/reports/summary',{'mode':mode});self.assertEqual(summary,cold['summary'])
                with reports.built(self.u,{'mode':mode}) as (spool,data):
                    for selected_section in data['counts']:
                        traced=[];spool.db.set_trace_callback(traced.append)
                        list(spool.rows(selected_section,'Товар0',30,0));spool.db.set_trace_callback(None)
                        plan=spool.db.execute('EXPLAIN QUERY PLAN '+traced[0]).fetchall()
                        self.assertNotIn('TEMP B-TREE',str(plan),selected_section)
            self.assertFalse(any('DECLARE ' in q['sql'] for q in queries))
            self.assertEqual(len(list(cache.root().glob('*.sqlite3'))),1 if mode=='period' else 2)
        with override_settings(REPORT_RESULT_CACHE_ENABLED=False):oracle=abc.report(self.u,{})
        cold=self.get('/api/v1/trading/reports/abc',{})
        self.assertEqual(cold['summary'],oracle['summary']);self.assertEqual(cold['items'],oracle['items'])
        with mock.patch.object(abc,'populate',side_effect=AssertionError('source ABC rescan')):
            self.get('/api/v1/trading/reports/abc',{'page':'2'})
            filtered=self.get('/api/v1/trading/reports/abc',{'q':'Товар0'})
            exported=self.get('/api/v1/trading/reports/abc/export.csv',{'q':'Товар0'},True)
            self.assertEqual(len(exported)-3,filtered['total']);self.assertGreater(filtered['total'],30)
            from decimal import Decimal
            self.assertEqual(sum((Decimal(row[3]) for row in exported[3:]),Decimal(0)),sum((Decimal(row['netRevenue']) for page in (1,2,3) for row in self.get('/api/v1/trading/reports/abc',{'q':'Товар0','page':str(page)})['items']),Decimal(0)))
            with abc.built(self.u,{}) as (spool,data,_,_):
                where,args=abc.query('Товар0','A');traced=[];spool.db.set_trace_callback(traced.append)
                list(abc.records(spool,Decimal(data['summary']['positivePoolRevenue']),where,args,30,0));spool.db.set_trace_callback(None)
                self.assertNotIn('TEMP B-TREE',str(spool.db.execute('EXPLAIN QUERY PLAN '+traced[0]).fetchall()))
                self.assertNotIn('TEMP B-TREE',str(spool.db.execute('EXPLAIN QUERY PLAN SELECT revenue,count FROM groups ORDER BY revenue COLLATE decimal DESC').fetchall()))
    def test_committed_bulk_rollback_caption_invalidation_scoped_salary_privacy_and_actor_revoke(self):
        self.v('receipt',5,1);sold=self.sale(1);manager=self.user('manager',self.store);self.login(manager)
        params={'mode':'period','store':str(self.store.pk)}
        old=self.get('/api/v1/trading/reports/summary',params);files=set(cache.root().glob('*.sqlite3'))
        payroll=Voucher.objects.create(kind='payroll',status='posted',date=self.today,store=self.store,created_by=self.u,total=2)
        self.get('/api/v1/trading/reports/summary',params);files=set(cache.root().glob('*.sqlite3'))
        Voucher.objects.filter(pk=payroll.pk).update(payload={'note':'private salary detail','rate':'99'})
        with mock.patch.object(reports,'period',side_effect=AssertionError('private salary edit must not invalidate manager')):self.get('/api/v1/trading/reports/summary',params)
        self.assertEqual(set(cache.root().glob('*.sqlite3')),files)
        line=VoucherLine.objects.get(voucher=sold);line.amount=12;VoucherLine.objects.bulk_update([line],['amount']);Voucher.objects.filter(pk=sold.pk).update(total=12)
        new=self.get('/api/v1/trading/reports/summary',params);self.assertEqual(new['revenue'],'12.00')
        with transaction.atomic():
            VoucherLine.objects.filter(pk=line.pk).update(amount=999);transaction.set_rollback(True)
        with mock.patch.object(reports,'period',side_effect=AssertionError('rollback must retain committed image')):self.assertEqual(self.get('/api/v1/trading/reports/summary',params),new)
        Store.objects.filter(pk=self.store.pk).update(name='Current caption')
        changed=self.get('/api/v1/trading/reports/summary',params);self.assertEqual(changed['scope_name'],'Current caption')
        self.login(self.u);reports.summary(self.u,{'mode':'balances'})
        Profile.objects.filter(user=self.u).update(role='manager',store=self.store)
        result=self.client.get('/api/v1/trading/reports/rows',{'mode':'balances','section':'payroll_debts'});self.assertEqual(result.status_code,403)
        User.objects.filter(pk=self.u.pk).update(is_active=False)
        with self.assertRaises(BusinessError):reports.summary(self.u,{'mode':'balances'})
    def test_rr_writer_between_key_and_build_current_read_only_and_next_hit_changes(self):
        self.v('receipt',5,1);sold=self.sale(1);line=VoucherLine.objects.get(voucher=sold)
        original=reports.period;started=Event();finished=Event();errors=[]
        def writer():
            close_old_connections()
            try:
                started.wait(5)
                with transaction.atomic():
                    VoucherLine.objects.filter(pk=line.pk).update(amount=77)
                    Voucher.objects.filter(pk=sold.pk).update(total=77)
            except BaseException as exc:errors.append(exc)
            finally:finished.set();connections.close_all()
        thread=Thread(target=writer);thread.start()
        def build(*args):
            with connection.cursor() as cursor:
                cursor.execute('SHOW transaction_isolation');self.assertEqual(cursor.fetchone()[0],'repeatable read')
                cursor.execute('SHOW transaction_read_only');self.assertEqual(cursor.fetchone()[0],'on')
            started.set();self.assertTrue(finished.wait(5));return original(*args)
        with mock.patch.object(reports,'period',build):first=reports.summary(self.u,{'mode':'period'})
        thread.join(5);self.assertFalse(thread.is_alive());self.assertFalse(errors)
        self.assertEqual(first['revenue'],'10.00');self.assertEqual(reports.summary(self.u,{'mode':'period'})['revenue'],'77.00')
        bad=Voucher.objects.create(kind='purchase_order',status='reversed',reversed_at=None,date=self.today,store=self.store,created_by=self.u)
        with self.assertRaises(BusinessError):reports.summary(self.u,{'mode':'period'})
    def test_two_worker_same_key_complete_publish_and_cancelled_csv_releases_lease(self):
        self.v('receipt',5,1);self.sale(1);original=reports.period;calls=[];errors=[];results=[]
        def build(*args):calls.append(1);time.sleep(.2);return original(*args)
        def worker():
            close_old_connections()
            try:results.append(reports.summary(self.u,{'mode':'period'}))
            except BaseException as exc:errors.append(exc)
            finally:connections.close_all()
        with mock.patch.object(reports,'period',build):
            threads=[Thread(target=worker) for _ in range(2)]
            for thread in threads:thread.start()
            for thread in threads:thread.join(8);self.assertFalse(thread.is_alive())
        self.assertFalse(errors,errors);self.assertEqual(len(calls),1);self.assertEqual(results[0],results[1]);self.assertEqual(len(list(cache.root().glob('*.sqlite3'))),1)
        response=reports.export_csv(self.u,{'mode':'period','section':'products'});iterator=iter(response.streaming_content);next(iterator)
        path=next(cache.root().glob('*.sqlite3'))
        with open(path,'rb') as handle:
            with self.assertRaises(BlockingIOError):fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        response.close()
        with open(path,'rb') as handle:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.assertFalse(connection.in_atomic_block);self.assertFalse(list(cache.root().glob('.build-*')))
    def test_actual_http_capacity_and_statement_timeout_are_retryable_without_partial_publish(self):
        self.login(self.u)
        with override_settings(REPORT_RESULT_CACHE_IMAGE_BYTES=4096,REPORT_RESULT_CACHE_TOTAL_BYTES=4096):
            result=self.client.get('/api/v1/trading/reports/summary',{'mode':'period'})
            self.assertEqual(result.status_code,503);self.assertEqual(result.json()['code'],'report_read_unavailable');self.assertEqual(result['Retry-After'],'2')
        self.assertFalse(list(cache.root().glob('.build-*')));self.assertFalse(list(cache.root().glob('*.sqlite3')))
        def slow(*args):
            with connection.cursor() as cursor:cursor.execute('SELECT pg_sleep(.2)')
            raise AssertionError('statement timeout did not stop source query')
        with override_settings(REPORT_RESULT_CACHE_STATEMENT_SECONDS=.01),mock.patch.object(reports,'period',slow):
            result=self.client.get('/api/v1/trading/reports/summary',{'mode':'period'})
            self.assertEqual(result.status_code,503,result.content)
        self.assertFalse(connection.in_atomic_block);self.assertFalse(list(cache.root().glob('.build-*')))
        self.assertEqual(self.client.get('/api/v1/trading/reports/summary',{'mode':'period'}).status_code,200)
        from server.erp.historical_reports import read_snapshot
        with read_snapshot():
            with connection.cursor() as cursor:cursor.execute("SET LOCAL statement_timeout='5ms'")
            with cache.read_limits():
                with connection.cursor() as cursor:
                    cursor.execute('SHOW statement_timeout');self.assertEqual(cursor.fetchone()[0],'5ms')
            with connection.cursor() as cursor:
                cursor.execute('SHOW statement_timeout');self.assertEqual(cursor.fetchone()[0],'5ms')
    def test_separate_process_shared_namespace_and_stable_hmac_hit_without_source_reads(self):
        import json
        import subprocess
        import sys
        from django.conf import settings
        self.v('receipt',5,1);self.sale(1)
        expected=reports.summary(self.u,{'mode':'period'})
        environment={k:os.environ[k] for k in ('PATH','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD')}
        environment.update(DJANGO_SETTINGS_MODULE='server.settings',DB_NAME=connection.settings_dict['NAME'],DJANGO_SECRET_KEY=settings.SECRET_KEY)
        code="""import json,sys,django
from unittest import mock
django.setup()
from django.test import override_settings
from django.contrib.auth.models import User
from server.erp import bounded_reports as reports
with override_settings(REPORT_RESULT_CACHE_DIR=sys.argv[1]),mock.patch.object(reports,'period',side_effect=AssertionError('child source rescan')):
    print(json.dumps(reports.summary(User.objects.get(pk=int(sys.argv[2])),{'mode':'period'})))
"""
        result=subprocess.run([sys.executable,'-c',code,self.temp.name,str(self.u.pk)],env=environment,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout),expected)
        self.assertEqual(len(list(cache.root().glob('*.sqlite3'))),1)

    def test_foreign_empty_compatibility_hit_never_observes_hidden_store_counters(self):
        foreign=Store.objects.create(name='Foreign');manager=self.user('manager',self.store);self.login(manager)
        params={'mode':'period','store':str(foreign.pk)}
        first=self.get('/api/v1/trading/reports/summary',params)
        self.assertTrue(all(count==0 for count in first['counts'].values()))
        Voucher.objects.create(kind='expense',status='posted',date=self.today,store=foreign,created_by=self.u,total=99)
        Store.objects.filter(pk=foreign.pk).update(name='Hidden changed caption')
        with mock.patch.object(reports,'period',side_effect=AssertionError('hidden foreign event invalidated empty projection')),CaptureQueriesContext(connection) as queries:
            second=self.get('/api/v1/trading/reports/summary',params)
        self.assertEqual(first,second)
        self.assertFalse(any('erp_tradingversion' in q['sql'].lower() for q in queries))
