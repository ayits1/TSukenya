"""Operational alerts become store-scoped tasks, deduplicated by business condition."""
import hashlib
from datetime import timedelta
from django.db import transaction
from django.utils import timezone
from .models import Document, Voucher
from .services import ledger_lock, obligation, audit
from .reporting import stock, scoped

@transaction.atomic
def sync_alerts(user):
    ledger_lock()
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
    created,resolved=0,0
    active_paths=set()
    for key,value in conditions.items():
        path='tasks/auto_'+hashlib.sha256(key.encode()).hexdigest()[:32]
        active_paths.add(path)
        doc=Document.objects.filter(pk=path).first()
        value.update({'scope':'operations','status':doc.data.get('status','todo') if doc and doc.data.get('_alertActive') else 'todo','_alertActive':True,'_alertKey':key,'createdAt':doc.data.get('createdAt') if doc else timezone.now().isoformat(),'order':doc.data.get('order') if doc else int(timezone.now().timestamp()*1000)})
        Document.objects.update_or_create(pk=path,defaults={'data':value})
        if not doc or not doc.data.get('_alertActive'):created+=1
    for d in Document.objects.filter(path__startswith='tasks/auto_'):
        if user.profile.store_id and d.data.get('store')!=user.profile.store_id:continue
        if d.path not in active_paths and d.data.get('_alertActive'):
            d.data.update({'_alertActive':False,'status':'done'});d.save(update_fields=['data']);resolved+=1
    if created or resolved:audit(user,'alerts_updated','operations',{'created':created,'resolved':resolved})
    return {'active':len(conditions),'created':created,'resolved':resolved}
