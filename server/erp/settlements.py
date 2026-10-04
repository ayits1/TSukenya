"""Explicit counterparty settlements. No automatic FIFO allocation or payroll netting."""
from collections import defaultdict
from contextlib import closing
from copy import copy
from decimal import Decimal
from itertools import islice
from django.db.models import Prefetch
from .models import PaymentAllocation, Voucher

SOURCE_KINDS = {'sale', 'receipt', 'debt_opening'}
EVENT_KINDS = {'payment', 'advance_allocation', 'payment_refund'}


def active(voucher, cutoff=None):
    if cutoff is None:
        return voucher.status == 'posted'
    from .historical_reports import active_at
    return active_at(voucher, cutoff)


def allocation_active(allocation, cutoff=None):
    return all(active(voucher, cutoff) for voucher in (allocation.settlement, allocation.payment, allocation.source))


def context(sources, cutoff=None):
    """Batch all direct returns/legacy payments and allocation records for a set of source invoices."""
    ids = [v.pk for v in sources]
    related, allocations = defaultdict(list), defaultdict(list)
    events = Voucher.objects.filter(reference_id__in=ids, kind__in=['customer_return','supplier_return','payment'], status__in=['posted','reversed'])
    for event in events:
        if active(event, cutoff):
            snapshot = copy(event); snapshot.status = 'posted'; related[event.reference_id].append(snapshot)
    rows = PaymentAllocation.objects.filter(source_id__in=ids).select_related('settlement','payment','source')
    for row in rows:
        if allocation_active(row, cutoff):
            allocations[row.source_id].append(row)
    return related, allocations


def current_allocations(source):
    return PaymentAllocation.objects.filter(source=source, settlement__status='posted', payment__status='posted', source__status='posted').select_related('settlement','payment','source')


def allocated_amount(reference, *, settlements, allocations):
    """One authoritative adapter including unbackfilled legacy single-reference payment records."""
    from .services import ZERO, money
    mapped = {row.settlement_id for row in allocations if row.settlement.kind == 'payment'}
    legacy = sum((event.total for event in settlements if event.kind == 'payment' and event.status == 'posted' and event.pk not in mapped), ZERO)
    return money(legacy + sum((row.amount for row in allocations), ZERO))


def prefetched_sources(query):
    return query.prefetch_related(
        Prefetch('voucher_set', queryset=Voucher.objects.filter(status='posted',kind__in=['customer_return','supplier_return','payment']),to_attr='browse_settlements'),
        Prefetch('settlement_allocations',queryset=PaymentAllocation.objects.filter(settlement__status='posted',payment__status='posted').select_related('settlement','payment','source'),to_attr='browse_allocations'))


def current_source_obligations(query):
    """Read posted sources in fixed batches without materializing their child collections.

    Reuse the report scalar reader with no date cutoff: current obligations include
    every posted child, including future-dated legacy records. Posting adapters
    above keep their existing contract; callers own authorization and read_snapshot.
    Headers omit the full payload, so consumers must use its scalar projections.
    """
    from . import report_children as children
    query = children.headers(query.filter(status='posted', kind__in=SOURCE_KINDS))
    with closing(query.iterator(chunk_size=children.CHUNK)) as sources:
        while batch := list(islice(sources, children.CHUNK)):
            amounts = children.obligations(batch, None)
            for source in batch:
                yield source, amounts[source.pk]


def direction(payment):
    """Cash received from a customer is +1; cash paid to a supplier is -1."""
    party = payment.party or (payment.reference.party if payment.reference_id else None)
    return Decimal(1) if party and party.kind == 'customer' else Decimal(-1)


def advance_balances(payments, cutoff=None):
    """Batch unused balances. Historic balances follow accounting dates and both event activities."""
    from .services import ZERO, money
    payments = list(payments); ids = [v.pk for v in payments]
    spent = defaultdict(lambda: ZERO)
    for row in PaymentAllocation.objects.filter(payment_id__in=ids).select_related('payment','settlement','source'):
        if allocation_active(row,cutoff): spent[row.payment_id] += row.amount
    # Compatibility for direct-model old payments created without backfill (never double count mapped ones).
    mapped = set(PaymentAllocation.objects.filter(settlement_id__in=ids).values_list('settlement_id',flat=True))
    for payment in payments:
        if payment.reference_id and payment.reference.kind in SOURCE_KINDS and payment.pk not in mapped and active(payment,cutoff):
            spent[payment.pk] += payment.total
    for refund in Voucher.objects.filter(reference_id__in=ids,kind='payment_refund',status__in=['posted','reversed']):
        if active(refund,cutoff): spent[refund.reference_id] += refund.total
    return {payment.pk: money(payment.total-spent[payment.pk]) if active(payment,cutoff) else ZERO for payment in payments}


def unused(payment):
    return advance_balances([payment])[payment.pk]


def positive_id(value, label):
    import re
    from .services import require
    require(type(value) is int or isinstance(value,str) and re.fullmatch(r'[0-9]{1,19}',value) is not None, f'{label}: некоректний ID.')
    result=int(value)
    require(0 < result <= 9223372036854775807, f'{label}: некоректний ID.')
    return result


def save_allocations(voucher, body):
    from .services import CENT, ZERO, dec, require, require_active
    if voucher.kind not in {'payment','advance_allocation'}:
        require(not body.get('allocations'), 'Розподіли доступні тільки платежу або використанню авансу.')
        return
    if voucher.kind == 'payment':
        require(voucher.party is not None,'Виберіть контрагента платежу.')
        payment=voucher
        raw=body.get('allocations')
        if raw is None:
            raw=[{'source':voucher.reference_id,'amount':str(voucher.total)}] if voucher.reference_id else [{'source':r.source_id,'amount':str(r.amount)} for r in voucher.allocation_entries.all()]
    else:
        payment=voucher.reference
        require(payment and payment.kind=='payment' and payment.status=='posted','Виберіть проведений платіж з невикористаним авансом.')
        raw=body.get('allocations',[])
        require(raw,'Виберіть документи для використання авансу.')
    require(isinstance(raw,list) and len(raw)<=200,'Розподіл містить не більше 200 документів.')
    rows=[];seen=set();total=ZERO;normalized=[]
    for item in raw:
        require(isinstance(item,dict),'Некоректний рядок розподілу.')
        key=positive_id(item.get('source'),'Документ')
        require(key not in seen,'Документ повторюється в розподілі.');seen.add(key)
        normalized.append((key,item))
    sources={source.pk:source for source in Voucher.objects.filter(pk__in=seen)}
    for key,item in normalized:
        source=sources.get(key)
        require(source is not None,'Документ розподілу: запис не знайдено.')
        require(source.kind in SOURCE_KINDS and source.status=='posted','Розподіл потребує проведеного боргового документа.')
        require(source.party_id==voucher.party_id and source.store_id==voucher.store_id,'Контрагент і магазин усіх розподілів мають збігатись із платежем.')
        require(source.kind=='debt_opening' or source.kind==('sale' if voucher.party.kind=='customer' else 'receipt'),'Напрям боргу не відповідає платежу.')
        require(source.date<=voucher.date and payment.date<=voucher.date,'Розподіл не може передувати документу або платежу.')
        require(isinstance(item.get('amount'),str),'Сума розподілу має бути десятковим рядком.')
        amount=dec(item['amount'],'Сума розподілу',minimum=CENT)
        rows.append(PaymentAllocation(settlement=voucher,payment=payment,source=source,amount=amount));total+=amount
    if voucher.kind=='payment':
        require(total<=voucher.total,'Сума розподілів перевищує платіж.')
        if voucher.reference_id:
            require(len(rows)==1 and rows[0].source_id==voucher.reference_id and total==voucher.total,'Оплата за одним документом має повністю розподілятись тільки на нього.')
        if total<voucher.total: require_active(voucher.party,'Контрагент нового авансу')
    else:
        require(total==voucher.total,'Сума використання авансу має дорівнювати сумі розподілів.')
    voucher.allocation_entries.all().delete()
    PaymentAllocation.objects.bulk_create(rows)


def validate_post(voucher):
    from .services import ZERO, obligation, require, require_active
    if voucher.kind not in EVENT_KINDS:return
    require(voucher.party is not None,'Виберіть контрагента платежу.')
    if voucher.kind in {'advance_allocation','payment_refund'}:
        require(voucher.reference and voucher.reference.kind=='payment' and voucher.reference.status=='posted','Вихідний платіж недоступний.')
        require(voucher.reference.date<=voucher.date,'Документ не може передувати вихідному платежу.')
        require(voucher.total<=unused(voucher.reference),'Сума перевищує невикористаний аванс.')
    if voucher.kind in {'payment','advance_allocation'}:
        rows=list(voucher.allocation_entries.select_related('source','payment','settlement'))
        related,allocations=context([row.source for row in rows])
        total=ZERO
        for row in rows:
            source=row.source
            require(source.status=='posted','Борговий документ уже скасований.')
            require(source.party_id==voucher.party_id and source.store_id==voucher.store_id,'Контрагент або магазин розподілу змінився.')
            require(source.date<=voucher.date and row.payment.date<=voucher.date,'Розподіл не може передувати документу або платежу.')
            require(row.amount<=obligation(source,settlements=related[source.pk],allocations=allocations[source.pk]),'Сума розподілу перевищує залишок боргу документа.')
            total+=row.amount
        require(total<=voucher.total and (voucher.kind!='advance_allocation' or total==voucher.total),'Некоректна сума розподілів.')
        if voucher.kind=='payment' and total<voucher.total:require_active(voucher.party,'Контрагент нового авансу')
