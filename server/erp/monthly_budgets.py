"""Explicit owner budgets; actuals remain accounting documents, never percentage estimates."""
import hashlib,json,re,uuid
from calendar import monthrange
from datetime import date
from decimal import Decimal
from collections import defaultdict
from django.db import transaction
from django.utils import timezone
from .models import ExpenseCategory,ExpenseCategoryAlias,MonthlyBudget,BudgetLine,Store
from .services import ZERO,QTY,dec,money,require,scope,ledger_lock,audit,Conflict,get
from .historical_reports import period_documents,period_sign,require_reversal_dates,read_snapshot
from .business_audit import select as audit_select,change as audit_change


def owner(user):require(user.profile.role=='owner','Бюджет доступний лише власнику.')
def identity(raw,label='ID'):
    require(isinstance(raw,str),f'{label}: некоректний UUID.')
    try:return uuid.UUID(raw)
    except (ValueError,TypeError):raise ValueError(f'{label}: некоректний UUID.')
def month(raw):
    require(isinstance(raw,str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}',raw) is not None,'Місяць має бути у форматі РРРР-ММ.')
    year,number=map(int,raw.split('-'));require(1<=year<=9998 and 1<=number<=12,'Некоректний місяць.')
    return date(year,number,1)
def store_for(user,raw):
    if raw in (None,''):
        require(not user.profile.store_id,'Мережевий бюджет недоступний у межах одного магазину.')
        return None
    require(type(raw) is int or isinstance(raw,str) and re.fullmatch(r'[0-9]{1,12}',raw) is not None,'Некоректний магазин.')
    store=get(Store,int(raw),'Магазин');scope(user,store);return store
def decimal(raw,label,quantum=Decimal('.01')):
    require(isinstance(raw,str),f'{label}: вкажіть десятковий рядок.')
    return dec(raw,label,quantum)
def category_json(c):return {'id':str(c.pk),'name':c.name,'semantic_key':c.semantic_key,'active':c.active,'revision':c.revision}
def category_snapshot(category):
    return audit_select(category,('id','name','semantic_key','active','revision')) if category else None

def budget_snapshot(budget):
    if budget is None:return None
    value={'id':str(budget.pk),'month':budget.month.isoformat(),'store_id':budget.store_id,'planned_revenue':str(budget.planned_revenue),'revision':budget.revision}
    result=audit_select(value,('id','month','store_id','planned_revenue','revision'))
    result['lines']=[audit_select(line,('id','category_id','category_name','position','mode','amount','rate','base')) for line in budget.lines.order_by('position','pk')]
    return result

def categories(user):
    require(user.profile.role in {'owner','manager','accountant'},'Недостатньо прав.')
    return {'items':[category_json(c) for c in ExpenseCategory.objects.order_by('name','pk')]}

def bind_expense(payload,previous=None):
    """Stable category + display snapshot. Old text remains unchanged in old documents."""
    raw=payload.get('category_id')
    if raw is None or raw=='':return {}
    category=get(ExpenseCategory,identity(raw,'Стаття'),'Стаття')
    same=previous and previous.get('category_id')==str(category.pk)
    require(category.active or same,'Статтю архівовано; виберіть активну статтю.')
    require(category.semantic_key!='salary','Зарплата обліковується нарахуванням, а не документом витрати.')
    return {'category_id':str(category.pk),'category':category.name}

@transaction.atomic
def save_category(user,body,key=None):
    owner(user);ledger_lock();require(isinstance(body,dict),'Некоректна стаття.')
    name=body.get('name');require(isinstance(name,str) and 0<len(name.strip())<=160,'Вкажіть назву статті до 160 символів.');name=name.strip()
    active=body.get('active',True);require(type(active) is bool,'Ознака активності має бути логічною.')
    require('semantic_key' not in body,'Системний ключ статті незмінний.')
    c=get(ExpenseCategory,identity(key),'Стаття') if key else None
    candidate=identity(body['id']) if body.get('id') else uuid.uuid4()
    if not c and ExpenseCategory.objects.filter(pk=candidate).exists():
        old=ExpenseCategory.objects.get(pk=candidate)
        require(old.revision==1 and old.name==name and old.active==active,'ID створення вже використано або статтю змінено.');return category_json(old)
    before=category_snapshot(c)
    aliases=ExpenseCategoryAlias.objects.filter(name=name)
    require(not aliases.exclude(category=c).exists() if c else not aliases.exists(),'Назва вже належить іншій історичній статті.')
    if c:
        require(type(body.get('revision')) is int,'Передайте версію статті.')
        if c.revision!=body['revision']:raise Conflict('Статтю змінено в іншому сеансі.','budget_revision_conflict',revision=c.revision)
        c.name=name;c.active=active;c.revision+=1
    else:c=ExpenseCategory(id=candidate,name=name,active=active)
    c.save();ExpenseCategoryAlias.objects.get_or_create(name=name,defaults={'category':c})
    audit(user,'budget_category_saved',f'budget-category/{c.pk}',audit_change(before,category_snapshot(c),observed=body.get('revision')));return category_json(c)

def budget_json(b):
    return {'id':str(b.pk),'month':b.month.strftime('%Y-%m'),'store':b.store_id,'revision':b.revision,'planned_revenue':str(b.planned_revenue),
            'lines':[{'id':str(l.pk),'category':str(l.category_id),'category_name':l.category_name,'mode':l.mode,'amount':str(l.amount),'rate':str(l.rate),'base':l.base} for l in b.lines.order_by('position','pk')]}

@transaction.atomic
def save(user,body,key=None):
    owner(user);ledger_lock();require(isinstance(body,dict),'Некоректний бюджет.')
    start=month(body.get('month'));store=store_for(user,body.get('store'));revenue=decimal(body.get('planned_revenue','0'),'Плановий виторг')
    raw=body.get('lines');require(isinstance(raw,list) and len(raw)<=200,'Потрібен список до 200 рядків бюджету.')
    old=get(MonthlyBudget,identity(key),'Бюджет') if key else None
    fingerprint=hashlib.sha256(json.dumps(body,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
    create_key=None
    if not old:
        create_key=body.get('idempotency_key');require(isinstance(create_key,str) and 1<=len(create_key)<=100,'Потрібен стабільний ключ створення бюджету.')
        reused=MonthlyBudget.objects.filter(create_key=create_key).first()
        if reused:
            require(reused.fingerprint==fingerprint and reused.revision==1,'Ключ створення вже використано або бюджет змінено.');return budget_json(reused)
    if old:
        require(old.month==start and old.store_id==(store.pk if store else None),'Період і магазин збереженого бюджету незмінні.')
        require(type(body.get('revision')) is int,'Передайте версію бюджету.')
        if old.revision!=body['revision']:raise Conflict('Бюджет змінено в іншому сеансі. Ваша чернетка збережена.','budget_revision_conflict',revision=old.revision)
    before=budget_snapshot(old)
    normalized=[];seen=set();prior={str(l.pk):l for l in old.lines.all()} if old else {}
    prepared=[]
    for position,item in enumerate(raw):
        require(isinstance(item,dict),'Некоректний рядок бюджету.')
        cid=identity(item.get('category'),'Стаття')
        lid=identity(item['id'],'Рядок') if item.get('id') else uuid.uuid4();require(lid not in seen,'Рядок повторюється.');seen.add(lid)
        prepared.append((position,item,cid,lid))
    foreign=BudgetLine.objects.filter(pk__in=seen)
    if old:foreign=foreign.exclude(budget=old)
    require(not foreign.exists(),'Рядок належить іншому бюджету.')
    cats={c.pk:c for c in ExpenseCategory.objects.filter(pk__in=[p[2] for p in prepared])}
    for position,item,cid,lid in prepared:
        category=cats.get(cid);require(category is not None,'Стаття: запис не знайдено.')
        previous=prior.get(str(lid))
        require(category.active or previous and previous.category_id==category.pk,'Архівну статтю можна зберігати лише в її чинному історичному рядку.')
        mode=item.get('mode');require(isinstance(mode,str) and mode in {'fixed_amount','variable_amount','revenue_rate'},'Виберіть спосіб планування.')
        base=item.get('base','revenue');require(base=='revenue','Підтримано лише явну базу «Виторг».')
        amount=decimal(item.get('amount','0'),'Планова сума');rate=decimal(item.get('rate','0'),'Відсоток',QTY);require(rate<=100,'Відсоток має бути від 0 до 100.')
        require(amount==0 if mode=='revenue_rate' else rate==0,'Сума і відсоток — різні способи планування.')
        normalized.append((position,lid,category,mode,amount,rate,base,previous.category_name if previous and previous.category_id==category.pk else category.name))
    if not old:
        other=MonthlyBudget.objects.filter(month=start,store=store).first()
        if other:raise Conflict('Бюджет цього місяця й магазину вже існує. Відкрийте його.','budget_exists',id=str(other.pk),revision=other.revision)
        b=MonthlyBudget(month=start,store=store,create_key=create_key,fingerprint=fingerprint)
    else:b=old;b.revision+=1
    b.planned_revenue=revenue;b.save()
    b.lines.exclude(pk__in=seen).delete()
    created=[];updated=[]
    for position,lid,c,mode,amount,rate,base,snapshot in normalized:
        line=prior.get(str(lid)) or BudgetLine(id=lid,budget=b)
        existing=not line._state.adding
        line.category=c;line.category_name=snapshot;line.position=position;line.mode=mode;line.amount=amount;line.rate=rate;line.base=base
        (updated if existing else created).append(line)
    BudgetLine.objects.bulk_create(created,batch_size=200)
    if updated:BudgetLine.objects.bulk_update(updated,['category','category_name','position','mode','amount','rate','base'],batch_size=200)
    audit(user,'monthly_budget_saved',f'budget/{b.pk}',audit_change(before,budget_snapshot(b),observed=body.get('revision')))
    return budget_json(b)

def view_data(user,params):
    owner(user);start=month(params.get('month') or timezone.localdate().strftime('%Y-%m'));store=store_for(user,params.get('store'))
    end=date(start.year,start.month,monthrange(start.year,start.month)[1]);today=timezone.localdate();through=min(today,end)
    b=MonthlyBudget.objects.filter(month=start,store=store).first();data=budget_json(b) if b else {'id':None,'month':start.strftime('%Y-%m'),'store':store.pk if store else None,'revision':None,'planned_revenue':'0.00','lines':[]}
    cats=list(ExpenseCategory.objects.all());by_id={str(c.pk):c for c in cats};system={c.semantic_key:c for c in cats if c.semantic_key};aliases={a.name:str(a.category_id) for a in ExpenseCategoryAlias.objects.all()}
    facts=defaultdict(lambda:ZERO);revenue=ZERO;coverage=total=0;ids=[store.pk] if store else list(Store.objects.values_list('pk',flat=True))
    if start<=through:
        require_reversal_dates(ids,through)
        for v in period_documents(ids,start,through,kinds=('expense','payroll','sale','customer_return')):
            sign=period_sign(v,start,through)
            if not sign:continue
            require(isinstance(v.payload,dict),'Документ має некоректні реквізити; перевірте регістри.')
            if v.kind in {'sale','customer_return'}:revenue+=sign*v.total*(1 if v.kind=='sale' else -1);continue
            if store and v.kind=='expense' and v.payload.get('expense_scope','store')=='network':continue
            total+=1
            if v.kind=='payroll':cid=str(system['salary'].pk);coverage+=1
            else:
                cid=v.payload.get('category_id')
                if isinstance(cid,str) and cid in by_id:coverage+=1
                elif isinstance(v.payload.get('category'),str) and v.payload['category'] in aliases:cid=aliases[v.payload['category']];coverage+=1
                else:cid=str(system['other'].pk)
            facts[cid]+=sign*v.total
    plans=defaultdict(lambda:ZERO)
    for row in data['lines']:plans[row['category']]+=money(Decimal(data['planned_revenue'])*Decimal(row['rate'])/100) if row['mode']=='revenue_rate' else Decimal(row['amount'])
    compared=[{'category':str(c.pk),'name':c.name,'active':c.active,'plan':str(money(plans[str(c.pk)])),'fact':str(money(facts[str(c.pk)])),'deviation':str(money(facts[str(c.pk)]-plans[str(c.pk)]))} for c in sorted(cats,key=lambda c:c.name) if str(c.pk) in plans or str(c.pk) in facts]
    data.update({'comparison':compared,'plan_total':str(money(sum(plans.values(),ZERO))),'fact_total':str(money(sum(facts.values(),ZERO))),
                 'deviation':str(money(sum(facts.values(),ZERO)-sum(plans.values(),ZERO))),'actual_revenue':str(money(revenue)),
                 'categories':[category_json(c) for c in sorted(cats,key=lambda c:c.name)],'stores':[{'id':s.pk,'name':s.name,'active':s.active} for s in (Store.objects.filter(pk=user.profile.store_id) if user.profile.store_id else Store.objects.all()).order_by('pk')],
                 'months':sorted(set(MonthlyBudget.objects.filter(store=store).values_list('month',flat=True)),reverse=True),
                 'days_passed':max(0,(through-start).days+1),'days_total':(end-start).days+1,'through':through.isoformat() if through>=start else None,
                 'coverage':{'classified':coverage,'documents':total},'basis':'accounting_dates','reversal_policy':'kyiv_reversed_at'})
    data['months']=[m.strftime('%Y-%m') for m in data['months']]
    return data

def view(user,params):
    with read_snapshot():return view_data(user,params)
