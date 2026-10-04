from .business_audit import snapshot as audit_snapshot, change as audit_change
import hashlib
import hmac
import json
import logging
import os
from decimal import Decimal, InvalidOperation, ROUND_CEILING
import re
import secrets
import time
from pathlib import Path
from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.db import transaction, IntegrityError
from django.db.models import Sum, F, Q
from django.utils import timezone
from django.core import signing
from django.core.exceptions import ValidationError
from django.contrib.auth.hashers import check_password, make_password
from server.auth import LOGIN_HTML, ACCOUNT_HTML, FAVICON, hash_password, valid_password
from .models import *
from .services import *
from .reporting import state, stock, report, voucher_json, scoped

COLLECTIONS={'tasks','ideas','products','expenses'}
SINGLE_DOCS={'settings/main','project/state'}
ROOT=settings.BASE_DIR
def release_commit():
    # Written by deploy/release.py into the image; a checkout without it reports 'unknown'.
    try:return json.loads((ROOT/'server'/'RELEASE').read_text())['commit']
    except (OSError,ValueError,KeyError,TypeError):return 'unknown'
RELEASE=release_commit()
OWNER=os.environ.get('OWNER_USERNAME','pavlo')
DEVICE_COOKIE,DEVICE_SALT,DEVICE_AGE='ts_device','tsukenya.login-device',180*86400


def response(value, status=200):
    return JsonResponse(value,safe=isinstance(value,dict),status=status,json_dumps_params={'ensure_ascii':False})

def body(request):
    try:
        require(0<len(request.body)<=1048576,'Запит завеликий або порожній.')
        value=json.loads(request.body)
        require(isinstance(value,dict),'Очікується JSON-об’єкт.')
        return value
    except (json.JSONDecodeError,UnicodeDecodeError):
        raise BusinessError('Некоректний JSON.')

def user_valid(user,password):
    if user.username==OWNER:
        stored=Setting.objects.filter(key='owner_password').first()
        if stored:return valid_password(password,stored.value)
    return check_password(password,user.password)

def trusted_device(request,username):
    # OWASP device cookie: signed on a successful login, it names the user this browser already proved.
    try:return signing.loads(request.COOKIES.get(DEVICE_COOKIE,''),salt=DEVICE_SALT,max_age=DEVICE_AGE)==username
    except signing.BadSignature:return False

def auth(request):
    require(request.portal_user is not None,'Сеанс завершився. Увійдіть знову.')
    if request.method not in {'GET','HEAD'}:
        origin=request.headers.get('Origin','')
        host=request.get_host()
        require(origin in {f'https://{host}',f'http://{host}'} and hmac.compare_digest(request.headers.get('X-CSRF-Token',''),request.portal_session.csrf),'Запит не підтверджений. Оновіть сторінку й повторіть.')
    return request.portal_user

def owner(user):
    require(user.profile.role=='owner','Недостатньо прав. Операція доступна лише власнику.')

CASHIER_PRODUCT_FIELDS={'name','type','category','pack','size','unit','barcode','regularPrice','salePrice','effectivePromotion','storeSalePrices','promotion','promotionPrice','priceAt','minStock','hidden','example'}

def legacy_state(user, effective_day=None, *, include_products=True):
    from .catalog import revision, defaults
    from .task_scope import task_visible, task_permissions
    from .managed_alerts import task_revision
    from .legacy_settings import settings_for_role
    catalog_config=defaults()
    from .promotion_prices import PriceResolver, context_store
    from .models import Store
    price_store=context_store(user)
    store_query=Store.objects.filter(active=True).order_by('pk')
    if user.profile.store_id is not None:store_query=store_query.filter(pk=user.profile.store_id)
    price_resolver=PriceResolver(catalog_config,price_store,effective_day) if include_products else None
    store_resolvers={str(s.pk):PriceResolver(catalog_config,s,effective_day) for s in store_query} if include_products else {}
    from .models import ProjectTask,IdeaProject
    linked_tasks={row['document_id']:row for row in ProjectTask.objects.values('document_id','project_id','project__store_id')} if user.profile.role=='owner' else {}
    linked_ideas={row['idea_id']:row for row in IdeaProject.objects.values('idea_id','id','store_id')} if user.profile.role=='owner' else {}
    collections=COLLECTIONS if include_products else COLLECTIONS-{'products'}
    data={x:[] for x in collections}|{x:{} for x in SINGLE_DOCS}
    documents=Document.objects.order_by('path')
    if not include_products:
        relevant=Q(path__in=SINGLE_DOCS)
        for collection in collections:relevant |= Q(path__startswith=collection+'/')
        documents=documents.filter(relevant)
    for d in documents:
        col,_,id=d.path.partition('/')
        if col in COLLECTIONS:
            link=linked_tasks.get(d.path) if col=='tasks' else linked_ideas.get(d.path) if col=='ideas' else None
            link_store=link.get('project__store_id',link.get('store_id')) if link else None
            initiative=str(link.get('project_id',link.get('id'))) if link and (user.profile.store_id is None or user.profile.store_id==link_store) else None
            if col=='tasks' and not task_visible(user,d.data):
                continue
            if col=='expenses':
                from .financial_scope import network_owner
                if not network_owner(user):continue
            if user.profile.role!='owner' and col in {'tasks','ideas'} and d.data.get('scope')!='operations':
                continue
            product=dict(d.data)
            if col=='products':
                resolved=price_resolver.resolve(d)
                product.update({k:resolved[k] for k in ('regularPrice','salePrice','effectivePromotion')})
                product['regularPrice']=float(resolved['regularPrice'])
                product['storeSalePrices']={key:r.resolve(d)['salePrice'] for key,r in store_resolvers.items()}
                product.setdefault('promotionPrice',None)
                if user.profile.role=='cashier':
                    # Allow-list: legacy sync metadata such as gsBase also carries purchase cost.
                    product={k:v for k,v in product.items() if k in CASHIER_PRODUCT_FIELDS}
                    product['price']=product['regularPrice']
                    product['manualPrice']=True
            data[col].append({'id':id,'data':product,
                             **({'permissions':{'canEdit':False,'canDelete':False} if link else task_permissions(user,d.path,product)} if col=='tasks' else {'permissions':{'canEdit':user.profile.role=='owner','canDelete':user.profile.role=='owner' and not bool(link)}} if col in {'ideas','expenses'} else {}),
                             **({'initiative':initiative} if initiative else {}),
                             **({'revision':revision(d,catalog_config)} if col=='products' else {'revision':task_revision(d)} if col in {'tasks','ideas','expenses'} else {})})
        elif d.path=='settings/main':data[d.path]=settings_for_role(d.data,user.profile.role,user.profile.store_id)
        elif d.path=='project/state' and user.profile.role=='owner':data[d.path]=d.data
    return data

def validate_product(data, path=None, config=None, check_promotion=True):
    require(isinstance(data.get('name'),str) and 0<len(data['name'].strip())<=250,'Вкажіть назву товару (до 250 символів).')
    if 'minStock' in data:dec(data['minStock'],'Мінімальний залишок',QTY)
    if data.get('promotionPrice') is not None:
        from .catalog import regular_price
        discount=dec(data['promotionPrice'],'Акційна ціна',minimum=Decimal('.01'))
        require(discount<=Decimal('99999999.99'),'Акційна ціна завелика.')
        if data.get('promotion') and check_promotion:
            require(discount<regular_price(data, config),'Акційна ціна має бути меншою за звичайну.')
    barcode=str(data.get('barcode','')).strip()
    require(len(barcode)<=80,'Штрихкод задовгий.')
    recipe=data.get('recipe',[])
    require(isinstance(recipe,list) and len(recipe)<=100,'Некоректна рецептура.')
    for row in recipe:
        require(isinstance(row,dict),'Некоректний інгредієнт.')
        ingredient=get(Document,'products/'+str(row.get('product')),'Інгредієнт')
        require(not path or ingredient.pk!=path,'Готовий товар не може бути власним інгредієнтом.')
        dec(row.get('quantity'),'Кількість інгредієнта',QTY,minimum=QTY)

def legacy_create_fingerprint(value):
    try:
        return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()
    except ValueError:
        raise BusinessError('Некоректні числа в запиті створення.')

@transaction.atomic
def legacy_mutation(request,user,path,create_key=None):
    ledger_lock()
    user.refresh_from_db(fields=['is_active'])
    user.profile.refresh_from_db()
    require(user.is_active,'Недостатньо прав. Обліковий запис вимкнено.')
    col,_,id=path.partition('/')
    require(col in COLLECTIONS or path in SINGLE_DOCS,'Невідомий тип документа.')
    require(re.fullmatch(r'[A-Za-z0-9_-]{1,120}',id or ''),'Некоректний ID.')
    role=user.profile.role
    require(role=='owner' or col=='products' and role in {'manager','warehouse'} or col=='tasks' and role=='manager','Недостатньо прав для редагування.')
    if col=='expenses':
        from .financial_scope import require_network_owner
        require_network_owner(user)
    if path=='settings/main' and request.method=='DELETE':
        from .legacy_settings import authorize_settings_write
        authorize_settings_write(user,request.method)
    receipt=None
    if create_key is not None:
        require(re.fullmatch(r'[A-Za-z0-9_-]{16,80}',create_key or ''),'Некоректний ключ створення.')
        receipt=LegacyCreateReceipt.objects.filter(pk=create_key).first()
        if receipt:
            if receipt.author_id!=user.pk or receipt.collection!=col:
                return response({'error':'Ключ створення вже використано іншим запитом.','code':'create_key_conflict'},409)
            path=receipt.document_path
            col,_,id=path.partition('/')
    d=Document.objects.filter(pk=path).first()
    audit_kind = 'product' if col=='products' else 'budget' if col=='expenses' else 'settings' if path=='settings/main' else None
    audit_before = audit_snapshot(audit_kind, d.data if d else None) if audit_kind else None
    if d is not None and col in {'tasks','ideas'}:
        from .initiatives import reject_linked_legacy
        reject_linked_legacy(user,d,request.method)
    if col=='tasks' and d is not None:
        from .task_scope import authorize_task
        authorize_task(user,d.data)
    if col in {'tasks','ideas','expenses'} and create_key is None and (d is not None or request.method in {'PATCH','DELETE'} or request.headers.get('If-Match')):
        from .managed_alerts import task_revision
        if d is None:return response({'error':'Запис більше недоступний. Чернетка збережена.','code':'record_missing'},409)
        if not request.headers.get('If-Match'):return response({'error':'Передайте початкову версію запису.','code':'revision_required'},428)
        if request.headers['If-Match']!=task_revision(d):return response({'error':'Запис уже змінено. Чернетка збережена: узгодьте зміни.','code':'revision_conflict'},409)
    if path=='settings/main' and request.headers.get('If-Match'):
        from .labels import revision as label_revision
        if request.headers['If-Match'] != label_revision(d.data if d else {}):
            return response({'error':'Макет уже змінено. Оновіть дані перед повторним збереженням.','code':'revision_conflict'},409)
    if col=='products' and d is not None:
        # Existing products are versioned like v1; the browser runtime sends their revision.
        from .catalog import revision
        if request.method=='PUT':return response({'error':'Товар уже існує. Оновіть дані та збережіть лише змінені поля.','code':'product_exists'},409)
        if not request.headers.get('If-Match'):return response({'error':'Оновіть дані перед збереженням: потрібна версія товару.','code':'revision_required'},428)
        if request.headers['If-Match']!=revision(d):return response({'error':'Товар уже змінено. Оновіть дані перед повторним збереженням.','code':'revision_conflict'},409)
    if request.method=='DELETE':
        require(d is not None,'Запис не знайдено.')
        if col=='tasks':
            from .task_scope import delete_task
            delete_task(user,path,d.data)
        require(col!='products' or not VoucherLine.objects.filter(product=d).exists() and not StockLot.objects.filter(product=d).exists(),'Товар уже використовується в обліку. Його не можна видалити.')
        if col=='products':
            from .models import PromotionPrice
            require(not PromotionPrice.objects.filter(product=d).exists(),'Товар використовується в історії акцій. Приховайте його замість видалення.')
            from .models import RecipeVersion, RecipeComponent, ProductionInput
            require(not ProductionInput.objects.filter(product_id=path).exists(),'Товар збережено як інгредієнт виробничого документа.')
            require(not RecipeVersion.objects.filter(product_id=path).exists() and not RecipeComponent.objects.filter(product_id=path).exists(),'Товар використовується в затверджених рецептурах.')
            require(not any(any(str(r.get('product'))==id for r in p.data.get('recipe',[])) for p in Document.objects.filter(path__startswith='products/')),'Товар використовується у рецептурі.')
        LegacyCreateReceipt.objects.filter(document_path=path,deleted_at__isnull=True).update(deleted_at=timezone.now())
        d.delete()
    else:
        value=body(request)
        if path=='settings/main':
            from .legacy_settings import authorize_settings_write
            authorize_settings_write(user,request.method,value)
            if user.profile.store_id is not None:
                # PUT from a redacted DTO cannot erase hidden financial fields.
                prior=dict(d.data) if d else {}
                if 'storeNames' in value:
                    from .budget import freeze_budget
                    freeze_budget(prior)
                value={**prior,**value}
        request_fingerprint=legacy_create_fingerprint(value) if create_key is not None else None
        if receipt:
            # Re-check current privileges and the original create scope, even for an exact replay.
            if col=='tasks':
                from .task_scope import prepare_task
                prepare_task(user,path,value)
            if col=='expenses':
                from .budget import validate_expense
                validate_expense(value)
            if receipt.request_fingerprint!=request_fingerprint:
                return response({'error':'Зміст цього запиту створення вже інший. Спочатку підтвердьте початкове створення.','code':'create_payload_conflict'},409)
            if receipt.deleted_at is not None or d is None:
                return response({'error':'Запис уже було створено та видалено. Повтор не відновлює його. Щоб почати нову чернетку, очистьте поле назви.','code':'create_deleted'},409)
            if receipt.created_fingerprint!=legacy_create_fingerprint(d.data):
                return response({'error':'Запис уже створено й змінено. Перегляньте його в списку; повтор не замінює зміни. Щоб почати нову чернетку, очистьте поле назви.','code':'create_changed','id':id},409)
            return response({'ok':True,'id':id,'replayed':True})
        if create_key is not None and d is not None:
            return response({'error':'Запис уже існує. Створення не може його замінити.','code':'create_exists'},409)
        if request.method=='PUT' and d is not None and create_key is None and col in {'tasks','ideas','expenses'}:
            if col=='tasks':
                from .task_scope import alert_task
                require(not alert_task(path,d.data),'Системну задачу змінює лише її робочий процес.')
            from .legacy_records import validate_patch
            value=validate_patch(col,value,d.data)
        if request.method=='PATCH':
            require(d is not None,'Запис не знайдено.')
            if col in {'tasks','ideas','expenses'}:
                from .legacy_records import validate_patch
                if col=='tasks' and set(value)&{'scope','store'}:
                    from .task_scope import prepare_task
                    prepare_task(user,path,{**d.data,**value},d.data)
                value=validate_patch(col,value,d.data)
            prior=dict(d.data)
            if path=='settings/main' and 'storeNames' in value:
                from .budget import freeze_budget
                freeze_budget(prior)
            if col!='products':value={**prior,**value}
        if col=='tasks':
            from .task_scope import prepare_task
            value=prepare_task(user,path,value,d.data if d is not None else None)
        if col=='expenses':
            from .budget import validate_expense
            value=validate_expense(value)
        if path=='settings/main':
            from .budget import validate_settings
            from .catalog import keep_pricing_settings
            old=d.data if d is not None else {}
            value=keep_pricing_settings(validate_settings(value,old),old)
        if col=='products':
            # The v1 validator also checks barcodes and refreshes the price review date.
            from .catalog import normalise_legacy, duplicate_name, DUPLICATE_NAME
            old=d.data if d is not None else {}
            value=normalise_legacy(value,old,path)
            from .promotion_history import observe_prices
            if d is not None:observe_prices(user,[d],'legacy','Редагування товару',seed=True)
            if duplicate_name(value,old,path):return response(DUPLICATE_NAME,409)
        if create_key is not None:
            Document.objects.create(pk=path,data=value)
            LegacyCreateReceipt.objects.create(key=create_key,author=user,collection=col,document_path=path,
                request_fingerprint=request_fingerprint,created_fingerprint=legacy_create_fingerprint(value))
        else:
            Document.objects.update_or_create(pk=path,defaults={'data':value})
    if col=='products' and request.method!='DELETE':
        from .promotion_history import observe_prices
        observe_prices(user,[Document.objects.get(pk=path)],'legacy','Редагування товару')
    saved = Document.objects.filter(pk=path).first() if audit_kind else None
    audit_detail = audit_change(audit_before, audit_snapshot(audit_kind, saved.data if saved else None), observed=request.headers.get('If-Match')) if audit_kind else {}
    audit(user,'catalog_changed' if col=='products' else 'legacy_changed',path,{'method':request.method, **audit_detail})
    if path=='settings/main':
        # The next save chains from this version, not from a later poll that may carry another session's layout.
        from .labels import revision as label_revision
        saved=Document.objects.filter(pk=path).first()
        return response({'ok':True,'id':id,'revision':label_revision(saved.data if saved else {})})
    if col in {'tasks','ideas','expenses'} and request.method!='DELETE':
        from .managed_alerts import task_revision
        saved=Document.objects.get(pk=path)
        return response({'ok':True,'id':id,'revision':task_revision(saved)})
    return response({'ok':True,'id':id})

@transaction.atomic
def entity_save(user,name,value):
    ledger_lock()
    user=current_actor(user)
    allowed={'stores':Store,'warehouses':Warehouse,'parties':Counterparty,'accounts':CashAccount,'employees':Employee}
    require(name in allowed,'Невідомий довідник.')
    if name in {'stores','warehouses','accounts','employees'}:owner(user)
    else:require(user.profile.role in {'owner','manager','accountant'},'Недостатньо прав.')
    model=allowed[name]
    obj=get(model,value['id'],'Запис') if value.get('id') else model()
    # Read-directory scope also governs writes, using the actor refreshed after the ledger lock.
    # Shared counterparties have no store identity and retain their existing global contract.
    if name=='stores':
        if obj.pk:scope(user,obj)
        else:require(user.profile.store_id is None,'Нові магазини може створювати лише власник мережі.')
    elif name in {'warehouses','accounts','employees'} and obj.pk:
        scope(user,obj.store)
    if obj.pk:require_revision(obj,value.get('revision'))
    before = audit_snapshot('entity', obj) if obj.pk else None
    obj.name=str(value.get('name','')).strip()
    require(0<len(obj.name)<=160,'Вкажіть назву (до 160 символів).')
    if name in {'warehouses','accounts','employees'}:
        obj.store=get(Store,value.get('store'),'Магазин')
        scope(user,obj.store)
        if obj.pk:
            require(obj.store_id==model.objects.get(pk=obj.pk).store_id,'Магазин існуючого запису змінити не можна.')
    if name in {'parties','accounts'}:
        options={'supplier','customer'} if name=='parties' else {'cash','bank','terminal'}
        obj.kind=value.get('kind')
        require(obj.kind in options,'Виберіть тип запису.')
        if obj.pk:require(obj.kind==model.objects.get(pk=obj.pk).kind,'Тип існуючого запису змінити не можна.')
    if name=='parties':
        obj.phone=str(value.get('phone',''))[:80];obj.email=str(value.get('email',''))[:254];obj.notes=str(value.get('notes',''))[:4000]
    if name=='employees':
        obj.shift_rate=dec(value.get('shift_rate',0),'Ставка за зміну')
        obj.bonus_percent=dec(value.get('bonus_percent',0),'Відсоток',QTY)
        require(obj.bonus_percent<=100,'Відсоток не може перевищувати 100.')
        obj.bonus_basis=value.get('bonus_basis','store')
        require(obj.bonus_basis in {'store','personal','profit'},'Некоректна база нарахування.')
    if hasattr(obj,'active'):obj.active=bool(value.get('active',True))
    obj.full_clean();obj.save()
    if name=='stores':
        d=Document.objects.filter(pk='settings/main').first()
        if d:
            from .budget import freeze_budget
            prior_stores=d.data.get('stores')
            d.data=freeze_budget(dict(d.data))
            if isinstance(prior_stores,list):
                d.data['stores']=list(Store.objects.filter(active=True).order_by('pk').values_list('name',flat=True))
            d.save(update_fields=['data'])
    audit(user,'entity_saved',f'{name}/{obj.pk}',{'name':obj.name, **audit_change(before, audit_snapshot('entity', obj), observed=value.get('revision'), reason=value.get('reason'))})
    return response({'id':obj.pk})

@transaction.atomic
def shift_action(user,value):
    ledger_lock()
    user=current_actor(user)
    require(user.profile.role in {'owner','manager','cashier'},'Недостатньо прав.')
    if value.get('action')=='close':
        s=get(CashShift,value.get('id'),'Зміна');scope(user,s.store)
        require(user.profile.role!='cashier' or s.opened_by_id==user.pk,'Зміну відкрив інший касир.')
        require(not s.closed_at,'Зміну вже закрито.')
        s.expected_cash=cash_balance(s.account)
        s.counted_cash=dec(value.get('counted'),'Фактична готівка')
        s.closed_at=timezone.now();s.note=str(value.get('note',''))[:4000];s.save()
        audit(user,'shift_closed',f'shift/{s.pk}',{'expected':str(s.expected_cash),'counted':str(s.counted_cash),'difference':str(s.counted_cash-s.expected_cash)})
        # The difference is posted, so the next shift opens with the counted cash and does not inherit it.
        post_cash_difference(user,s,s.note)
    else:
        a=get(CashAccount,value.get('account'),'Каса');scope(user,a.store)
        require(a.kind=='cash','Касову зміну можна відкрити лише для готівкового рахунку.')
        require(not CashShift.objects.filter(account=a,closed_at__isnull=True).exists(),'На цій касі вже відкрита зміна.')
        e=get(Employee,value['employee'],'Працівник') if value.get('employee') else None
        require(not e or e.store_id==a.store_id,'Працівник належить іншому магазину.')
        require_active(e,'Працівник')
        s=CashShift.objects.create(account=a,store=a.store,employee=e,opened_by=user,opening_cash=cash_balance(a))
        audit(user,'shift_opened',f'shift/{s.pk}')
    return response({'id':s.pk})

@transaction.atomic
def work_shift_save(user,value):
    lock=ledger_lock()
    user=current_actor(user)
    require(user.profile.role in {'owner','accountant'},'Недостатньо прав для зарплати.')
    e=get(Employee,value.get('employee'),'Працівник');scope(user,e.store)
    key=value.get('idempotency_key')
    fingerprint=None
    if key is not None:
        require(not value.get('id') and isinstance(key,str) and bool(re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',key)), 'Ключ створення табеля має бути UUID і дозволений лише для нового запису.')
        fingerprint=request_fingerprint(user,value)
        receipt=WorkShiftCreateReceipt.objects.select_related('work_shift').filter(pk=key).first()
        if receipt:
            scope(user,receipt.work_shift.store)
            if receipt.author_id!=user.pk or receipt.fingerprint!=fingerprint:
                raise Conflict('Ключ повтору вже використано для іншого запису табеля.', 'idempotency_conflict')
            return response({'id':receipt.work_shift_id})
    d=day(value.get('date'));require(d<=timezone.localdate(),'Зміну не можна відмітити майбутнім днем.')
    require(not lock.closed_through or d>lock.closed_through,'Обліковий період закритий.')
    s=get(WorkShift,value['id'],'Зміна') if value.get('id') else WorkShift(employee=e,store=e.store,date=d)
    if not s.pk:require_active(e,'Працівник')
    require(not s.payroll_id,'Зміну вже включено в нарахування.')
    if s.pk:require_revision(s,value.get('revision'))
    before = audit_snapshot('work_shift', s) if s.pk else None
    require(not s.pk or s.employee_id==e.pk and s.date==d,'Працівника та дату існуючої зміни змінити не можна.')
    s.units=dec(value.get('units',1),'Частка зміни',CENT,minimum=CENT)
    require(s.units<=10,'Завелика кількість змін.')
    s.shift_rate=dec(value.get('shift_rate',e.shift_rate),'Ставка')
    s.bonus_percent=dec(value.get('bonus_percent',e.bonus_percent),'Відсоток',QTY)
    require(s.bonus_percent<=100,'Відсоток перевищує 100.')
    s.bonus_basis=value.get('bonus_basis',e.bonus_basis)
    require(s.bonus_basis in {'store','personal','profit'},'Некоректна база відсотка.')
    s.cash_shift=get(CashShift,value['cash_shift'],'Касова зміна') if value.get('cash_shift') else None
    require(not s.cash_shift or s.cash_shift.store_id==e.store_id,'Касова зміна належить іншому магазину.')
    if s.cash_shift:
        opened=timezone.localtime(s.cash_shift.opened_at).date()
        closed=timezone.localtime(s.cash_shift.closed_at).date() if s.cash_shift.closed_at else timezone.localdate()
        require(opened<=d<=closed,'Дата табеля не відповідає касовій зміні.')
    require(s.bonus_percent==0 or s.cash_shift is not None,'Для відсотка від виторгу виберіть касову зміну.')
    duplicate=WorkShift.objects.filter(employee=e,date=d,cash_shift=s.cash_shift).exclude(pk=s.pk).first()
    if duplicate:
        raise Conflict('За цей день уже є табель цього працівника для вибраної касової зміни. Відкрийте існуючий запис; для іншої касової зміни створіть окремий.', 'work_shift_exists', id=duplicate.pk)
    counted=WorkShift.objects.filter(employee=e,cash_shift=s.cash_shift,bonus_percent__gt=0).exclude(pk=s.pk).first() if s.cash_shift and s.bonus_percent>0 else None
    require(counted is None,f'Відсоток від виторгу касової зміни № {s.cash_shift_id} уже враховано в табелі за {counted.date.isoformat()}. Для цього дня залиште лише ставку (відсоток 0).' if counted else '')
    s.note=str(value.get('note',''))[:2000];s.full_clean();s.save()
    audit(user,'work_shift_saved',f'work_shift/{s.pk}',{'rate':str(s.shift_rate),'percent':str(s.bonus_percent),'basis':s.bonus_basis, **audit_change(before, audit_snapshot('work_shift', s), observed=value.get('revision'), reason=value.get('reason'))})
    if key is not None:
        WorkShiftCreateReceipt.objects.create(key=key,author=user,work_shift=s,fingerprint=fingerprint)
    return response({'id':s.pk})

def portal(request):
    try:
        return handle(request)
    except Conflict as exc:
        return response({'error':str(exc),'code':exc.code,**exc.extra},409)
    except BusinessError as exc:
        status=401 if request.portal_user is None and request.path!='/api/login' else 400
        if 'прав' in str(exc) or 'роль' in str(exc) or 'доступ' in str(exc) or 'не підтверджений' in str(exc):status=403
        return response({'error':str(exc)},status)
    except ValidationError as exc:
        return response({'error':' '.join(exc.messages)},400)
    except IntegrityError:
        return response({'error':'Запис уже існує або використовується в обліку.'},409)
    except (TypeError,ValueError):
        logging.getLogger(__name__).warning('Malformed request data: %s %s',request.method,request.path,exc_info=True)
        return response({'error':'Некоректні дані запиту.'},400)

def handle(request):
    path=request.path
    if path=='/health' and request.method in {'GET','HEAD'}:
        LedgerLock.objects.get(pk=1)
        from .service_health import import_worker_status
        return response({'status':'ok','storage':'relational','version':'crm-2','release':RELEASE,'imports':import_worker_status()})
    if path=='/favicon.svg':return HttpResponse(FAVICON,content_type='image/svg+xml')
    if path=='/ui.css' and request.method in {'GET','HEAD'}:
        return HttpResponse((ROOT/'app/ui.css').read_bytes(),content_type='text/css')
    if path=='/api/login' and request.method=='POST':
        value=body(request)
        require(request.headers.get('Origin') in {f'http://{request.get_host()}',f'https://{request.get_host()}'},'Непідтверджений запит входу.')
        username=str(value.get('username',''))
        remote=request.META.get('REMOTE_ADDR','unknown')
        forwarded=request.headers.get('X-Forwarded-For','').split(',')[0].strip()
        if request.META.get('HTTP_X_FORWARDED_PROTO'):remote=forwarded or remote
        bucket_keys=[hashlib.sha256(('user:'+username).encode()).hexdigest(),hashlib.sha256(('ip:'+remote).encode()).hexdigest()]
        # A browser that already signed in as this user skips the username-wide lockout; the IP bucket still applies.
        trusted=trusted_device(request,username)
        now=int(time.time())
        with transaction.atomic():
            for key in bucket_keys[1:] if trusted else bucket_keys:
                throttle,_=LoginThrottle.objects.get_or_create(pk=key,defaults={'until':now+900})
                throttle=LoginThrottle.objects.select_for_update().get(pk=key)
                if throttle.until<=now:throttle.attempts=0;throttle.until=now+900
                if throttle.attempts>=15:return response({'error':'Забагато спроб входу. Повторіть через 15 хвилин.'},429)
                # Reserved under the row lock for concurrent attempts; refunded below on success, so only failures count.
                if key==bucket_keys[0]:throttle.attempts+=1
                throttle.save()
        u=User.objects.filter(username=username,is_active=True).first()
        if not u or not user_valid(u,str(value.get('password',''))):
            LoginThrottle.objects.filter(pk=bucket_keys[1]).update(attempts=F('attempts')+1)
            time.sleep(.3)
            return response({'error':'Невірний логін або пароль'},401)
        if not trusted:LoginThrottle.objects.filter(pk=bucket_keys[0],attempts__gt=0).update(attempts=F('attempts')-1)
        LoginThrottle.objects.filter(until__lt=int(time.time())).delete()
        token,csrf=secrets.token_urlsafe(32),secrets.token_urlsafe(32)
        PortalSession.objects.filter(expires__lt=int(time.time())).delete()
        PortalSession.objects.create(user=u,token_hash=hashlib.sha256(token.encode()).hexdigest(),csrf=csrf,expires=int(time.time())+7*86400)
        result=response({'ok':True})
        result.set_cookie('ts_session',token,max_age=7*86400,httponly=True,secure=request.is_secure(),samesite='Strict')
        result.set_cookie(DEVICE_COOKIE,signing.dumps(u.username,salt=DEVICE_SALT),max_age=DEVICE_AGE,httponly=True,secure=request.is_secure(),samesite='Strict')
        return result
    if path=='/' and request.method in {'GET','HEAD'}:
        if not request.portal_user:return HttpResponse(LOGIN_HTML)
        html=(ROOT/'app/index.html').read_text().replace('<script src="/portal.js">','<script src="/monthly-budget.js"></script><script src="/legacy-record-editor.js"></script><script src="/portal.js">',1).replace('<link rel="stylesheet" href="/ui.css">','<link rel="stylesheet" href="/initiatives.css"><link rel="stylesheet" href="/erp.css"><link rel="stylesheet" href="/ui.css">',1).replace('<script src="/ui.js">','<script src="/portal-api.js"></script><script src="/runtime.js"></script><script src="/managed-alerts.js"></script><script src="/erp-browse.js"></script><script src="/erp-shifts.js"></script><script src="/erp-finance.js"></script><script src="/erp-payments.js"></script><script src="/erp-orders.js"></script><script src="/erp-production.js"></script><script src="/reconciliation.js"></script><script src="/erp-directories.js"></script><script src="/erp-reports.js"></script><script src="/erp.js"></script><script src="/initiatives.js"></script><script src="/ui.js">',1)
        manifest_file=ROOT/'frontend/dist/.vite/manifest.json'
        if manifest_file.exists():
            manifest=json.loads(manifest_file.read_text())
            styles=set()
            scripts=[]
            def collect_styles(key):
                entry=manifest.get(key,{})
                styles.update(entry.get('css',[]))
                for chunk in entry.get('imports',[]): collect_styles(chunk)
            for key in ['src/catalog-entry.tsx','src/labels-entry.tsx','src/customers-entry.tsx','src/native-conflict-entry.tsx','src/trading-entry.tsx']:
                collect_styles(key)
                if manifest.get(key,{}).get('file'): scripts.append('<script type="module" src="/frontend/'+manifest[key]['file']+'" onerror="window.dispatchEvent(new CustomEvent(\'tsukenya:module-unavailable\',{detail:\''+key.split('/')[1].split('-')[0]+'\'}))"></script>')
            html=html.replace('</head>',''.join('<link rel="stylesheet" href="/frontend/'+name+'">' for name in sorted(styles))+'</head>').replace('</body>',''.join(scripts)+'</body>')
        return HttpResponse(html)
    if path=='/account' and not request.portal_user:
        result=HttpResponse(status=302);result['Location']='/';return result
    user=auth(request)
    if path.startswith('/api/v1/portal/'):
        from .portal_api import handle_portal
        return handle_portal(request,user)
    if path in {'/api/v1/trading/reports/summary','/api/v1/trading/reports/rows','/api/v1/trading/reports/export.csv'} and request.method=='GET':
        from . import bounded_reports
        require(user.profile.role in bounded_reports.ROLES,'Недостатньо прав для фінансових звітів.')
        if path.endswith('/export.csv'): return bounded_reports.export_csv(user,request.GET)
        return response(bounded_reports.rows(user,request.GET) if path.endswith('/rows') else bounded_reports.summary(user,request.GET))
    if path.startswith('/api/v1/'):
        if path.startswith('/api/v1/trading/'):
            from .directories import handle as handle_directories
            return handle_directories(request,user)
        if path.startswith('/api/v1/crm/'):
            from .customers import handle_customers
            return handle_customers(request,user)
        if path.startswith('/api/v1/promotions/'):
            from .promotions import handle_promotions
            return handle_promotions(request,user)
        if path.startswith('/api/v1/labels/'):
            from .labels import handle_labels
            return handle_labels(request,user)
        from .catalog import handle_catalog
        return handle_catalog(request,user)
    if path.startswith('/frontend/assets/') and request.method in {'GET','HEAD'}:
        file=(ROOT/'frontend/dist'/path[len('/frontend/'):]).resolve()
        base=(ROOT/'frontend/dist/assets').resolve()
        if not file.is_relative_to(base) or not file.is_file():return HttpResponse(status=404)
        return HttpResponse(file.read_bytes(),content_type='text/css' if file.suffix=='.css' else 'text/javascript')
    if path=='/account':return HttpResponse(ACCOUNT_HTML.replace('Змінити пароль власника','Змінити пароль'))
    if path in {'/runtime.js','/legacy-record-editor.js','/portal-api.js','/managed-alerts.js','/csv.js','/catalog-import.js','/catalog-import-jobs.js','/catalog-pricing.js','/erp-browse.js','/erp-shifts.js','/erp-finance.js','/erp-payments.js','/monthly-budget.js','/erp-orders.js','/erp-production.js','/reconciliation.js','/erp-directories.js','/erp-reports.js','/erp.js','/erp.css','/initiatives.js','/initiatives.css','/portal.js','/combobox.js','/portal.css','/ui.js','/ui.css','/workspace.css'} and request.method in {'GET','HEAD'}:
        f=ROOT/('server/runtime.js' if path=='/runtime.js' else 'app'+path)
        return HttpResponse(f.read_bytes(),content_type='text/css' if path.endswith('.css') else 'text/javascript')
    if path=='/api/state' and request.method=='GET':
        from .state_polling import state_response
        return state_response(request,user,legacy_state)
    if path=='/api/logout' and request.method=='POST':
        request.portal_session.delete();result=response({'ok':True});result.delete_cookie('ts_session');return result
    if path=='/api/account/password' and request.method=='POST':
        value=body(request)
        require(user_valid(user,str(value.get('current',''))),'Поточний пароль неправильний.')
        password=str(value.get('new',''));require(14<=len(password)<=256,'Новий пароль має містити від 14 до 256 символів.')
        with transaction.atomic():
            if user.username==OWNER:Setting.objects.update_or_create(pk='owner_password',defaults={'value':hash_password(password)})
            else:user.set_password(password);user.save(update_fields=['password'])
            PortalSession.objects.filter(user=user).delete()
            audit(user,'password_changed',f'user/{user.pk}')
        result=response({'ok':True});result.delete_cookie('ts_session');return result
    if path.startswith('/api/docs/') and request.method in {'PUT','PATCH','DELETE'}:
        return legacy_mutation(request,user,path[len('/api/docs/'):])
    if path.startswith('/api/') and path[5:] in COLLECTIONS and request.method=='POST':
        col=path[5:];id=secrets.token_urlsafe(18).replace('-','_')
        return legacy_mutation(request,user,col+'/'+id,request.headers.get('Idempotency-Key') if col in {'tasks','ideas','expenses'} else None)
    match=re.fullmatch(r'/api/erp/alerts/tasks/((?:auto_|reprint_)[a-f0-9]{32})/actions',path)
    if match and request.method=='POST':
        from .managed_alerts import action
        return action(request,user,match[1])
    if path=='/api/erp/alerts' and request.method=='POST':
        require(user.profile.role in {'owner','manager'},'Недостатньо прав.')
        from .alerts import run_alerts
        return response(run_alerts(user,'manual'))
    if path=='/api/erp/state' and request.method=='GET':return response(state(user))
    if path=='/api/erp/import-preview' and request.method=='POST':
        require(user.profile.role in {'owner','manager','warehouse'},'Недостатньо прав.')
        text=str(body(request).get('csv','')).lstrip('\ufeff')
        require(0<len(text)<=200000,'CSV порожній або завеликий.')
        from .csv_format import read_rows
        headers,reader=read_rows(text)
        require(headers and {'ID','Кількість','Ціна'}.issubset(headers),'Потрібні колонки ID, Кількість, Ціна. Роздільник — крапка з комою або кома.')
        rows=[];seen=set()
        for index,row in reader:
            if not any(row.values()) or not (row.get('Кількість') or '').strip():continue
            product_id=(row.get('ID') or '').strip();product=get(Document,'products/'+product_id,f'Рядок {index}, товар')
            require(product_id not in seen,f'Рядок {index}: повторний ID товару.');seen.add(product_id)
            qty=dec(row.get('Кількість'),'Кількість',QTY);price=dec(row.get('Ціна'),'Ціна',Decimal('.0001'))
            expiry=(row.get('Придатний до') or '').strip()
            if expiry:day(expiry)
            rows.append({'product':product_id,'name':product.data.get('name',''),'quantity':str(qty),'price':str(price),'lot':(row.get('Партія') or '').strip(),'expiry':expiry})
            require(len(rows)<=200,'В одному документі може бути не більше 200 товарів.')
        require(rows,'У CSV немає товарних рядків.')
        return response({'lines':rows})
    if path.startswith('/api/erp/recipes/versions'):
        from .recipes_versions import handle_versions
        return handle_versions(request,user)
    if path=='/api/erp/recipes' and request.method in {'GET','POST'}:
        require(user.profile.role in {'owner','manager','warehouse'},'Недостатньо прав для рецептур.')
        from .catalog import revision
        if request.method=='GET':
            product=Document.objects.filter(pk='products/'+str(request.GET.get('product',''))).first()
            if product is None:return response({'error':'Готовий товар: запис не знайдено.'},404)
            return response({'product':{'id':product.path.split('/',1)[1],'name':product.data.get('name',''),'unit':product.data.get('unit','шт')},'recipe':product.data.get('recipe',[]),'revision':revision(product)})
        value=body(request)
        require(isinstance(value.get('revision'),str) and value['revision'],'Оновіть рецептуру перед збереженням: потрібна версія товару.')
        with transaction.atomic():
            ledger_lock();user=current_actor(user);require(user.profile.role in {'owner','manager','warehouse'},'Недостатньо прав для рецептур.');product=get(Document,'products/'+str(value.get('product')),'Готовий товар')
            if value['revision']!=revision(product):return response({'error':'Товар уже змінено. Оновіть рецептуру перед повторним збереженням.','code':'revision_conflict'},409)
            # A recipe never changes price terms, so an older discount does not block it.
            data={**product.data,'recipe':value.get('recipe',[])};validate_product(data,product.pk,check_promotion=False)
            require(len({str(row.get('product')) for row in data['recipe']})==len(data['recipe']),'Інгредієнт не може повторюватись.')
            product.data=data;product.save(update_fields=['data']);audit(user,'recipe_saved',product.pk,{'recipe':data['recipe']})
            saved_revision=revision(product)
        return response({'ok':True,'revision':saved_revision})
    if path=='/api/erp/replenishment' and request.method=='GET':
        from .replenishment import replenishment
        return response(replenishment(user))
    if path=='/api/erp/assortment' and request.method in {'GET','POST'}:
        from .assortment import assortment, save_assortment
        return response(assortment(user,request.GET) if request.method=='GET' else save_assortment(user,body(request)))
    if path in {'/api/erp/stock','/api/erp/stock.csv'} and request.method=='GET':
        from .stock_browsing import stock_page, stock_csv
        return stock_csv(user,request.GET) if path.endswith('.csv') else response(stock_page(user,request.GET))
    if path=='/api/erp/report/drilldown' and request.method=='GET':
        from .report_drilldown import drilldown
        return response(drilldown(user,request.GET))
    if path=='/api/erp/report' and request.method=='GET':
        require(user.profile.role in {'owner','manager','accountant'},'Недостатньо прав для фінансових звітів.')
        return response(report(user,request.GET))
    if path=='/api/erp/ledger' and request.method=='GET':
        from .financial_browsing import ledger
        return response(ledger(user,request.GET))
    if path.startswith('/api/erp/budget-categories') or path.startswith('/api/erp/monthly-budgets'):
        from . import monthly_budgets as budgets
        if user.profile.role not in {'owner','manager','accountant'}:return response({'error':'Недостатньо прав.'},403)
        if path=='/api/erp/budget-categories':
            if request.method=='GET':return response(budgets.categories(user))
            if request.method=='POST':
                if user.profile.role!='owner':return response({'error':'Лише власник може змінювати статті.'},403)
                return response(budgets.save_category(user,body(request)),201)
        match=re.fullmatch(r'/api/erp/budget-categories/([0-9a-fA-F-]{36})',path)
        if match and request.method=='PUT':
            if user.profile.role!='owner':return response({'error':'Лише власник може змінювати статті.'},403)
            return response(budgets.save_category(user,body(request),match[1]))
        if path.startswith('/api/erp/monthly-budgets'):
            if user.profile.role!='owner':return response({'error':'Бюджет доступний лише власнику.'},403)
            if path=='/api/erp/monthly-budgets':
                if request.method=='GET':return response(budgets.view(user,request.GET))
                if request.method=='POST':return response(budgets.save(user,body(request)),201)
            match=re.fullmatch(r'/api/erp/monthly-budgets/([0-9a-fA-F-]{36})',path)
            if match and request.method=='PUT':return response(budgets.save(user,body(request),match[1]))
        return response({'error':'Невідомий маршрут бюджету.'},404)
    if path=='/api/erp/budget-fact' and request.method=='GET':
        from .budget import budget_fact
        return response(budget_fact(user,request.GET))
    if path=='/api/erp/debts/summary' and request.method=='GET':
        from .financial_browsing import debt_summary
        return response(debt_summary(user))
    if path=='/api/erp/debts' and request.method=='GET':
        from .financial_browsing import debts
        return response(debts(user,request.GET))
    if path in {'/api/erp/advances','/api/erp/party-statement'} and request.method=='GET':
        if user.profile.role not in {'owner','manager','accountant'}:return response({'error':'Недостатньо прав для фінансових даних.'},403)
        from .party_finance import advances, statement
        return response((advances if path.endswith('/advances') else statement)(user,request.GET))
    if path=='/api/erp/initiatives':
        from .initiatives import list_projects,mutate
        if request.method=='GET':return response(list_projects(user,request.GET))
        require(request.method=='POST','Метод не підтримується.');return response(mutate(user,body(request)),201)
    if path=='/api/erp/initiatives/options' and request.method=='GET':
        from .initiatives import options
        return response(options(user,request.GET))
    initiative_idea=re.fullmatch(r'/api/erp/initiatives/ideas/([A-Za-z0-9_-]{1,120})',path)
    if initiative_idea and request.method=='GET':
        from .initiatives import idea_info
        from .historical_reports import read_snapshot
        with read_snapshot():return response(idea_info(user,initiative_idea[1]))
    initiative_match=re.fullmatch(r'/api/erp/initiatives/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(/candidates|/sources)?',path)
    if initiative_match:
        from .initiatives import detail,candidates,source_detail,mutate
        if request.method=='GET':return response(({'/candidates':candidates,'/sources':source_detail}.get(initiative_match[2],detail))(user,initiative_match[1],request.GET))
        require(request.method=='POST' and not initiative_match[2],'Метод не підтримується.');return response(mutate(user,body(request),initiative_match[1]))
    if path.startswith('/api/erp/reconciliation-runs'):
        from . import reconcile_journal as journal
        require(request.method=='GET','Журнал звірки доступний лише для читання.')
        from .historical_reports import read_snapshot
        with read_snapshot():
            if path=='/api/erp/reconciliation-runs':return response(journal.runs(user,request.GET))
            match=re.fullmatch(r'/api/erp/reconciliation-runs/([0-9a-fA-F-]{36})(/issues)?',path)
            require(match is not None,'Некоректна адреса журналу звірки.')
            return response(journal.findings(user,match[1],request.GET) if match[2] else journal.run_json(journal.detail(user,match[1])))
    if path=='/api/erp/references' and request.method=='GET':
        from .browsing import references
        return response(references(user,request.GET))
    order_match=re.fullmatch(r'/api/erp/orders/(\d+)',path)
    if order_match:
        from .orders import order_json,mutate,ORDER_KINDS,reserve_limits
        if request.method=='GET':
            from .historical_reports import read_snapshot
            from .browsing import page_number
            with read_snapshot():
                order=get(Voucher,order_match[1],'Замовлення');scope(user,order.store);permission(user,order.kind);require(order.kind in ORDER_KINDS,'Це не замовлення.')
                return response({'id':order.pk,'order':order_json(order,user,page_number(request.GET)),**({'limits':reserve_limits(order,user)} if request.GET.get('purpose')=='reserve' else {})})
        require(request.method=='POST','Метод не підтримується.');return response(mutate(user,order_match[1],body(request)))
    if path=='/api/erp/vouchers':
        if request.method=='POST':return response(voucher_json(save_voucher(user,body(request)),True,user=user),201)
        require(request.method=='GET','Метод не підтримується.')
        from .browsing import page_number, page_bounds, filter_search, positive_integer, PAGE_SIZE
        qs=scoped(Voucher.objects.select_related('created_by'),user)
        qs=qs.filter(kind__in=ROLE_KINDS[user.profile.role])
        if user.profile.role not in {'owner','accountant'}:qs=qs.exclude(kind='expense',payload__expense_scope='network')
        if request.GET.get('kind'):qs=qs.filter(kind__in=request.GET['kind'].split(','))
        if request.GET.get('status'):qs=qs.filter(status=request.GET['status'])
        if request.GET.get('party'):
            party_id=positive_integer(request.GET['party'],'ID контрагента')
            qs=qs.filter(Q(party_id=party_id) | Q(kind='customer_return',reference__kind='sale',reference__party_id=party_id,reference__store_id=F('store_id')))
        if request.GET.get('store'):qs=qs.filter(store_id=positive_integer(request.GET['store'],'ID магазину'))
        qs=filter_search(qs,request.GET)
        total=qs.count();page,pages,offset=page_bounds(total,page_number(request.GET))
        from .browsing import with_settlements
        rows=with_settlements(qs.order_by('-pk')[offset:offset+PAGE_SIZE])
        return response({'items':[voucher_json(v,user=user,settlements=v.browse_settlements,allocations=v.browse_allocations) for v in rows],'total':total,'page':page,'pages':pages})
    match=re.fullmatch(r'/api/erp/vouchers/(\d+)(?:/(post|reverse))?',path)
    if match:
        pk,action=match.groups();v=get(Voucher,pk,'Документ');scope(user,v.store);permission(user,v.kind)
        if action=='post' and request.method=='POST':
            value=body(request)
            observed={'expected_revision':value['revision']} if 'revision' in value else {}
            return response(voucher_json(post_voucher(user,pk,**observed),True,user=user))
        if action=='reverse' and request.method=='POST':return response(voucher_json(reverse_voucher(user,pk,body(request).get('reason','')),True,user=user))
        if not action and request.method=='GET':
            expense_permission(user,v)
            return response(voucher_json(v,True,user=user))
        if not action and request.method=='PUT':return response(voucher_json(save_voucher(user,body(request),pk),True,user=user))
        if not action and request.method=='DELETE':
            with transaction.atomic():
                ledger_lock();user=current_actor(user);v.refresh_from_db();scope(user,v.store);permission(user,v.kind);expense_permission(user,v);require(v.status=='draft','Видалити можна тільки чернетку.')
                value=body(request)
                if 'revision' in value:require_voucher_revision(v,value['revision'])
                audit(user,'draft_deleted',f'voucher/{pk}',audit_change(audit_snapshot('voucher', v), None, observed=value.get('revision')));v.delete()
            return response({'ok':True})
    match=re.fullmatch('/api/erp/entities/(stores|warehouses|parties|accounts|employees)',path)
    if match and request.method=='POST':return entity_save(user,match[1],body(request))
    if path=='/api/erp/shifts' and request.method=='POST':return shift_action(user,body(request))
    if path=='/api/erp/work-shifts' and request.method=='POST':return work_shift_save(user,body(request))
    if path=='/api/erp/shifts' and request.method=='GET':
        from .shift_browsing import cash_shifts
        return response(cash_shifts(user,request.GET))
    if path=='/api/erp/work-shifts' and request.method=='GET':
        from .shift_browsing import work_shifts
        return response(work_shifts(user,request.GET))
    if path=='/api/erp/period' and request.method=='POST':
        owner(user);value=body(request)
        with transaction.atomic():
            lock=ledger_lock();user=current_actor(user);owner(user);lock.closed_through=day(value['date']) if value.get('date') else None
            require(str(value.get('reason','')).strip(),'Вкажіть причину зміни періоду.')
            require(not lock.closed_through or lock.closed_through<timezone.localdate(),'Закривати можна лише завершені дні.')
            require(not lock.closed_through or not Voucher.objects.filter(status='draft',date__lte=lock.closed_through).exists(),'У періоді є чернетки. Проведіть або видаліть їх.')
            lock.save();audit(user,'period_changed','ledger',{'date':value.get('date'),'reason':str(value.get('reason',''))[:4000]})
        return response({'ok':True})
    if path=='/api/erp/users':
        owner(user)
        if request.method=='GET':return response({'users':list(User.objects.select_related('profile').values('id','username','is_active','profile__role','profile__store_id'))})
        if request.method=='POST':
            value=body(request);name=str(value.get('username','')).strip()
            require(re.fullmatch('[A-Za-z0-9_.-]{3,80}',name),'Логін: 3–80 латинських символів, цифри, крапка або дефіс.')
            role=value.get('role');require(role in ROLE_KINDS and role!='owner','Виберіть роль працівника.')
            with transaction.atomic():
                ledger_lock();user=current_actor(user);owner(user)
                u=get(User,value['id'],'Користувач') if value.get('id') else User(username=name)
                require(u.username!=OWNER,'Власника редагуйте через обліковий запис.')
                if not u.pk or value.get('password'):
                    password=str(value.get('password',''));require(14<=len(password)<=256,'Пароль: від 14 до 256 символів.');u.set_password(password)
                u.is_active=bool(value.get('active',True));u.save()
                Profile.objects.update_or_create(user=u,defaults={'role':role,'store':get(Store,value['store'],'Магазин') if value.get('store') else None})
                PortalSession.objects.filter(user=u).delete();audit(user,'user_saved',f'user/{u.pk}',{'role':role,'active':u.is_active})
            return response({'id':u.pk})
    if path=='/api/erp/audit' and request.method=='GET':
        from .financial_browsing import audit_events
        return response(audit_events(user,request.GET))
    if path=='/api/erp/fiscal' and request.method=='POST':
        owner(user);value=body(request)
        with transaction.atomic():
            ledger_lock();user=current_actor(user);owner(user)
            Setting.objects.update_or_create(pk='fiscal_required',defaults={'value':'true' if value.get('required') else 'false'});audit(user,'fiscal_mode_changed','settings',{'required':bool(value.get('required'))})
        return response({'ok':True})
    if path=='/api/erp/discount-limit' and request.method=='POST':
        owner(user);value=body(request)
        try:percent=Decimal(str(value.get('percent')).replace(',','.'))
        except InvalidOperation:percent=Decimal(-1)
        require(percent.is_finite() and 0<=percent<=100 and percent==percent.quantize(Decimal('.01')),'Максимальна знижка касира — число від 0 до 100 із не більше ніж двома знаками після коми.')
        with transaction.atomic():
            ledger_lock();user=current_actor(user);owner(user);old=discount_limit()
            Setting.objects.update_or_create(pk=DISCOUNT_KEY,defaults={'value':str(percent)});audit(user,'discount_limit_changed','settings',{'old':percent_text(old),'new':percent_text(percent)})
        return response({'percent':percent_text(percent)})
    return response({'error':'Сторінку не знайдено.'},404)
