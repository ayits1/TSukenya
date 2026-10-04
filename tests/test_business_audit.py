"""B18 whitelists, request context and current source explanations, isolated PG data."""
from datetime import date, datetime, timezone as utc
from decimal import Decimal
from threading import Thread
from unittest import mock, skipUnless
import uuid
import hashlib
import time
from django.db import connection, connections, close_old_connections
from django.http import HttpResponse
from django.test import SimpleTestCase, RequestFactory, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.business_audit import snapshot, change, request_id
from server.erp.middleware import PortalMiddleware
from server.erp.report_drilldown import drilldown
from server.erp.reporting import report
from server.erp.historical_reports import read_snapshot
from server.erp.models import User, Profile, Employee, WorkShift, Voucher, CashAccount, StockLot, Store, Warehouse, PortalSession
from server.erp.services import reverse_voucher, save_voucher, post_voucher, BusinessError
from tests.test_erp import AccountingFixture


class AuditWhitelistTests(SimpleTestCase):
    def test_recursive_whitelist_and_decimal_adapter(self):
        value = {'name':'Товар','price':12.5,'password':'x','session':'x','gsBase':'x','nested':{'secret':'x'}}
        self.assertEqual(snapshot('product',value), {'name':'Товар','price':'12.5'})
        safe = snapshot('voucher',{'id':2,'payload':{'password':'x','difference':'-0.10','payments':[{'account':1,'amount':'1.20','secret':'x'}]},'lines':[{'name':'Товар','quantity':'1.250','price':'12.50','session':'x'}]})
        self.assertEqual(safe['payload'],{'difference':'-0.10','payments':[{'account':1,'amount':'1.20'}]})
        self.assertEqual(safe['lines'],[{'name':'Товар','quantity':'1.250','price':'12.50'}])
        self.assertEqual(snapshot('settings',{'gsBase':'x','rounding':0.5,'stores':['A',{'secret':'x'}]}),{'rounding':'0.5','stores':['A']})
        self.assertNotIn('observed_revision',change(None,{},observed='password=x'))
        self.assertEqual(change(None,{},observed=3,reason='  Помилка  ')['reason'],'Помилка')

    def test_request_uuid_resets_after_response_exception_and_nested_request(self):
        factory=RequestFactory(); identifier=str(uuid.uuid4()); seen=[]
        def response(request):
            seen.append(request_id.get()); return HttpResponse('OK')
        middleware=PortalMiddleware(response)
        result=middleware(factory.get('/',HTTP_X_REQUEST_ID=identifier))
        self.assertEqual((seen,result['X-Request-ID']),([identifier],identifier));self.assertIsNone(request_id.get())
        result=middleware(factory.get('/',HTTP_X_REQUEST_ID='not-a-uuid'))
        uuid.UUID(result['X-Request-ID']);self.assertNotEqual(result['X-Request-ID'],'not-a-uuid');self.assertIsNone(request_id.get())
        with mock.patch.object(middleware,'get_response',side_effect=RuntimeError('failure')):
            with self.assertRaises(RuntimeError):middleware(factory.get('/'))
        self.assertIsNone(request_id.get())
        token=request_id.set(identifier)
        try:
            middleware(factory.get('/'));self.assertEqual(request_id.get(),identifier)
        finally:request_id.reset(token)


class SourceExplanationTests(TransactionTestCase):
    v=AccountingFixture.v;cash_start=AccountingFixture.cash_start;sale=AccountingFixture.sale
    def setUp(self):
        AccountingFixture.setUp(self);self.today='2026-10-01'
        self.v('receipt',10,5);self.sold=self.sale(2,10)
    def user(self,role,store=None):
        actor=User.objects.create(username=role+str(User.objects.count()));Profile.objects.create(user=actor,role=role,store=store);return actor
    def sources(self,metric,user=None,**params):
        return drilldown(user or self.u,{'from':self.today,'to':self.today,'metric':metric,**params})
    def test_malformed_source_payload_is_actionable_without_writes(self):
        self.cash_start()
        expense=self.v('expense',amount=10,account=self.cash.pk,payload={'expense_scope':'store'})
        Voucher.objects.filter(pk=expense.pk).update(payload=[])
        from server.erp.models import AuditEvent, CashEntry
        before=(AuditEvent.objects.count(),CashEntry.objects.count())
        for metric in ('profit','cash_net'):
            with self.assertRaisesMessage(BusinessError,f'Документ {expense.pk}'):
                self.sources(metric)
        with self.assertRaisesMessage(BusinessError,f'Документ {expense.pk}'):
            report(self.u,{'from':self.today,'to':self.today})
        self.assertEqual((AuditEvent.objects.count(),CashEntry.objects.count()),before)
    def test_signed_components_reconcile_with_period_and_kyiv_reversal(self):
        self.cash_start();self.v('expense',amount=10,account=self.cash.pk,payload={'expense_scope':'store'})
        self.v('expense',amount=20,account=self.cash.pk,payload={'expense_scope':'network'})
        writeoff=self.v('writeoff',1);inventory=self.v('inventory',6,5)
        for scope in ({},{'store':str(self.store.pk)}):
            totals=report(self.u,{'from':self.today,'to':self.today,**scope})
            for metric in ('revenue','cogs','gross_profit','profit','expenses','writeoffs','inventory_adjustment','cash_net','unallocated_expenses'):
                data=self.sources(metric,**scope)
                self.assertEqual(data['amount'],totals[metric],(metric,scope))
                self.assertEqual(sum((Decimal(x['amount']) for x in data['items']),Decimal(0)),Decimal(data['amount']))
                self.assertEqual(data['snapshot'],'current')
        reverse_voucher(self.u,inventory.pk,'Тест скасування');reverse_voucher(self.u,writeoff.pk,'Тест скасування')
        reverse_voucher(self.u,self.sold.pk,'Помилка')
        Voucher.objects.filter(pk=self.sold.pk).update(reversed_at=datetime(2026,10,1,21,30,tzinfo=utc.utc))
        data=self.sources('profit',**{'from':'2026-10-02','to':'2026-10-02'})
        self.assertEqual(data['amount'],'-10.00');self.assertTrue(all(x['reversal'] and x['date']=='2026-10-02' for x in data['items']))
        network_manager=self.user('manager')
        network=self.sources('unallocated_expenses',network_manager)['items'][0]
        self.assertFalse(network['canOpen']);self.assertIsNone(network['voucher']);self.assertIsNone(network['number'])
        both=self.sources('revenue',**{'to':'2026-10-02'});self.assertEqual(both['amount'],'0.00');self.assertEqual(both['items'],[])
    def test_salary_privacy_covers_profit_cash_and_balance(self):
        self.cash_start();employee=Employee.objects.create(name='Private employee',store=self.store,shift_rate=100)
        work=WorkShift.objects.create(employee=employee,store=self.store,date=self.today,shift_rate=100,bonus_percent=0,bonus_basis='store')
        payroll=self.v('payroll',employee=employee.pk,payload={'shift_ids':[work.pk]})
        self.v('payroll_payment',employee=employee.pk,account=self.cash.pk,amount=25)
        manager=self.user('manager',self.store);accountant=self.user('accountant',self.store)
        for metric,params in [('profit',{}),('payroll',{}),('cash_net',{}),('cash',{'mode':'balances','as_of':self.today,'source':str(self.cash.pk)})]:
            data=self.sources(metric,manager,**params)
            salary=[row for row in data['items'] if row['type']=='aggregate'];self.assertEqual(len(salary),1,metric)
            self.assertEqual(set(salary[0]),{'type','metric','amount','label','canOpen'})
            self.assertFalse(any(row.get('kind') in {'payroll','payroll_payment'} for row in data['items']))
            self.assertNotIn('Private employee',str(data));self.assertNotIn('shift_rate',str(data))
        allowed=self.sources('payroll',accountant);self.assertEqual(allowed['items'][0]['voucher'],payroll.pk);self.assertTrue(allowed['items'][0]['canOpen'])
    def test_scope_target_transfers_and_source_actions(self):
        other=Store.objects.create(name='Target');wh=Warehouse.objects.create(store=other,name='Target');account=CashAccount.objects.create(store=other,name='Target bank',kind='bank')
        self.cash_start();self.v('cash_transfer',amount=50,account=self.cash.pk,payload={'target_account':account.pk});self.v('transfer',3,target=wh.pk)
        manager=self.user('manager',other)
        for metric,identifier,expected in [('cash',account.pk,'50.00'),('stock',StockLot.objects.get(warehouse=wh).pk,'15.00')]:
            data=self.sources(metric,manager,mode='balances',as_of=self.today,source=str(identifier))
            self.assertEqual(data['amount'],expected);self.assertEqual(data['items'][0]['store'],other.pk)
            self.assertFalse(data['items'][0]['canOpen']);self.assertIsNone(data['items'][0]['voucher']);self.assertIsNone(data['items'][0]['number'])
        data=self.sources('cash',manager,mode='balances',as_of=self.today,source=str(self.cash.pk));self.assertEqual(data['items'],[]);self.assertEqual(data['amount'],'0.00')
        self.assertEqual(self.sources('revenue',manager,store=str(self.store.pk))['amount'],'0.00')
        for role in ('cashier','warehouse'):
            with self.assertRaises(BusinessError):self.sources('profit',self.user(role,self.store))
    def test_pagination_invalid_filters_and_no_writes(self):
        self.cash_start()
        for _ in range(31):self.v('expense',amount=1,account=self.cash.pk)
        with CaptureQueriesContext(connection) as queries:data=self.sources('expenses',page='2')
        self.assertEqual((data['total'],data['page'],len(data['items'])),(31,2,1));self.assertEqual(data['amount'],'31.00')
        stale=self.sources('expenses',page='999');self.assertEqual((stale['page'],len(stale['items'])),(2,1))
        self.assertFalse(any(q['sql'].lstrip().split(' ',1)[0].upper() in {'INSERT','UPDATE','DELETE'} for q in queries))
        for params in ({'metric':'bad'},{'from':'bad'},{'mode':'bad'},{'metric':'cash','mode':'balances','source':'bad'}):
            with self.assertRaises(BusinessError):drilldown(self.u,{'from':self.today,'to':self.today,'metric':'profit',**params})
    def test_api_roles_current_decimal_dto_and_owner_only_existing_audit(self):
        for role in ('owner','manager','accountant','cashier'):
            actor=self.u if role=='owner' else self.user(role,self.store)
            token='b18-isolated-'+role
            PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=actor,csrf='b18-csrf',expires=int(time.time())+3600)
            self.client.cookies['ts_session']=token
            response=self.client.get('/api/erp/report/drilldown',{'metric':'profit','from':self.today,'to':self.today},HTTP_X_REQUEST_ID='invalid')
            self.assertEqual(response.status_code,403 if role=='cashier' else 200,response.content)
            uuid.UUID(response['X-Request-ID']);self.assertIsNone(request_id.get())
            if role!='cashier':self.assertIsInstance(response.json()['amount'],str);self.assertEqual(response.json()['snapshot'],'current')
            self.assertEqual(self.client.get('/api/erp/audit').status_code,200 if role=='owner' else 403)

    @skipUnless(connection.vendor=='postgresql','PostgreSQL RR semantics')
    def test_current_snapshot_stable_during_concurrent_post_and_new_request_changes(self):
        errors=[]
        with read_snapshot():
            before=self.sources('revenue')['amount']
            def write():
                close_old_connections()
                try:
                    actor=User.objects.get(pk=self.u.pk)
                    saved=save_voucher(actor,{'kind':'sale','store':self.store.pk,'warehouse':self.wh.pk,'date':self.today,'party':self.customer.pk,'lines':[{'product':'p','quantity':1,'price':10}]})
                    post_voucher(actor,saved.pk)
                except Exception as error:errors.append(str(error))
                finally:connections.close_all()
            thread=Thread(target=write);thread.start();thread.join(5)
            self.assertFalse(thread.is_alive());self.assertEqual(errors,[]);self.assertEqual(self.sources('revenue')['amount'],before)
        self.assertEqual(self.sources('revenue')['amount'],'30.00')


class AuditMutationHooksTests(AccountingFixture):
    def authenticate(self):
        token='b18-mutation-isolated';PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=self.u,csrf='b18-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']=token
        return {'HTTP_ORIGIN':'http://testserver','HTTP_X_CSRF_TOKEN':'b18-csrf'}
    def event(self,action,subject):
        from server.erp.models import AuditEvent
        detail=AuditEvent.objects.filter(action=action,subject=subject).latest('pk').detail
        uuid.UUID(detail['request_id']);return detail
    def test_voucher_create_edit_post_reverse_before_after_and_exact_retry(self):
        from server.erp.models import AuditEvent
        self.v('receipt',10,5)
        body={'kind':'sale','date':self.today,'store':self.store.pk,'warehouse':self.wh.pk,'party':self.customer.pk,'idempotency_key':'b18-voucher-retry','lines':[{'product':'p','quantity':1,'price':'10'}],'password':'never-audit'}
        draft=save_voucher(self.u,body);subject=f'voucher/{draft.pk}'
        detail=self.event('draft_saved',subject);self.assertIsNone(detail['before']);self.assertEqual(detail['after']['lines'][0]['price'],'10.0000');self.assertNotIn('password',str(detail))
        count=AuditEvent.objects.count();self.assertEqual(save_voucher(self.u,body).pk,draft.pk);self.assertEqual(AuditEvent.objects.count(),count)
        draft=save_voucher(self.u,{**body,'revision':1,'note':'Причина перегляду','lines':[{'product':'p','quantity':2,'price':'10'}]},draft.pk)
        detail=self.event('draft_saved',subject);self.assertEqual((detail['before']['revision'],detail['after']['revision'],detail['observed_revision']),(1,2,1));self.assertEqual(detail['before']['lines'][0]['quantity'],'1.000')
        posted=post_voucher(self.u,draft.pk,expected_revision=2);detail=self.event('posted',subject)
        self.assertEqual((detail['before']['status'],detail['after']['status']),('draft','posted'));self.assertEqual(detail['after']['cost'],'10.00');self.assertEqual(detail['after']['lines'][0]['cost'],'10.00');self.assertEqual(detail['observed_revision'],2)
        count=AuditEvent.objects.count();post_voucher(self.u,draft.pk,expected_revision=1);self.assertEqual(AuditEvent.objects.count(),count)
        reverse_voucher(self.u,posted.pk,'  Помилка оператора  ');detail=self.event('reversed',subject)
        self.assertEqual((detail['before']['status'],detail['after']['status']),('posted','reversed'));self.assertEqual(detail['reason'],'Помилка оператора');self.assertTrue(detail['after']['reversed_at'])
        count=AuditEvent.objects.count();reverse_voucher(self.u,posted.pk,'повтор');self.assertEqual(AuditEvent.objects.count(),count)
    def test_delete_audit_is_same_request_uuid_and_survives_deleted_draft(self):
        headers=self.authenticate();draft=save_voucher(self.u,{'kind':'expense','date':self.today,'store':self.store.pk,'account':self.cash.pk,'amount':'5'})
        identifier=str(uuid.uuid4());response=self.client.delete(f'/api/erp/vouchers/{draft.pk}',{'revision':1},content_type='application/json',HTTP_X_REQUEST_ID=identifier,**headers)
        self.assertEqual(response.status_code,200,response.content);detail=self.event('draft_deleted',f'voucher/{draft.pk}')
        self.assertEqual(detail['request_id'],identifier);self.assertEqual(detail['before']['total'],'5.00');self.assertIsNone(detail['after']);self.assertEqual(detail['observed_revision'],1);self.assertFalse(Voucher.objects.filter(pk=draft.pk).exists());self.assertIsNone(request_id.get())
    def test_employee_rate_and_workshift_snapshots_capture_before_mutation(self):
        from server.erp.views import entity_save,work_shift_save
        from server.erp.services import record_revision
        response=entity_save(self.u,'employees',{'name':'Працівник','store':self.store.pk,'shift_rate':'100','bonus_percent':'0'})
        import json
        employee=Employee.objects.get(pk=json.loads(response.content)['id']);version=record_revision(employee)
        entity_save(self.u,'employees',{'id':employee.pk,'name':'Працівник','store':self.store.pk,'revision':version,'shift_rate':'125.50','bonus_percent':'0','password':'never-audit'})
        detail=self.event('entity_saved',f'employees/{employee.pk}');self.assertEqual((detail['before']['shift_rate'],detail['after']['shift_rate']),('100.00','125.50'));self.assertEqual(detail['observed_revision'],version);self.assertNotIn('password',str(detail))
        response=work_shift_save(self.u,{'employee':employee.pk,'date':self.today,'units':'0.50','shift_rate':'125.50','bonus_percent':'0'})
        shift=WorkShift.objects.get(pk=json.loads(response.content)['id']);version=record_revision(shift)
        work_shift_save(self.u,{'id':shift.pk,'revision':version,'employee':employee.pk,'date':self.today,'units':'1','shift_rate':'150','bonus_percent':'0'})
        detail=self.event('work_shift_saved',f'work_shift/{shift.pk}');self.assertEqual(detail['before']['units'],'0.50');self.assertEqual(detail['after']['units'],'1.00');self.assertEqual(detail['observed_revision'],version)
    def test_payment_allocations_are_whitelisted_before_and_after(self):
        self.cash_start();receipt=self.v('receipt',10,5)
        body={'kind':'payment','date':self.today,'store':self.store.pk,'party':self.party.pk,'account':self.cash.pk,'amount':'20','allocations':[{'source':receipt.pk,'amount':'20'}]}
        draft=save_voucher(self.u,body);detail=self.event('draft_saved',f'voucher/{draft.pk}')
        self.assertEqual(detail['after']['allocations'],[{'source_id':receipt.pk,'payment_id':draft.pk,'amount':'20.00'}])
        draft=save_voucher(self.u,{**body,'revision':1,'amount':'15','allocations':[{'source':receipt.pk,'amount':'15'}]},draft.pk)
        detail=self.event('draft_saved',f'voucher/{draft.pk}');self.assertEqual(detail['before']['allocations'][0]['amount'],'20.00');self.assertEqual(detail['after']['allocations'][0]['amount'],'15.00')
        post_voucher(self.u,draft.pk,expected_revision=2);detail=self.event('posted',f'voucher/{draft.pk}');self.assertEqual(detail['before']['allocations'],detail['after']['allocations'])

    def test_failed_and_stale_mutation_have_no_audit_and_no_write(self):
        from server.erp.models import AuditEvent
        body={'kind':'sale','date':self.today,'store':self.store.pk,'warehouse':self.wh.pk,'lines':[{'product':'p','quantity':1,'price':'10'}]}
        draft=save_voucher(self.u,body);count=AuditEvent.objects.count()
        with self.assertRaises(BusinessError):post_voucher(self.u,draft.pk,expected_revision=1)
        self.assertEqual(AuditEvent.objects.count(),count);draft.refresh_from_db();self.assertEqual(draft.status,'draft')
        with self.assertRaises(BusinessError):save_voucher(self.u,{**body,'revision':2},draft.pk)
        self.assertEqual(AuditEvent.objects.count(),count)


from django.test import TestCase
from tests import test_catalog as catalog_fixture
from server.erp.models import Document,AuditEvent

class AuditCatalogHooksTests(TestCase):
    setUp=catalog_fixture.CatalogTests.setUp;detail=catalog_fixture.CatalogTests.detail;patch=catalog_fixture.CatalogTests.patch
    def test_catalog_and_legacy_budget_whitelists_and_request_context(self):
        document=Document.objects.get(pk='products/one');document.data.update(gsBase={'cost':999,'secret':'x'},secret='x');document.save()
        version=self.detail()['revision'];identifier=str(uuid.uuid4())
        response=self.patch({'revision':version,'cost':'20','promotion':False})
        self.assertEqual(response.status_code,200,response.content);event=AuditEvent.objects.filter(action='catalog_changed').get();data=event.detail
        self.assertEqual((data['before']['cost'],data['after']['cost']),('10','20.0'));self.assertEqual(data['observed_revision'],version);self.assertEqual(data['request_id'],response['X-Request-ID']);self.assertNotIn('gsBase',str(data));self.assertNotIn('secret',str(data))
        count=AuditEvent.objects.count();self.assertEqual(self.patch({'revision':version,'cost':'30'}).status_code,409);self.assertEqual(AuditEvent.objects.count(),count)
        budget=self.client.put('/api/docs/expenses/b18',{'name':'Оренда','group':'fixed','amount':123.45,'password':'never-audit'},content_type='application/json',**self.headers)
        self.assertEqual(budget.status_code,200,budget.content);data=AuditEvent.objects.filter(subject='expenses/b18').get().detail;self.assertIsNone(data['before']);self.assertEqual(data['after']['amount'],'123.45');self.assertNotIn('password',str(data))
        from server.erp.budget_template import revision as template_revision
        old_settings=Document.objects.filter(pk='settings/main').first()
        settings=self.client.patch('/api/docs/settings/main',{'budgetStores':2,'gsBase':{'secret':'x'}},content_type='application/json',HTTP_X_BUDGET_TEMPLATE_REVISION=template_revision(old_settings.data if old_settings else {}),**self.headers)
        self.assertEqual(settings.status_code,200,settings.content);data=AuditEvent.objects.filter(subject='settings/main',action='legacy_changed').get().detail;self.assertEqual(data['after']['budgetStores'],2);self.assertNotIn('gsBase',str(data));self.assertNotIn('secret',str(data))
    def test_import_and_pricing_before_after_replay_has_no_new_audit(self):
        def post(resource,action,value):return self.client.post(f'/api/v1/catalog/{resource}/{action}',value,content_type='application/json',**self.headers)
        payload={'entries':[{'line':2,'values':{'name':'Water','cost':'20'}}]};preview=post('import','preview',payload);self.assertEqual(preview.status_code,200,preview.content)
        payload={**payload,'snapshot':preview.json()['snapshot'],'idempotencyKey':str(uuid.uuid4())}
        committed=post('import','commit',payload);self.assertEqual(committed.status_code,200,committed.content)
        data=AuditEvent.objects.filter(subject='products/two',action='catalog_changed').get().detail;self.assertEqual((data['before']['cost'],data['after']['cost']),('12','20.0'));self.assertEqual(data['observed_revision'],payload['snapshot']);count=AuditEvent.objects.count();self.assertEqual(post('import','commit',payload).json(),committed.json());self.assertEqual(AuditEvent.objects.count(),count)
        coffee=Document.objects.get(pk='products/one');coffee.data['promotion']=False;coffee.save()
        payload={'kind':'markup','ids':None,'markup':'40','resetManualPrices':False,'updateDefault':True};preview=post('pricing','preview',payload);self.assertEqual(preview.status_code,200,preview.content)
        payload={**payload,'snapshot':preview.json()['snapshot'],'idempotencyKey':str(uuid.uuid4())};committed=post('pricing','commit',payload);self.assertEqual(committed.status_code,200,committed.content)
        data=AuditEvent.objects.filter(subject='products/two',action='catalog_changed').latest('pk').detail;self.assertEqual(data['after']['markup'],'40.0');self.assertEqual(data['before']['cost'],'20.0')
        settings=AuditEvent.objects.filter(action='pricing_settings_changed').get().detail;self.assertEqual((settings['before']['defaultMarkup'],settings['after']['defaultMarkup']),('30','40.0'));self.assertEqual(settings['observed_revision'],payload['snapshot']);count=AuditEvent.objects.count();self.assertEqual(post('pricing','commit',payload).json(),committed.json());self.assertEqual(AuditEvent.objects.count(),count)
