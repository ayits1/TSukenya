"""Read-only party balances and statement from authoritative allocations and dated events."""
from decimal import Decimal
from collections import defaultdict
from django.db.models import Q
from django.utils import timezone
from .models import Counterparty, Voucher
from .reporting import scoped
from .financial_browsing import financial_access
from .browsing import positive_integer, page_number, page_bounds, PAGE_SIZE, filter_search
from .services import ZERO, day, dec, money, obligation, require, get
from .settlements import SOURCE_KINDS, EVENT_KINDS, active, context, advance_balances


def payment_rows(payments, cutoff=None):
    payments=list(payments); balances=advance_balances(payments,cutoff)
    return [{'payment':v.pk,'number':f'{v.pk:06d}','date':v.date.isoformat(),'store':v.store_id,'party':v.party_id,'party_name':v.party.name,
             'direction':v.party.kind,'total':str(v.total),'unallocated':str(balances[v.pk])} for v in payments if v.party_id and balances[v.pk]>0]


def advances(user,params):
    financial_access(user)
    query=scoped(Voucher.objects.filter(kind='payment',status='posted').select_related('party','reference__party'),user)
    for key,field in [('store','store_id'),('party','party_id'),('id','pk')]:
        if params.get(key):query=query.filter(**{field:positive_integer(params[key],'ID')})
    direction=params.get('direction','');require(direction in {'','customer','supplier'},'Некоректний напрям авансу.')
    if direction:query=query.filter(party__kind=direction)
    rows=payment_rows(filter_search(query,params).order_by('-pk'))
    total=len(rows);page,pages,offset=page_bounds(total,page_number(params))
    return {'items':rows[offset:offset+PAGE_SIZE],'total':total,'page':page,'pages':pages,
            'totals':{side:str(money(sum((Decimal(row['unallocated']) for row in rows if row['direction']==side),ZERO))) for side in ('customer','supplier')}}


def statement_data(user,params):
    financial_access(user)
    party=get(Counterparty,positive_integer(params.get('party',''),'ID контрагента'),'Контрагент')
    require(party.kind in {'customer','supplier'},'Некоректний тип контрагента.')
    today=timezone.localdate();end=day(params.get('to') or today.isoformat());start=day(params.get('from') or end.replace(day=1).isoformat())
    require(start<=end<=today,'Некоректний період звірки.')
    query=scoped(Voucher.objects.filter(party=party,status__in=['posted','reversed'],kind__in=SOURCE_KINDS|EVENT_KINDS|{'customer_return','supplier_return'}),user)
    if params.get('store'):query=query.filter(store_id=positive_integer(params['store'],'ID магазину'))
    from .historical_reports import reversal_day, require_reversal_dates
    ids=list(query.values_list('store_id',flat=True).distinct());require_reversal_dates(ids,end)
    docs=list(query.filter(Q(date__lte=end)).select_related('party','reference__party').prefetch_related('allocation_entries').order_by('date','pk'))
    signed=Decimal(1) if party.kind=='customer' else Decimal(-1)
    opening=closing=ZERO;rows=[]
    for v in docs:
        embedded=sum((dec(p['amount']) for p in v.payload.get('payments',[])),ZERO)
        effect=v.total-embedded if v.kind=='sale' else -v.total+embedded if v.kind in {'customer_return','supplier_return'} else -v.total if v.kind=='payment' else v.total if v.kind=='payment_refund' else ZERO if v.kind=='advance_allocation' else v.total
        effect*=signed
        for event_date,sign in [(v.date,1)]+([(reversal_day(v),-1)] if reversal_day(v) else []):
            if event_date>end:continue
            value=effect*sign;closing+=value
            if event_date<start:opening+=value;continue
            rows.append({'voucher':v.pk,'number':f'{v.pk:06d}','kind':v.kind,'date':event_date.isoformat(),'store':v.store_id,'amount':str(money(value)),'reversal':sign==-1,
                         'allocations':[{'source':a.source_id,'number':f'{a.source_id:06d}','amount':str(a.amount)} for a in v.allocation_entries.all()]})
    rows.sort(key=lambda row:(row['date'],row['voucher'],row['reversal']))
    sources=[v for v in docs if v.kind in SOURCE_KINDS and active(v,end)]
    related,allocations=context(sources,end);debts=[];age=defaultdict(lambda:ZERO)
    for source in sources:
        amount=obligation(source,settlements=related[source.pk],allocations=allocations[source.pk])
        if not amount:continue
        due=source.payload.get('due_date','');days=(end-day(due)).days if due else None
        bucket='no_due' if days is None else 'not_due' if days<=0 else '1_30' if days<=30 else '31_60' if days<=60 else '61_90' if days<=90 else 'over_90'
        age[bucket]+=amount
        debts.append({'voucher':source.pk,'number':f'{source.pk:06d}','date':source.date.isoformat(),'store':source.store_id,'amount':str(money(amount)),'due_date':due,'age_bucket':bucket})
    advance=payment_rows([v for v in docs if v.kind=='payment'],end)
    debt_total=money(sum((Decimal(row['amount']) for row in debts),ZERO));advance_total=money(sum((Decimal(row['unallocated']) for row in advance),ZERO));net=(debt_total-advance_total)*signed
    total=len(rows);page,pages,offset=page_bounds(total,page_number(params));balance=opening
    for row in rows:
        balance+=Decimal(row['amount']);row['balance']=str(money(balance))
    return {'party':party.pk,'party_name':party.name,'direction':party.kind,'from':start.isoformat(),'to':end.isoformat(),'basis':'accounting_dates',
            'opening_balance':str(money(opening)),'closing_balance':str(money(closing)),
            'debit':str(money(sum((Decimal(row['amount']) for row in rows if Decimal(row['amount'])>0),ZERO))),
            'credit':str(money(-sum((Decimal(row['amount']) for row in rows if Decimal(row['amount'])<0),ZERO))),
            'items':rows[offset:offset+PAGE_SIZE],'total':total,'page':page,'pages':pages,
            'debts':debts,'advances':advance,'debt_total':str(debt_total),'advance_total':str(advance_total),
            'age':{key:str(money(age[key])) for key in ('no_due','not_due','1_30','31_60','61_90','over_90')},
            'reconciliation':{'net_documents_and_advances':str(money(net)),'matches':net==money(closing)}}


def statement(user,params):
    from .historical_reports import read_snapshot
    with read_snapshot():return statement_data(user,params)
