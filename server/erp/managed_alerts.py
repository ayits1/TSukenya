"""An active business condition and the user's work are separate facts; callers lock the ledger."""
import hashlib
import hmac
from django.conf import settings
import json
import re
import uuid
from zoneinfo import ZoneInfo
from django.db import transaction
from django.utils import timezone
from .models import Document,AlertTaskAction
from .services import require,ledger_lock,audit,Conflict,day
from .task_scope import authorize_task,alert_task

WORK_FIELDS=('_alertWorkState','_alertAcceptedBy','_alertAcceptedAt','_alertDeferredUntil','_alertDeferReason','_alertCompletedBy','_alertCompletedAt')
ACTIONS={'accept','defer','complete','resume'}

def kyiv_day():
    return timezone.localtime(timezone.now(),ZoneInfo('Europe/Kyiv')).date()

def work_state(data):
    return data.get('_alertWorkState') or ('completed' if data.get('status')=='done' else 'accepted' if data.get('status')=='doing' else 'open')

def clear_work(value):
    for key in WORK_FIELDS:value.pop(key,None)
    value['_alertWorkState']='open'
    value['status']='todo'

def preserve_work(value,old):
    for key in WORK_FIELDS:
        if key in old:value[key]=old[key]
    value['_alertWorkState']=work_state(old)

def elapsed(value,now,stamp):
    until=value.get('_alertDeferredUntil')
    if work_state(value)=='deferred' and isinstance(until,str) and until<=now.isoformat():
        clear_work(value)
        value.update({'_alertNote':'Строк відкладення настав','_alertNoteAt':stamp})
        return True
    return False

def task_revision(doc):
    material=json.dumps([doc.path,doc.data],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
    return hmac.new(settings.SECRET_KEY.encode(),material,hashlib.sha256).hexdigest()[:32]

def task_json(doc):
    return {'id':doc.path.split('/',1)[1],'revision':task_revision(doc),'data':doc.data}

@transaction.atomic
def action(request,user,identifier):
    from .views import body,response
    ledger_lock()
    from django.contrib.auth.models import User
    # The request's user/profile can predate a ledger wait and a role revocation.
    user=User.objects.select_related('profile').filter(pk=user.pk,is_active=True,profile__isnull=False).first()
    require(user is not None,'Недостатньо прав. Обліковий запис вимкнено.')
    require(re.fullmatch(r'(?:auto_|reprint_)[a-f0-9]{32}',identifier) is not None,'Некоректна системна задача.')
    doc=Document.objects.filter(pk='tasks/'+identifier).first()
    require(doc is not None,'Системну задачу не знайдено.')
    authorize_task(user,doc.data)
    require(alert_task(doc.path,doc.data),'Це не системна задача.')
    value=body(request)
    require({'action','revision','idempotencyKey'}<=set(value) and not(set(value)-{'action','revision','idempotencyKey','until','reason'}),'Некоректні реквізити дії задачі.')
    operation=value['action'];require(isinstance(operation,str) and operation in ACTIONS,'Оберіть коректну дію задачі.')
    try:key=uuid.UUID(value['idempotencyKey']) if isinstance(value['idempotencyKey'],str) else None
    except ValueError:key=None
    require(key is not None,'Некоректний ключ дії задачі.')
    try:fingerprint=hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest()
    except (TypeError,ValueError):require(False,'Некоректні реквізити дії задачі.')
    receipt=AlertTaskAction.objects.filter(pk=key).first()
    if receipt:
        if receipt.author_id!=user.pk or receipt.task_id!=doc.pk or receipt.fingerprint!=fingerprint:raise Conflict('Ключ використано для іншої дії задачі.','idempotency_conflict')
        return response({'task':task_json(doc),'replayed':True,'appliedRevision':receipt.applied_revision,'appliedCycle':receipt.cycle})
    if not isinstance(value['revision'],str) or value['revision']!=task_revision(doc):raise Conflict('Задачу вже змінено. Ваше введення збережено: оновіть умови перед повтором.','revision_conflict')
    active=bool(doc.data.get('_alertActive')) if doc.path.startswith('tasks/auto_') else doc.data.get('status')!='done'
    require(active or doc.path.startswith('tasks/reprint_') and operation=='resume','Умову вже усунено. Оновіть список задач.')
    reason=value.get('reason','');require(isinstance(reason,str) and len(reason.strip())<=500,'Некоректне пояснення дії.')
    require(operation=='defer' or 'until' not in value,'Дата відкладення доступна лише для дії «Відкласти».')
    stamp=timezone.now().isoformat();before=dict(doc.data);updated=dict(before)
    if operation=='defer':
        until=value.get('until');require(isinstance(until,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}',until) is not None,'Оберіть дату відкладення.')
        require(day(until)>kyiv_day(),'Дата повернення до задачі має бути пізнішою за сьогодні.')
        require(reason.strip(),'Поясніть причину відкладення.')
        updated.update({'_alertWorkState':'deferred','_alertDeferredUntil':until,'_alertDeferReason':reason.strip(),'status':'todo'})
    else:
        updated.pop('_alertDeferredUntil',None);updated.pop('_alertDeferReason',None)
        if operation=='accept':updated.update({'_alertWorkState':'accepted','status':'doing','_alertAcceptedBy':user.username,'_alertAcceptedAt':stamp})
        elif operation=='complete':updated.update({'_alertWorkState':'completed','status':'done','_alertCompletedBy':user.username,'_alertCompletedAt':stamp})
        else:clear_work(updated)
    doc.data=updated;doc.save(update_fields=['data'])
    receipt=AlertTaskAction.objects.create(id=key,task=doc,author=user,fingerprint=fingerprint,applied_revision=task_revision(doc),cycle=int(updated.get('_alertCycle') or 1))
    audit(user,'alert_task_action',doc.path,{'action':operation,'before':{k:before.get(k) for k in ('status',*WORK_FIELDS)},'after':{k:updated.get(k) for k in ('status',*WORK_FIELDS)},'reason':reason.strip(),'cycle':receipt.cycle,'observedRevision':value['revision']})
    return response({'task':task_json(doc),'replayed':False,'appliedRevision':receipt.applied_revision,'appliedCycle':receipt.cycle})


def legacy_status(user,value,previous):
    """Existing status-only clients cannot keep a hidden defer flag while changing work state."""
    if value.get('status')==previous.get('status'):return value
    stamp=timezone.now().isoformat()
    value=dict(value);value.pop('_alertDeferredUntil',None);value.pop('_alertDeferReason',None)
    status=value.get('status')
    if status=='doing':value.update({'_alertWorkState':'accepted','_alertAcceptedBy':user.username,'_alertAcceptedAt':stamp})
    elif status=='done':value.update({'_alertWorkState':'completed','_alertCompletedBy':user.username,'_alertCompletedAt':stamp})
    else:clear_work(value)
    return value
