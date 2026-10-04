"""Bounded read adapters; mutation and historical pure settlement oracles stay unchanged."""
import json
from collections import defaultdict
from decimal import Decimal

from django.db.models import Q, Exists, OuterRef, Sum, F, Value, DecimalField, Subquery, TextField
from django.db.models.functions import Coalesce
from django.db.models.fields.json import KeyTextTransform
from django.db.models.expressions import RawSQL
from django.db.models import BooleanField
from django.db import connection
from django.utils import timezone

from . import report_children as children
from .bounded_reports import Spool, batches
from .browsing import PAGE_SIZE, positive_integer, page_number, page_bounds, filter_search
from .financial_browsing import financial_access, CALENDAR_DAYS
from .historical_reports import read_snapshot, reversal_day, require_reversal_dates
from .models import Voucher, VoucherLine, Counterparty
from .reporting import scoped
from .services import ZERO, money, require, permission, current_actor, day, get
from .settlements import SOURCE_KINDS, EVENT_KINDS, active


def sources(query, cutoff=None):
    """At most 200 headers/four scalar accumulators; never load payload or children."""
    query = children.headers(query.select_related('party'), party=True).only(
        *children.HEADER_FIELDS, 'warehouse_id', 'party__id', 'party__name', 'party__kind')
    base=connection.ops.quote_name(Voucher._meta.db_table)+'.'+connection.ops.quote_name('payload')
    # Preserve legacy false empty deadlines without decoding a potentially huge container.
    empty=f"({base}->'due_date') IN ('[]'::jsonb,'{{}}'::jsonb)" if connection.vendor=='postgresql' else f"json_type({base},'$.due_date') IN ('array','object') AND NOT EXISTS(SELECT 1 FROM json_each({base},'$.due_date'))"
    query=query.annotate(report_due_empty=RawSQL(empty,[],output_field=BooleanField()))
    for batch in batches(query):
        amounts = children.obligations(batch, cutoff)
        for source in batch:
            yield source, amounts[source.pk]
        batch.clear()


def payments(query, cutoff=None):
    query = children.headers(query.select_related('party', 'reference'), party=True, reference=True)
    for batch in batches(query):
        amounts = children.advances(batch, cutoff)
        for payment in batch:
            if payment.party_id and amounts[payment.pk] > 0:
                yield {'payment': payment.pk, 'number': f'{payment.pk:06d}', 'date': payment.date.isoformat(),
                       'store': payment.store_id, 'party': payment.party_id, 'party_name': payment.party.name,
                       'direction': payment.party.kind, 'total': str(payment.total), 'unallocated': str(amounts[payment.pk])}
        batch.clear()


def selected_page(spool, section, params, order="CAST(key AS INTEGER) DESC"):
    total = spool.count(section)
    page, pages, offset = page_bounds(total, page_number(params))
    # order is internal, never a request parameter. Only one bounded page is decoded.
    cursor = spool.db.execute('SELECT value FROM rows WHERE section=? ORDER BY '+order+' LIMIT ? OFFSET ?',
                             (section, PAGE_SIZE, offset))
    return {'items': [json.loads(row[0]) for row in cursor], 'total': total, 'page': page, 'pages': pages}


def references(user, params):
    from .browsing import SOURCE_KINDS as reference_kinds
    with read_snapshot():
        user = current_actor(user)
        purpose = params.get('purpose', '')
        require(purpose in reference_kinds, 'Невідоме призначення вихідного документа.')
        permission(user, purpose)
        query = scoped(Voucher.objects.filter(status='posted', kind__in=reference_kinds[purpose]), user)
        for key, field in [('store','store_id'), ('party','party_id'), ('id','pk')]:
            if params.get(key): query = query.filter(**{field: positive_integer(params[key], 'ID документа' if key=='id' else 'ID довідника')})
        if purpose in {'sale','receipt'}: query = query.filter(order_control__closed_at__isnull=True)
        query = filter_search(query, params)
        if purpose == 'payment':
            query = query.exclude(Q(kind='sale',party__isnull=True))
            with Spool() as spool:
                for voucher, outstanding in sources(query.order_by('-pk')):
                    if outstanding > 0: spool.put('references', voucher.pk, reference_row(voucher, outstanding))
                return selected_page(spool, 'references', params)
        quantity = DecimalField(max_digits=18, decimal_places=3)
        used = VoucherLine.objects.filter(reference_line_id=OuterRef('pk'), voucher__kind=purpose,
            voucher__status='posted').order_by().values('reference_line_id').annotate(amount=Sum('quantity')).values('amount')
        remaining = VoucherLine.objects.filter(voucher_id=OuterRef('pk')).annotate(
            used=Coalesce(Subquery(used), Value(Decimal('0')), output_field=quantity)).filter(quantity__gt=F('used'))
        query = query.annotate(has_remaining=Exists(remaining)).filter(has_remaining=True)
        total = query.count(); page, pages, offset = page_bounds(total, page_number(params))
        rows = list(query.order_by('-pk').defer('payload')[offset:offset+PAGE_SIZE])
        amounts = children.obligations([v for v in rows if v.kind in SOURCE_KINDS], None)
        return {'items': [reference_row(v, amounts.get(v.pk)) for v in rows], 'total':total,'page':page,'pages':pages}


def reference_row(voucher, outstanding):
    return {'id':voucher.pk,'number':f'{voucher.pk:06d}','kind':voucher.kind,'date':voucher.date.isoformat(),
            'store':voucher.store_id,'party':voucher.party_id,'total':str(voucher.total),
            'outstanding':str(outstanding) if outstanding is not None else None,'warehouse':voucher.warehouse_id}


def deadline(voucher):
    require(not voucher.report_payload_bad,'Некоректні реквізити історичного документа.')
    if voucher.report_due_bad:
        require(voucher.report_due_empty,'Некоректний строк оплати історичного документа.')
        return [] if voucher.report_due_kind in {'array'} else {}
    return voucher.report_due if voucher.report_due_present else ''


def debt_rows(user, params, today):
    query = scoped(Voucher.objects.filter(status='posted',kind__in=SOURCE_KINDS)
        .filter(Q(party__isnull=False)|Q(kind='receipt')),user)
    for key,field in [('store','store_id'),('party','party_id')]:
        if params.get(key): query=query.filter(**{field:positive_integer(params[key],'ID довідника')})
    query=filter_search(query,params).order_by('-pk')
    status=params.get('status',''); require(status in {'','overdue','not_overdue'},'Некоректний стан боргу.')
    due=day(params['due']).isoformat() if params.get('due') else None
    due_from=day(params['due_from']).isoformat() if params.get('due_from') else None
    due_to=day(params['due_to']).isoformat() if params.get('due_to') else None
    require(not due_from or not due_to or due_from<=due_to,'Початковий строк оплати пізніший за кінцевий.')
    for voucher,amount in sources(query):
        if not amount: continue
        due_value=deadline(voucher)
        overdue=bool(due_value and due_value<today.isoformat())
        if status and overdue!=(status=='overdue'):continue
        if due and due_value!=due:continue
        if due_from and (not due_value or due_value<due_from):continue
        if due_to and (not due_value or due_value>due_to):continue
        kind='receipt' if voucher.kind=='debt_opening' and voucher.party.kind=='supplier' else 'sale' if voucher.kind=='debt_opening' else voucher.kind
        yield {'voucher':voucher.pk,'number':f'{voucher.pk:06d}','kind':kind,'original_kind':voucher.kind,
               'store':voucher.store_id,'date':voucher.date.isoformat(),'party':voucher.party.name if voucher.party else 'Роздрібний покупець',
               'party_id':voucher.party_id,'total':str(voucher.total),'amount':str(amount),'due_date':due_value,'overdue':overdue}


def debts(user, params):
    with read_snapshot(), Spool() as spool:
        user=current_actor(user);financial_access(user);today=timezone.localdate()
        totals={'owed_to_us':ZERO,'owed_by_us':ZERO}
        for row in debt_rows(user,params,today):
            totals['owed_by_us' if row['kind']=='receipt' else 'owed_to_us']+=Decimal(row['amount'])
            spool.put('debts',row['voucher'],row)
        return {**selected_page(spool,'debts',params),'debt_totals':{k:str(money(v)) for k,v in totals.items()}}


def advances(user,params):
    with read_snapshot(), Spool() as spool:
        user=current_actor(user);financial_access(user)
        query=scoped(Voucher.objects.filter(kind='payment',status='posted'),user)
        for key,field in [('store','store_id'),('party','party_id'),('id','pk')]:
            if params.get(key):query=query.filter(**{field:positive_integer(params[key],'ID')})
        direction=params.get('direction','');require(direction in {'','customer','supplier'},'Некоректний напрям авансу.')
        if direction:query=query.filter(party__kind=direction)
        totals={'customer':ZERO,'supplier':ZERO}
        for row in payments(filter_search(query,params).order_by('-pk')):
            totals[row['direction']]+=Decimal(row['unallocated']);spool.put('advances',row['payment'],row)
        return {**selected_page(spool,'advances',params),'totals':{k:str(money(v)) for k,v in totals.items()}}


def summary(user):
    from datetime import timedelta
    with read_snapshot(), Spool() as spool:
        user=current_actor(user);financial_access(user);today=timezone.localdate()
        horizon=(today+timedelta(days=CALENDAR_DAYS-1)).isoformat()
        overdue={k:{'amount':ZERO,'count':0} for k in ('to_us','by_us')}
        total=ZERO
        for row in debt_rows(user,{},today):
            if Decimal(row['amount'])<=0:continue
            if row['overdue']:
                side=overdue['by_us' if row['kind']=='receipt' else 'to_us']
                side['amount']+=Decimal(row['amount']);side['count']+=1
            elif row['kind']=='receipt' and row['due_date'] and row['due_date']<=horizon:
                selected={k:row[k] for k in ('voucher','number','store','party','due_date','amount')}
                spool.put('due',f"{row['due_date']}:{row['voucher']:020d}",selected);total+=Decimal(row['amount'])
        first=spool.db.execute('SELECT value FROM rows WHERE section=? ORDER BY key LIMIT 5',('due',))
        return {'today':today.isoformat(),'days':CALENDAR_DAYS,
                'overdue':{k:{'amount':str(money(v['amount'])),'count':v['count']} for k,v in overdue.items()},
                'payments':[json.loads(row[0]) for row in first],'payments_count':spool.count('due'),'payments_total':str(money(total))}


def statement(user,params):
    """Active bounded statement projection; legacy statement_data remains the pure oracle."""
    require(not set(params)-{'party','store','from','to','page'},'Невідомий параметр звірки.')
    with read_snapshot(), Spool() as spool:
        user=current_actor(user);financial_access(user)
        party=get(Counterparty,positive_integer(params.get('party',''),'ID контрагента'),'Контрагент')
        require(party.kind in {'customer','supplier'},'Некоректний тип контрагента.')
        today=timezone.localdate();end=day(params.get('to') or today.isoformat());start=day(params.get('from') or end.replace(day=1).isoformat())
        require(start<=end<=today,'Некоректний період звірки.')
        query=scoped(Voucher.objects.filter(party=party,status__in=['posted','reversed'],kind__in=SOURCE_KINDS|EVENT_KINDS|{'customer_return','supplier_return'}),user)
        store=positive_integer(params['store'],'ID магазину') if params.get('store') else None
        if store:query=query.filter(store_id=store)
        ids=list(query.values_list('store_id',flat=True).distinct());require_reversal_dates(ids,end)
        docs=query.filter(date__lte=end).order_by('date','pk')
        signed=Decimal(1) if party.kind=='customer' else Decimal(-1)
        opening=closing=debit=credit=ZERO
        for batch in batches(children.headers(docs)):
            embedded=dict.fromkeys([v.pk for v in batch],ZERO)
            for pk,_,amount,_ in children.json_children(Voucher.objects.filter(pk__in=embedded),'payments'):
                from .services import dec
                embedded[pk]+=dec(amount)
            for v in batch:
                paid=embedded[v.pk]
                effect=v.total-paid if v.kind=='sale' else -v.total+paid if v.kind in {'customer_return','supplier_return'} else -v.total if v.kind=='payment' else v.total if v.kind=='payment_refund' else ZERO if v.kind=='advance_allocation' else v.total
                effect*=signed
                reversal=reversal_day(v)
                for event_date,sign in [(v.date,1)]+([(reversal,-1)] if reversal else []):
                    if event_date>end:continue
                    value=effect*sign;closing+=value
                    if event_date<start:opening+=value;continue
                    amount=money(value)
                    if amount>0:debit+=amount
                    if amount<0:credit-=amount
                    row={'voucher':v.pk,'number':f'{v.pk:06d}','kind':v.kind,'date':event_date.isoformat(),'store':v.store_id,'amount':str(amount),'reversal':sign==-1}
                    spool.put('statement',f'{event_date.isoformat()}:{v.pk:020d}:{int(sign==-1)}',row)
            batch.clear()
        balance=opening
        cursor=spool.db.execute('SELECT key,value FROM rows WHERE section=? ORDER BY key',('statement',))
        while rows:=cursor.fetchmany(100):
            for key,raw in rows:
                row=json.loads(raw);balance+=Decimal(row['amount']);row['balance']=str(money(balance));spool.put('statement',key,row)
        age=defaultdict(lambda:ZERO);debt_total=advance_total=ZERO
        for source,amount in sources(docs.filter(kind__in=SOURCE_KINDS),end):
            if not active(source,end) or not amount:continue
            due=deadline(source)
            elapsed=(end-day(due)).days if due else None
            bucket='no_due' if elapsed is None else 'not_due' if elapsed<=0 else '1_30' if elapsed<=30 else '31_60' if elapsed<=60 else '61_90' if elapsed<=90 else 'over_90'
            age[bucket]+=amount;debt_total+=amount
        for payment in payments(docs.filter(kind='payment'),end):advance_total+=Decimal(payment['unallocated'])
        debt_total=money(debt_total);advance_total=money(advance_total);net=(debt_total-advance_total)*signed
        return {**selected_page(spool,'statement',params,'key'),'party':party.pk,'party_name':party.name,'direction':party.kind,
                'from':start.isoformat(),'to':end.isoformat(),'basis':'accounting_dates',
                'opening_balance':str(money(opening)),'closing_balance':str(money(closing)),
                'debit':str(money(debit)),'credit':str(money(credit)),'debt_total':str(debt_total),'advance_total':str(advance_total),
                'age':{k:str(money(age[k])) for k in ('no_due','not_due','1_30','31_60','61_90','over_90')},
                'reconciliation':{'net_documents_and_advances':str(money(net)),'matches':net==money(closing)},
                'contract':'trading-settlement-statement-v1','policy':{'role':user.profile.role,'store':user.profile.store_id},
                'query':{'party':party.pk,'store':store,'from':start.isoformat(),'to':end.isoformat()}}


def vouchers(user,params):
    from .services import ROLE_KINDS
    from .reporting import voucher_json
    with read_snapshot():
        user=current_actor(user)
        query=scoped(Voucher.objects.select_related('created_by'),user).filter(kind__in=ROLE_KINDS[user.profile.role])
        if user.profile.role not in {'owner','accountant'}:
            # Missing legacy scope is a store expense, as expense_permission defines.
            query=query.alias(read_expense_scope=Coalesce(KeyTextTransform('expense_scope','payload'),Value('store'),output_field=TextField())).exclude(kind='expense',read_expense_scope='network')
        if params.get('kind'):query=query.filter(kind__in=params['kind'].split(','))
        if params.get('status'):query=query.filter(status=params['status'])
        if params.get('party'):
            party=positive_integer(params['party'],'ID контрагента')
            query=query.filter(Q(party_id=party)|Q(kind='customer_return',reference__kind='sale',reference__party_id=party,reference__store_id=F('store_id')))
        if params.get('store'):query=query.filter(store_id=positive_integer(params['store'],'ID магазину'))
        query=filter_search(query,params);total=query.count();page,pages,offset=page_bounds(total,page_number(params))
        rows=list(query.order_by('-pk').defer('payload')[offset:offset+PAGE_SIZE])
        amounts=children.obligations([v for v in rows if v.status=='posted' and v.kind in SOURCE_KINDS],None)
        return {'items':[voucher_json(v,user=user,outstanding=amounts.get(v.pk)) for v in rows],
                'total':total,'page':page,'pages':pages}
