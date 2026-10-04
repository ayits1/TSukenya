"""Bounded portal reads. Payloads/pages are bounded; legacy scope/search summaries stream O(N).
The historical JSON visibility policy is deliberately evaluated by its existing Python helper.
"""
import re
from decimal import Decimal
from django.contrib.auth.models import User
from django.db.models import Case, When, Value, FloatField
from django.db.models.functions import Cast
from django.db.models.fields.json import KeyTextTransform
from django.utils import timezone
from .models import Document, ProjectTask, IdeaProject
from .historical_reports import read_snapshot
from .task_scope import task_visible, task_permissions, alert_task
from .managed_alerts import task_revision
from .services import require
from .financial_scope import require_network_owner
from .legacy_settings import settings_for_role
from .portal_api import legacy_number

LIMIT=30
CATEGORIES=['Оренда','Комунальні','Логістика','Обслуговування','Маркетинг','Податки','Зарплата','Інше']
HINTS=[('Зарплата','зарплат|оплата праці|заробітн'),('Оренда','оренд'),('Комунальні','комунал|електро|світло|вода|опален|газ'),('Логістика','логіст|доставк|перевез|пальн|бензин'),('Обслуговування','обслуг|ремонт|сервіс|прибиран'),('Маркетинг','маркет|реклам|просуван'),('Податки','подат|єсв|збір')]


def actor(user):
    current=User.objects.select_related('profile').filter(pk=user.pk,is_active=True).first()
    require(current is not None and hasattr(current,'profile'),'Недостатньо прав.')
    return current


def metadata(user,effective_day=None):
    data={'settings/main':{},'project/state':{}}
    for doc in Document.objects.filter(path__in=data).iterator(chunk_size=2):
        if doc.path=='settings/main':data[doc.path]=settings_for_role(doc.data,user.profile.role,user.profile.store_id)
        elif user.profile.role=='owner':data[doc.path]=doc.data
    return data


def category(data):
    if data.get('category') in CATEGORIES:return data['category']
    name=str(data.get('name') or '').lower()
    return next((label for label,pattern in HINTS if re.search(pattern,name)), 'Інше')


def context(user,collection,params):
    require(collection in {'tasks','ideas','expenses'},'Невідома колекція.')
    if collection=='expenses':require_network_owner(user)
    out={'collection':collection,'role':user.profile.role,'store':user.profile.store_id,'q':params.get('q','')}
    require(isinstance(out['q'],str) and len(out['q'])<=250,'Пошук: не більше 250 символів.')
    if collection=='tasks':
        out.update(space=params.get('space','operations'),status=params.get('status','all'),stage=params.get('stage','all'))
        require(out['space'] in {'operations','development'} and out['status'] in {'all','todo','doing','done'} and out['stage'] in {'all','unknown','1','2','3','4'},'Перевірте фільтри задач.')
        require(out['space']!='development' or user.profile.role=='owner','Недостатньо прав для розвитку бізнесу.')
    elif collection=='ideas':
        out['reaction']=params.get('reaction','all');require(out['reaction'] in {'all','awaiting','yes','no'},'Перевірте реакцію на ідею.')
    else:
        out['group']=params.get('group','all');require(out['group'] in {'all','fixed','variable'},'Перевірте групу витрат.')
    return out


def documents(collection):
    # Exact finite legacy numeric order; malformed values have the former zero fallback.
    number=Case(When(data__order__regex=r'^[+-]?[0-9]{1,250}(?:\.[0-9]{1,250})?$',then=Cast(KeyTextTransform('order','data'),FloatField())),default=Value(0.),output_field=FloatField())
    return Document.objects.filter(path__startswith=collection+'/').annotate(portal_order=number).order_by('portal_order','path')


def visible(user,collection,data):
    if not isinstance(data,dict):return False
    if collection=='tasks':return task_visible(user,data)
    if collection=='ideas':return user.profile.role=='owner' or data.get('scope')=='operations'
    return True


def matches(data,ctx):
    if ctx['collection']=='tasks':
        if (data.get('scope')=='operations')!=(ctx['space']=='operations'):return False
        if ctx['status']!='all' and (data.get('status') or 'todo')!=ctx['status']:return False
        stage=data.get('stage');valid=type(stage) is int and 1<=stage<=4
        if ctx['stage']=='unknown' and valid:return False
        if ctx['stage'] not in {'all','unknown'} and stage!=int(ctx['stage']):return False
    elif ctx['collection']=='ideas':
        reaction=data.get('reaction');selected=ctx['reaction']
        if selected=='awaiting' and reaction:return False
        if selected in {'yes','no'} and reaction!=selected:return False
    elif ctx['group']!='all' and ('fixed' if data.get('group')=='fixed' else 'variable')!=ctx['group']:return False
    fields=('title','text') if ctx['collection']=='ideas' else ('title',) if ctx['collection']=='tasks' else ('name',)
    return not ctx['q'] or ctx['q'].casefold() in ' '.join(str(data.get(k) or '') for k in fields).casefold()


def items(user,collection,docs):
    paths=[d.path for d in docs]; links={}
    if user.profile.role=='owner':
        rows=ProjectTask.objects.filter(document_id__in=paths).values('document_id','project_id','project__store_id') if collection=='tasks' else IdeaProject.objects.filter(idea_id__in=paths).values('idea_id','id','store_id') if collection=='ideas' else []
        for r in rows:links[r.get('document_id',r.get('idea_id'))]=r
    linked_ideas=set()
    if collection=='ideas' and docs:
        ids=[d.path.split('/',1)[1] for d in docs]
        for d in Document.objects.filter(path__startswith='tasks/',data__ideaId__in=ids).iterator(chunk_size=200):
            if isinstance(d.data,dict) and d.data.get('scope')!='operations' and task_visible(user,d.data):linked_ideas.add(d.data.get('ideaId'))
    result=[]
    for doc in docs:
        data=dict(doc.data);identifier=doc.path.split('/',1)[1];link=links.get(doc.path)
        store=link.get('project__store_id',link.get('store_id')) if link else None
        initiative=str(link.get('project_id',link.get('id'))) if link and (user.profile.store_id is None or store==user.profile.store_id) else None
        permissions=task_permissions(user,doc.path,data) if collection=='tasks' else {'canEdit':user.profile.role=='owner','canDelete':user.profile.role=='owner'}
        if link:permissions={'canEdit':False if collection=='tasks' else permissions['canEdit'],'canDelete':False}
        if collection=='expenses':data['amount']=format(legacy_number(data.get('amount')), 'f')
        row={'id':identifier,'revision':task_revision(doc),'data':data,'permissions':permissions,'initiative':initiative,'managed':collection=='tasks' and alert_task(doc.path,data)}
        if collection=='ideas':row['hasDevelopmentTask']=identifier in linked_ideas
        result.append(row)
    return result


def page(user,collection,params):
    raw=params.get('page','1');require(isinstance(raw,str) and re.fullmatch(r'[0-9]{1,9}',raw) and int(raw)>0,'Перевірте номер сторінки.')
    requested=int(raw)
    with read_snapshot():
        user=actor(user);ctx=context(user,collection,params);total=0;selected=[];last=[]
        for doc in documents(collection).iterator(chunk_size=200):
            if not visible(user,collection,doc.data) or not matches(doc.data,ctx):continue
            if total%LIMIT==0:last=[]
            last.append(doc)
            if (requested-1)*LIMIT<=total<requested*LIMIT:selected.append(doc)
            total+=1
        pages=max(1,(total+LIMIT-1)//LIMIT);number=min(requested,pages)
        if number!=requested:selected=last
        return {'items':items(user,collection,selected),'total':total,'page':number,'pages':pages,'limit':LIMIT,'generatedAt':timezone.now().isoformat(),'context':ctx}


def task(user,identifier):
    require(re.fullmatch(r'[A-Za-z0-9_-]{1,120}',identifier) is not None,'Некоректна задача.')
    with read_snapshot():
        user=actor(user);doc=Document.objects.filter(pk='tasks/'+identifier).first()
        require(doc is not None and visible(user,'tasks',doc.data),'Задача недоступна.')
        return items(user,'tasks',[doc])[0]


def summary(user,params):
    section=params.get('section','operations');require(section in {'operations','development','budget'},'Оберіть розділ підсумків.')
    with read_snapshot():
        user=actor(user)
        if section=='budget':require_network_owner(user)
        if section=='development':require(user.profile.role=='owner','Недостатньо прав.')
        result={'section':section,'generatedAt':timezone.now().isoformat(),'context':{'role':user.profile.role,'store':user.profile.store_id}}
        if section=='budget':
            totals={'fixed':Decimal(0),'variable':Decimal(0)};by_category={k:Decimal(0) for k in CATEGORIES};counts={'fixed':0,'variable':0}
            for doc in documents('expenses').iterator(chunk_size=200):
                data=doc.data;amount=legacy_number(data.get('amount'));group='fixed' if data.get('group')=='fixed' else 'variable';by_category[category(data)]+=amount
                if group in totals:totals[group]+=amount;counts[group]+=1
            return {**result,'totals':{k:format(v,'f') for k,v in totals.items()},'byCategory':{k:format(v,'f') for k,v in by_category.items()},'counts':counts}
        statuses={'todo':0,'doing':0,'done':0};stages={str(i):0 for i in range(1,5)}|{'unknown':0};active=0;nearest=[];total=0;unfinished=0;unknown_status=0
        ctx=context(user,'tasks',{'space':section})
        for doc in documents('tasks').iterator(chunk_size=200):
            data=doc.data
            if not visible(user,'tasks',data) or not matches(data,ctx):continue
            status=data.get('status') or 'todo';total+=1;unfinished+=status!='done';unknown_status+=status not in statuses
            if status in statuses:statuses[status]+=1
            stage=data.get('stage');stages[str(stage) if type(stage) is int and 1<=stage<=4 else 'unknown']+=1
            active+=bool(data.get('_alertActive'))
            if section=='operations' and status!='done' or section=='development' and status=='doing':
                nearest.append(doc)
                nearest.sort(key=lambda d:(str(d.data.get('dueDate') or '9999') if section=='operations' else '',d.portal_order,d.path));nearest=nearest[:5]
        result.update(total=total,unfinished=unfinished,unknownStatus=unknown_status,statuses=statuses,stages=stages,activeConditions=active,nearest=items(user,'tasks',nearest))
        if section=='development':
            reactions={'awaiting':0,'yes':0,'no':0}
            for doc in documents('ideas').iterator(chunk_size=200):
                if visible(user,'ideas',doc.data):
                    reaction=doc.data.get('reaction') or 'awaiting'
                    if reaction in reactions:reactions[reaction]+=1
            result['reactions']=reactions
        return result
