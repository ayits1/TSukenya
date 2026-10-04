"""B20 owner-only initiatives, explicit accounting attribution and legacy identity links."""
import hashlib,hmac,json,re,uuid
from decimal import Decimal,InvalidOperation
from zoneinfo import ZoneInfo
from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.contrib.auth.models import User
from django.db import transaction
from django.db.models import Q,Sum
from django.utils import timezone
from .models import IdeaProject,ProjectTask,ProjectExpense,ProjectOperation,Document,Store,Voucher
from .services import require,Conflict,ledger_lock,get,scope,expense_permission,audit,day
from .historical_reports import read_snapshot
from .browsing import page_number,page_bounds,positive_integer
from .business_audit import change,select

STATES={'planned','active','completed','cancelled'}
PLAN_FIELDS={'title','problem','hypothesis','responsible','plannedBudget','metric','metricUnit','targetValue'}


def owner(user):
    if not user.is_active or user.profile.role!='owner':raise PermissionDenied('Проєкти розвитку доступні лише активному власнику.')


def allowed_projects(user):
    owner(user);query=IdeaProject.objects.all()
    if user.profile.store_id is not None:query=query.filter(store_id=user.profile.store_id)
    return query


def access(user,project):
    owner(user)
    if user.profile.store_id is not None and project.store_id!=user.profile.store_id:raise PermissionDenied('Проєкт належить іншому магазину або мережі.')


def integer(value,label):
    if type(value) is int and 0<value<=999999999999:return value
    return positive_integer(value,label)


def identifier(value,label):
    require(isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,120}',value),f'{label}: некоректний ID.');return value


def token(document):
    material=json.dumps(document.data,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False)
    return hmac.new(settings.SECRET_KEY.encode(),(document.path+'\n'+material).encode(),hashlib.sha256).hexdigest()


def text(value,label,maximum=4000,required=False):
    require(isinstance(value,str) and len(value)<=maximum,f'{label}: вкажіть текст до {maximum} символів.');value=value.strip()
    require(not required or value,f'{label}: поле обов’язкове.');return value


def decimal(value,label,places=4,nonnegative=False):
    if value in (None,''):return None
    require(isinstance(value,str) and re.fullmatch(r'-?[0-9]+(?:\.[0-9]{1,'+str(places)+r'})?',value),f'{label}: потрібен десятковий рядок до {places} знаків.')
    try:number=Decimal(value)
    except InvalidOperation:require(False,f'{label}: некоректне число.')
    require(abs(number)<=Decimal('999999999999') and (not nonnegative or number>=0),f'{label}: число поза допустимим діапазоном.');return number.quantize(Decimal(1).scaleb(-places))


def idea_info(user,identifier_value):
    owner(user);document=get(Document,'ideas/'+identifier(identifier_value,'Ідея'),'Ідея');require(isinstance(document.data,dict),'Некоректні дані ідеї.')
    project=allowed_projects(user).filter(idea=document).first()
    return {'id':identifier_value,'title':document.data.get('title') if isinstance(document.data.get('title'),str) else '', 'text':document.data.get('text') if isinstance(document.data.get('text'),str) else '', 'reaction':document.data.get('reaction') if document.data.get('reaction') in ('yes','no',None) else None,'revision':token(document),'project':str(project.pk) if project else None}


def business(project):
    result=select(project,('id','title','problem','hypothesis','store_id','responsible_id','state','planned_budget','metric','metric_unit','target_value','fact_value','result_summary','result_date','cancel_reason','revision'))
    result['source_idea']=project.idea_id
    result['project_task_count']=project.task_links.count()
    result['project_expense_count']=project.expense_links.count()
    result['actual_expenses']=str(project.expense_links.filter(voucher__status='posted').aggregate(total=Sum('voucher__total'))['total'] or Decimal('0.00'))
    return result


def project_json(project,user,params=None):
    access(user,project);params=params or {};task_page=page_number({'page':params.get('tasksPage','1')});expense_page=page_number({'page':params.get('expensesPage','1')})
    tasks=project.task_links.select_related('document').order_by('pk');task_total=tasks.count();task_page,task_pages,start=page_bounds(task_total,task_page)
    # Current role/store is intersected again for each read; a historical attachment never grants access.
    expenses=project.expense_links.select_related('voucher').order_by('pk')
    if user.profile.store_id is not None:expenses=expenses.filter(voucher__store_id=user.profile.store_id).filter(Q(voucher__payload__expense_scope='store')|Q(voucher__payload__expense_scope__isnull=True)|Q(voucher__payload__expense_scope=None))
    actual=expenses.filter(voucher__status='posted').aggregate(total=Sum('voucher__total'))['total'] or Decimal('0.00');expense_total=expenses.count();expense_page,expense_pages,expense_start=page_bounds(expense_total,expense_page)
    return {'id':str(project.pk),'idea':project.idea_id.partition('/')[2],'title':project.title,'problem':project.problem,'hypothesis':project.hypothesis,'store':project.store_id,'responsible':project.responsible_id,'responsibleName':project.responsible.username if project.responsible else None,'responsibleActive':project.responsible.is_active if project.responsible else None,'state':project.state,'revision':project.revision,'plannedBudget':str(project.planned_budget) if project.planned_budget is not None else None,'actualExpenses':str(actual),'actualPolicy':'Поточна сума явно пов’язаних проведених витрат. Сторновані документи не входять; кошти повторно не проводяться.','metric':project.metric,'metricUnit':project.metric_unit,'targetValue':str(project.target_value) if project.target_value is not None else None,'factValue':str(project.fact_value) if project.fact_value is not None else None,'resultSummary':project.result_summary,'resultDate':project.result_date.isoformat() if project.result_date else None,'cancelReason':project.cancel_reason,
        'tasks':{'page':task_page,'pages':task_pages,'total':task_total,'items':[{'id':link.document_id.partition('/')[2],'title':link.document.data.get('title',''),'status':link.document.data.get('status','todo'),'phase':link.phase,'revision':token(link.document)} for link in tasks[start:start+30]]},
        'expenses':{'page':expense_page,'pages':expense_pages,'total':expense_total,'items':[{'id':link.voucher_id,'number':f'{link.voucher_id:06d}','date':link.voucher.date.isoformat(),'amount':str(link.voucher.total),'status':link.voucher.status,'store':link.voucher.store_id,'category':link.voucher.payload.get('category','Інше') if isinstance(link.voucher.payload,dict) else 'Невизначена стаття','canOpen':True} for link in expenses[expense_start:expense_start+30]]}}


def list_projects(user,params):
    with read_snapshot():
        query=allowed_projects(user).select_related('responsible').order_by('-created_at','pk');search=text(params.get('q',''),'Пошук',250)
        if search:query=query.filter(title__icontains=search)
        state=params.get('state')
        if state:require(state in STATES,'Невідомий стан проєкту.');query=query.filter(state=state)
        total=query.count();page,pages,start=page_bounds(total,page_number(params));items=[{'id':str(p.pk),'idea':p.idea_id.partition('/')[2],'title':p.title,'state':p.state,'revision':p.revision,'store':p.store_id} for p in query[start:start+30]]
        return {'items':items,'page':page,'pages':pages,'total':total}


def detail(user,project_id,params):
    with read_snapshot():return project_json(get(IdeaProject,project_id,'Проєкт'),user,params)


def options(user,params):
    with read_snapshot():
        owner(user);stores=Store.objects.filter(active=True).order_by('pk')
        if user.profile.store_id is not None:stores=stores.filter(pk=user.profile.store_id)
        return {'stores':list(stores.values('id','name')),'networkAllowed':user.profile.store_id is None,'users':list(User.objects.filter(is_active=True).order_by('username').values('id','username'))}


def candidates(user,project_id,params):
    with read_snapshot():
        project=get(IdeaProject,project_id,'Проєкт');access(user,project);purpose=params.get('purpose');search=text(params.get('q',''),'Пошук',250)
        if purpose=='tasks':
            query=Document.objects.filter(path__startswith='tasks/').filter(Q(data__scope='development')|Q(data__scope__isnull=True)|Q(data__scope=None)).exclude(initiative_task__isnull=False).exclude(path__startswith='tasks/auto_').exclude(path__startswith='tasks/reprint_').order_by('pk')
            if search:query=query.filter(data__title__icontains=search)
            total=query.count();page,pages,start=page_bounds(total,page_number(params));items=[{'id':d.path.partition('/')[2],'title':d.data.get('title',''),'status':d.data.get('status','todo'),'revision':token(d)} for d in query[start:start+30] if isinstance(d.data,dict) and not any(k.startswith(('_alert','_price')) for k in d.data)]
        else:
            require(purpose=='expenses','Виберіть задачі або витрати.');query=Voucher.objects.filter(kind='expense',status='posted',initiative_expense__isnull=True).order_by('-date','-pk')
            if user.profile.store_id is not None:query=query.filter(store_id=user.profile.store_id).filter(Q(payload__expense_scope='store')|Q(payload__expense_scope__isnull=True)|Q(payload__expense_scope=None))
            if project.store_id is not None:query=query.filter(store_id=project.store_id).filter(Q(payload__expense_scope='store')|Q(payload__expense_scope__isnull=True)|Q(payload__expense_scope=None))
            if search:query=query.filter(Q(note__icontains=search)|Q(payload__category__icontains=search)|Q(pk=int(search)) if search.isascii() and search.isdecimal() else Q(note__icontains=search)|Q(payload__category__icontains=search))
            total=query.count();page,pages,start=page_bounds(total,page_number(params));items=[{'id':v.pk,'number':f'{v.pk:06d}','date':str(v.date),'amount':str(v.total),'category':v.payload.get('category','Інше') if isinstance(v.payload,dict) else 'Невизначена стаття','revision':v.revision} for v in query[start:start+30]]
        return {'purpose':purpose,'items':items,'page':page,'pages':pages,'total':total}


def apply_plan(project,value):
    if 'title' in value:project.title=text(value['title'],'Назва',250,True)
    for field in ('problem','hypothesis'): 
        if field in value:setattr(project,field,text(value[field],{'problem':'Проблема','hypothesis':'Гіпотеза'}[field]))
    if 'responsible' in value:
        raw=value['responsible'];person=get(User,integer(raw,'Відповідальний'),'Відповідальний') if raw is not None else None
        require(person is None or person.is_active or project.responsible_id==person.pk,'Нове призначення неактивного відповідального недоступне.');project.responsible=person
    if 'plannedBudget' in value:project.planned_budget=decimal(value['plannedBudget'],'План бюджету',2,True)
    if 'metric' in value:project.metric=text(value['metric'],'Показник',160)
    if 'metricUnit' in value:project.metric_unit=text(value['metricUnit'],'Одиниця показника',80)
    if 'targetValue' in value:project.target_value=decimal(value['targetValue'],'План показника')
    require(not project.metric or project.metric_unit,'Вкажіть одиницю вимірювання показника.');require(project.target_value is None or project.metric,'Числова ціль потребує назви показника.')


def outcome(project,value):
    project.result_summary=text(value.get('resultSummary'),'Опис результату',4000,True);require(isinstance(value.get('resultDate'),str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}',value['resultDate']),'Вкажіть дату результату у форматі РРРР-ММ-ДД.');project.result_date=day(value['resultDate']);require(project.result_date<=timezone.localtime(timezone.now(),ZoneInfo('Europe/Kyiv')).date(),'Дата результату не може бути майбутньою.')
    project.fact_value=decimal(value.get('factValue'),'Фактичний показник');require(not project.metric and project.target_value is None or project.fact_value is not None,'Для заданого показника потрібне фактичне значення.');require(project.metric or project.fact_value is None,'Фактичне число потребує заданого показника й одиниці.')


def reject_linked_legacy(user,document,method):
    link=ProjectTask.objects.filter(document=document).select_related('project').first()
    if link:access(user,link.project);raise Conflict('Задача належить проєкту. Відкрийте проєкт і змініть її з перевіреної версії.','initiative_task_managed')
    project=IdeaProject.objects.filter(idea=document).first()
    if project:
        access(user,project)
        require(method!='DELETE','Ідею використано в проєкті. Історичне джерело не можна видалити.')


@transaction.atomic
def mutate(user,value,project_id=None):
    ledger_lock();user.refresh_from_db(fields=['is_active']);user.profile.refresh_from_db();owner(user);require(isinstance(value,dict),'Очікується об’єкт дії проєкту.')
    raw=value.get('idempotencyKey');require(isinstance(raw,str),'Потрібен UUID повтору.')
    try:key=uuid.UUID(raw)
    except (ValueError,AttributeError):require(False,'Некоректний UUID повтору.')
    require(str(key)==raw,'Потрібен канонічний UUID повтору.')
    try:fingerprint=hashlib.sha256(json.dumps([project_id,value],sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()
    except (TypeError,ValueError):require(False,'Некоректні дані дії проєкту.')
    prior=ProjectOperation.objects.filter(pk=key).select_related('project').first()
    if prior:
        access(user,prior.project)
        if prior.actor_id!=user.pk or prior.fingerprint!=fingerprint:raise Conflict('Ключ повтору використано з іншим змістом.','idempotency_conflict')
        return prior.result
    affected_before=None;affected_after=None;action=value.get('action');base={'action','idempotencyKey','revision','reason'};extras={'create':PLAN_FIELDS|{'idea','ideaRevision','store'},'edit':PLAN_FIELDS,'start':set(),'complete':{'resultSummary','resultDate','factValue'},'result_edit':{'resultSummary','resultDate','factValue'},'cancel':set(),'task_create':{'title','phase','stage'},'task_link':{'task','taskRevision','phase'},'task_update':{'task','taskRevision','status'},'expense_attach':{'voucher','voucherRevision'},'expense_detach':{'voucher'}}
    require(isinstance(action,str) and action in extras and not set(value)-base-extras[action],'Невідома дія або поля проєкту.')
    reason=text(value.get('reason',''),'Причина')
    if project_id is None:
        require(action=='create','Потрібне створення проєкту.');idea=get(Document,'ideas/'+identifier(value.get('idea'),'Ідея'),'Ідея');require(isinstance(idea.data,dict),'Некоректна ідея.');require(idea.data.get('reaction')=='yes','Спочатку явно оберіть ідею для реалізації.')
        if value.get('ideaRevision')!=token(idea):raise Conflict('Ідею вже змінено. Оновіть її перед створенням проєкту.','revision_conflict')
        existing=IdeaProject.objects.filter(idea=idea).first()
        if existing:
            access(user,existing);raise Conflict('Проєкт для цієї ідеї вже існує. Відкрийте його.','initiative_exists',id=str(existing.pk))
        store=get(Store,integer(value['store'],'Магазин'),'Магазин') if value.get('store') is not None else None
        require(store is None or store.active,'Магазин неактивний.');require(user.profile.store_id is None or store and store.pk==user.profile.store_id,'Виберіть дозволений магазин.')
        project=IdeaProject(idea=idea,store=store,created_by=user,title='');apply_plan(project,value);require(project.title,'Вкажіть назву проєкту.');before=None;project.save()
    else:
        project=get(IdeaProject,project_id,'Проєкт');access(user,project);observed=value.get('revision');require(type(observed) is int and observed>0,'Потрібна версія проєкту.')
        if observed!=project.revision:raise Conflict('Проєкт уже змінено. Чернетку збережено у формі; оновіть проєкт перед новим рішенням.','revision_conflict')
        before=business(project);open_state=project.state in {'planned','active'}
        if action=='edit':require(open_state,'План завершеного або скасованого проєкту не редагується.');apply_plan(project,value)
        elif action=='start':require(project.state=='planned','Почати можна лише запланований проєкт.');project.state='active'
        elif action=='complete':require(project.state=='active','Завершити можна лише активний проєкт.');outcome(project,value);project.state='completed'
        elif action=='result_edit':require(project.state=='completed' and reason,'Виправлення завершеного результату потребує причини.');outcome(project,value)
        elif action=='cancel':require(open_state and reason,'Скасування відкритого проєкту потребує причини.');project.state='cancelled';project.cancel_reason=reason
        elif action.startswith('task_'):
            require(open_state,'Задачі завершеного або скасованого проєкту не змінюються.')
            if action=='task_create':
                title=text(value.get('title'),'Назва задачі',250,True);stage=value.get('stage',1);require(type(stage) is int and 1<=stage<=4,'Вкажіть чинний етап старого плану (1–4).')
                document=Document.objects.create(path='tasks/'+str(uuid.uuid4()),data={'title':title,'scope':'development','status':'todo','stage':stage,'order':int(timezone.now().timestamp()*1000)})
            else:
                document=get(Document,'tasks/'+identifier(value.get('task'),'Задача'),'Задача');require(isinstance(document.data,dict),'Некоректна задача.');require(document.data.get('scope') in (None,'development') and not document.path.startswith(('tasks/auto_','tasks/reprint_')) and not any(k.startswith(('_alert','_price')) for k in document.data),'Операційні та системні задачі не є планом розвитку.')
                text(document.data.get('title'),'Назва задачі',250,True);require(document.data.get('status','todo') in ('todo','doing','done'),'Перевірте стан старої задачі.');affected_before={'task':document.path,'title':document.data.get('title'),'status':document.data.get('status','todo')}
                if value.get('taskRevision')!=token(document):raise Conflict('Задачу вже змінено. Оновіть її перед дією.','revision_conflict')
            if action=='task_update':
                require(ProjectTask.objects.filter(project=project,document=document).exists(),'Задача належить іншому проєкту.');status=value.get('status');require(isinstance(status,str) and status in {'todo','doing','done'},'Некоректний стан задачі.');document.data={**document.data,'status':status};document.save(update_fields=['data'])
            else:
                require(not ProjectTask.objects.filter(document=document).exists(),'Задача вже прив’язана до проєкту.');phase=text(value.get('phase',''),'Етап проєкту',160);ProjectTask.objects.create(project=project,document=document,phase=phase)
            affected_after={'task':document.path,'title':document.data.get('title'),'status':document.data.get('status','todo'),'phase':ProjectTask.objects.get(document=document).phase}
        elif action.startswith('expense_'):
            voucher=get(Voucher,integer(value.get('voucher'),'Витрата'),'Витрата');
            if user.profile.store_id is not None and voucher.store_id!=user.profile.store_id:raise PermissionDenied('Немає доступу до магазину витрати.')
            scope(user,voucher.store);require(isinstance(voucher.payload,dict),'Перевірте реквізити старої витрати.');expense_permission(user,voucher);require(voucher.kind=='expense','Пов’язати можна лише документ витрати.');require(project.store_id is None or voucher.store_id==project.store_id and voucher.payload.get('expense_scope') in (None,'store'),'Витрата не належить магазину проєкту.')
            affected_before={'voucher':voucher.pk,'amount':str(voucher.total),'status':voucher.status,'attached':ProjectExpense.objects.filter(project=project,voucher=voucher).exists()}
            if action=='expense_attach':
                require(voucher.status=='posted','Пов’язати можна тільки проведену витрату.');
                if type(value.get('voucherRevision')) is not int or value['voucherRevision']!=voucher.revision:raise Conflict('Витрату вже змінено. Перевірте актуальний документ.','revision_conflict')
                require(not ProjectExpense.objects.filter(voucher=voucher).exists(),'Витрата вже пов’язана з проєктом.');ProjectExpense.objects.create(project=project,voucher=voucher)
            else:require(reason,'Відв’язування витрати потребує причини.');link=ProjectExpense.objects.filter(project=project,voucher=voucher).first();require(link is not None,'Витрата не пов’язана з цим проєктом.');link.delete()
            affected_after={**affected_before,'attached':action=='expense_attach'}
        else:require(False,'Створення недоступне для існуючого проєкту.')
        project.revision+=1;project.save()
    result={'ok':True,'project':project_json(project,user)};ProjectOperation.objects.create(key=key,project=project,actor=user,fingerprint=fingerprint,result=result)
    detail=change(before,business(project),observed=value.get('revision') or value.get('ideaRevision'),reason=reason)
    if affected_before is not None or affected_after is not None:detail['related_change']={'before':affected_before,'after':affected_after}
    audit(user,'initiative_'+action,'initiative/'+str(project.pk),detail);return result
