import hashlib,json,time,uuid,importlib
from datetime import timedelta,datetime
from zoneinfo import ZoneInfo
from types import SimpleNamespace
from threading import Barrier,Thread
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.db import connection,connections,close_old_connections
from django.contrib.auth.models import User
from django.utils import timezone
from tests.test_erp import AccountingFixture
from server.erp.models import *
from server.erp.services import *
from server.erp.monthly_budgets import save,view,view_data,save_category,bind_expense

class MonthlyBudgetTests(TransactionTestCase):
    v=AccountingFixture.v
    def setUp(self):
        AccountingFixture.setUp(self)
        if not ExpenseCategory.objects.exists():
            importlib.import_module('server.erp.migrations.0010_monthly_budgets').seed_categories(__import__('django.apps',fromlist=['apps']).apps,SimpleNamespace(connection=connection))
        self.rent=ExpenseCategory.objects.get(semantic_key='rent');self.salary=ExpenseCategory.objects.get(semantic_key='salary');self.othercat=ExpenseCategory.objects.get(semantic_key='other');self.month=timezone.localdate().strftime('%Y-%m')
    def body(self,**extra):return {'month':self.month,'store':self.store.pk,'planned_revenue':'1000','idempotency_key':str(uuid.uuid4()),'lines':[{'id':str(uuid.uuid4()),'category':str(self.rent.pk),'mode':'fixed_amount','amount':'100','rate':'0','base':'revenue'}],**extra}
    def login(self,user=None):
        user=user or self.u;token=f'budget-{user.pk}';PortalSession.objects.update_or_create(token_hash=hashlib.sha256(token.encode()).hexdigest(),defaults={'user':user,'csrf':'budget-csrf','expires':int(time.time())+3600});self.client.cookies['ts_session']=token
    def request(self,method,path,value):return getattr(self.client,method)(path,data=json.dumps(value),content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='budget-csrf')

    def test_create_retry_update_conflict_no_postings_and_past_selection(self):
        body=self.body();before=(CashEntry.objects.count(),StockEntry.objects.count(),Document.objects.count())
        result=save(self.u,body);again=save(self.u,body);self.assertEqual(again['id'],result['id']);self.assertEqual(AuditEvent.objects.filter(action='monthly_budget_saved').count(),1)
        body['revision']=result['revision'];body['lines'][0]['amount']='120';updated=save(self.u,body,result['id']);self.assertEqual(updated['revision'],2)
        with self.assertRaises(Conflict):save(self.u,body,result['id'])
        with self.assertRaises(Conflict):save(self.u,self.body())
        old=(timezone.localdate().replace(day=1)-timedelta(days=1)).strftime('%Y-%m');save(self.u,self.body(month=old));read=view(self.u,{'month':old,'store':str(self.store.pk)})
        self.assertEqual(read['month'],old);self.assertIn(self.month,read['months']);self.assertEqual((CashEntry.objects.count(),StockEntry.objects.count(),Document.objects.count()),before)

    def test_explicit_rate_plan_does_not_fabricate_fact_or_convert_legacy_amount(self):
        body=self.body();body['lines'] += [{'id':str(uuid.uuid4()),'category':str(self.rent.pk),'mode':'variable_amount','amount':'10','rate':'0'}, {'id':str(uuid.uuid4()),'category':str(self.othercat.pk),'mode':'revenue_rate','amount':'0','rate':'1.234','base':'revenue'}]
        save(self.u,body);r=view(self.u,{'month':self.month,'store':str(self.store.pk)})
        self.assertEqual(r['plan_total'],'122.34');self.assertEqual(r['fact_total'],'0.00');self.assertEqual(r['actual_revenue'],'0.00')
        self.assertEqual(r['comparison'][0]['deviation'],str(-Decimal(r['comparison'][0]['plan'])))

    def test_scope_network_salary_accrual_not_payout_and_kyiv_storno(self):
        today=timezone.localdate();prior=today.replace(day=1)-timedelta(days=1)
        self.v('cash_opening',account=self.cash.pk,amount='1000',date=prior.isoformat())
        old=self.v('expense',account=self.cash.pk,amount='30',date=prior.isoformat(),payload={'category':'Оренда'})
        reverse_voucher(self.u,old.pk,'QA');Voucher.objects.filter(pk=old.pk).update(reversed_at=datetime.combine(today.replace(day=1),datetime.min.time(),tzinfo=ZoneInfo('Europe/Kyiv')))
        self.v('expense',account=self.cash.pk,amount='50',payload={'category_id':str(self.rent.pk)})
        self.v('expense',account=self.cash.pk,amount='10',payload={'category':'Невідома давня стаття'})
        self.v('expense',account=self.cash.pk,amount='40',payload={'category_id':str(self.rent.pk),'expense_scope':'network'})
        worker=Employee.objects.create(store=self.store,name='Worker',shift_rate=20,bonus_percent=0)
        shift=WorkShift.objects.create(store=self.store,employee=worker,date=today,shift_rate=20,bonus_percent=0,bonus_basis='store')
        self.v('payroll',employee=worker.pk,payload={'shift_ids':[shift.pk]})
        self.v('payroll_payment',account=self.cash.pk,employee=worker.pk,amount='5')
        scoped=view(self.u,{'month':self.month,'store':str(self.store.pk)});network=view(self.u,{'month':self.month})
        self.assertEqual(scoped['fact_total'],'50.00');self.assertEqual(network['fact_total'],'90.00')
        facts={x['category']:x['fact'] for x in network['comparison']};self.assertEqual(facts[str(self.salary.pk)],'20.00');self.assertEqual(facts[str(self.rent.pk)],'60.00');self.assertEqual(network['coverage']['classified'],4);self.assertEqual(network['coverage']['documents'],5)

    def test_rename_aliases_archive_keeps_history_and_semantics(self):
        body=self.body(store=None);saved=save(self.u,body)
        changed=save_category(self.u,{'name':'Приміщення','active':False,'revision':self.rent.revision},str(self.rent.pk))
        self.assertTrue(ExpenseCategoryAlias.objects.filter(name='Оренда',category=self.rent).exists())
        self.v('cash_opening',account=self.cash.pk,amount='100');self.v('expense',account=self.cash.pk,amount='15',payload={'category':'Оренда'})
        r=view(self.u,{'month':self.month});self.assertEqual(r['fact_total'],'15.00');self.assertEqual(r['lines'][0]['category_name'],'Оренда')
        body['revision']=saved['revision'];save(self.u,body,saved['id'])
        with self.assertRaises(BusinessError):save(self.u,self.body(store=None,month='2026-01'))
        with self.assertRaises(BusinessError):save_category(self.u,{'name':'Оренда','active':True})
        with self.assertRaises(BusinessError):save_category(self.u,{'name':'Інше','active':True,'revision':changed['revision']},str(self.rent.pk))
        with self.assertRaises(BusinessError):save_category(self.u,{'name':'Оплата праці','semantic_key':'other','revision':1},str(self.salary.pk))
        save_category(self.u,{'name':'Оплата праці','revision':1},str(self.salary.pk));self.salary.refresh_from_db();self.assertEqual(self.salary.semantic_key,'salary')

    def test_validation_atomic_and_expense_category_id_guard(self):
        for extra in [{'month':'2026-13'},{'month':'²026-01'},{'planned_revenue':'1.001'},{'planned_revenue':True},{'store':False},{'lines':[{'category':str(self.rent.pk),'mode':'revenue_rate','amount':'1','rate':'1'}]},{'lines':[{'category':str(self.rent.pk),'mode':'revenue_rate','amount':'0','rate':'101'}]}]:
            with self.assertRaises((BusinessError,ValueError)):save(self.u,self.body(**extra))
        self.assertEqual(MonthlyBudget.objects.count(),0);self.assertEqual(BudgetLine.objects.count(),0)
        with self.assertRaises(BusinessError):bind_expense({'category_id':str(self.salary.pk)})
        save_category(self.u,{'name':'Оренда','active':False,'revision':1},str(self.rent.pk))
        with self.assertRaises(BusinessError):bind_expense({'category_id':str(self.rent.pk)})
        self.assertEqual(bind_expense({'category_id':str(self.rent.pk)},{'category_id':str(self.rent.pk)})['category_id'],str(self.rent.pk))

    def test_api_roles_csrf_saved_id_revision_and_get_read_only(self):
        self.login();before=(AuditEvent.objects.count(),MonthlyBudget.objects.count(),Document.objects.count())
        read=self.client.get('/api/erp/monthly-budgets',{'month':self.month});self.assertEqual(read.status_code,200,read.content);self.assertEqual((AuditEvent.objects.count(),MonthlyBudget.objects.count(),Document.objects.count()),before)
        b=self.body();response=self.request('post','/api/erp/monthly-budgets',b);self.assertEqual(response.status_code,201,response.content);key=response.json()['id'];self.assertEqual(self.request('post','/api/erp/monthly-budgets',b).json()['id'],key)
        self.assertEqual(self.client.post('/api/erp/monthly-budgets',data=json.dumps(b),content_type='application/json').status_code,403)
        for role in ('manager','accountant','cashier','warehouse'):
            user=User.objects.create(username=role);Profile.objects.create(user=user,role=role,store=self.store);self.login(user)
            self.assertEqual(self.client.get('/api/erp/monthly-budgets').status_code,403)
            self.assertEqual(self.request('post','/api/erp/monthly-budgets',b).status_code,403)
            self.assertEqual(self.client.get('/api/erp/budget-categories').status_code,200 if role in ('manager','accountant') else 403)
            self.assertEqual(self.request('post','/api/erp/budget-categories',{'name':'Denied'}).status_code,403)

    def test_batched_lines_preserve_order_and_reject_foreign_identity(self):
        body=self.body();body['lines']=[{'id':str(uuid.uuid4()),'category':str(self.rent.pk),'mode':'fixed_amount','amount':str(i),'rate':'0'} for i in range(65)]
        with CaptureQueriesContext(connection) as queries:saved=save(self.u,body)
        self.assertLessEqual(len(queries),25);self.assertEqual([l['amount'] for l in saved['lines']],[str(Decimal(i).quantize(Decimal('.01'))) for i in range(65)])
        body['revision']=saved['revision'];body['lines'].reverse()
        with CaptureQueriesContext(connection) as queries:updated=save(self.u,body,saved['id'])
        self.assertLessEqual(len(queries),25);self.assertEqual(updated['lines'][0]['amount'],'64.00')
        foreign=self.body(store=None);foreign['lines'][0]['id']=body['lines'][0]['id']
        with self.assertRaises(BusinessError):save(self.u,foreign)
        for raw in (False,0):
            with self.assertRaises(BusinessError):bind_expense({'category_id':raw})

    def test_legacy_fact_payload_is_visible_and_invalid_structure_rejected(self):
        self.v('cash_opening',account=self.cash.pk,amount='100')
        expense=self.v('expense',account=self.cash.pk,amount='15',payload={'category':'Оренда'})
        Voucher.objects.filter(pk=expense.pk).update(payload={'category_id':{'invalid':'legacy'},'category':'Оренда'})
        data=view(self.u,{'month':self.month});self.assertEqual(data['fact_total'],'15.00');self.assertEqual(data['coverage'],{'classified':1,'documents':1});self.assertEqual(data['comparison'][0]['category'],str(self.rent.pk))
        Voucher.objects.filter(pk=expense.pk).update(payload={'category_id':[],'category':[]})
        data=view(self.u,{'month':self.month});self.assertEqual(data['coverage']['classified'],0);self.assertEqual(data['comparison'][0]['category'],str(self.othercat.pk))
        Voucher.objects.filter(pk=expense.pk).update(payload=[])
        with self.assertRaises(BusinessError):view(self.u,{'month':self.month})

    def test_api_malformed_mode_rejected_without_mutation_or_audit(self):
        self.login();before=(MonthlyBudget.objects.count(),BudgetLine.objects.count(),AuditEvent.objects.count())
        for mode in ([],{},False,None,1):
            body=self.body();body['lines'][0]['mode']=mode
            response=self.request('post','/api/erp/monthly-budgets',body)
            self.assertEqual(response.status_code,400,response.content)
            self.assertEqual((MonthlyBudget.objects.count(),BudgetLine.objects.count(),AuditEvent.objects.count()),before)

    def test_category_create_retry_rejects_edited_record_even_after_name_restored(self):
        self.login();body={'id':str(uuid.uuid4()),'name':'Окрема стаття','active':True}
        first=self.request('post','/api/erp/budget-categories',body);self.assertEqual(first.status_code,201,first.content)
        retried=self.request('post','/api/erp/budget-categories',body);self.assertEqual(retried.json(),first.json())
        subject='budget-category/'+body['id'];self.assertEqual(AuditEvent.objects.filter(subject=subject).count(),1)
        changed=self.request('put','/api/erp/budget-categories/'+body['id'],{'name':'Змінена стаття','active':True,'revision':1});self.assertEqual(changed.status_code,200,changed.content)
        restored=self.request('put','/api/erp/budget-categories/'+body['id'],{'name':body['name'],'active':True,'revision':2});self.assertEqual(restored.status_code,200,restored.content)
        audits=AuditEvent.objects.filter(subject=subject).count()
        refused=self.request('post','/api/erp/budget-categories',body)
        self.assertEqual(refused.status_code,409,refused.content)
        conflict=refused.json()
        self.assertEqual(conflict['code'],'original_request_confirmed')
        self.assertIs(conflict['original_request_confirmed'],True)
        self.assertEqual((conflict['id'],conflict['request_key'],conflict['resource']),(body['id'],body['id'],'category'))
        self.assertNotIn('revision',conflict)  # Identity is not a new editable baseline.
        self.assertEqual(AuditEvent.objects.filter(subject=subject).count(),audits)
        self.assertEqual(PlanningCreateReceipt.objects.filter(key=body['id']).count(),1)
        self.assertEqual(ExpenseCategory.objects.get(pk=body['id']).revision,3)

    def test_normalized_budget_and_category_audit_captures_pre_mutation_rows(self):
        body=self.body();body.update({'password':'not-business-data','create_key':'not-an-audit-field'})
        second={'id':str(uuid.uuid4()),'category':str(self.othercat.pk),'mode':'revenue_rate','amount':'0','rate':'1.234','base':'revenue'};body['lines'].append(second)
        saved=save(self.u,body);subject='budget/'+saved['id'];event=AuditEvent.objects.filter(subject=subject).get().detail
        self.assertIsNone(event['before']);self.assertEqual(event['after']['planned_revenue'],'1000.00');self.assertEqual(event['after']['lines'][1]['position'],1);self.assertEqual(event['after']['lines'][1]['rate'],'1.234');self.assertTrue(event['request_id'])
        original=event['after'];body['revision']=1;body['planned_revenue']='1234.56';body['lines']=[second];second['mode']='variable_amount';second['rate']='0';second['amount']='19.23'
        updated=save(self.u,body,saved['id']);event=AuditEvent.objects.filter(subject=subject).order_by('-pk').first().detail
        self.assertEqual(event['before'],original);self.assertEqual(event['observed_revision'],1);self.assertEqual(event['after']['revision'],2);self.assertEqual(event['after']['planned_revenue'],'1234.56')
        self.assertEqual(event['after']['lines'],[{'id':second['id'],'category_id':str(self.othercat.pk),'category_name':'Інше','position':0,'mode':'variable_amount','amount':'19.23','rate':'0.000','base':'revenue'}])
        for forbidden in ('password','not-business-data','idempotency_key','create_key','fingerprint'):self.assertNotIn(forbidden,json.dumps(event))
        renamed=save_category(self.u,{'name':'Приміщення','active':False,'revision':1,'unknown_private':'not-allowed'},str(self.rent.pk))
        event=AuditEvent.objects.filter(subject='budget-category/'+str(self.rent.pk)).get().detail
        self.assertEqual(event['before'],{'id':str(self.rent.pk),'name':'Оренда','semantic_key':'rent','active':True,'revision':1});self.assertEqual(event['after'],renamed);self.assertEqual(event['observed_revision'],1);self.assertNotIn('unknown_private',str(event))

    def test_postgres_concurrent_create_and_update_same_budget(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL global planning lock')
        body=self.body();barrier=Barrier(2);results=[]
        def run_create():
            close_old_connections()
            try:barrier.wait(timeout=10);results.append(save(User.objects.get(pk=self.u.pk),body)['id'])
            finally:connections.close_all()
        threads=[Thread(target=run_create) for _ in range(2)]
        for t in threads:t.start()
        for t in threads:t.join(timeout=15)
        self.assertEqual(len(results),2);self.assertEqual(len(set(results)),1);self.assertEqual(MonthlyBudget.objects.count(),1)
        b=MonthlyBudget.objects.get();body['revision']=b.revision;barrier=Barrier(2);results=[]
        def run_update():
            close_old_connections()
            try:barrier.wait(timeout=10);save(User.objects.get(pk=self.u.pk),body,str(b.pk));results.append('saved')
            except Conflict:results.append('conflict')
            finally:connections.close_all()
        threads=[Thread(target=run_update) for _ in range(2)]
        for t in threads:t.start()
        for t in threads:t.join(timeout=15)
        self.assertCountEqual(results,['saved','conflict']);b.refresh_from_db();self.assertEqual(b.revision,2)
