"""Explicit order controls and retry receipts, independent of financial postings."""
import hashlib,json,uuid,re
from datetime import date
from decimal import Decimal
from django.db import transaction
from django.db.models import F,Sum,Q,OuterRef,Subquery,DecimalField,Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from .models import OrderControl,OrderOperation,StockReservation,StockLot,Voucher,VoucherLine
from .reservations import kyiv_day,live,held_quantities,unused,expiry_instant,release_unused
from .services import ZERO,QTY,CENT,Conflict,dec,day,get,ledger_lock,permission,require,scope,audit,current_actor
from .browsing import positive_integer

ORDER_KINDS={'customer_order','purchase_order'}


def identifier_value(value,label):
    if type(value) is int and 0<value<=999999999999:return value
    return positive_integer(value,label)

def control(order):
    return OrderControl.objects.filter(order=order).first()


def remaining_lines(order):
    lines=list(order.lines.order_by('pk'));next_kind='sale' if order.kind=='customer_order' else 'receipt'
    used={row['reference_line_id']:row['quantity'] for row in VoucherLine.objects.filter(reference_line_id__in=[line.pk for line in lines],voucher__kind=next_kind,voucher__status='posted').values('reference_line_id').annotate(quantity=Sum('quantity'))}
    return [(line,used.get(line.pk,ZERO),line.quantity-used.get(line.pk,ZERO)) for line in lines]


def editable(user,order):
    return user.profile.role in {'owner','manager'} or user.profile.role=='warehouse' and order.kind=='purchase_order' or user.profile.role=='cashier' and order.kind=='customer_order' and order.created_by_id==user.pk


def order_json(order,user,page=1):
    state=control(order);lines=remaining_lines(order)
    fulfilled=sum((used for _,used,_ in lines),ZERO);left=sum((remaining for _,_,remaining in lines),ZERO)
    lifecycle='draft' if order.status=='draft' else 'cancelled' if order.status=='reversed' else 'closed' if state and state.closed_at else 'fulfilled' if not left else 'partial' if fulfilled else 'approved'
    history=StockReservation.objects.filter(order_line__voucher=order);total=history.count();page=max(1,min(page,max(1,(total+49)//50)))
    rows=list(history.select_related('lot','owner').order_by('-pk')[(page-1)*50:page*50]);active_ids=set(live().filter(pk__in=[row.pk for row in rows]).values_list('pk',flat=True))
    reserved={row['order_line_id']:row['amount'] for row in live().filter(order_line__voucher=order).values('order_line_id').annotate(amount=Sum(F('quantity')-F('used')-F('released')))}
    return {'state':lifecycle,'revision':state.revision if state else 1,'canManage':editable(user,order),'expected_date':(state.expected_date.isoformat() if state.expected_date else None) if state else order.payload.get('expected_date') or None,'minimum_order_amount':str(state.minimum_amount) if state and state.minimum_amount is not None else order.payload.get('minimum_order_amount'),
            'history':{'page':page,'pages':max(1,(total+49)//50),'total':total},'lines':[{'line':line.pk,'name':line.name,'unit':line.unit,'quantity':str(line.quantity),'fulfilled':str(used),'remaining':str(remaining),'reserved':str(reserved.get(line.pk,ZERO))} for line,used,remaining in lines],
            'reservations':[{'id':row.pk,'line':row.order_line_id,'lot':row.lot_id,'code':row.lot.code,'lot_expiry':row.lot.expiry.isoformat() if row.lot.expiry else None,'owner':row.owner.username,'created_at':row.created_at.isoformat(),'expires_on':row.expires_on.isoformat(),'expires_at':expiry_instant(row.expires_on),'quantity':str(row.quantity),'used':str(row.used),'released':str(row.released),'active':row.pk in active_ids,'available':str(unused(row) if row.pk in active_ids else ZERO)} for row in reversed(rows)]}


def reserve_limits(order,user):
    require(order.kind=='customer_order' and editable(user,order),'Недостатньо прав для резерву.')
    rows=remaining_lines(order);reserved={row['order_line_id']:row['amount'] for row in live().filter(order_line__voucher=order).values('order_line_id').annotate(amount=Sum(F('quantity')-F('used')-F('released')))}
    held=live().filter(lot_id=OuterRef('pk')).values('lot_id').annotate(amount=Sum(F('quantity')-F('used')-F('released'))).values('amount')
    result=[]
    for line,_,remaining in rows:
        needed=max(ZERO,remaining-reserved.get(line.pk,ZERO));available=ZERO;maximum=None;enough=False
        lots=StockLot.objects.filter(warehouse=order.warehouse,product=line.product,quantity__gt=0).filter(Q(expiry__isnull=True)|Q(expiry__gte=kyiv_day())).annotate(held=Coalesce(Subquery(held,output_field=DecimalField(max_digits=18,decimal_places=3)),Value(ZERO))).order_by(F('expiry').desc(nulls_first=True),'-pk')
        if line.lot:lots=lots.filter(code=line.lot)
        for lot in lots.iterator(chunk_size=200):
            available+=max(ZERO,lot.quantity-lot.held)
            if not enough and needed>0 and available>=needed:maximum=lot.expiry.isoformat() if lot.expiry else None;enough=True
        result.append({'line':line.pk,'name':line.name,'unit':line.unit,'needed':str(needed),'available':str(available),'max_date':maximum,'canReserveFull':enough})
    return result


def normalise_terms(v,payload):
    if v.kind not in ORDER_KINDS:
        return {'order_revision':payload['order_revision']} if v.reference_id and v.reference.kind in ORDER_KINDS and 'order_revision' in payload else {}
    terms={}
    if payload.get('expected_date'):
        expected=day(payload['expected_date']);require(expected>=v.date,'Очікувана дата не може передувати даті замовлення.');terms['expected_date']=expected.isoformat()
    if v.kind=='purchase_order' and payload.get('minimum_order_amount') not in (None,''):
        require(isinstance(payload['minimum_order_amount'],str) and re.fullmatch(r'[0-9]+(?:\.[0-9]{1,2})?',payload['minimum_order_amount']),'Мінімальна сума постачальника має бути десятковим рядком до 2 знаків.')
        terms['minimum_order_amount']=str(dec(payload['minimum_order_amount'],'Мінімальна сума постачальника',minimum=CENT))
    return terms


def validate_source(v):
    if not v.reference_id or v.reference.kind not in ORDER_KINDS:return
    source=v.reference;state=control(source)
    require(not state or state.closed_at is None,'Замовлення закрито. Нове виконання недоступне.')
    observed=v.payload.get('order_revision')
    if observed is not None:
        require(type(observed) is int and observed>0,'Потрібна додатна ціла версія замовлення.')
        current=state.revision if state else 1
        if observed!=current:raise Conflict('Замовлення або його резерви вже змінено. Виберіть актуальне замовлення й перевірте рядки.','order_revision_conflict',id=source.pk,revision=current)


def approve(order):
    if order.kind not in ORDER_KINDS:return
    minimum=order.payload.get('minimum_order_amount')
    if minimum is not None:require(order.total>=Decimal(minimum),'Сума замовлення менша за явно заданий мінімум постачальника.')
    OrderControl.objects.get_or_create(order=order,defaults={'expected_date':day(order.payload['expected_date']) if order.payload.get('expected_date') else None,'minimum_amount':Decimal(minimum) if minimum is not None else None})


def changed_source(v):
    if v.reference_id and v.reference.kind in ORDER_KINDS:
        row,_=OrderControl.objects.get_or_create(order=v.reference)
        row.revision+=1;row.save(update_fields=['revision'])


def cancel_order(order):
    if order.kind not in ORDER_KINDS:return
    release_unused(order);row,_=OrderControl.objects.get_or_create(order=order);row.revision+=1;row.save(update_fields=['revision'])


def reservation_audit(row):
    return {'id':row.pk,'line':row.order_line_id,'code':row.lot.code,'name':row.order_line.name,'unit':row.order_line.unit,'expires_on':row.expires_on,'quantity':row.quantity,'used':row.used,'released':row.released,'owner':row.owner.username}


@transaction.atomic
def mutate(user,order_id,value):
    ledger_lock();user=current_actor(user);order=get(Voucher,order_id,'Замовлення');scope(user,order.store);permission(user,order.kind);require(order.kind in ORDER_KINDS,'Це не замовлення.');require(editable(user,order),'Змінювати резерви касир може лише для власного замовлення.')
    require(isinstance(value,dict),'Очікується об’єкт дії замовлення.');action=value.get('action');require(isinstance(action,str) and action in {'reserve','release','expire','close','expected_date'},'Невідома дія замовлення.')
    fields={'action','revision','idempotencyKey','reason'}|({'expires_on','lines'} if action=='reserve' else {'reservation','quantity'} if action=='release' else {'expected_date'} if action=='expected_date' else set())
    require(not set(value)-fields,'Дія містить невідомі поля.')
    raw_key=value.get('idempotencyKey');require(isinstance(raw_key,str),'Потрібен UUID повтору.');
    try:key=uuid.UUID(raw_key)
    except (ValueError,AttributeError):raise Conflict('Некоректний ключ повтору.','invalid_key')
    require(str(key)==raw_key,'Потрібен канонічний UUID повтору.')
    try:material=json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)
    except (ValueError,TypeError):require(False,'Некоректні JSON-дані дії замовлення.')
    digest=hashlib.sha256(material.encode()).hexdigest();previous=OrderOperation.objects.filter(pk=key).first()
    if previous:
        if previous.actor_id!=user.pk or previous.order_id!=order.pk or previous.payload_hash!=digest:raise Conflict('Ключ дії вже використано з іншим змістом.','idempotency_conflict')
        return previous.result
    state=control(order);revision=state.revision if state else 1
    require(type(value.get('revision')) is int and value['revision']>0,'Потрібна версія замовлення.')
    if value['revision']!=revision:raise Conflict('Замовлення або резерви вже змінено. Оновіть дані.','order_revision_conflict',revision=revision)
    require(order.status=='posted','Спочатку погодьте замовлення.')
    require(not state or state.closed_at is None,'Замовлення вже закрито.')
    before=order_json(order,user);reservation_before=None;reservation_after=None;reason=value.get('reason','');require(isinstance(reason,str) and len(reason)<=4000,'Некоректна причина.')
    state=state or OrderControl.objects.create(order=order)
    if action=='reserve':
        require(order.kind=='customer_order','Резерв доступний тільки замовленню покупця.');require(order.store.active and order.warehouse is not None and order.party and order.party.active,'Потрібні активні магазин і покупець та склад замовлення.');expires=day(value.get('expires_on'));require(expires>=kyiv_day(),'Строк резерву вже минув.');require(expires<date.max,'Строк резерву має дозволяти обчислити початок наступного дня.')
        raw=value.get('lines');require(isinstance(raw,list) and 1<=len(raw)<=200,'Вкажіть товарні рядки резерву.');require(all(isinstance(row,dict) and set(row)=={'line','quantity'} for row in raw),'Некоректні рядки резерву.')
        remaining={line.pk:(line,left) for line,_,left in remaining_lines(order)};seen=set();currently={line['line']:Decimal(line['reserved']) for line in before['lines']}
        for item in raw:
            identifier=identifier_value(item['line'],'ID рядка');require(identifier in remaining and identifier not in seen,'Рядок не належить замовленню або повторений.');seen.add(identifier);require(isinstance(item['quantity'],str) and re.fullmatch(r'[0-9]+(?:\.[0-9]{1,3})?',item['quantity']),'Кількість резерву має бути десятковим рядком до 3 знаків.');quantity=dec(item['quantity'],'Резерв',QTY,minimum=QTY);line,left=remaining[identifier];require(quantity+currently.get(identifier,ZERO)<=left,'Резерв перевищує невиконаний залишок рядка.')
            lots=list(StockLot.objects.filter(warehouse=order.warehouse,product=line.product,quantity__gt=0).filter(Q(expiry__isnull=True)|Q(expiry__gte=expires)).order_by(F('expiry').asc(nulls_last=True),'pk'))
            if line.lot:lots=[lot for lot in lots if lot.code==line.lot]
            held=held_quantities([lot.pk for lot in lots]);needed=quantity
            for lot in lots:
                take=min(needed,max(ZERO,lot.quantity-held.get(lot.pk,ZERO)))
                if take:StockReservation.objects.create(order_line=line,lot=lot,owner=user,expires_on=expires,quantity=take);needed-=take
                if not needed:break
            require(not needed,'Недостатньо вільних партій, придатних до вибраного строку. Скоротіть строк явно або змініть кількість.')
    elif action=='release':
        require(reason.strip(),'Вкажіть причину звільнення.');identifier=identifier_value(value.get('reservation'),'ID резерву');row=get(StockReservation,identifier,'Резерв');require(row.order_line.voucher_id==order.pk,'Резерв належить іншому замовленню.');require(isinstance(value.get('quantity'),str) and re.fullmatch(r'[0-9]+(?:\.[0-9]{1,3})?',value['quantity']),'Кількість звільнення має бути десятковим рядком до 3 знаків.');quantity=dec(value['quantity'],'Звільнення',QTY,minimum=QTY);reservation_before=reservation_audit(row);require(quantity<=unused(row),'Звільняти можна лише невикористану частину.');row.released+=quantity;row.save(update_fields=['released']);reservation_after=reservation_audit(row)
    elif action=='expire':release_unused(order,expired_only=True)
    elif action=='close':
        require(reason.strip(),'Вкажіть причину закриття.');release_unused(order);state.closed_at=timezone.now();state.closed_by=user;state.reason=reason.strip()
    else:
        require(order.kind=='purchase_order','Очікувана поставка доступна тільки закупівлі.');expected=day(value['expected_date']) if value.get('expected_date') else None;require(expected is None or expected>=order.date,'Очікувана дата не може передувати замовленню.');state.expected_date=expected
    state.revision+=1;state.save();after=order_json(order,user);result={'ok':True,'id':order.pk,'order':after}
    OrderOperation.objects.create(key=key,order=order,actor=user,payload_hash=digest,result=result)
    from .business_audit import snapshot,change
    detail=change(snapshot('order',{**before,**({'reservation':reservation_before} if reservation_before else {})}),snapshot('order',{**after,**({'reservation':reservation_after} if reservation_after else {})}),observed=value['revision'],reason=reason)
    if action=='reserve':detail['expires_on']=expires.isoformat()
    audit(user,'order_'+action,f'voucher/{order.pk}',{**detail,'idempotencyKey':raw_key})
    return result
