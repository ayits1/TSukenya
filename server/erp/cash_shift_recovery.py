"""Till recovery: normalized immutable action receipts; current state never proves authorship."""
import hashlib
import json
import re
import uuid
from django.db import transaction
from django.utils import timezone
from .historical_reports import read_snapshot
from .models import CashShift, CashShiftActionReceipt, CashAccount, Employee, Store
from .services import (Conflict, current_actor, get, require, scope, dec, ledger_lock,
                       cash_balance, require_active, record_revision, audit, post_cash_difference)

ROLES = {'owner', 'manager', 'cashier'}


def authorize(user):
    require(user.profile.role in ROLES, 'Недостатньо прав для касових змін.')


def identifier(value, label):
    require(type(value) is int or isinstance(value, str) and re.fullmatch(r'[1-9]\d*',value), label + ': некоректний ID.')
    result=int(value)
    require(0 < result <= 9007199254740991, label + ': некоректний ID.')
    return result


def request_key(value):
    key=value.get('idempotency_key')
    require(isinstance(key,str), 'Вкажіть UUID початкового запиту.')
    try: parsed=uuid.UUID(key)
    except (ValueError,AttributeError): require(False, 'Некоректний UUID початкового запиту.')
    require(str(parsed)==key, 'Некоректний UUID початкового запиту.')
    return parsed


def normalize(value):
    require(isinstance(value,dict), 'Некоректний запит касової зміни.')
    mode=value.get('action','open')
    require(isinstance(mode,str) and mode in {'open','close'}, 'Невідома дія касової зміни.')
    allowed={'action','idempotency_key','account','employee'} if mode=='open' else {'action','idempotency_key','id','counted','note','revision'}
    require(not set(value)-allowed, 'Невідомі поля касової зміни.')
    if mode=='open':
        result={'action':'open','account':identifier(value.get('account'),'Каса'),
                'employee':identifier(value['employee'],'Працівник') if value.get('employee') not in (None,'') else None}
    else:
        note=value.get('note','')
        require(isinstance(note,str) and len(note)<=4000, 'Примітка: до 4000 символів.')
        revision=value.get('revision')
        require(isinstance(revision,str) and re.fullmatch(r'[0-9a-f]{32}',revision), 'Вкажіть перевірену версію касової зміни.')
        result={'action':'close','id':identifier(value.get('id'),'Зміна'),
                'counted':str(dec(value.get('counted'),'Фактична готівка')), 'note':note,'revision':revision}
    return result


def fingerprint(user, original):
    return hashlib.sha256(json.dumps([user.pk,original],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def resource(user, original):
    if original['action']=='open':
        account=get(CashAccount,original['account'],'Каса');scope(user,account.store)
        return account
    row=get(CashShift,original['id'],'Зміна');scope(user,row.store)
    require(user.profile.role!='cashier' or row.opened_by_id==user.pk, 'Немає доступу: зміну відкрив інший касир.')
    return row


def acknowledgement(receipt):
    return {'id':receipt.shift_id,'type':'cash_shift','action':receipt.action,
            'request_key':str(receipt.key),'original':receipt.original}


def matching(user,key,original):
    receipt=CashShiftActionReceipt.objects.filter(pk=key).first()
    if receipt is None:return None
    require(user.profile.store_id is None or receipt.store_id_snapshot==user.profile.store_id,'Немає доступу до цього магазину.')
    if receipt.author_id!=user.pk or receipt.action!=original['action'] or receipt.fingerprint!=fingerprint(user,original):
        raise Conflict('UUID уже використано для іншого запиту касової зміни.','idempotency_conflict')
    scope(user,get(Store,receipt.shift.store_id,'Магазин'))
    return receipt


@transaction.atomic
def action(user,value):
    ledger_lock();user=current_actor(user);authorize(user)
    key=request_key(value);original=normalize(value);obj=resource(user,original)
    receipt=matching(user,key,original)
    if receipt:return acknowledgement(receipt)
    if original['action']=='open':
        require(obj.kind=='cash','Касову зміну можна відкрити лише для готівкового рахунку.')
        require(not CashShift.objects.filter(account=obj,closed_at__isnull=True).exists(),'На цій касі вже відкрита зміна.')
        employee=get(Employee,original['employee'],'Працівник') if original['employee'] else None
        require(not employee or employee.store_id==obj.store_id,'Працівник належить іншому магазину.')
        require_active(employee,'Працівник')
        row=CashShift.objects.create(account=obj,store=obj.store,employee=employee,opened_by=user,opening_cash=cash_balance(obj))
        audit(user,'shift_opened',f'shift/{row.pk}')
    else:
        row=obj
        if original['revision']!=record_revision(row):raise Conflict('Касова зміна вже змінилася. Перечитайте її стан.','revision_conflict')
        require(not row.closed_at,'Зміну вже закрито.')
        row.expected_cash=cash_balance(row.account);row.counted_cash=dec(original['counted'],'Фактична готівка')
        row.closed_at=timezone.now();row.note=original['note'];row.save()
        audit(user,'shift_closed',f'shift/{row.pk}',{'expected':str(row.expected_cash),'counted':str(row.counted_cash),'difference':str(row.counted_cash-row.expected_cash)})
        post_cash_difference(user,row,row.note)
    receipt=CashShiftActionReceipt.objects.create(key=key,author=user,action=original['action'],shift=row,
        store_id_snapshot=row.store_id,fingerprint=fingerprint(user,original),original=original)
    return acknowledgement(receipt)


def policy(user):
    return {'role':user.profile.role,'storeId':user.profile.store_id,
            'networkOwner':user.profile.role=='owner' and user.profile.store_id is None}


def query_params(params, allowed):
    require(not set(params)-allowed and all(isinstance(value,str) for value in params.values()),'Некоректні параметри касової зміни.')
    if hasattr(params,'getlist'):
        require(all(len(params.getlist(key))==1 for key in params),'Параметр касової зміни повторюється.')


def recovery_context(user,params):
    query_params(params,{'action','id','account','store'})
    mode=params.get('action','open');require(isinstance(mode,str) and mode in {'open','close'},'Невідома дія касової зміни.')
    query_params(params,{'action','id','store'} if mode=='close' else {'action','account','store'})
    with read_snapshot():
        user=current_actor(user);authorize(user)
        row=None;account=None;store=None
        if mode=='close':
            row=get(CashShift,identifier(params.get('id'),'Зміна'),'Зміна');resource(user,{'action':'close','id':row.pk})
            account=row.account_id;store=row.store_id
        elif params.get('account'):
            a=get(CashAccount,identifier(params['account'],'Каса'),'Каса');scope(user,a.store);account=a.pk;store=a.store_id
        elif params.get('store'):
            store=identifier(params['store'],'Магазин');scope(user,get(Store,store,'Магазин'))
        else:store=user.profile.store_id
        if params.get('store'):require(store==identifier(params['store'],'Магазин'),'Магазин касової зміни змінився; доступ відкликано.')
        return {'type':'cash_shift','action':mode,'id':row.pk if row else None,'account':account,'store':store,
                **policy(user),'canWrite':row is None or row.closed_at is None}


def current(user,params):
    query_params(params,{'id'});require(set(params)=={'id'},'Очікується ID касової зміни.')
    with read_snapshot():
        user=current_actor(user);authorize(user)
        row=resource(user,{'action':'close','id':identifier(params['id'],'Зміна')})
        return {'id':row.pk,'store':row.store_id,'account':row.account_id,'employee':row.employee_id,
                'openedBy':row.opened_by_id,'openedAt':row.opened_at.isoformat(),
                'closedAt':row.closed_at.isoformat() if row.closed_at else None,'openingCash':str(row.opening_cash),
                'expectedCash':str(row.expected_cash) if row.expected_cash is not None else None,
                'countedCash':str(row.counted_cash) if row.counted_cash is not None else None,'note':row.note,
                'revision':record_revision(row),'editing':{**policy(user),'canWrite':row.closed_at is None}}


def identity(user,value):
    require(isinstance(value,dict) and set(value)=={'request'},'Очікується початковий запит.')
    with read_snapshot():
        user=current_actor(user);authorize(user)
        original=normalize(value['request']);key=request_key(value['request']);resource(user,original)
        receipt=matching(user,key,original)
        return {'confirmed':True,**acknowledgement(receipt)} if receipt else {'confirmed':False,'type':'cash_shift','action':original['action'],'request_key':str(key)}
