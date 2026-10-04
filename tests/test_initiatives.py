"""B20 additive project identity, results and explicit expense attribution, isolated data."""
import uuid,hashlib,time,json
from datetime import timedelta
from decimal import Decimal
from threading import Thread,Barrier
from unittest.mock import patch
from django.test import TransactionTestCase
from django.db import connection,connections,close_old_connections
from django.core.exceptions import PermissionDenied
from tests.test_erp import AccountingFixture
from server.erp.models import *
from server.erp.services import BusinessError,Conflict,reverse_voucher
from server.erp.initiatives import mutate,idea_info,project_json,detail,token,candidates,list_projects,business


class InitiativeTests(TransactionTestCase):
    v=AccountingFixture.v;cash_start=AccountingFixture.cash_start
    def setUp(self):
        AccountingFixture.setUp(self);self.idea=Document.objects.create(path='ideas/source',data={'title':'Кава із собою','text':'Перевірити новий формат','reaction':'yes'});self.cash_start()
    def create(self,idea='source',**extra):
        return mutate(self.u,{'action':'create','idempotencyKey':str(uuid.uuid4()),'idea':idea,'ideaRevision':idea_info(self.u,idea)['revision'],'title':'Перевірка формату','store':self.store.pk,**extra})
    def act(self,project,action,**extra):
        project.refresh_from_db();return mutate(self.u,{'action':action,'idempotencyKey':str(uuid.uuid4()),'revision':project.revision,**extra},str(project.pk))
    def project(self,**extra):return IdeaProject.objects.get(pk=self.create(**extra)['project']['id'])
    def expense(self,amount='10',**extra):return self.v('expense',**({'amount':amount,'account':self.cash.pk,'payload':{'category':'Логістика'}}|extra))
    def login(self,user):
        value='isolated-initiative-'+str(uuid.uuid4());PortalSession.objects.create(token_hash=hashlib.sha256(value.encode()).hexdigest(),user=user,csrf='initiative-csrf',expires=int(time.time())+3600);self.client.cookies['ts_session']=value
    def post(self,path,value,csrf='initiative-csrf'):
        return self.client.post(path,data=json.dumps(value),content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN=csrf)
    def test_qualitative_result_optional_budget_and_exact_retry_after_later_changes(self):
        body={'action':'create','idempotencyKey':str(uuid.uuid4()),'idea':'source','ideaRevision':token(self.idea),'title':'Новий формат','store':self.store.pk};result=mutate(self.u,body);project=IdeaProject.objects.get(pk=result['project']['id']);self.assertIsNone(project.planned_budget);self.assertIsNone(project.target_value)
        self.act(project,'edit',title='Пізніша назва');self.idea.data['reaction']='no';self.idea.save();counts=(IdeaProject.objects.count(),AuditEvent.objects.count())
        self.assertEqual(mutate(self.u,body),result);self.assertEqual(counts,(IdeaProject.objects.count(),AuditEvent.objects.count()))
        with self.assertRaises(Conflict):mutate(self.u,{**body,'title':'Інший запит'})
        self.act(project,'start');self.act(project,'complete',resultSummary='Покупці обирають новий формат',resultDate=self.today);project.refresh_from_db();self.assertEqual(project.state,'completed');self.assertIsNone(project.fact_value)
        with self.assertRaises(BusinessError):self.act(project,'edit',title='Переписати старий план')
        self.act(project,'result_edit',resultSummary='Уточнений підсумок',resultDate=self.today,reason='Уточнення спостережень');self.assertEqual(Document.objects.get(pk=self.idea.pk).data['title'],'Кава із собою')
    def test_explicit_numeric_measurement_decimal_results_and_active_responsible(self):
        person=User.objects.create(username='responsible');project=self.project(plannedBudget='125.50',metric='Повторні покупки',metricUnit='%',targetValue='12.0001',responsible=person.pk);person.is_active=False;person.save();self.act(project,'edit',responsible=person.pk);other=User.objects.create(username='inactive',is_active=False)
        with self.assertRaises(BusinessError):self.act(project,'edit',responsible=other.pk)
        self.act(project,'start');count=AuditEvent.objects.count()
        for extra in ({'resultSummary':'Без числа','resultDate':self.today},{'resultSummary':'','resultDate':self.today,'factValue':'1'},{'resultSummary':'Підсумок','resultDate':'2099-01-01','factValue':'1'},{'resultSummary':'Підсумок','resultDate':self.today,'factValue':'NaN'}):
            with self.assertRaises(BusinessError):self.act(project,'complete',**extra)
        self.assertEqual(AuditEvent.objects.count(),count);self.act(project,'complete',resultSummary='Результат нижчий за план',resultDate=self.today,factValue='-2.0001');project.refresh_from_db();self.assertEqual(project.fact_value,Decimal('-2.0001'));self.assertEqual(business(project)['planned_budget'],'125.50');self.assertEqual(business(project)['target_value'],'12.0001')
        event=AuditEvent.objects.filter(action='initiative_complete').latest('pk');self.assertEqual(event.detail['after']['fact_value'],'-2.0001');uuid.UUID(event.detail['request_id']);self.assertNotIn('password',str(event.detail))
    def test_legacy_task_identity_no_duplicate_operational_tasks_and_managed_mutation(self):
        old=Document.objects.create(path='tasks/old',data={'title':'Старий план','stage':3,'status':'doing'});project=self.project();self.act(project,'task_link',task='old',taskRevision=token(old),phase='Пілот');old.refresh_from_db();self.assertEqual(old.data,{'title':'Старий план','stage':3,'status':'doing'});self.assertEqual(ProjectTask.objects.get().document_id,old.pk)
        self.act(project,'task_create',title='Підготувати викладку',stage=1,phase='Підготовка');project.refresh_from_db();task=ProjectTask.objects.filter(project=project).exclude(document=old).get().document
        self.act(project,'task_update',task=task.pk.partition('/')[2],taskRevision=token(task),status='done');task.refresh_from_db();self.assertEqual(task.data['status'],'done')
        other=self.project(idea=self.second_idea())
        with self.assertRaises(BusinessError):self.act(other,'task_link',task='old',taskRevision=token(old))
        op=Document.objects.create(path='tasks/op',data={'title':'Каса','scope':'operations','status':'todo'})
        with self.assertRaises(BusinessError):self.act(project,'task_link',task='op',taskRevision=token(op))
        self.login(self.u);state=self.client.get('/api/state').json();entry=next(row for row in state['data']['tasks'] if row['id']=='old');self.assertEqual(entry['permissions'],{'canEdit':False,'canDelete':False});self.assertEqual(entry['initiative'],str(project.pk))
        self.assertEqual(self.post('/api/erp/initiatives/'+str(project.pk),{'action':'task_update','revision':project.revision,'idempotencyKey':str(uuid.uuid4()),'task':'old','taskRevision':'bad','status':'done'}).status_code,409)
        for method,data in [('patch',{'status':'done'}),('delete',None)]:
            response=getattr(self.client,method)('/api/docs/tasks/old',data=data,content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='initiative-csrf');self.assertEqual(response.status_code,409,response.content)
        response=self.client.delete('/api/docs/ideas/source',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='initiative-csrf');self.assertEqual(response.status_code,400);self.assertTrue(Document.objects.filter(pk=self.idea.pk).exists())
    def second_idea(self):
        name='other-'+uuid.uuid4().hex;Document.objects.create(path='ideas/'+name,data={'title':'Інша ідея','reaction':'yes'});return name
    def test_expense_whole_attribution_current_actual_reversal_and_no_extra_postings(self):
        project=self.project(plannedBudget='50.00');expense=self.expense('20.05');count=(Voucher.objects.count(),CashEntry.objects.count(),StockEntry.objects.count());self.act(project,'expense_attach',voucher=expense.pk,voucherRevision=expense.revision);data=project_json(project,self.u);self.assertEqual(data['actualExpenses'],'20.05');self.assertEqual(count,(Voucher.objects.count(),CashEntry.objects.count(),StockEntry.objects.count()))
        other=self.project(idea=self.second_idea())
        with self.assertRaises(BusinessError):self.act(other,'expense_attach',voucher=expense.pk,voucherRevision=expense.revision)
        reverse_voucher(self.u,expense.pk,'Не відбулося');data=project_json(project,self.u);self.assertEqual(data['actualExpenses'],'0.00');self.assertEqual(data['expenses']['items'][0]['status'],'reversed')
        self.act(project,'expense_detach',voucher=expense.pk,reason='Помилкова належність');self.assertEqual(project.expense_links.count(),0);event=AuditEvent.objects.filter(action='initiative_expense_detach').latest('pk');self.assertTrue(event.detail['related_change']['before']['attached']);self.assertFalse(event.detail['related_change']['after']['attached'])
    def test_roles_scoped_owner_csrf_revision_malformed_and_current_source_access(self):
        project=self.project();foreign=Store.objects.create(name='Foreign');wh=Warehouse.objects.create(store=foreign,name='Foreign');account=CashAccount.objects.create(store=foreign,name='ForeignCash');self.v('cash_opening',amount='100',store=foreign.pk,account=account.pk,warehouse=wh.pk);expense=self.expense('10',store=foreign.pk,warehouse=wh.pk,account=account.pk)
        self.u.profile.store=self.store;self.u.profile.save();self.login(self.u);self.assertEqual(candidates(self.u,str(project.pk),{'purpose':'expenses'})['items'],[])
        with self.assertRaises(PermissionDenied):self.act(project,'expense_attach',voucher=expense.pk,voucherRevision=expense.revision)
        body={'action':'start','revision':project.revision,'idempotencyKey':str(uuid.uuid4())};path='/api/erp/initiatives/'+str(project.pk);self.assertEqual(self.post(path,body,'bad').status_code,403);self.assertEqual(self.post(path,{**body,'revision':0}).status_code,400);self.assertEqual(self.post(path,{**body,'idempotencyKey':['bad']}).status_code,400);self.assertEqual(self.post(path,{**body,'password':'secret'}).status_code,400)
        for role in ('manager','cashier','warehouse','accountant'):
            user=User.objects.create(username=role);Profile.objects.create(user=user,role=role,store=self.store);self.login(user);self.assertEqual(self.client.get(path).status_code,403);self.assertEqual(self.client.get('/api/erp/initiatives/options').status_code,403);self.assertEqual(self.post(path,body).status_code,403)
    def concurrency(self,operations):
        barrier=Barrier(len(operations));results=[]
        def run(fn):
            close_old_connections()
            try:barrier.wait(timeout=10);results.append(('ok',fn(User.objects.get(pk=self.u.pk))))
            except Exception as error:results.append(('error',error))
            finally:connections.close_all()
        threads=[Thread(target=run,args=(fn,)) for fn in operations]
        for thread in threads:thread.start()
        for thread in threads:thread.join(timeout=15);self.assertFalse(thread.is_alive())
        return results
    def test_postgresql_unique_source_and_exact_key_concurrency(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL lock required.')
        body={'action':'create','idempotencyKey':str(uuid.uuid4()),'idea':'source','ideaRevision':token(self.idea),'title':'Пілот','store':self.store.pk};results=self.concurrency([lambda u:mutate(u,body),lambda u:mutate(u,{**body,'idempotencyKey':str(uuid.uuid4())})]);self.assertEqual([s for s,_ in results].count('ok'),1);self.assertEqual(IdeaProject.objects.count(),1);self.assertIsInstance(next(v for s,v in results if s=='error'),Conflict)
        project=IdeaProject.objects.get();project.refresh_from_db();body={'action':'task_create','idempotencyKey':str(uuid.uuid4()),'revision':project.revision,'title':'Одна задача','stage':1};results=self.concurrency([lambda u:mutate(u,body,str(project.pk)),lambda u:mutate(u,body,str(project.pk))]);self.assertEqual([s for s,_ in results],['ok','ok']);self.assertEqual(results[0][1],results[1][1]);self.assertEqual(project.task_links.count(),1);self.assertEqual(AuditEvent.objects.filter(action='initiative_task_create').count(),1)
    def test_pagination_current_snapshot_and_unchanged_global_stage(self):
        Document.objects.create(path='project/state',data={'stage':3,'nextStep':'Старий маршрут'});project=self.project();expense=self.expense('10');self.act(project,'expense_attach',voucher=expense.pk,voucherRevision=expense.revision)
        if connection.vendor=='postgresql':
            from server.erp.initiatives import project_json as original
            def changed(p,user,params):
                def reverse():
                    close_old_connections()
                    try:reverse_voucher(User.objects.get(pk=self.u.pk),expense.pk,'Паралельний факт')
                    finally:connections.close_all()
                thread=Thread(target=reverse);thread.start();thread.join(timeout=15);self.assertFalse(thread.is_alive());return original(p,user,params)
            with patch('server.erp.initiatives.project_json',side_effect=changed):self.assertEqual(detail(self.u,str(project.pk),{})['actualExpenses'],'10.00')
            self.assertEqual(detail(self.u,str(project.pk),{})['actualExpenses'],'0.00')
        docs=Document.objects.bulk_create([Document(path='tasks/page-'+str(i),data={'title':'Етап '+str(i),'status':'todo','scope':'development'}) for i in range(35)]);ProjectTask.objects.bulk_create([ProjectTask(project=project,document=d) for d in docs]);data=detail(self.u,str(project.pk),{'tasksPage':'2'});self.assertEqual(data['tasks']['total'],35);self.assertEqual(len(data['tasks']['items']),5);self.assertEqual(Document.objects.get(pk='project/state').data,{'stage':3,'nextStep':'Старий маршрут'});self.assertEqual(business(project)['project_task_count'],35);self.assertNotIn('project_tasks',business(project))
