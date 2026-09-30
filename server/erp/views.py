import hashlib
import hmac
import json
import os
import csv
import io
from decimal import Decimal, ROUND_CEILING
import re
import secrets
import time
from pathlib import Path
from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.db import transaction, IntegrityError
from django.db.models import Sum, F
from django.utils import timezone
from django.core.exceptions import ValidationError
from django.contrib.auth.hashers import check_password, make_password
from server.auth import LOGIN_HTML, ACCOUNT_HTML, FAVICON, hash_password, valid_password
from .models import *
from .services import *
from .reporting import state, stock, report, voucher_json, scoped

COLLECTIONS={'tasks','ideas','products','expenses'}
SINGLE_DOCS={'settings/main','project/state'}
ROOT=settings.BASE_DIR
OWNER=os.environ.get('OWNER_USERNAME','pavlo')


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

def auth(request):
    require(request.portal_user is not None,'Сеанс завершився. Увійдіть знову.')
    if request.method not in {'GET','HEAD'}:
        origin=request.headers.get('Origin','')
        host=request.get_host()
        require(origin in {f'https://{host}',f'http://{host}'} and hmac.compare_digest(request.headers.get('X-CSRF-Token',''),request.portal_session.csrf),'Запит не підтверджений. Оновіть сторінку й повторіть.')
    return request.portal_user

def owner(user):
    require(user.profile.role=='owner','Недостатньо прав. Операція доступна лише власнику.')

def legacy_state(user):
    data={x:[] for x in COLLECTIONS}|{x:{} for x in SINGLE_DOCS}
    for d in Document.objects.all():
        col,_,id=d.path.partition('/')
        if col in COLLECTIONS:
            if user.profile.role!='owner' and (col=='expenses' or col in {'tasks','ideas'} and d.data.get('scope')!='operations'):
                continue
            product=dict(d.data)
            if col=='products' and user.profile.role=='cashier':
                config=Document.objects.filter(pk='settings/main').first()
                config=config.data if config else {}
                rounding=Decimal(str(config.get('rounding',.5)))
                require(rounding>0,'Некоректне округлення ціни.')
                if not product.get('manualPrice') or product.get('price') is None:
                    raw=Decimal(str(product.get('cost',0)))*(1+Decimal(str(product.get('markup',config.get('defaultMarkup',30))))/100)
                    product['price']=float((raw/rounding).to_integral_value(rounding=ROUND_CEILING)*rounding)
                    product['manualPrice']=True
                product.pop('cost',None);product.pop('markup',None)
            data[col].append({'id':id,'data':product})
        elif d.path in SINGLE_DOCS:data[d.path]=d.data
    return data

def validate_product(data, path=None):
    require(isinstance(data.get('name'),str) and 0<len(data['name'].strip())<=250,'Вкажіть назву товару (до 250 символів).')
    if 'minStock' in data:dec(data['minStock'],'Мінімальний залишок',QTY)
    barcode=str(data.get('barcode','')).strip()
    require(len(barcode)<=80,'Штрихкод задовгий.')
    recipe=data.get('recipe',[])
    require(isinstance(recipe,list) and len(recipe)<=100,'Некоректна рецептура.')
    for row in recipe:
        require(isinstance(row,dict),'Некоректний інгредієнт.')
        ingredient=get(Document,'products/'+str(row.get('product')),'Інгредієнт')
        require(not path or ingredient.pk!=path,'Готовий товар не може бути власним інгредієнтом.')
        dec(row.get('quantity'),'Кількість інгредієнта',QTY,minimum=QTY)

@transaction.atomic
def legacy_mutation(request,user,path):
    ledger_lock()
    col,_,id=path.partition('/')
    require(col in COLLECTIONS or path in SINGLE_DOCS,'Невідомий тип документа.')
    require(re.fullmatch(r'[A-Za-z0-9_-]{1,120}',id or ''),'Некоректний ID.')
    role=user.profile.role
    require(role=='owner' or col=='products' and role in {'manager','warehouse'} or col=='tasks' and role=='manager','Недостатньо прав для редагування.')
    d=Document.objects.filter(pk=path).first()
    if request.method=='DELETE':
        require(d is not None,'Запис не знайдено.')
        require(col!='products' or not VoucherLine.objects.filter(product=d).exists() and not StockLot.objects.filter(product=d).exists(),'Товар уже використовується в обліку. Його не можна видалити.')
        if col=='products':
            require(not any(any(str(r.get('product'))==id for r in p.data.get('recipe',[])) for p in Document.objects.filter(path__startswith='products/')),'Товар використовується у рецептурі.')
        d.delete()
    else:
        value=body(request)
        if request.method=='PATCH':
            require(d is not None,'Запис не знайдено.')
            value={**d.data,**value}
        if col=='products':
            validate_product(value,path)
            barcode=str(value.get('barcode','')).strip()
            require(not barcode or not Document.objects.filter(path__startswith='products/').exclude(pk=path).filter(data__barcode=barcode).exists(),'Цей штрихкод уже використовується.')
        Document.objects.update_or_create(pk=path,defaults={'data':value})
    audit(user,'catalog_changed' if col=='products' else 'legacy_changed',path,{'method':request.method})
    return response({'ok':True,'id':id})

@transaction.atomic
def entity_save(user,name,value):
    ledger_lock()
    allowed={'stores':Store,'warehouses':Warehouse,'parties':Counterparty,'accounts':CashAccount,'employees':Employee}
    require(name in allowed,'Невідомий довідник.')
    if name in {'stores','warehouses','accounts','employees'}:owner(user)
    else:require(user.profile.role in {'owner','manager','accountant'},'Недостатньо прав.')
    model=allowed[name]
    obj=get(model,value['id'],'Запис') if value.get('id') else model()
    obj.name=str(value.get('name','')).strip()
    require(0<len(obj.name)<=160,'Вкажіть назву (до 160 символів).')
    if name in {'warehouses','accounts','employees'}:
        obj.store=get(Store,value.get('store'),'Магазин')
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
            d.data={**d.data,'stores':list(Store.objects.filter(active=True).order_by('pk').values_list('name',flat=True))}
            d.save(update_fields=['data'])
    audit(user,'entity_saved',f'{name}/{obj.pk}',{'name':obj.name})
    return response({'id':obj.pk})

@transaction.atomic
def shift_action(user,value):
    ledger_lock()
    require(user.profile.role in {'owner','manager','cashier'},'Недостатньо прав.')
    if value.get('action')=='close':
        s=get(CashShift,value.get('id'),'Зміна');scope(user,s.store)
        require(user.profile.role!='cashier' or s.opened_by_id==user.pk,'Зміну відкрив інший касир.')
        require(not s.closed_at,'Зміну вже закрито.')
        s.expected_cash=cash_balance(s.account)
        s.counted_cash=dec(value.get('counted'),'Фактична готівка')
        s.closed_at=timezone.now();s.note=str(value.get('note',''))[:4000];s.save()
        audit(user,'shift_closed',f'shift/{s.pk}',{'expected':str(s.expected_cash),'counted':str(s.counted_cash),'difference':str(s.counted_cash-s.expected_cash)})
    else:
        a=get(CashAccount,value.get('account'),'Каса');scope(user,a.store)
        require(a.kind=='cash','Касову зміну можна відкрити лише для готівкового рахунку.')
        require(not CashShift.objects.filter(account=a,closed_at__isnull=True).exists(),'На цій касі вже відкрита зміна.')
        e=get(Employee,value['employee'],'Працівник') if value.get('employee') else None
        require(not e or e.store_id==a.store_id,'Працівник належить іншому магазину.')
        s=CashShift.objects.create(account=a,store=a.store,employee=e,opened_by=user,opening_cash=cash_balance(a))
        audit(user,'shift_opened',f'shift/{s.pk}')
    return response({'id':s.pk})

@transaction.atomic
def work_shift_save(user,value):
    owner_or_accountant=user.profile.role in {'owner','accountant'}
    require(owner_or_accountant,'Недостатньо прав для зарплати.')
    lock=ledger_lock()
    e=get(Employee,value.get('employee'),'Працівник');scope(user,e.store)
    d=day(value.get('date'));require(d<=timezone.localdate(),'Зміну не можна відмітити майбутнім днем.')
    require(not lock.closed_through or d>lock.closed_through,'Обліковий період закритий.')
    s=get(WorkShift,value['id'],'Зміна') if value.get('id') else WorkShift(employee=e,store=e.store,date=d)
    require(not s.payroll_id,'Зміну вже включено в нарахування.')
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
    s.note=str(value.get('note',''))[:2000];s.full_clean();s.save()
    audit(user,'work_shift_saved',f'work_shift/{s.pk}',{'rate':str(s.shift_rate),'percent':str(s.bonus_percent),'basis':s.bonus_basis})
    return response({'id':s.pk})

def portal(request):
    try:
        return handle(request)
    except BusinessError as exc:
        status=401 if request.portal_user is None and request.path!='/api/login' else 400
        if 'прав' in str(exc) or 'роль' in str(exc) or 'доступ' in str(exc) or 'не підтверджений' in str(exc):status=403
        return response({'error':str(exc)},status)
    except ValidationError as exc:
        return response({'error':' '.join(exc.messages)},400)
    except IntegrityError:
        return response({'error':'Запис уже існує або використовується в обліку.'},409)

def handle(request):
    path=request.path
    if path=='/health' and request.method in {'GET','HEAD'}:
        LedgerLock.objects.get(pk=1)
        return response({'status':'ok','storage':'relational','version':'crm-2'})
    if path=='/favicon.svg':return HttpResponse(FAVICON,content_type='image/svg+xml')
    if path=='/api/login' and request.method=='POST':
        value=body(request)
        require(request.headers.get('Origin') in {f'http://{request.get_host()}',f'https://{request.get_host()}'},'Непідтверджений запит входу.')
        username=str(value.get('username',''))
        remote=request.META.get('REMOTE_ADDR','unknown')
        forwarded=request.headers.get('X-Forwarded-For','').split(',')[0].strip()
        if request.META.get('HTTP_X_FORWARDED_PROTO'):remote=forwarded or remote
        bucket_keys=[hashlib.sha256(('user:'+username).encode()).hexdigest(),hashlib.sha256(('ip:'+remote).encode()).hexdigest()]
        now=int(time.time())
        with transaction.atomic():
            for key in bucket_keys:
                throttle,_=LoginThrottle.objects.get_or_create(pk=key,defaults={'until':now+900})
                throttle=LoginThrottle.objects.select_for_update().get(pk=key)
                if throttle.until<=now:throttle.attempts=0;throttle.until=now+900
                if throttle.attempts>=15:return response({'error':'Забагато спроб входу. Повторіть через 15 хвилин.'},429)
                if key==bucket_keys[0]:throttle.attempts+=1
                throttle.save()
        u=User.objects.filter(username=username,is_active=True).first()
        if not u or not user_valid(u,str(value.get('password',''))):
            LoginThrottle.objects.filter(pk=bucket_keys[1]).update(attempts=F('attempts')+1)
            time.sleep(.3)
            return response({'error':'Невірний логін або пароль'},401)
        LoginThrottle.objects.filter(pk=bucket_keys[0]).delete()
        LoginThrottle.objects.filter(until__lt=int(time.time())).delete()
        token,csrf=secrets.token_urlsafe(32),secrets.token_urlsafe(32)
        PortalSession.objects.filter(expires__lt=int(time.time())).delete()
        PortalSession.objects.create(user=u,token_hash=hashlib.sha256(token.encode()).hexdigest(),csrf=csrf,expires=int(time.time())+7*86400)
        result=response({'ok':True})
        result.set_cookie('ts_session',token,max_age=7*86400,httponly=True,secure=request.is_secure(),samesite='Strict')
        return result
    if path=='/' and request.method in {'GET','HEAD'}:
        if not request.portal_user:return HttpResponse(LOGIN_HTML)
        html=(ROOT/'app/index.html').read_text().replace('<script>','<link rel="stylesheet" href="/erp.css"><script src="/runtime.js"></script><script src="/erp.js"></script>\n<script>',1)
        return HttpResponse(html)
    if path=='/account' and not request.portal_user:
        result=HttpResponse(status=302);result['Location']='/';return result
    user=auth(request)
    if path=='/account':return HttpResponse(ACCOUNT_HTML.replace('Змінити пароль власника','Змінити пароль'))
    if path in {'/runtime.js','/erp.js','/erp.css'} and request.method in {'GET','HEAD'}:
        f=ROOT/('server/runtime.js' if path=='/runtime.js' else 'app'+path)
        return HttpResponse(f.read_bytes(),content_type='text/css' if path.endswith('.css') else 'text/javascript')
    if path=='/api/state' and request.method=='GET':
        return response({'data':legacy_state(user),'csrf':request.portal_session.csrf,'role':user.profile.role})
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
        return legacy_mutation(request,user,col+'/'+id)
    if path=='/api/erp/alerts' and request.method=='POST':
        require(user.profile.role in {'owner','manager'},'Недостатньо прав.')
        from .alerts import sync_alerts
        return response(sync_alerts(user))
    if path=='/api/erp/state' and request.method=='GET':return response(state(user))
    if path=='/api/erp/import-preview' and request.method=='POST':
        require(user.profile.role in {'owner','manager','warehouse'},'Недостатньо прав.')
        text=str(body(request).get('csv','')).lstrip('\ufeff')
        require(0<len(text)<=200000,'CSV порожній або завеликий.')
        delimiter=';' if text.splitlines()[0].count(';')>=text.splitlines()[0].count(',') else ','
        reader=csv.DictReader(io.StringIO(text),delimiter=delimiter)
        require(reader.fieldnames and {'ID','Кількість','Ціна'}.issubset(reader.fieldnames),'Потрібні колонки ID, Кількість, Ціна. Роздільник — крапка з комою або кома.')
        rows=[];seen=set()
        for index,row in enumerate(reader,2):
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
    if path=='/api/erp/recipes' and request.method=='POST':
        require(user.profile.role in {'owner','manager','warehouse'},'Недостатньо прав для рецептур.')
        value=body(request)
        with transaction.atomic():
            ledger_lock();product=get(Document,'products/'+str(value.get('product')),'Готовий товар')
            data={**product.data,'recipe':value.get('recipe',[])};validate_product(data,product.pk)
            product.data=data;product.save(update_fields=['data']);audit(user,'recipe_saved',product.pk,{'recipe':data['recipe']})
        return response({'ok':True})
    if path=='/api/erp/stock' and request.method=='GET':
        require(user.profile.role in {'owner','manager','warehouse','accountant','cashier'},'Недостатньо прав.')
        result=stock(user)
        if user.profile.role=='cashier':
            for rows in result.values():
                for row in rows:row.pop('value',None)
        return response(result)
    if path=='/api/erp/report' and request.method=='GET':
        require(user.profile.role in {'owner','manager','accountant'},'Недостатньо прав для фінансових звітів.')
        return response(report(user,request.GET))
    if path=='/api/erp/ledger' and request.method=='GET':
        require(user.profile.role in {'owner','manager','accountant'},'Недостатньо прав.')
        qs=scoped(CashEntry.objects.select_related('voucher','account'),user,'account__store_id').order_by('-pk')[:500]
        return response({'entries':[{'id':e.pk,'voucher':e.voucher_id,'date':e.voucher.date,'account':e.account.name,'kind':e.voucher.kind,'amount':str(e.amount),'note':e.voucher.note,'reversal':e.is_reversal} for e in qs]})
    if path=='/api/erp/vouchers':
        if request.method=='POST':return response(voucher_json(save_voucher(user,body(request)),True),201)
        require(request.method=='GET','Метод не підтримується.')
        qs=scoped(Voucher.objects.select_related('created_by'),user)
        qs=qs.filter(kind__in=ROLE_KINDS[user.profile.role])
        if request.GET.get('kind'):qs=qs.filter(kind__in=request.GET['kind'].split(','))
        if request.GET.get('status'):qs=qs.filter(status=request.GET['status'])
        if request.GET.get('party'):qs=qs.filter(party_id=request.GET['party'])
        if request.GET.get('store'):qs=qs.filter(store_id=request.GET['store'])
        if request.GET.get('from'):qs=qs.filter(date__gte=day(request.GET['from']))
        if request.GET.get('to'):qs=qs.filter(date__lte=day(request.GET['to']))
        require(request.GET.get('page','1').isdigit(),'Некоректний номер сторінки.')
        page=max(1,min(100000,int(request.GET.get('page','1'))))
        return response({'items':[voucher_json(v) for v in qs.order_by('-pk')[(page-1)*30:page*30]],'total':qs.count(),'page':page})
    match=re.fullmatch(r'/api/erp/vouchers/(\d+)(?:/(post|reverse))?',path)
    if match:
        pk,action=match.groups();v=get(Voucher,pk,'Документ');scope(user,v.store);permission(user,v.kind)
        if action=='post' and request.method=='POST':return response(voucher_json(post_voucher(user,pk),True))
        if action=='reverse' and request.method=='POST':return response(voucher_json(reverse_voucher(user,pk,body(request).get('reason','')),True))
        if not action and request.method=='GET':return response(voucher_json(v,True))
        if not action and request.method=='PUT':return response(voucher_json(save_voucher(user,body(request),pk),True))
        if not action and request.method=='DELETE':
            with transaction.atomic():
                ledger_lock();v.refresh_from_db();require(v.status=='draft','Видалити можна тільки чернетку.');audit(user,'draft_deleted',f'voucher/{pk}');v.delete()
            return response({'ok':True})
    match=re.fullmatch('/api/erp/entities/(stores|warehouses|parties|accounts|employees)',path)
    if match and request.method=='POST':return entity_save(user,match[1],body(request))
    if path=='/api/erp/shifts' and request.method=='POST':return shift_action(user,body(request))
    if path=='/api/erp/work-shifts' and request.method=='POST':return work_shift_save(user,body(request))
    if path=='/api/erp/period' and request.method=='POST':
        owner(user);value=body(request)
        with transaction.atomic():
            lock=ledger_lock();lock.closed_through=day(value['date']) if value.get('date') else None
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
                u=get(User,value['id'],'Користувач') if value.get('id') else User(username=name)
                require(u.username!=OWNER,'Власника редагуйте через обліковий запис.')
                if not u.pk or value.get('password'):
                    password=str(value.get('password',''));require(14<=len(password)<=256,'Пароль: від 14 до 256 символів.');u.set_password(password)
                u.is_active=bool(value.get('active',True));u.save()
                Profile.objects.update_or_create(user=u,defaults={'role':role,'store':get(Store,value['store'],'Магазин') if value.get('store') else None})
                PortalSession.objects.filter(user=u).delete();audit(user,'user_saved',f'user/{u.pk}',{'role':role,'active':u.is_active})
            return response({'id':u.pk})
    if path=='/api/erp/audit' and request.method=='GET':
        owner(user)
        return response({'events':list(AuditEvent.objects.select_related('user').order_by('-pk')[:200].values('id','at','user__username','action','subject','detail'))})
    if path=='/api/erp/fiscal' and request.method=='POST':
        owner(user);value=body(request);Setting.objects.update_or_create(pk='fiscal_required',defaults={'value':'true' if value.get('required') else 'false'});audit(user,'fiscal_mode_changed','settings',{'required':bool(value.get('required'))});return response({'ok':True})
    return response({'error':'Сторінку не знайдено.'},404)
