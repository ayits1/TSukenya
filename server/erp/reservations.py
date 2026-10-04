"""Physical FEFO holds. Call mutations only inside the accounting ledger lock."""
from datetime import datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo
from django.db.models import F, Q, Sum, DecimalField
from django.utils import timezone
from .models import StockReservation, ReservationUse, StockLot

KYIV=ZoneInfo('Europe/Kyiv')
ZERO=Decimal('0')


def kyiv_day():
    return timezone.localtime(timezone.now(),KYIV).date()


def live(at=None):
    return StockReservation.objects.filter(expires_on__gte=at or kyiv_day(),order_line__voucher__status='posted',order_line__voucher__order_control__closed_at__isnull=True).filter(quantity__gt=F('used')+F('released'))


def held_quantities(lot_ids,at=None):
    values=live(at).filter(lot_id__in=lot_ids).values('lot_id').annotate(held=Sum(F('quantity')-F('used')-F('released'),output_field=DecimalField(max_digits=18,decimal_places=3)))
    return {row['lot_id']:row['held'] for row in values}


def unused(reservation):
    return reservation.quantity-reservation.used-reservation.released


def expiry_instant(expires_on):
    return datetime.combine(expires_on+timedelta(days=1),time.min,tzinfo=KYIV).isoformat()


def outgoing_plan(v,line,quantity,lots):
    """Own source-order holds first, then unheld FEFO stock; money stays in services."""
    from .services import require
    lots=list(lots);held=held_quantities([lot.pk for lot in lots]);owned={}
    if v.kind=='sale' and v.reference_id and line.reference_line_id:
        rows=list(live().filter(order_line_id=line.reference_line_id).order_by('lot__expiry','lot_id','pk'))
        available_ids={lot.pk for lot in lots}
        matching=sum((unused(row) for row in rows if row.lot_id in available_ids),ZERO)
        outside=sum((unused(row) for row in rows if row.lot_id not in available_ids),ZERO)
        require(not outside or quantity<=matching,'Замовлення має резерв в інших партіях. Використайте його партії або явно звільніть резерв.')
        for row in rows:
            if row.lot_id in available_ids:owned.setdefault(row.lot_id,[]).append(row)
    remaining=quantity;plan=[]
    for lot in lots:
        for reservation in owned.get(lot.pk,[]):
            take=min(remaining,unused(reservation))
            if take:
                plan.append((lot,take,reservation));remaining-=take
            if not remaining:return plan
    for lot in lots:
        take=min(remaining,max(ZERO,lot.quantity-held.get(lot.pk,ZERO)))
        if take:plan.append((lot,take,None));remaining-=take
        if not remaining:return plan
    require(remaining==0,f'{line.name}: недостатньо вільного придатного залишку (не вистачає {remaining} {line.unit}). Резерви інших замовлень недоступні.')
    return plan


def consume(reservation,line,quantity):
    if reservation is None:return
    reservation.used+=quantity;reservation.save(update_fields=['used'])
    ReservationUse.objects.create(reservation=reservation,line=line,quantity=quantity)


def guard_movement(lot,new_quantity):
    from .services import require
    require(new_quantity>=held_quantities([lot.pk]).get(lot.pk,ZERO),'Партія має чинний резерв. Спочатку явно звільніть невикористану частину резерву.')


def reverse_uses(v):
    at=kyiv_day();now=timezone.now()
    for use in ReservationUse.objects.filter(line__voucher=v,reversed_at__isnull=True).select_related('reservation__order_line__voucher'):
        reservation=use.reservation;reservation.used-=use.quantity
        control=getattr(reservation.order_line.voucher,'order_control',None)
        closed=reservation.order_line.voucher.status!='posted' or control is not None and control.closed_at is not None
        released=closed or reservation.expires_on<at
        if released:reservation.released+=use.quantity
        reservation.save(update_fields=['used','released']);use.reversed_at=now;use.released_on_reverse=released;use.save(update_fields=['reversed_at','released_on_reverse'])


def release_unused(order,*,expired_only=False):
    at=kyiv_day();rows=StockReservation.objects.filter(order_line__voucher=order).filter(quantity__gt=F('used')+F('released'))
    if expired_only:rows=rows.filter(expires_on__lt=at)
    changed=[]
    for row in rows:
        before={'id':row.pk,'used':str(row.used),'released':str(row.released)}
        row.released+=unused(row);row.save(update_fields=['released'])
        changed.append({'before':before,'after':{'id':row.pk,'used':str(row.used),'released':str(row.released)}})
    return changed
