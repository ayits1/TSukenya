"""Owner settings intents: per-kind audit versions, immutable receipts, guarded read-only recovery."""
import hashlib
import hmac
import json
import re
import uuid
from decimal import Decimal, InvalidOperation
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from .historical_reports import read_snapshot
from .models import AuditEvent, LedgerLock, Setting, SettingActionReceipt, Voucher
from .services import BusinessError, Conflict, audit, current_actor, day, discount_limit, DISCOUNT_KEY, ledger_lock, percent_text, require

KINDS = {'period': ('period_changed', 'ledger'), 'fiscal': ('fiscal_mode_changed', 'settings'), 'discount-limit': ('discount_limit_changed', 'settings')}


def kind(value):
    require(isinstance(value,str) and value in KINDS,'Невідоме налаштування.')
    return value


def authorize(user):
    require(user.profile.role=='owner','Недостатньо прав. Операція доступна лише власнику.')


def key(value):
    require(isinstance(value,dict),'Некоректний запит налаштування.')
    raw=value.get('idempotency_key')
    require(isinstance(raw,str),'Вкажіть UUID початкового запиту.')
    try: parsed=uuid.UUID(raw)
    except (ValueError,AttributeError):require(False,'Некоректний UUID початкового запиту.')
    require(str(parsed)==raw,'Некоректний UUID початкового запиту.')
    return parsed


def normalize(setting,value):
    kind(setting);require(isinstance(value,dict),'Некоректний запит налаштування.')
    names={'period':{'date','reason'},'fiscal':{'required'},'discount-limit':{'percent'}}[setting]
    require(set(value)==names|{'idempotency_key','revision'},'Невідомі або відсутні поля налаштування.')
    revision=value['revision']
    require(isinstance(revision,str) and re.fullmatch(r'[0-9a-f]{32}',revision),'Вкажіть перевірену версію налаштування.')
    if setting=='period':
        date=value['date'];reason=value['reason']
        require(date is None or isinstance(date,str),'Некоректна дата закриття.')
        parsed=day(date) if date else None
        require(not parsed or date==parsed.isoformat(),'Вкажіть дату у форматі РРРР-ММ-ДД.')
        require(isinstance(reason,str) and 0<len(reason.strip()) and len(reason)<=4000,'Вкажіть причину зміни періоду (до 4000 символів).')
        result={'date':parsed.isoformat() if parsed else None,'reason':reason}
    elif setting=='fiscal':
        require(type(value['required']) is bool,'Виберіть режим обліку чеків.')
        result={'required':value['required']}
    else:
        raw=value['percent'];require(isinstance(raw,str) and re.fullmatch(r'\d{1,3}(?:[.,]\d{1,2})?',raw),'Вкажіть максимальну знижку рядком десяткових відсотків.')
        try: percent=Decimal(raw.replace(',','.'))
        except InvalidOperation:percent=Decimal(-1)
        require(percent.is_finite() and 0<=percent<=100 and percent==percent.quantize(Decimal('.01')),'Максимальна знижка касира — число від 0 до 100 із не більше ніж двома знаками після коми.')
        result={'percent':percent_text(percent)}
    return {**result,'revision':revision}


def policy(user):
    return {'role':user.profile.role,'storeId':user.profile.store_id,'networkOwner':user.profile.store_id is None,'canWrite':True}


def projection(setting,lock=None):
    action,subject=KINDS[kind(setting)]
    qs=AuditEvent.objects.filter(action=action,subject=subject).order_by('-pk')
    if setting=='period':
        latest=qs.values_list('pk','detail__reason').first()
        reason=latest[1] if latest else ''
        require(isinstance(reason,str) and len(reason)<=4000,'Історична причина зміни періоду має некоректний формат.')
        closing=lock.closed_through if lock else LedgerLock.objects.filter(pk=1).values_list('closed_through',flat=True).first()
        value={'date':closing.isoformat() if closing else None,'reason':reason}
    else:
        last=qs.values_list('pk',flat=True).first();latest=(last,) if last is not None else None
        value={'required':Setting.objects.filter(pk='fiscal_required').values_list('value',flat=True).first()=='true'} if setting=='fiscal' else {'percent':percent_text(discount_limit())}
    material=json.dumps([setting,value,latest[0] if latest else None],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
    revision=hmac.new(settings.SECRET_KEY.encode(),material,hashlib.sha256).hexdigest()[:32]
    return value,revision


def fingerprint(user,setting,original):
    return hashlib.sha256(json.dumps([user.pk,setting,original],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def acknowledgement(receipt):
    return {'type':'setting','setting':receipt.setting,'request_key':str(receipt.key),'original':receipt.original,**receipt.result}


def matching(user,setting,request_key,original):
    receipt=SettingActionReceipt.objects.filter(pk=request_key).first()
    if not receipt:return None
    if receipt.author_id!=user.pk or receipt.setting!=setting or receipt.fingerprint!=fingerprint(user,setting,original):
        raise Conflict('UUID уже використано для іншого запиту налаштування.','idempotency_conflict')
    return receipt


@transaction.atomic
def action(user,setting,value):
    lock=ledger_lock();user=current_actor(user);authorize(user);kind(setting)
    request_key=key(value);original=normalize(setting,value)
    receipt=matching(user,setting,request_key,original)
    if receipt:return acknowledgement(receipt)
    previous,revision=projection(setting,lock)
    if revision!=original['revision']:raise Conflict('Налаштування вже змінилося. Перечитайте його поточну версію.','revision_conflict')
    if setting=='period':
        closing=day(original['date']) if original['date'] else None
        require(not closing or closing<timezone.localdate(),'Закривати можна лише завершені дні.')
        require(not closing or not Voucher.objects.filter(status='draft',date__lte=closing).exists(),'У періоді є чернетки. Проведіть або видаліть їх.')
        lock.closed_through=closing;lock.save(update_fields=['closed_through'])
        detail={'date':original['date'],'reason':original['reason']}
    elif setting=='fiscal':
        Setting.objects.update_or_create(pk='fiscal_required',defaults={'value':'true' if original['required'] else 'false'})
        detail={'required':original['required']}
    else:
        Setting.objects.update_or_create(pk=DISCOUNT_KEY,defaults={'value':original['percent']})
        detail={'old':previous['percent'],'new':original['percent']}
    event,subject=KINDS[setting];audit(user,event,subject,detail)
    applied,new_revision=projection(setting,lock)
    receipt=SettingActionReceipt.objects.create(key=request_key,author=user,setting=setting,fingerprint=fingerprint(user,setting,original),original=original,result={'value':applied,'revision':new_revision})
    return acknowledgement(receipt)


def rejected(setting,value):
    try:request_key=key(value);kind(setting)
    except (BusinessError,AttributeError):return {}
    return {'write_rejected':True,'type':'setting','setting':setting,'request_key':str(request_key)}


def mutation(user,setting,value):
    # Proof catches only a rolled-back attempt. Outer commit/callback/serialization failures are outside it.
    with transaction.atomic():
        try:
            with transaction.atomic():result=action(user,setting,value)
        except Conflict as exc:
            if exc.code!='revision_conflict':raise
            result={'error':str(exc),'code':exc.code,**rejected(setting,value)};status=409
        except BusinessError as exc:
            if any(word in str(exc) for word in ['прав','роль','доступ','не підтверджений']):raise
            result={'error':str(exc),**rejected(setting,value)};status=400
        else:status=200
    return result,status


def parameters(params):
    require(not params,'Невідомі параметри налаштування.')


def recovery_context(user,setting,params):
    kind(setting);parameters(params)
    with read_snapshot():
        user=current_actor(user);authorize(user)
        return {'type':'setting','setting':setting,**policy(user)}


def current(user,setting,params):
    kind(setting);parameters(params)
    with read_snapshot():
        user=current_actor(user);authorize(user);value,revision=projection(setting)
        return {'type':'setting','setting':setting,'value':value,'revision':revision,'editing':policy(user)}


def identity(user,setting,value):
    kind(setting);require(isinstance(value,dict) and set(value)=={'request'},'Очікується початковий запит.')
    with read_snapshot():
        user=current_actor(user);authorize(user)
        require(isinstance(value['request'],dict),'Некоректний початковий запит.')
        request_key=key(value['request']);original=normalize(setting,value['request']);receipt=matching(user,setting,request_key,original)
        return {'confirmed':True,**acknowledgement(receipt)} if receipt else {'confirmed':False,'type':'setting','setting':setting,'request_key':str(request_key)}
