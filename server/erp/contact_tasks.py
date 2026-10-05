"""Scoped contact work. Every accounting fact remains in its existing service."""
import hashlib,json,re,uuid
from datetime import date
from django.contrib.auth.models import User
from django.db import transaction
from django.db.models import Q,Count
from django.utils import timezone
from .models import ContactTask,ContactTaskOperation,Counterparty,Store
from .services import require,current_actor,ledger_lock,Conflict,BusinessError,audit
from .historical_reports import read_snapshot
from .browsing import page_bounds,page_number,PAGE_SIZE

ROLES={'owner','manager','accountant'}
STATUSES={'todo','doing','done','cancelled'}
TERMS={'title','note','due_on','assignee','status','archived'}
class TaskDenied(BusinessError):pass
def fresh(actor):
    try:return current_actor(actor)
    except BusinessError as e:raise TaskDenied(str(e))

def uid(v):
    require(isinstance(v,str),'Вкажіть UUID.')
    try:r=uuid.UUID(v)
    except (ValueError,AttributeError):require(False,'Некоректний UUID.')
    require(str(r)==v,'Некоректний UUID.');return r

def integer(v):
    require(type(v) is int or isinstance(v,str) and re.fullmatch('[1-9][0-9]{0,15}',v),'Некоректний ID.')
    n=int(v);require(0<n<=9007199254740991,'Некоректний ID.');return n

def access(user,store=None):
    if user.profile.role not in ROLES:raise TaskDenied('Задачі контакту недоступні для цієї ролі.')
    if store is not None and user.profile.store_id not in (None,store):raise TaskDenied('Магазин недоступний.')

def scope(query,user,store=None):
    access(user,store)
    chosen=store if store is not None else user.profile.store_id
    return query.filter(store_id=chosen) if chosen else query

def day(v):
    require(isinstance(v,str) and re.fullmatch('[0-9]{4}-[0-9]{2}-[0-9]{2}',v),'Некоректна дата.')
    try:return date.fromisoformat(v)
    except ValueError:require(False,'Некоректна дата.')

def normalize(value):
    require(isinstance(value,dict) and set(value)==TERMS,'Некоректні поля задачі.')
    require(isinstance(value['title'],str) and 0<len(value['title'].strip())<=250,'Назва: від 1 до 250 символів.')
    require(isinstance(value['note'],str) and len(value['note'])<=4000,'Примітка: до 4000 символів.')
    require(isinstance(value['status'],str) and value['status'] in STATUSES,'Некоректний стан задачі.')
    require(type(value['archived']) is bool,'Некоректний стан архіву.')
    return {**value,'title':value['title'].strip(),'due_on':None if value['due_on'] is None else day(value['due_on']).isoformat(),'assignee':None if value['assignee'] is None else integer(value['assignee'])}

def projection(t):
    return {'title':t.title,'note':t.note,'due_on':t.due_on.isoformat() if t.due_on else None,'assignee':t.assignee_id,'status':t.status,'archived':t.archived}

def record(t):
    return {'id':str(t.pk),'customer':t.customer_id,'store':t.store_id,'revision':t.revision,'terms':projection(t),
        'customerName':t.customer.name,'customerActive':t.customer.active,'storeName':t.store.name,'assigneeName':t.assignee.username if t.assignee else None,'assigneeActive':t.assignee.is_active if t.assignee else None,
        'createdAt':t.created_at.isoformat(),'updatedAt':t.updated_at.isoformat(),'completedAt':t.completed_at.isoformat() if t.completed_at else None}

def ready(query):return query.select_related('customer','store','assignee').only('id','customer_id','store_id','revision','title','note','due_on','assignee_id','status','archived','created_at','updated_at','completed_at','customer__name','customer__active','customer__kind','store__name','assignee__username','assignee__is_active')
def fingerprint(actor,action,identifier,customer,store,revision,terms):
    return hashlib.sha256(json.dumps([actor.pk,action,str(identifier),customer,store,revision,terms],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()

def request_terms(value,action,identifier=None):
    require(isinstance(value,dict) and set(value)==({'id','request_key','customer','store','terms'} if action=='create' else {'request_key','revision','terms'}),'Некоректний запит задачі.')
    key=uid(value['request_key']);identifier=uid(value['id']) if action=='create' else uid(identifier)
    revision=None if action=='create' else integer(value['revision'])
    terms=normalize(value['terms'])
    if action=='create':require(terms['status']=='todo' and not terms['archived'],'Нова задача починається у стані «Заплановано».')
    return key,identifier,revision,terms

def acknowledgement(op):return {'resource':'contact_task','request_key':str(op.key),'action':op.action,'original':op.original}

def check_receipt(actor,key,identifier,action,revision,terms,customer=None,store=None):
    row=ContactTaskOperation.objects.filter(pk=key).values('actor_id','task_id','action','fingerprint','store_id_snapshot','customer_id_snapshot','task__store_id','task__customer_id').first()
    if row is None:return None
    access(actor,row['store_id_snapshot']);access(actor,row['task__store_id'])
    if row['store_id_snapshot']!=row['task__store_id'] or row['customer_id_snapshot']!=row['task__customer_id']:raise TaskDenied('Контекст задачі змінено; доступ відкликано.')
    if row['actor_id']!=actor.pk or row['task_id']!=identifier or row['action']!=action or row['fingerprint']!=fingerprint(actor,action,identifier,customer or row['task__customer_id'],store or row['task__store_id'],revision,terms):
        raise Conflict('UUID уже використано для іншого запиту.','idempotency_conflict')
    return ContactTaskOperation.objects.get(pk=key)

def assignee_allowed(identifier,store):
    return User.objects.filter(pk=identifier,is_active=True,profile__role__in=ROLES).filter(Q(profile__store_id=store)|Q(profile__store__isnull=True)).exists()

@transaction.atomic
def save(actor,value,identifier=None):
    ledger_lock();actor=fresh(actor);access(actor)
    action='create' if identifier is None else 'update'
    key,identifier,revision,terms=request_terms(value,action,identifier)
    customer=integer(value['customer']) if action=='create' else None;store=integer(value['store']) if action=='create' else None
    if store:access(actor,store)
    old=check_receipt(actor,key,identifier,action,revision,terms,customer,store)
    if old:return acknowledgement(old)
    if action=='create':
        require(Counterparty.objects.filter(pk=customer,kind='customer').exists(),'Клієнта не знайдено.')
        require(Store.objects.filter(pk=store).exists(),'Магазин не знайдено.')
        if ContactTask.objects.filter(pk=identifier).exists():raise Conflict('ID задачі вже використано.','idempotency_conflict')
        t=ContactTask(id=identifier,customer_id=customer,store_id=store,created_by=actor);before=None
    else:
        t=scope(ContactTask.objects.select_for_update().filter(pk=identifier),actor).first();require(t is not None,'Задачу не знайдено.');access(actor,t.store_id)
        if t.revision!=revision:raise Conflict('Задачу вже змінено. Перечитайте для порівняння.','revision_conflict')
        before=projection(t);t.revision+=1
    if terms['assignee'] is not None and terms['assignee']!=t.assignee_id:require(assignee_allowed(terms['assignee'],t.store_id),'Виконавець недоступний у цьому магазині.')
    if terms['status']=='done' and t.status!='done':t.completed_at=timezone.now()
    elif terms['status']!='done':t.completed_at=None
    for k,v in terms.items():setattr(t,k+'_id' if k=='assignee' else k,day(v) if k=='due_on' and v else v)
    t.save()
    original={'id':str(t.pk),'customer':t.customer_id,'store':t.store_id,'revision':t.revision,'terms':projection(t)}
    op=ContactTaskOperation.objects.create(key=key,actor=actor,task=t,store_id_snapshot=t.store_id,customer_id_snapshot=t.customer_id,action=action,fingerprint=fingerprint(actor,action,identifier,t.customer_id,t.store_id,revision,terms),original=original)
    audit(actor,'contact_task_'+action,str(t.pk),{'before':before,'after':original,'observed_revision':revision})
    return acknowledgement(op)

def unique(params,allowed):
    require(set(params)<=allowed,'Некоректні параметри.')
    if hasattr(params,'getlist'):require(all(len(params.getlist(k))==1 for k in params),'Параметр має бути однозначним.')

def list_tasks(actor,params):
    unique(params,{'customer','store','status','archived','assignee','q','dueFrom','dueTo','overdue','page'})
    with read_snapshot():
        actor=fresh(actor);store=integer(params['store']) if params.get('store') else None
        q=scope(ContactTask.objects.all(),actor,store)
        if params.get('customer'):q=q.filter(customer_id=integer(params['customer']))
        status=params.get('status','');require(status=='' or status in STATUSES,'Некоректний стан.')
        if status:q=q.filter(status=status)
        archive=params.get('archived','no');require(archive in {'no','yes','all'},'Некоректний архів.')
        if archive!='all':q=q.filter(archived=archive=='yes')
        assignee=params.get('assignee','')
        if assignee:q=q.filter(assignee_id=actor.pk if assignee=='me' else None if assignee=='unassigned' else integer(assignee))
        search=params.get('q','').strip();require(len(search)<=250,'Пошуковий запит задовгий.')
        if search:q=q.filter(Q(title__icontains=search)|Q(customer__name__icontains=search))
        start=day(params['dueFrom']) if params.get('dueFrom') else None;end=day(params['dueTo']) if params.get('dueTo') else None
        require(not start or not end or start<=end,'Початок має бути не пізніше завершення.')
        if start:q=q.filter(due_on__gte=start)
        if end:q=q.filter(due_on__lte=end)
        today=timezone.localdate();overdue=Q(due_on__lt=today,status__in=['todo','doing'])
        require(params.get('overdue','') in {'','yes'},'Некоректний стан строку.')
        if params.get('overdue'):q=q.filter(overdue)
        summary={s:q.filter(status=s).count() for s in sorted(STATUSES)};summary['overdue']=q.filter(overdue).count()
        total=q.count();page,pages,offset=page_bounds(total,page_number(params))
        from django.db.models import F
        rows=ready(q).order_by(F('due_on').asc(nulls_last=True),'created_at','id')[offset:offset+PAGE_SIZE]
        return {'items':[record(t) for t in rows],'total':total,'page':page,'pages':pages,'summary':summary,'scope':{'store':store or actor.profile.store_id,'today':today.isoformat()},'canEdit':True}

def current(actor,identifier):
    with read_snapshot():
        actor=fresh(actor);access(actor)
        t=ready(scope(ContactTask.objects.filter(pk=uid(identifier)),actor)).first();require(t is not None,'Задачу не знайдено.');access(actor,t.store_id)
        return {'resource':'contact_task','record':record(t),'permissions':{'canEdit':True}}

def context(actor,params):
    unique(params,{'id','customer','store'})
    with read_snapshot():
        actor=fresh(actor);access(actor)
        t=None
        if params.get('id'):
            t=ContactTask.objects.only('id','customer_id','store_id').filter(pk=uid(params['id'])).first()
        if t:
            customer=t.customer_id;store=t.store_id
            require(not params.get('customer') or integer(params['customer'])==customer,'Контакт змінився.');require(not params.get('store') or integer(params['store'])==store,'Магазин змінився.')
        else:customer=integer(params.get('customer'));store=integer(params.get('store'))
        access(actor,store)
        contacts=Counterparty.objects.filter(pk=customer)
        require((contacts if t else contacts.filter(kind='customer')).exists(),'Контакт недоступний.')
        require(Store.objects.filter(pk=store).exists(),'Магазин недоступний.')
        return {'resource':'contact_task','id':params.get('id') or None,'exists':t is not None,'customer':customer,'store':store,'role':actor.profile.role,'storeId':actor.profile.store_id,'canEdit':True}

def identity(actor,value):
    with read_snapshot():
        actor=fresh(actor);access(actor)
        require(isinstance(value,dict) and set(value)=={'action','id','request'},'Некоректний запит підтвердження.')
        action=value['action'];require(isinstance(action,str) and action in {'create','update'},'Некоректна дія.')
        key,identifier,revision,terms=request_terms(value['request'],action,value['id'])
        require(str(identifier)==value['id'],'Невідповідний ID.')
        customer=integer(value['request']['customer']) if action=='create' else None;store=integer(value['request']['store']) if action=='create' else None
        if store:access(actor,store)
        op=check_receipt(actor,key,identifier,action,revision,terms,customer,store)
        if op:return {'confirmed':True,**acknowledgement(op)}
        if action=='update':
            t=ContactTask.objects.filter(pk=identifier).only('store_id').first();require(t is not None,'Задачу не знайдено.');access(actor,t.store_id)
        return {'resource':'contact_task','request_key':str(key),'action':action,'confirmed':False}

def history(actor,identifier,params):
    unique(params,{'page'})
    with read_snapshot():
        actor=fresh(actor);access(actor)
        t=ContactTask.objects.filter(pk=uid(identifier)).only('store_id').first();require(t is not None,'Задачу не знайдено.');access(actor,t.store_id)
        query=t.operations.order_by('-created_at','key');total=query.count();page,pages,offset=page_bounds(total,page_number(params))
        return {'resource':'contact_task_history','id':str(t.pk),'items':[{'request_key':str(o['key']),'actor':o['actor__username'],'action':o['action'],'at':o['created_at'].isoformat(),'revision':o['original']['revision'],'terms':o['original']['terms']} for o in query.values('key','actor__username','action','created_at','original')[offset:offset+PAGE_SIZE]],'total':total,'page':page,'pages':pages}

def assignees(actor,params):
    unique(params,{'store','q','page','id'})
    with read_snapshot():
        actor=fresh(actor);store=integer(params.get('store'));access(actor,store)
        query=User.objects.filter(is_active=True,profile__role__in=ROLES).filter(Q(profile__store_id=store)|Q(profile__store__isnull=True))
        search=params.get('q','').strip();require(len(search)<=250,'Пошуковий запит задовгий.')
        if search:query=query.filter(username__icontains=search)
        if params.get('id'):query=query.filter(pk=integer(params['id']))
        total=query.count();page,pages,offset=page_bounds(total,page_number(params))
        return {'store':store,'items':[{'id':u.pk,'name':u.username} for u in query.order_by('username','pk')[offset:offset+PAGE_SIZE]],'total':total,'page':page,'pages':pages}

def _handle(request,actor):
    from .views import response,body
    path=request.path
    if path=='/api/v1/crm/contact-tasks':
        if request.method=='GET':return response(list_tasks(actor,request.GET))
        if request.method=='POST':
            value=body(request)
            try:result=save(actor,value)
            except BusinessError as e:
                if isinstance(e,(Conflict,TaskDenied)):raise
                # Bound rollback proof only; never wrap serialization after committed save.
                return response({'error':str(e),'write_rejected':True,'resource':'contact_task','request_key':value.get('request_key') if isinstance(value,dict) else None,'action':'create'},400)
            return response(result)
    if path=='/api/v1/crm/contact-tasks/identity' and request.method=='POST':return response(identity(actor,body(request)))
    if path=='/api/v1/crm/contact-task-context' and request.method=='GET':return response(context(actor,request.GET))
    if path=='/api/v1/crm/contact-task-assignees' and request.method=='GET':return response(assignees(actor,request.GET))
    match=re.fullmatch(r'/api/v1/crm/contact-tasks/([a-f0-9-]{36})(/history)?',path)
    if match:
        identifier=match[1]
        if request.method=='GET':return response(history(actor,identifier,request.GET) if match[2] else current(actor,identifier))
        if request.method=='PATCH' and not match[2]:return response(save(actor,body(request),identifier))
    return response({'error':'Метод недоступний.','code':'method_not_allowed'},405)

def handle(request,actor):
    from .views import response
    try:return _handle(request,actor)
    except TaskDenied as e:return response({'error':str(e)},403)
