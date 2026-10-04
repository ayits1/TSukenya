"""B24 bounded report pages/export preserve the historical accounting contract."""
import csv
import hashlib
import io
import os
import time
from datetime import timedelta
from decimal import Decimal
from threading import Thread
from unittest import mock, skipUnless
from django.db import connection, close_old_connections, DatabaseError, transaction
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.contrib.auth.models import User
from django.utils import timezone
from server.erp import bounded_reports as service
from server.erp.models import *
from server.erp.services import BusinessError, reverse_voucher
from server.erp.reporting import report
from tests.test_erp import AccountingFixture
from tests import test_historical_reports as historical
from tests import test_payroll_rules as payroll


class BoundedReportsTests(TransactionTestCase):
    v=AccountingFixture.v;cash_start=AccountingFixture.cash_start;sale=AccountingFixture.sale
    def setUp(self):
        if self._testMethodName.startswith('test_historical_'):historical.HistoricalReportTests.setUp(self)
        elif self._testMethodName.startswith('test_bonus_'):
            self.payroll_fixture=payroll.PayrollRuleTests();self.payroll_fixture.setUp()
            for k,v in self.payroll_fixture.__dict__.items():
                if not k.startswith('_'):setattr(self,k,v)
        else:AccountingFixture.setUp(self)
    def user(self,role,store=None):
        u=User.objects.create(username=role+str(User.objects.count()));Profile.objects.create(user=u,role=role,store=store);return u
    def login(self,user):
        token='bounded-report-'+str(user.pk);PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=user,csrf='qa-report',expires=int(time.time())+3600);self.client.cookies['ts_session']=token
    def page_all(self,user,params,section):
        rows=[];page=1
        while True:
            result=service.rows(user,{**params,'section':section,'page':str(page)});self.assertLessEqual(len(result['items']),30);rows+=result['items']
            if page==result['pages']:return rows
            page+=1
    def parity(self,user,params):
        old=report(user,params);new=service.summary(user,params)
        for k,v in old.items():
            if isinstance(v,list) or k in {'debt_count','debt_totals'} and params['mode']=='period':continue
            self.assertEqual(new[k],v,k)
        for section,count in new['counts'].items():
            actual=self.page_all(user,params,section);self.assertEqual(len(actual),len(old[section]),section);self.assertEqual(count,len(actual))
            def canonical(row):return {key:row[key] for key in old[section][0]} if old[section] else row
            self.assertCountEqual([canonical(x) for x in actual],old[section],section)
        return new
    def wide(self):
        now=timezone.now()
        for i in range(65):
            name=('=1+1' if i==0 else f'Товар{i:03}')
            p=Document.objects.create(path=f'products/w{i}',data={'name':name,'unit':'шт'})
            store=Store.objects.create(name=f'Крамниця{i:03}');wh=Warehouse.objects.create(store=store,name='Склад');account=CashAccount.objects.create(store=store,name=f'Рахунок{i:03}',kind='bank');employee=Employee.objects.create(store=store,name=f'Касир{i:03}')
            shift=CashShift.objects.create(store=store,account=account,employee=employee,opened_by=self.u,opening_cash=0,closed_at=now,expected_cash=5,counted_cash=4)
            CashShift.objects.filter(pk=shift.pk).update(opened_at=now-timedelta(hours=2))
            def voucher(kind,**kw):return Voucher.objects.create(kind=kind,status='posted',date=self.today,store=store,created_by=self.u,posted_at=now,**kw)
            receipt=voucher('receipt',party=self.party,total=100,cost=100)
            lot=StockLot.objects.create(product=p,warehouse=wh,code=f'Партія{i}',quantity=9,value=90)
            StockEntry.objects.create(voucher=receipt,lot=lot,quantity=10,value=100)
            sold=voucher('sale',party=self.customer,total=20,cost=10,shift=shift)
            VoucherLine.objects.create(voucher=sold,product=p,name=name,unit='шт',quantity=1,price=20,amount=20,cost=10)
            StockEntry.objects.create(voucher=sold,lot=lot,quantity=-1,value=-10)
            voucher('expense',total=3,payload={'category':f'Стаття{i:03}','expense_scope':'store'})
            voucher('payroll',employee=employee,total=2)
            paid=voucher('payment',party=self.customer,total=5)
            CashEntry.objects.create(voucher=paid,account=account,amount=5)
    def test_all_sections_65_rows_parity_clamp_and_full_csv(self):
        self.wide()
        for mode in ('period','balances'):
            params={'mode':mode};result=self.parity(self.u,params)
            for section,count in result['counts'].items():
                self.assertGreaterEqual(count,65)
                clamp=service.rows(self.u,{**params,'section':section,'page':'9999'});self.assertEqual(clamp['page'],clamp['pages']);self.assertEqual(len(clamp['items']),count%30 or 30)
                response=service.export_csv(self.u,{**params,'section':section});text=b''.join(response.streaming_content).decode('utf-8-sig')
                csvrows=list(csv.reader(io.StringIO(text),delimiter=';'));self.assertEqual(len(csvrows)-2,count,section)
                if section in {'products','stock'}:self.assertTrue(any('\t=1+1' in x for x in csvrows))
    def test_network_expense_and_explicit_allocation_refund_parity(self):
        self.cash_start();receipt=self.v('receipt',10,5)
        self.v('expense',amount=3,account=self.cash.pk,payload={'expense_scope':'network','category':'Мережа'})
        self.v('expense',amount=2,account=self.cash.pk,payload={'category':'Оренда'})
        self.parity(self.u,{'mode':'period'})
        self.parity(self.user('manager',self.store),{'mode':'period','store':str(self.store.pk)})
        from server.erp.services import save_voucher,post_voucher
        payment=save_voucher(self.u,{'kind':'payment','date':self.today,'store':self.store.pk,'party':self.party.pk,'account':self.cash.pk,'amount':'100','allocations':[]});payment=post_voucher(self.u,payment.pk)
        allocation=save_voucher(self.u,{'kind':'advance_allocation','date':self.today,'store':self.store.pk,'reference':payment.pk,'amount':'30','allocations':[{'source':receipt.pk,'amount':'30'}]});allocation=post_voucher(self.u,allocation.pk)
        refund=save_voucher(self.u,{'kind':'payment_refund','date':self.today,'store':self.store.pk,'reference':payment.pk,'account':self.cash.pk,'amount':'20'});refund=post_voucher(self.u,refund.pk)
        result=self.parity(self.u,{'mode':'balances'});self.assertEqual(result['advance_totals']['supplier'],'50.00');self.assertEqual(result['debt_totals']['owed_by_us'],'20.00')
        reverse_voucher(self.u,refund.pk,'QA');self.parity(self.u,{'mode':'balances'})
        reverse_voucher(self.u,allocation.pk,'QA');self.parity(self.u,{'mode':'balances'})
    def test_csv_search_full_filter_and_stale_actor_private_export(self):
        self.wide()
        params={'mode':'period','section':'products','q':'Товар06'}
        page=service.rows(self.u,params)
        text=b''.join(service.export_csv(self.u,params).streaming_content).decode('utf-8-sig')
        self.assertEqual(len(list(csv.reader(io.StringIO(text),delimiter=';')))-2,page['total'])
        data=service.summary(self.u,{'mode':'balances'})
        text=b''.join(service.export_csv(self.u,{'mode':'balances','section':'all'}).streaming_content).decode('utf-8-sig')
        self.assertEqual(len(list(csv.reader(io.StringIO(text),delimiter=';')))-2,sum(data['counts'].values()))
        response=service.export_csv(self.u,{'mode':'balances','section':'payroll_debts'})
        Profile.objects.filter(user=self.u).update(role='manager')
        with self.assertRaises(BusinessError):b''.join(response.streaming_content)
    def test_exact_sort_negative_totals_and_literal_search(self):
        with service.Spool() as spool:
            for key,value in [('a','99999999999999.98'),('b','99999999999999.99'),('c','-1.01')]:spool.put('products',key,{'name':'100%_\\ '+key,'result':value})
            self.assertEqual([k for k,_ in spool.rows('products')],['b','a','c']);self.assertEqual(spool.count('products','%_\\'),3)
            self.assertEqual(os.stat(spool.directory.name+'/rows.sqlite3').st_mode & 0o777,0o600)
    def test_historical_cutoff_storno_future_payments_and_transfer_parity(self):
        for cutoff in ('2026-09-30','2026-10-01','2026-10-02','2026-10-03'):self.parity(self.u,{'mode':'balances','as_of':cutoff})
        for month in ('09','10'):self.parity(self.u,{'mode':'period','from':f'2026-{month}-01','to':f'2026-{month}-03' if month=='10' else '2026-09-30'})
        target=Store.objects.create(name='Target');warehouse=Warehouse.objects.create(store=target,name='Target');account=CashAccount.objects.create(store=target,name='Target',kind='bank')
        self.today='2026-10-03';self.v('transfer',2,target=warehouse.pk);self.cash_start();self.v('cash_transfer',amount=12,account=self.cash.pk,payload={'target_account':account.pk})
        self.parity(self.user('manager',target),{'mode':'balances','as_of':self.today})
    def test_bonus_chronology_uses_previous_returns_remaining_basis_and_role(self):
        fixture=self.payroll_fixture
        employee,shift,sold,work,payroll=fixture.late_return()
        fixture.cash_return(sold,fixture.till(),2,100,date=fixture.yesterday)
        fixture.cash_return(sold,fixture.till(),2,100,date=fixture.today)
        for role in ('owner','manager','accountant'):
            user=self.u if role=='owner' else self.user(role,self.store)
            self.parity(user,{'mode':'period','from':fixture.today,'to':fixture.today})
            if role=='manager':self.assertTrue(all('late_return_bonus' not in x for x in self.page_all(user,{'mode':'period'},'cashiers')))
    def test_roles_scope_invalid_queries_and_no_business_write(self):
        self.v('receipt',3,5);self.sale(1)
        before=(AuditEvent.objects.count(),Voucher.objects.count(),StockEntry.objects.count(),CashEntry.objects.count())
        for role in ('owner','manager','accountant','cashier'):
            user=self.user(role,self.store);self.login(user)
            for endpoint in ('summary','rows?section=stock','export.csv?section=stock'):
                result=self.client.get('/api/v1/trading/reports/'+endpoint+('&' if '?' in endpoint else '?')+'mode=balances')
                self.assertEqual(result.status_code,403 if role=='cashier' else 200,result.content if not result.streaming else '')
                if result.streaming:b''.join(result.streaming_content)
            if role=='manager':
                self.assertEqual(self.client.get('/api/v1/trading/reports/rows?mode=balances&section=payroll_debts').status_code,403)
        self.login(self.u)
        for params in ({'page':'0'},{'page':'wat'},{'mode':'bad'},{'q':'x'*251},{'section':'payroll_debts','mode':'period'},{'from':'2026-02-30'},{'as_of':'9999-01-01','mode':'balances'}):
            response=self.client.get('/api/v1/trading/reports/rows',{'section':'products',**params});self.assertEqual(response.status_code,400,response.content)
        manager=self.user('manager',self.store);foreign=Store.objects.create(name='Foreign')
        for mode in ('period','balances'):
            data=service.summary(manager,{'mode':mode,'store':str(foreign.pk)});self.assertTrue(all(v==0 for v in data['counts'].values()))
        self.assertEqual(before,(AuditEvent.objects.count(),Voucher.objects.count(),StockEntry.objects.count(),CashEntry.objects.count()))
    def test_export_fresh_actor_and_cancel_cleanup(self):
        self.v('receipt',3,5)
        captured=[];original=service.Spool.__enter__
        def enter(spool):
            result=original(spool);captured.append(spool.directory.name);return result
        with mock.patch.object(service.Spool,'__enter__',enter):
            response=service.export_csv(self.u,{'mode':'balances','section':'stock'});iterator=iter(response.streaming_content);next(iterator);self.assertTrue(os.path.isdir(captured[0]));response.close();self.assertFalse(os.path.exists(captured[0]))
        response=service.export_csv(self.u,{'mode':'balances','section':'stock'});Profile.objects.filter(user=self.u).update(role='cashier')
        with self.assertRaises(BusinessError):b''.join(response.streaming_content)
    def test_spool_failed_initialization_removes_private_directory(self):
        captured=[];original=service.tempfile.TemporaryDirectory
        def directory(*args,**kwargs):
            value=original(*args,**kwargs);captured.append(value.name);return value
        with mock.patch.object(service.tempfile,'TemporaryDirectory',directory),mock.patch.object(service.sqlite3,'connect',side_effect=service.sqlite3.OperationalError('QA disk error')):
            with self.assertRaises(service.sqlite3.OperationalError):
                with service.Spool():pass
        self.assertFalse(os.path.exists(captured[0]))
    def test_period_cash_movements_query_count_one_vs_65(self):
        def entry():
            voucher=Voucher.objects.create(kind='expense',status='posted',date=self.today,store=self.store,created_by=self.u,total=1,payload={'category':'Плата','expense_scope':'store'})
            CashEntry.objects.create(voucher=voucher,account=self.cash,amount=-1)
        entry()
        with CaptureQueriesContext(connection) as one:service.summary(self.u,{'mode':'period'})
        for _ in range(64):entry()
        with CaptureQueriesContext(connection) as many:data=service.summary(self.u,{'mode':'period'})
        self.assertEqual(len(many),len(one));self.assertLess(len(many),25)
        self.assertEqual(data['cash_net'],'-65.00');self.assertEqual(data['cash_net'],report(self.u,{'mode':'period'})['cash_net'])
    def test_batched_queries_do_not_scale_per_stock_debt_row(self):
        self.wide()
        with CaptureQueriesContext(connection) as queries:service.rows(self.u,{'mode':'balances','section':'stock'})
        self.assertLess(len(queries),35,[(q['sql']) for q in queries])
    @skipUnless(connection.vendor=='postgresql','PostgreSQL READ ONLY / RR proof')
    def test_real_snapshot_is_readonly_and_export_stable_across_concurrent_rename(self):
        self.v('receipt',3,5)
        with service.built(self.u,{'mode':'balances'}) as (spool,data):
            with self.assertRaises(DatabaseError):
                with transaction.atomic():Document.objects.create(path='products/no',data={})
            errors=[]
            def mutate():
                close_old_connections()
                try:Document.objects.filter(pk=self.p.pk).update(data={'name':'New','unit':'шт'})
                except Exception as error:errors.append(error)
                finally:close_old_connections()
            thread=Thread(target=mutate);thread.start();thread.join(10);self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
            self.assertEqual(Document.objects.get(pk=self.p.pk).data['name'],'Product')
            self.assertEqual(next(spool.rows('stock'))[1]['name'],'Product')
        self.assertEqual(service.rows(self.u,{'mode':'balances','section':'stock'})['items'][0]['name'],'New')
