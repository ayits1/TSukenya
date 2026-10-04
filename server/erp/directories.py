"""B24 read-only trading directories. Pages and selected IDs are never business writes."""
import csv
import io
import re
import uuid
from decimal import Decimal

from django.db import connection
from django.db.models import Exists, OuterRef, Q, Sum
from django.db.models.functions import Lower, Cast
from django.db.models import CharField
from django.db.models.fields.json import KeyTextTransform
from django.http import StreamingHttpResponse
from django.utils import timezone

from .browsing import PAGE_SIZE, page_bounds, page_number, positive_integer
from .csv_format import MARKER, guarded
from .historical_reports import read_snapshot
from .models import Store, Warehouse, CashAccount, Employee, Counterparty, Document, CashShift, CashEntry, Voucher, LedgerLock, Setting, ExpenseCategory
from .services import KINDS, ROLE_KINDS, ACTIVE_PARTY_KINDS, money, record_revision, require, discount_limit, percent_text

MODELS = {'stores': Store, 'warehouses': Warehouse, 'accounts': CashAccount, 'employees': Employee, 'parties': Counterparty, 'products': Document, 'expense_categories':ExpenseCategory, 'cash_shifts':CashShift}
ROLES = set(ROLE_KINDS)
PURPOSES = set(KINDS) | {'label', 'browse', 'manage', 'finance', 'work_shift', 'shift_open', 'recipe', 'legacy_recipe', 'filter', 'transfer_target', 'cash_transfer_target'}


def identifier(value, resource):
    require(isinstance(value, str), 'Некоректний ID довідника.')
    if resource == 'products':
        require(re.fullmatch(r'[^/\x00-\x1f]{1,120}', value) is not None, 'Некоректний ID товару.')
        return 'products/' + value
    if resource == 'expense_categories':
        require(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',value) is not None,'Некоректний ID статті витрат.')
        return uuid.UUID(value)
    return positive_integer(value, 'ID довідника')


def parameters(user, resource, params):
    require(user.profile.role in ROLES and resource in MODELS, 'Довідник недоступний.')
    if resource == 'expense_categories':require(user.profile.role in {'owner','manager','accountant'},'Статті витрат недоступні.')
    if resource == 'cash_shifts':require(user.profile.role in {'owner','manager','cashier','accountant'},'Касові зміни недоступні.')
    purpose = params.get('purpose', 'browse')
    require(purpose in PURPOSES, 'Невідоме призначення вибору.')
    if purpose in KINDS: require(purpose in ROLE_KINDS[user.profile.role], 'Ваша роль не дозволяє цю операцію.')
    if purpose in {'manage'}: require(user.profile.role == 'owner' or resource == 'parties' and user.profile.role in {'manager','accountant'}, 'Редагування довідника недоступне.')
    if purpose == 'work_shift': require(user.profile.role in {'owner','accountant'}, 'Табель недоступний.')
    if purpose in {'recipe', 'legacy_recipe'}: require(user.profile.role in {'owner','manager','warehouse'}, 'Рецептури недоступні.')
    if purpose == 'finance': require(user.profile.role in {'owner','manager','accountant'}, 'Фінанси недоступні.')
    if purpose == 'shift_open': require(user.profile.role in {'owner','manager','cashier','accountant'}, 'Касові зміни недоступні.')
    search = params.get('q', '').strip()
    require(len(search) <= 250, 'Пошуковий запит задовгий.')
    require(params.get('active', '') in {'','yes','no'}, 'Невідомий стан довідника.')
    require(params.get('sort', '') in {'','name','id'}, 'Невідоме сортування довідника.')
    kind = params.get('kind', '')
    require(not kind or resource == 'accounts' and kind in {'cash','bank','terminal'} or resource == 'parties' and kind in {'supplier','customer'}, 'Невідомий тип довідника.')
    requested = positive_integer(params['store'], 'ID магазину') if params.get('store') else None
    require(requested is None or user.profile.store_id is None or requested == user.profile.store_id, 'Магазин недоступний.')
    return purpose, search, requested


def query_for(user, resource, params, *, selected=False):
    purpose, search, store = parameters(user, resource, params)
    query = MODELS[resource].objects.all()
    scope = user.profile.store_id
    if resource == 'stores':
        if scope is not None: query = query.filter(pk=scope)
        if store is not None: query = query.filter(pk=store)
    elif resource in {'warehouses','accounts','employees','cash_shifts'}:
        if scope is not None: query = query.filter(store_id=scope)
        if store is not None: query = query.filter(store_id=store)
    elif resource == 'products': query = query.filter(path__startswith='products/')
    # Contacts are the existing shared directory, not inferred from past sales.
    if resource == 'cash_shifts':
        query=query.select_related('account')
        if user.profile.role == 'cashier':query=query.filter(opened_by=user)
    if selected: return query
    if resource == 'cash_shifts':
        query=query.filter(closed_at__isnull=True)
        if search:query=query.filter(Q(account__name__icontains=search) | Q(pk=int(search) if search.isdecimal() else -1))
        return query
    if resource == 'products':
        if search:
            for word in search.split(): query = query.filter(Q(data__name__icontains=word) | Q(data__barcode__icontains=word))
        if params.get('exclude'): query = query.exclude(pk=identifier(params['exclude'], resource))
        if purpose == 'recipe': query = query.filter(Q(data__hidden__isnull=True) | ~Q(data__hidden=True))
        return query
    if search:
        query = query.filter(Q(name__icontains=search) | Q(phone__icontains=search) | Q(email__icontains=search)) if resource == 'parties' else query.filter(name__icontains=search)
    if resource in {'stores','employees','parties','expense_categories'} and params.get('active'): query = query.filter(active=params['active']=='yes')
    if resource == 'expense_categories' and purpose == 'expense':query=query.exclude(semantic_key='salary').filter(active=True)
    if params.get('kind'): query = query.filter(kind=params['kind'])
    if resource == 'parties' and purpose in {'purchase_order','receipt','supplier_return'}: query=query.filter(kind='supplier')
    if resource == 'parties' and purpose in {'sale','customer_order','customer_return'}: query=query.filter(kind='customer')
    if resource == 'parties' and purpose in ACTIVE_PARTY_KINDS: query=query.filter(active=True)
    if resource == 'employees' and purpose in {'sale','shift_open','work_shift'}: query=query.filter(active=True)
    if resource == 'accounts' and purpose == 'shift_open':
        query = query.filter(kind='cash',store__active=True).annotate(in_use=Exists(CashShift.objects.filter(account_id=OuterRef('pk'),closed_at__isnull=True))).filter(in_use=False)
    return query


def extras(user, resource, objects, purpose):
    ids=[obj.pk for obj in objects]
    result={}
    if resource == 'accounts' and purpose == 'finance':
        result = {row['account_id']: {'balance':str(money(row['amount']))} for row in CashEntry.objects.filter(account_id__in=ids).values('account_id').annotate(amount=Sum('amount'))}
    if resource == 'employees' and purpose in {'manage','finance'} and user.profile.role in {'owner','accountant'}:
        amounts={}
        for row in Voucher.objects.filter(employee_id__in=ids,status='posted',kind__in=['payroll','payroll_payment']).values('employee_id','kind').annotate(amount=Sum('total')):
            values=amounts.setdefault(row['employee_id'],{});values[row['kind']]=money(row['amount'])
        result={pk:{'payroll_debt':str(values.get('payroll',Decimal(0))-values.get('payroll_payment',Decimal(0)))} for pk,values in amounts.items()}
    return result


def item(user, resource, obj, additional=None, resolver=None):
    if resource == 'cash_shifts':return {'id':str(obj.pk),'name':f'Зміна № {obj.pk} · {obj.account.name}','store_id':obj.store_id,'account_id':obj.account_id}
    if resource == 'products':
        from .catalog import revision, decimal
        resolved=resolver.resolve(obj)
        return {'id':obj.pk.split('/',1)[1],'name':str(obj.data.get('name') or ''),'unit':str(obj.data.get('unit') or 'шт'),'barcode':str(obj.data.get('barcode') or ''),
                'hidden':bool(obj.data.get('hidden')),'promotion':bool(resolved['effectivePromotion']),'regularPrice':resolved['regularPrice'],'salePrice':resolved['salePrice'],
                'revision':revision(obj),
                **({'cost':format(decimal(obj.data.get('cost')), 'f')} if user.profile.role!='cashier' else {})}
    result={'id':str(obj.pk),'name':obj.name}
    if resource in {'warehouses','accounts','employees'}: result['store_id']=obj.store_id
    if resource in {'stores','employees','parties','expense_categories'}: result['active']=obj.active
    if resource == 'expense_categories':result['semantic_key']=obj.semantic_key or ''
    if resource in {'accounts','parties'}: result['kind']=obj.kind
    if resource == 'parties': result.update(phone=obj.phone,email=obj.email,notes=obj.notes)
    if resource == 'employees' and user.profile.role in {'owner','accountant'}:
        result.update(shift_rate=str(obj.shift_rate),bonus_percent=str(obj.bonus_percent),bonus_basis=obj.bonus_basis)
    if user.profile.role == 'owner' or resource == 'parties' and user.profile.role in {'manager','accountant'}: result['revision']=record_revision(obj)
    result.update(additional or {})
    if resource == 'accounts' and additional is not None: result.setdefault('balance','0.00')
    if resource == 'employees' and additional is not None and user.profile.role in {'owner','accountant'}: result.setdefault('payroll_debt','0.00')
    return result


def serialized(user, resource, objects, purpose, store=None, *, selected=False):
    extra=extras(user,resource,objects,purpose)
    resolver=None
    if resource == 'products':
        from .catalog import defaults
        from .promotion_prices import PriceResolver,context_store
        # Historical selection/stock labels remain readable when the store is archived.
        # Scope is already checked by parameters(); new-operation choice pricing keeps its guard.
        if store is not None and (selected or purpose in {'label','browse','filter'}):
            pricing_store=Store.objects.filter(pk=store).first()
            require(pricing_store is not None,'Магазин недоступний.')
        else:pricing_store=context_store(user,str(store) if store else None)
        resolver=PriceResolver(defaults(),pricing_store,product_paths=[obj.pk for obj in objects])
    return [item(user,resource,obj,extra.get(obj.pk,{}) if purpose in {'finance','manage'} else None,resolver) for obj in objects]


def page(user, resource, params):
    with read_snapshot():
        purpose,_,store=parameters(user,resource,params)
        query=query_for(user,resource,params)
        total=query.count();current,pages,offset=page_bounds(total,page_number(params))
        query=query.annotate(directory_name=Cast('pk',CharField()) if resource=='cash_shifts' else Lower(KeyTextTransform('name','data') if resource=='products' else 'name'))
        objects=list(query.order_by('pk' if params.get('sort')=='id' else 'directory_name','pk')[offset:offset+PAGE_SIZE])
        return {'items':serialized(user,resource,objects,purpose,store),'total':total,'page':current,'pages':pages,'limit':PAGE_SIZE}


def details(user, value):
    require(isinstance(value,dict) and set(value)<= {'ids','store','purpose'}, 'Некоректний запит вибраних записів.')
    refs=value.get('ids')
    require(isinstance(refs,list) and len(refs)<=200, 'Дозволено до 200 вибраних ID.')
    grouped={};seen=set()
    for ref in refs:
        require(isinstance(ref,dict) and set(ref)=={'type','id'} and isinstance(ref['type'],str) and ref['type'] in MODELS, 'Некоректний тип вибраного запису.')
        pk=identifier(ref['id'],ref['type'])
        key=(ref['type'],pk);require(key not in seen,'ID не має повторюватись.');seen.add(key)
        grouped.setdefault(ref['type'],[]).append(pk)
    result=[];missing=[]
    with read_snapshot():
        for resource,ids in grouped.items():
            params={key:str(value[key]) for key in ('store','purpose') if value.get(key) is not None}
            purpose,_,store=parameters(user,resource,params)
            found=list(query_for(user,resource,params,selected=True).filter(pk__in=ids).order_by('pk'))
            result += [{'type':resource,**row} for row in serialized(user,resource,found,purpose,store,selected=True)]
            available={obj.pk for obj in found}
            missing += [{'type':resource,'id':str(pk).split('/',1)[1] if resource=='products' else str(pk)} for pk in ids if pk not in available]
    return {'items':result,'unavailable':missing}


def lookup(user, params):
    mode=params.get('mode');require(mode in {'barcode','name'},'Невідомий режим пошуку товару.')
    text=params.get('q','').strip();require(0<len(text)<=250,'Вкажіть штрихкод або точну назву.')
    with read_snapshot():
        purpose,_,store=parameters(user,'products',{'q':text,'store':params.get('store',''),'purpose':'sale'})
        query=query_for(user,'products',{'store':params.get('store',''),'purpose':'sale'},selected=True)
        query=query.filter(data__barcode=text) if mode=='barcode' else query.filter(data__name__iexact=text)
        total=query.count();objects=list(query.order_by('pk')[:PAGE_SIZE])
        return {'items':serialized(user,'products',objects,purpose,store),'total':total,'page':1,'pages':max(1,(total+PAGE_SIZE-1)//PAGE_SIZE),'limit':PAGE_SIZE}


def bootstrap(user, csrf):
    require(user.profile.role in ROLES,'Облік недоступний.')
    with read_snapshot():
        from .financial_scope import network_owner
        from .reporting import alert_status
        stores=Store.objects.all()
        if user.profile.store_id is not None:stores=stores.filter(pk=user.profile.store_id)
        first=stores.order_by('pk').values_list('pk',flat=True).first()
        return {'csrf':csrf,'role':user.profile.role,'username':user.username,'storeId':user.profile.store_id,'defaultStoreId':first,
                'defaultCategoryId':str(ExpenseCategory.objects.filter(semantic_key='other').values_list('pk',flat=True).first() or '') if user.profile.role in {'owner','manager','accountant'} else '',
                'canViewAudit':network_owner(user),'closed_through':LedgerLock.objects.get(pk=1).closed_through,
                'fiscal_required':Setting.objects.filter(key='fiscal_required',value='true').exists(),'max_discount':percent_text(discount_limit()),
                **({'alerts_status':alert_status()} if user.profile.role in {'owner','manager'} else {})}


def template(user, params):
    purpose=params.get('purpose','opening');require(purpose in {'opening','receipt','inventory'},'Шаблон недоступний для цієї операції.')
    parameters(user,'products',{'purpose':purpose})
    def generate():
        buffer=io.StringIO(newline='');writer=csv.writer(buffer,delimiter=';',quoting=csv.QUOTE_ALL,lineterminator='\r\n')
        def record(values):
            buffer.seek(0);buffer.truncate(0);writer.writerow(values);return buffer.getvalue()
        yield '\ufeff'+record(['ID'+MARKER,'Кількість','Ціна','Партія','Придатний до'])
        with read_snapshot():
            for obj in Document.objects.filter(path__startswith='products/').only('path','data').order_by('path').iterator(chunk_size=100):
                raw=obj.pk.split('/',1)[1];raw='\t'+raw if guarded(raw) else raw
                yield record([raw,'',str(obj.data.get('cost') or 0),'',''])
    result=StreamingHttpResponse(generate(),content_type='text/csv; charset=utf-8');result['Content-Disposition']='attachment; filename="opening-template.csv"';result['Cache-Control']='private, no-store';return result


def handle(request,user):
    from .views import body,response
    path=request.path.removeprefix('/api/v1/trading/')
    if request.method=='GET' and path=='bootstrap':return response(bootstrap(user,request.portal_session.csrf))
    if request.method=='GET' and path=='products/lookup':return response(lookup(user,request.GET))
    if request.method=='GET' and path=='products/template.csv':return template(user,request.GET)
    if request.method=='POST' and path=='directories/details':return response(details(user,body(request)))
    if request.method=='GET' and path.startswith('directories/'):return response(page(user,path.split('/',1)[1],request.GET))
    return response({'error':'Метод або довідник недоступний.'},405)
