"""Report-only child streams. Legacy posting/settlement callers keep their original adapters.
All SQL fragments come from this module and Django's scoped query compiler, never request text.
JSON arrays are expanded by the database; only one scalar child record is decoded at a time.
"""
import json
from contextlib import closing
from datetime import datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from django.core.exceptions import EmptyResultSet
from django.db import connection
from django.db.models import Exists, OuterRef, Q, F
from django.db.models import JSONField, BooleanField, CharField
from django.db.models.expressions import RawSQL
from .models import Document, PaymentAllocation, Voucher
from .services import BusinessError, ZERO, dec, money
from .settlements import SOURCE_KINDS, active
from .historical_reports import KYIV

CHUNK = 200
HEADER_FIELDS = ('id','kind','status','date','reversed_at','store_id','total','cost','party_id','reference_id','employee_id','shift_id','posted_at')


def headers(query, *, party=False, reference=False):
    fields = list(HEADER_FIELDS)
    if party: fields += ['party__id','party__name','party__kind']
    if reference: fields += ['reference__id','reference__kind']
    table=connection.ops.quote_name(Voucher._meta.db_table)
    base=table+'.'+connection.ops.quote_name('payload')
    annotations={}
    for alias,key in [('scope','expense_scope'),('category','category'),('difference','difference'),('due','due_date')]:
        if connection.vendor=='postgresql':
            value=f"{base}->'{key}'"; kind=f"jsonb_typeof({value})"
            present=f"{base} ? '{key}'"
            scalar=f"{kind} IN ('string','number','boolean','null')"
            expression=f"CASE WHEN {scalar} THEN {value} ELSE 'null'::jsonb END"
        else:
            path="'$."+key+"'"; kind=f"json_type({base},{path})"
            present=f"{kind} IS NOT NULL"; scalar=f"{kind} IN ('text','integer','real','true','false','null')"
            expression=f"CASE WHEN {scalar} THEN ({base} -> {path}) END"
        annotations['report_'+alias]=RawSQL(expression,[],output_field=JSONField())
        annotations['report_'+alias+'_kind']=RawSQL(kind,[],output_field=CharField())
        annotations['report_'+alias+'_present']=RawSQL(present,[],output_field=BooleanField())
        annotations['report_'+alias+'_bad']=RawSQL(f"({present} AND NOT ({scalar}))",[],output_field=BooleanField())
    root=f"jsonb_typeof({base})" if connection.vendor=='postgresql' else f"json_type({base})"
    annotations['report_payload_bad']=RawSQL(f"{root}!='object'",[],output_field=BooleanField())
    return query.only(*fields).annotate(**annotations)


def payload(voucher, keys=None):
    if keys is None:keys=('scope','category') if voucher.kind=='expense' else ('difference',) if voucher.kind=='cash_difference' else ()
    if keys and (voucher.report_payload_bad or any(getattr(voucher,'report_'+alias+'_bad') for alias in keys)):
        raise BusinessError(f'Документ {voucher.pk} має некоректні реквізити показника; перевірте регістри.')
    fields={'scope':'expense_scope','category':'category','difference':'difference','due':'due_date'}
    voucher.payload={}
    for alias in keys:
        if getattr(voucher,'report_'+alias+'_present'):
            kind=getattr(voucher,'report_'+alias+'_kind');value=getattr(voucher,'report_'+alias)
            voucher.payload[fields[alias]]=kind=='true' if kind in {'true','false'} else value
    return voucher


def stock_captions(query):
    # Resolve the product join, but never select its whole data (including legacy recipes).
    query=query.alias(_report_product_data=F('lot__product__data'))
    base=connection.ops.quote_name(Document._meta.db_table)+'.'+connection.ops.quote_name('data')
    annotations={}
    for key in ('name','unit'):
        if connection.vendor=='postgresql':
            value=f"{base}->'{key}'";kind=f'jsonb_typeof({value})';present=f"{base} ? '{key}'"
            scalar=f"{kind} IN ('string','number','boolean','null')"
            expression=f"CASE WHEN {scalar} THEN {value} ELSE 'null'::jsonb END"
        else:
            kind=f"json_type({base},'$.{key}')";present=f'{kind} IS NOT NULL'
            scalar=f"{kind} IN ('text','integer','real','true','false','null')"
            expression=f"CASE WHEN {scalar} THEN ({base} -> '$.{key}') END"
        annotations['report_'+key]=RawSQL(expression,[],output_field=JSONField())
        annotations['report_'+key+'_kind']=RawSQL(kind,[],output_field=CharField())
        annotations['report_'+key+'_present']=RawSQL(present,[],output_field=BooleanField())
        annotations['report_'+key+'_bad']=RawSQL(f'({present} AND NOT ({scalar}))',[],output_field=BooleanField())
    return query.annotate(**annotations)


def stock_caption(entry,key,default):
    if getattr(entry,'report_'+key+'_bad'):
        raise BusinessError(f'Товар партії {entry.lot_id} має некоректний підпис; перевірте каталог.')
    if not getattr(entry,'report_'+key+'_present'):return default
    kind=getattr(entry,'report_'+key+'_kind');value=getattr(entry,'report_'+key)
    return kind=='true' if kind in {'true','false'} else value


def nonzero_period(query,start,end):
    first=datetime.combine(start,time.min,tzinfo=KYIV)
    after=datetime.combine(end+timedelta(days=1),time.min,tzinfo=KYIV)
    return query.exclude(Q(date__range=(start,end)) & Q(reversed_at__gte=first,reversed_at__lt=after))


def active_query(query, cutoff, prefix=''):
    if cutoff is None: return query.filter(**{prefix+'status':'posted'})
    after = datetime.combine(cutoff + timedelta(days=1),time.min,tzinfo=KYIV)
    return query.filter(**{prefix+'status__in':['posted','reversed'],prefix+'date__lte':cutoff}).filter(
        Q(**{prefix+'reversed_at__isnull':True}) | Q(**{prefix+'reversed_at__gte':after}))


def active_allocations(query, cutoff):
    for prefix in ('settlement__','payment__','source__'): query=active_query(query,cutoff,prefix)
    return query


def cursor_rows(sql, params):
    with connection.chunked_cursor() as cursor:
        cursor.execute(sql,params)
        while rows := cursor.fetchmany(CHUNK):
            yield from rows


def json_children(query, array, *, include_product=True):
    """Yield (voucher ID, reference ID, raw scalar value, raw product) without payload materialization.
    Missing arrays are empty; present malformed arrays/items are refused, not silently zeroed.
    Float JSON values retain Python json.loads/Decimal behavior used by the old oracle.
    """
    if array not in {'payments','differences'}: raise ValueError('Unapproved report JSON array')
    field = 'amount' if array=='payments' else 'value'
    try:subquery,params=query.order_by().values('pk').query.sql_with_params()
    except EmptyResultSet:return
    table=connection.ops.quote_name(Voucher._meta.db_table)
    if connection.vendor=='postgresql':
        path="v.payload->%s"
        sql=f"SELECT v.id, jsonb_typeof({path}) FROM {table} v WHERE v.id IN ({subquery}) AND (jsonb_typeof(v.payload)!='object' OR (v.payload ? %s AND jsonb_typeof({path}) IS DISTINCT FROM 'array'))"
        with closing(cursor_rows(sql,[array,*params,array,array])) as rows:invalid=next(rows,None)
        if invalid: raise BusinessError(f'Документ {invalid[0]} має некоректні реквізити показника; перевірте регістри.')
        product_sql="CASE WHEN jsonb_typeof(j.item->'product') IN ('string','number','boolean','null') THEN (j.item->'product')::text END, jsonb_typeof(j.item->'product')" if array=='differences' and include_product else 'NULL, NULL'
        sql=f"""SELECT v.id,v.reference_id,
        jsonb_typeof(j.item),jsonb_typeof(j.item->%s),
        CASE WHEN jsonb_typeof(j.item->%s) IN ('string','number','boolean','null') THEN (j.item->%s)::text END,
        {product_sql}
        FROM {table} v CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.payload->%s,'[]'::jsonb)) WITH ORDINALITY j(item,n)
        WHERE v.id IN ({subquery}) ORDER BY v.id,j.n"""
        args=[field,field,field,array,*params]
    elif connection.vendor=='sqlite':
        path='$.'+array
        sql=f"SELECT v.id,json_type(v.payload,%s) FROM {table} v WHERE v.id IN ({subquery}) AND (json_type(v.payload)!='object' OR (json_type(v.payload,%s) IS NOT NULL AND json_type(v.payload,%s)!='array'))"
        with closing(cursor_rows(sql,[path,*params,path,path])) as rows:invalid=next(rows,None)
        if invalid: raise BusinessError(f'Документ {invalid[0]} має некоректні реквізити показника; перевірте регістри.')
        # The -> JSON token preserves float digits and integers beyond SQLite int64.
        product_sql="CASE WHEN j.type='object' AND json_type(j.value,'$.product') IN ('text','integer','real','true','false','null') THEN (j.value -> '$.product') END,CASE WHEN j.type='object' THEN json_type(j.value,'$.product') END" if array=='differences' and include_product else 'NULL, NULL'
        sql=f"""SELECT v.id,v.reference_id,j.type,
        CASE WHEN j.type='object' THEN json_type(j.value,%s) END,
        CASE WHEN j.type='object' AND json_type(j.value,%s) IN ('text','integer','real','true','false','null')
             THEN (j.value -> %s) END,
        {product_sql}
        FROM {table} v JOIN json_each(v.payload,%s) j WHERE v.id IN ({subquery}) ORDER BY v.id,CAST(j.key AS INTEGER)"""
        args=['$.'+field]*3+[path,*params]
    else: raise BusinessError('Обмежене читання JSON звітів потребує PostgreSQL або SQLite QA.')
    for pk,reference,kind,value_kind,raw,product,product_kind in cursor_rows(sql,args):
        if kind!='object' or value_kind not in {'string','number','boolean','null','text','integer','real','true','false'} or product_kind not in {None,'string','number','boolean','null','text','integer','real','true','false'}:
            raise BusinessError(f'Документ {pk} має некоректні реквізити показника; перевірте регістри.')
        value=json.loads(raw);product=json.loads(product) if product is not None else ''
        yield pk,reference,value,product


def inventory_totals(query, spool):
    for pk,_,raw,product in json_children(query.filter(kind='inventory'),'differences'):
        try:
            amount=Decimal(raw)
            if not amount.is_finite(): raise InvalidOperation
        except (ValueError,TypeError,InvalidOperation):
            raise BusinessError(f'Документ {pk} має некоректні реквізити показника; перевірте регістри.') from None
        spool.add('_inventory',pk,{'amount':'0'},{'amount':amount})
        key=json.dumps([pk,str(product).removeprefix('products/')],separators=(',',':'))
        spool.add('_inventory_product',key,{'amount':'0'},{'amount':amount})


def obligations(sources, cutoff):
    """Fixed four scalar accumulators per source; exact old obligation decomposition/rounding."""
    ids=[s.pk for s in sources]
    parts={pk:{key:ZERO for key in ('returned','paid','embedded','refunded')} for pk in ids}
    mapped=active_allocations(PaymentAllocation.objects.filter(source_id=OuterRef('reference_id'),settlement_id=OuterRef('pk'),settlement__kind='payment'),cutoff)
    events=Voucher.objects.filter(reference_id__in=ids,kind__in=['customer_return','supplier_return','payment'],status__in=['posted','reversed'])
    for event in events.only('id','reference_id','kind','total','status','date','reversed_at').annotate(report_mapped=Exists(mapped)).iterator(chunk_size=CHUNK):
        if not active(event,cutoff): continue
        if event.kind=='payment':
            if not event.report_mapped: parts[event.reference_id]['paid']+=event.total
        else: parts[event.reference_id]['returned']+=event.total
    for source,amount in active_allocations(PaymentAllocation.objects.filter(source_id__in=ids),cutoff).values_list('source_id','amount').iterator(chunk_size=CHUNK): parts[source]['paid']+=amount
    for pk,_,amount,_ in json_children(Voucher.objects.filter(pk__in=ids,kind='sale'),'payments'): parts[pk]['embedded']+=dec(amount)
    for _,source,amount,_ in json_children(active_query(events.filter(kind__in=['customer_return','supplier_return']),cutoff),'payments'): parts[source]['refunded']+=dec(amount)
    return {source.pk:source.total-money(parts[source.pk]['returned'])-money(parts[source.pk]['paid'])-parts[source.pk]['embedded']+parts[source.pk]['refunded'] for source in sources}


def advances(payments, cutoff):
    """Old advance_balances equation; unbounded children never populate a QuerySet result cache."""
    ids=[v.pk for v in payments];spent=dict.fromkeys(ids,ZERO)
    for payment,amount in active_allocations(PaymentAllocation.objects.filter(payment_id__in=ids),cutoff).values_list('payment_id','amount').iterator(chunk_size=CHUNK): spent[payment]+=amount
    # Legacy mapped suppression is deliberately unconditional, exactly like advance_balances.
    mapped=PaymentAllocation.objects.filter(settlement_id=OuterRef('pk'))
    for payment in Voucher.objects.filter(pk__in=ids).only('id','reference_id','reference__kind','total','kind','status','date','reversed_at').select_related('reference').annotate(report_mapped=Exists(mapped)).iterator(chunk_size=CHUNK):
        if payment.reference_id and payment.reference.kind in SOURCE_KINDS and not payment.report_mapped and active(payment,cutoff): spent[payment.pk]+=payment.total
    for refund in active_query(Voucher.objects.filter(reference_id__in=ids,kind='payment_refund',status__in=['posted','reversed']),cutoff).only('id','reference_id','total').iterator(chunk_size=CHUNK): spent[refund.reference_id]+=refund.total
    return {payment.pk:money(payment.total-spent[payment.pk]) if active(payment,cutoff) else ZERO for payment in payments}
