"""Operational alerts become store-scoped tasks, deduplicated by business condition."""
import hashlib
import logging
import uuid
from datetime import timedelta
from django.db import transaction
from django.utils import timezone
import json
from .models import Document, Voucher, Setting
from .services import ledger_lock, obligation, audit
from .reporting import stock, scoped, ALERT_OK_KEY, ALERT_ERROR_KEY, ALERT_PUBLIC_ERROR

logger=logging.getLogger(__name__)

def record_alert_error(user,source,error):
    # Only network-wide runs say anything about the whole control; a failed run rolled back, so the error is written outside its transaction.
    if user is not None and user.profile.store_id:return
    reference=uuid.uuid4().hex[:12]
    logger.error('Operational alert control failed [%s], source=%s',reference,source,exc_info=(type(error),error,error.__traceback__))
    Setting.objects.update_or_create(pk=ALERT_ERROR_KEY,defaults={'value':json.dumps({'at':timezone.now().isoformat(),'source':source,'message':ALERT_PUBLIC_ERROR,'reference':reference},ensure_ascii=False)})

def run_alerts(user,source='manual'):
    try:return sync_alerts(user,source)
    except Exception as error:
        try:record_alert_error(user,source,error)
        except Exception:logger.exception('Could not record operational alert control failure')
        raise

@transaction.atomic
def sync_alerts(user,source='manual'):
    ledger_lock()
    from .promotion_history import scan_prices
    scan_prices(user,source=source)
    now=timezone.localdate();conditions={}
    data=stock(user)
    for s in data['totals']:
        if s['low']:
            from .models import Warehouse
            wh=Warehouse.objects.get(pk=s['warehouse'])
            conditions[f"low:{s['warehouse']}:{s['product']}"]={'title':f"Поповнити: {s['name']} · {wh.name} (доступно {s['available']} {s['unit']}, мінімум {s['minimum']})",'store':wh.store_id,'dueDate':now.isoformat()}
    for l in data['lots']:
        if l['expiry'] and l['expiry']<=(now+timedelta(days=7)).isoformat():
            from .models import Warehouse
            wh=Warehouse.objects.get(pk=l['warehouse'])
            conditions[f"expiry:{l['id']}"]={'title':f"Перевірити термін: {l['name']} · партія {l['lot']} · до {l['expiry']}",'store':wh.store_id,'dueDate':l['expiry']}
    for v in scoped(Voucher.objects.filter(status='posted',kind__in=['receipt','sale','debt_opening'],party__isnull=False).select_related('party'),user):
        due=v.payload.get('due_date')
        if due and due<=now.isoformat() and obligation(v)>0:
            conditions[f'due:{v.pk}']={'title':f"Перевірити оплату: {v.party.name} · документ № {v.pk:06d} · {obligation(v)} грн",'store':v.store_id,'dueDate':due}
    created,resolved,reopened=0,0,0;stamp=timezone.now().isoformat()
    active_paths=set()
    for key,value in conditions.items():
        path='tasks/auto_'+hashlib.sha256(key.encode()).hexdigest()[:32]
        active_paths.add(path)
        doc=Document.objects.filter(pk=path).first();old=doc.data if doc else {}
        live=bool(old.get('_alertActive'));status=old.get('status','todo') if live else 'todo'
        cycle=int(old.get('_alertCycle') or 1)+(0 if live or not doc else 1)
        value.update({'scope':'operations','status':status,'_alertActive':True,'_alertKey':key,'_alertCycle':cycle,'createdAt':old.get('createdAt') or stamp,'order':old.get('order') or int(timezone.now().timestamp()*1000)})
        if live and status=='done':
            # Done does not hide a condition that is still active: the next control reopens the task.
            value.update({'status':'todo','_alertNote':'Умова досі діє','_alertNoteAt':stamp});reopened+=1
        elif live:
            for k in ('_alertNote','_alertNoteAt'):
                if k in old:value[k]=old[k]
        elif doc:value.update({'_alertNote':'Умова виникла знову','_alertNoteAt':stamp})
        Document.objects.update_or_create(pk=path,defaults={'data':value})
        if not live:created+=1
    for d in Document.objects.filter(path__startswith='tasks/auto_'):
        if user.profile.store_id and d.data.get('store')!=user.profile.store_id:continue
        if d.path not in active_paths and d.data.get('_alertActive'):
            d.data.update({'_alertActive':False,'status':'done','_alertNote':'Причину усунено','_alertNoteAt':stamp});d.save(update_fields=['data']);resolved+=1
    if created or resolved or reopened:audit(user,'alerts_updated','operations',{'created':created,'resolved':resolved,'reopened':reopened,'source':source})
    if not user.profile.store_id:Setting.objects.update_or_create(pk=ALERT_OK_KEY,defaults={'value':json.dumps({'at':stamp,'source':source,'active':len(conditions),'created':created,'resolved':resolved,'reopened':reopened})})
    return {'active':len(conditions),'created':created,'resolved':resolved,'reopened':reopened}
