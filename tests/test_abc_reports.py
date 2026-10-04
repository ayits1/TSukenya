"""ABC read-only accounting vectors and bounded transport; synthetic isolated data."""
import csv
import hashlib
import io
import os
import time
from datetime import timedelta, datetime, timezone as utc
from decimal import Decimal
from unittest import mock, skipUnless
from threading import Thread
from django.db import connection, close_old_connections
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.contrib.auth.models import User
from django.utils import timezone
from server.erp import abc_reports as service, bounded_reports
from server.erp.models import Document, Voucher, VoucherLine, Store, Profile, PortalSession, AuditEvent
from server.erp.services import BusinessError
from tests.test_erp import AccountingFixture

class ABCReportsTests(TransactionTestCase):
    v=AccountingFixture.v;cash_start=AccountingFixture.cash_start;sale=AccountingFixture.sale
    def setUp(self):
        AccountingFixture.setUp(self)
        self.params={'from':self.today,'to':self.today}
    def line(self,key,amount,cost=0,kind='sale',date=None,status='posted',reversed_at=None,unit='шт',hidden=False,store=None,name=None):
        product,_=Document.objects.get_or_create(path='products/'+key,defaults={'data':{'name':name or key,'unit':unit,'hidden':hidden}})
        voucher=Voucher.objects.create(kind=kind,status=status,date=date or self.today,store=store or self.store,created_by=self.u,posted_at=timezone.now(),reversed_at=reversed_at,total=amount,cost=cost)
        VoucherLine.objects.create(voucher=voucher,product=product,name=name or key,unit=unit,quantity=1,price=amount,amount=amount,cost=cost)
        return voucher
    def user(self,role,store=None):
        u=User.objects.create(username=role+str(User.objects.count()));Profile.objects.create(user=u,role=role,store=store);return u
    def login(self,user):
        token='abc-'+str(user.pk);PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=user,csrf='qa-abc',expires=int(time.time())+3600);self.client.cookies['ts_session']=token
    def test_actual_posting_parity_returns_and_storno(self):
        self.v('receipt',10,5);sold=self.sale(3)
        self.v('customer_return',1,99,reference=sold.pk,party=self.customer.pk,payload={'payments':[{'account':self.bank.pk,'amount':'10'}]})
        result=service.report(self.u,self.params)
        old=bounded_reports.rows(self.u,{**self.params,'mode':'period','section':'products'})['items'][0]
        row=result['items'][0]
        self.assertEqual((row['netRevenue'],row['netCogs'],row['grossProfit'],row['quantity']),(old['revenue'],old['cogs'],old['gross_profit'],old['quantity']))
        self.assertEqual(row['classification'],'A')
        self.assertEqual(AuditEvent.objects.filter(action='posted').count(),3)
    def test_ties_before_group_custom_threshold_filter_does_not_reclassify(self):
        for key,value in [('first',70),('tie1',15),('tie2',15),('negative',2),('zero',5)]:self.line(key,value,kind='customer_return' if key=='negative' else 'sale')
        self.line('zero',5,kind='customer_return')
        result=service.report(self.u,self.params);by={r['product']:r for r in result['items']}
        self.assertEqual([by[k]['classification'] for k in ['first','tie1','tie2']],['A','A','A'])
        self.assertEqual(by['tie1']['cumulativeBefore'],'70.0000');self.assertEqual(by['tie2']['cumulativeAfter'],'100.0000')
        self.assertEqual(result['summary']['classes']['A']['share'],'100.0000')
        filtered=service.report(self.u,{**self.params,'q':'tie2','class':'A'})
        self.assertEqual(filtered['summary'],result['summary']);self.assertEqual(filtered['total'],1)
        custom=service.report(self.u,{**self.params,'aThreshold':'60','bThreshold':'90'})
        self.assertEqual([r['classification'] for r in custom['items'][:3]],['A','B','B'])
        self.assertEqual((by['negative']['classification'],by['zero']['classification']),('unclassified','unclassified'))
    def test_kyiv_reversal_hidden_and_mixed_units_no_guessed_quantity(self):
        yesterday=timezone.localdate()-timedelta(days=1)
        self.line('old',20,8,date=yesterday,status='reversed',reversed_at=datetime.combine(yesterday,datetime.min.time(),utc.utc)+timedelta(hours=22),hidden=True)
        self.line('mixed',3,unit='кг');self.line('mixed',4,unit='шт')
        self.line('ignored',100,status='draft')
        result=service.report(self.u,self.params);by={r['product']:r for r in result['items']}
        self.assertEqual(by['old']['netRevenue'],'-20.00');self.assertTrue(by['old']['hiddenCurrent'])
        self.assertEqual((by['mixed']['unit'],by['mixed']['quantity'],by['mixed']['unitConflicted']),(None,None,True))
        self.assertEqual(result['summary']['mixedUnitCount'],1);self.assertNotIn('ignored',by)
        self.assertEqual(service.report(self.u,{**self.params,'from':yesterday.isoformat()})['summary']['negativeCount'],0)
    def test_nonpositive_coverage_threshold_validation_no_writes(self):
        self.line('minus',3,kind='customer_return');self.line('zero',0)
        before=(Document.objects.count(),Voucher.objects.count(),AuditEvent.objects.count())
        report=service.report(self.u,self.params)
        self.assertEqual(report['summary']['positivePoolRevenue'],'0.00');self.assertTrue(all(r['share'] is None for r in report['items']))
        for a,b in [('0','95'),('95','95'),('80','100'),('80.001','95'),('NaN','95')]:
            with self.assertRaises(BusinessError):service.report(self.u,{**self.params,'aThreshold':a,'bThreshold':b})
        self.assertEqual(before,(Document.objects.count(),Voucher.objects.count(),AuditEvent.objects.count()))
    def test_bounded_pages_full_csv_decimal_order_search_and_cleanup(self):
        for i in range(65):self.line(f'p{i:03}',Decimal('9999999999.99') if i==0 else Decimal(i),name='=1+1' if i==0 else f'Товар{i:03}')
        result=service.report(self.u,self.params);self.assertEqual((result['total'],result['pages'],len(result['items'])),(65,3,30));self.assertEqual(result['items'][0]['netRevenue'],'9999999999.99')
        self.assertEqual(len(service.report(self.u,{**self.params,'page':'999'})['items']),5)
        text=b''.join(service.export_csv(self.u,self.params).streaming_content).decode('utf-8-sig')
        rows=list(csv.reader(io.StringIO(text),delimiter=';'));self.assertEqual(len(rows)-3,65);self.assertIn('\t=1+1',rows[3])
        self.assertEqual(service.report(self.u,{**self.params,'q':'%_\\'})['total'],0)
        paths=[]
        modes=[]
        class Tracking(service.Spool):
            def __enter__(self):
                value=super().__enter__();paths.append(self.directory.name);modes.append(os.stat(self.directory.name+'/rows.sqlite3').st_mode&0o777);return value
        with mock.patch.object(service,'Spool',Tracking):
            response=service.export_csv(self.u,self.params);next(iter(response.streaming_content));self.assertTrue(os.path.isdir(paths[0]));response.close();self.assertFalse(os.path.exists(paths[0]))
        self.assertEqual(modes,[0o600])
        with CaptureQueriesContext(connection) as queries:service.report(self.u,self.params)
        self.assertLess(len(queries),15)
    def test_csv_scope_name_formula_guard_preserves_signed_numeric_values(self):
        self.store.name='=1+1';self.store.save()
        self.line('return',Decimal('0.99'),kind='customer_return',name='@SUM(1,2)')
        text=b''.join(service.export_csv(self.u,{**self.params,'store':str(self.store.pk)}).streaming_content).decode('utf-8-sig')
        rows=list(csv.reader(io.StringIO(text),delimiter=';'))
        self.assertEqual(rows[0][1],'\t=1+1');self.assertEqual(rows[3][1],'\t@SUM(1,2)');self.assertEqual(rows[3][3],'-0.99')

    def test_hidden_scalar_projection_does_not_fetch_raw_nested_json(self):
        self.line('nested',1)
        Document.objects.filter(pk='products/nested').update(data={'hidden':['x'*20000]})
        with CaptureQueriesContext(connection) as queries:
            result=service.report(self.u,self.params)
        self.assertFalse(result['items'][0]['hiddenCurrent'])
        linequery=next(q['sql'] for q in queries if 'erp_voucherline' in q['sql'] and 'SELECT' in q['sql'])
        self.assertIn('CASE WHEN',linequery)
        self.assertIn('hidden_current',linequery)

    def test_export_initial_context_uses_fresh_actor_not_cached_profile(self):
        self.line('one',1)
        stale=self.user('cashier',self.store)
        self.assertEqual(stale.profile.role,'cashier')
        Profile.objects.filter(user=stale).update(role='accountant')
        response=service.export_csv(stale,self.params)
        text=b''.join(response.streaming_content).decode('utf-8-sig')
        self.assertIn('one',text)
        response.close()

    def test_private_spool_cleanup_on_stream_error(self):
        self.line('one',1)
        paths=[]
        class Tracking(service.Spool):
            def __enter__(self):
                value=super().__enter__();paths.append(self.directory.name);return value
        with mock.patch.object(service,'Spool',Tracking),mock.patch.object(service,'records',side_effect=RuntimeError('isolated failure')):
            response=service.export_csv(self.u,self.params)
            with self.assertRaises(RuntimeError):b''.join(response.streaming_content)
            response.close()
        self.assertEqual(len(paths),1);self.assertFalse(os.path.exists(paths[0]))

    def test_current_roles_store_scope_and_stream_actor_guard(self):
        self.line('local',10);self.assertEqual(service.report(self.u,self.params)['scopeName'],'Усі доступні магазини');foreign=Store.objects.create(name='Foreign');self.line('foreign',20,store=foreign)
        for role in ['owner','manager','accountant']:
            user=self.user(role,self.store);self.assertEqual(service.report(user,self.params)['total'],1)
            self.assertEqual(service.report(user,{**self.params,'store':str(foreign.pk)})['total'],0)
        denied=self.user('cashier',self.store);self.login(denied)
        self.assertEqual(self.client.get('/api/v1/trading/reports/abc',self.params).status_code,403)
        self.assertEqual(self.client.get('/api/v1/trading/reports/abc/export.csv',self.params).status_code,403)
        response=service.export_csv(self.u,self.params);Profile.objects.filter(user=self.u).update(role='cashier')
        with self.assertRaises(BusinessError):next(iter(response.streaming_content))
        response.close()
    @skipUnless(connection.vendor=='postgresql','PostgreSQL read-only transaction')
    def test_repeatable_read_and_read_only(self):
        self.line('one',10)
        with service.built(self.u,self.params) as (spool,data,q,selected):
            with connection.cursor() as cursor:
                cursor.execute('SHOW transaction_isolation');self.assertEqual(cursor.fetchone()[0],'repeatable read')
                cursor.execute('SHOW transaction_read_only');self.assertEqual(cursor.fetchone()[0],'on')
            self.assertEqual(data['summary']['netRevenue'],'10.00')

    @skipUnless(connection.vendor=='postgresql','PostgreSQL independent snapshot')
    def test_snapshot_concurrent_posting_and_http_no_store(self):
        self.line('one',10)
        original=service.require_reversal_dates
        errors=[]
        def boundary(ids,end):
            original(ids,end)
            def write():
                close_old_connections()
                try:self.line('two',20)
                except BaseException as error:errors.append(error)
                finally:close_old_connections()
            worker=Thread(target=write);worker.start();worker.join(10);self.assertFalse(worker.is_alive());self.assertFalse(errors)
        with mock.patch.object(service,'require_reversal_dates',boundary):
            report=service.report(self.u,self.params)
        self.assertEqual(report['summary']['netRevenue'],'10.00')
        self.assertEqual(service.report(self.u,self.params)['summary']['netRevenue'],'30.00')
        self.login(self.u);response=self.client.get('/api/v1/trading/reports/abc',self.params)
        self.assertEqual(response.status_code,200);self.assertIn('no-store',response['Cache-Control'])
