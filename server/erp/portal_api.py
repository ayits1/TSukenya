"""Compact legacy-shell reads. Catalogue model is equal-weight legacy pricing, not campaign/POS pricing."""
import csv
import hashlib
import io
import json
import math
import re
from datetime import datetime, timedelta, timezone as dt_timezone
from decimal import Decimal, InvalidOperation, localcontext, ROUND_HALF_UP
from zoneinfo import ZoneInfo
from django.db import transaction
from django.http import HttpResponse, StreamingHttpResponse
from django.utils import timezone
from .models import Document
from .catalog import defaults, decimal, plain, regular_price, revision
from .catalog_access import revalidate_actor
from .services import require, ledger_lock, current_actor
from .historical_reports import read_snapshot
from .financial_scope import require_network_owner, network_owner
from .browsing import positive_integer
from .csv_format import MARKER, guarded

KYIV=ZoneInfo('Europe/Kyiv')


def legacy_number(value):
    """Readonly Decimal adapter for the old shell's finite parseFloat/comma convention."""
    source=str(value).replace(',', '.', 1).lstrip().lstrip('\ufeff')
    match=re.match(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?',source)
    if match:
        result=Decimal(match[0])
        if math.isfinite(float(result)):return result
    return Decimal(0)


def legacy_sale_price(data,config):
    # regularPrice was already authoritative in the legacy full-state DTO.
    regular=regular_price(data,config);promotion=legacy_number(data.get('promotionPrice'))
    if data.get('promotion') and 0<promotion<regular and promotion==promotion.quantize(Decimal('.01')):return promotion
    return regular


def legacy_stale_days(data):
    value=data.get('staleDays')
    if value is None:return Decimal(30)
    if isinstance(value,bool):return Decimal(int(value))
    if isinstance(value,str) and not value.strip():return Decimal(0)
    try:
        result=Decimal(str(value))
        return result if result.is_finite() else None
    except (InvalidOperation,ValueError):return None


def price_timestamp(value):
    """JS Date.parse parity for supported ISO legacy priceAt: date-only UTC, naive datetime Kyiv."""
    if not isinstance(value,str) or not value:return None
    try:
        if re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}',value):return datetime.fromisoformat(value).replace(tzinfo=dt_timezone.utc)
        result=datetime.fromisoformat(value.replace('Z','+00:00'))
        return result.replace(tzinfo=KYIV) if result.tzinfo is None else result
    except ValueError:return None


def summary(user, *, model=False):
    if model:require_network_owner(user)
    now=timezone.now()
    with read_snapshot(strict=False),localcontext() as context:
        user=current_actor(user)
        if model:require_network_owner(user)
        context.prec=40
        config=defaults();settings=Document.objects.filter(pk='settings/main').first()
        data=settings.data if settings else {}
        days=legacy_stale_days(data)
        counts={'catalogCount':0,'noPriceCount':0,'stalePriceCount':0,'exampleCount':0,'allExampleCount':0}
        total_margin=Decimal(0);coverage=0;next_change=None
        minimum=maximum=None;nonpositive=0
        for product in Document.objects.filter(path__startswith='products/').order_by('path').iterator(chunk_size=200):
            p=product.data
            if p.get('example'):counts['allExampleCount']+=1
            if p.get('hidden'):continue
            if p.get('example'):counts['exampleCount']+=1;continue
            counts['catalogCount']+=1
            price=legacy_sale_price(p,config)
            if price<=0:counts['noPriceCount']+=1
            else:
                stamp=price_timestamp(p.get('priceAt'))
                elapsed=now-stamp if stamp else None
                elapsed_days=Decimal(elapsed.days)+(Decimal(elapsed.seconds)+Decimal(elapsed.microseconds)/1000000)/86400 if elapsed else Decimal(0)
                if stamp is None or days is not None and elapsed_days>days:counts['stalePriceCount']+=1
                elif stamp is not None and days is not None:
                    try:threshold=stamp+timedelta(days=float(days))
                    except (OverflowError,ValueError):threshold=None
                    if threshold is not None and (next_change is None or threshold<next_change):next_change=threshold
            if model:
                cost=legacy_number(p.get('cost'))
                if cost>0 and price>0:
                    margin=(price-cost)/price
                    coverage+=1;total_margin+=margin
                    minimum=margin if minimum is None else min(minimum,margin)
                    maximum=margin if maximum is None else max(maximum,margin)
                    nonpositive+=margin<=0
        result={**counts,'generatedAt':now.isoformat(),'nextChangeAt':(next_change+timedelta(milliseconds=1)).isoformat() if next_change else None,
                'priceBasis':'legacy_product_promotion','staleBasis':'elapsed_24h_strict_greater'}
        if model or network_owner(user):
            expenses=Document.objects.filter(path__startswith='expenses/').values_list('data',flat=True).iterator(chunk_size=200)
            fixed=variable=Decimal(0)
            for expense in expenses:
                amount=decimal(expense.get('amount'))
                if expense.get('group')=='fixed':fixed+=amount
                else:variable+=amount
            result['plannedExpenses']=format(fixed+variable,'.2f')
        if model:
            from .catalogue_range import catalogue_range
            result['marginRange']=catalogue_range(minimum=minimum,maximum=maximum,coverage=coverage,
                nonpositive=nonpositive,expenses=fixed+variable)
            average=total_margin/coverage if coverage else Decimal(0)
            from .budget import budget_count
            needed=(fixed+variable)/average if average>0 else None
            rounded=lambda value:format(value.quantize(Decimal('.01'),rounding=ROUND_HALF_UP),'f')
            result.update(breakEvenDaily=rounded(needed/30) if needed is not None else None,breakEvenPerStore=rounded(needed/30/budget_count(data)) if needed is not None else None,marginPercent=format((average*100).quantize(Decimal('1'),rounding=ROUND_HALF_UP),'f'),basis='legacy_catalogue_equal_weight',fixed=format(fixed,'.2f'),variable=format(variable,'.2f'),coverage=coverage,
                equalWeightMargin=plain(average),breakEvenRevenue=rounded(needed) if needed is not None else None,
                reason='ready' if average>0 else 'no_coverage' if not coverage else 'nonpositive_margin',budgetStores=budget_count(data))
        # A value version, not a global/private audit sequence. Reads never write.
        result['revision']=hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()
        return result


def sales_margin(user):
    require_network_owner(user)
    from .promotion_prices import kyiv_day
    from .historical_reports import period_documents,period_sign,require_reversal_dates
    from .models import Store
    from .report_contributions import voucher_contributions
    end=kyiv_day();start=end-timedelta(days=29)
    with read_snapshot(strict=False),localcontext() as context:
        user=current_actor(user)
        require_network_owner(user)
        context.prec=40
        ids=set(Store.objects.values_list('pk',flat=True));require_reversal_dates(ids,end)
        revenue=cogs=Decimal(0)
        for voucher in period_documents(ids,start,end,kinds=('sale','customer_return')).iterator(chunk_size=200):
            contributions=voucher_contributions(voucher,period_sign(voucher,start,end),scoped=False)
            revenue+=contributions.get('revenue',Decimal(0));cogs+=contributions.get('cogs',Decimal(0))
        plan=sum((decimal(p.get('amount')) for p in Document.objects.filter(path__startswith='expenses/').values_list('data',flat=True).iterator(chunk_size=200)),Decimal(0))
        gross=revenue-cogs;margin=gross/revenue if revenue>0 else Decimal(0);daily=revenue/30
        need=plan/margin/30 if revenue>0 and margin>0 else None
        rounded=lambda v:format(v.quantize(Decimal('.01'),rounding=ROUND_HALF_UP),'f')
        return {'from':start.isoformat(),'to':end.isoformat(),'revenue':rounded(revenue),'gross':rounded(gross),'dailyRevenue':rounded(daily),
            'marginPercent':format((margin*100).quantize(Decimal('1'),rounding=ROUND_HALF_UP),'f'),'needDaily':rounded(need) if need is not None else None,
            'gapDaily':rounded(need-daily) if need is not None else None,'basis':'accounting_dates_30d_weighted',
            'reason':'no_sales' if revenue<=0 else 'nonpositive_margin' if margin<=0 else 'ready'}


def examples(user,params):
    require(user.profile.role=='owner','Недостатньо прав. Приклади може прибирати лише власник.')
    page=positive_integer(params.get('page','1'),'Сторінка')
    with read_snapshot(strict=False):
        config=defaults();query=Document.objects.filter(path__startswith='products/',data__example=True).order_by('path')
        total=query.count();pages=max(1,(total+29)//30);page=min(page,pages)
        items=[{'id':d.path.split('/',1)[1],'name':str(d.data.get('name') or ''),'hidden':bool(d.data.get('hidden')),'revision':revision(d,config)} for d in query[(page-1)*30:page*30]]
        return {'items':items,'total':total,'page':page,'pages':pages,'limit':30}


@transaction.atomic
def delete_examples(request,user):
    from .views import body,response,legacy_mutation
    payload=body(request)
    require(set(payload)=={'items','idempotencyKey'},'Некоректний пакет прибирання прикладів.')
    key=payload.get('idempotencyKey')
    require(isinstance(key,str) and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',key),'Потрібний UUID прибирання.')
    items=payload.get('items')
    require(isinstance(items,list) and 1<=len(items)<=30,'Виберіть від 1 до 30 прикладів.')
    require(all(isinstance(item,dict) and set(item)=={'id','revision'} and isinstance(item['id'],str) and re.fullmatch(r'[A-Za-z0-9_-]{1,120}',item['id']) and isinstance(item['revision'],str) and re.fullmatch(r'[a-f0-9]{64}',item['revision']) for item in items),'Некоректна версія прикладу.')
    require(len({item['id'] for item in items})==len(items),'Повторені приклади.')
    digest=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    ledger_lock();revalidate_actor(user,{'owner'},'Недостатньо прав. Приклади може прибирати лише власник.')
    path='cleanup_runs/'+key;receipt=Document.objects.filter(pk=path).first()
    if receipt:
        if receipt.data['owner']!=user.pk or receipt.data['hash']!=digest:return response({'error':'Ключ прибирання вже використано.','code':'idempotency_conflict'},409)
        return response(receipt.data['result'])
    results=[]
    from .services import BusinessError
    for item in items:
        document=Document.objects.filter(pk='products/'+item['id']).first()
        if document is None or document.data.get('example') is not True:
            results.append({'id':item['id'],'status':'rejected','error':'Товар відсутній або вже не є прикладом.'});continue
        if revision(document)!=item['revision']:
            results.append({'id':item['id'],'status':'conflicted','error':'Товар уже змінено. Оновіть список.'});continue
        # Reuse all current stock/recipe/production/campaign guards and audit.
        from types import SimpleNamespace
        deletion=SimpleNamespace(method='DELETE',headers={'If-Match':item['revision']})
        try:
            with transaction.atomic():result=legacy_mutation(deletion,user,document.path)
            value=json.loads(result.content)
            results.append({'id':item['id'],'status':'deleted'} if result.status_code==200 else {'id':item['id'],'status':'conflicted','error':value['error']})
        except BusinessError as error:results.append({'id':item['id'],'status':'rejected','error':str(error)})
    result={'ok':True,'idempotencyKey':key,'items':results}
    Document.objects.create(path=path,data={'owner':user.pk,'hash':digest,'result':result})
    return response(result)


def catalogue_csv(user,params):
    require(set(params)<= {'includeHidden','store'},'Невідомий параметр експорту.')
    hidden=params.get('includeHidden','false');require(hidden in {'true','false'},'Некоректний параметр прихованих товарів.')
    require(hidden!='true' or user.profile.role=='owner','Приховані товари доступні для експорту лише власнику.')
    from .promotion_prices import context_store
    context_store(user,params.get('store'))
    def generate():
        from .promotion_prices import PriceResolver,context_store
        buffer=io.StringIO(newline='');writer=csv.writer(buffer,delimiter=';',quoting=csv.QUOTE_ALL,lineterminator='\r\n')
        def row(values):
            buffer.seek(0);buffer.truncate(0);writer.writerow([('\t'+str(value)) if guarded(str(value)) else str(value) for value in values]);return buffer.getvalue()
        # Generator owns the snapshot until consumed/closed; SQL cursor is bounded.
        with read_snapshot():
            user.refresh_from_db(fields=['is_active']);user.profile.refresh_from_db()
            require(user.is_active,'Обліковий запис вимкнено.')
            require(hidden!='true' or user.profile.role=='owner','Приховані товари доступні для експорту лише власнику.')
            private=user.profile.role!='cashier';config=defaults();store=context_store(user,params.get('store'))
            query=Document.objects.filter(path__startswith='products/').order_by('path')
            if hidden=='false':query=query.filter(Q(data__hidden__isnull=True)|~Q(data__hidden=True))
            from .catalog_schema import columns, schema
            export_fields=columns(private=private)
            headers=[field['label'] for field in export_fields]
            headers[0]+=schema()['marker']+MARKER
            yield '\ufeff'+row(headers)
            iterator=query.iterator(chunk_size=100)
            from itertools import islice
            while batch:=list(islice(iterator,100)):
                resolver=PriceResolver(config,store,product_paths=[d.path for d in batch])
                for document in batch:
                    p=document.data;prices=resolver.resolve(document)
                    values={k:p.get(k,'') or '' for k in ('name','type','category','pack','size','unit','barcode')}
                    values.update(cost=format(decimal(p['cost']),'.2f') if p.get('cost') is not None else '',markup=plain(decimal(p['markup'])) if p.get('markup') is not None else '',
                        manualPrice='Ручна' if p.get('manualPrice') else 'Автоматична',
                        price=format(decimal(p.get('price')),'.2f') if p.get('manualPrice') and p.get('price') is not None else '',
                        promotion='Так' if p.get('promotion') else 'Ні',
                        promotionPrice=format(decimal(p.get('promotionPrice')),'.2f') if p.get('promotionPrice') is not None else '',
                        regularPrice=prices['regularPrice'],salePrice=prices['salePrice'],
                        effectivePromotion='Так' if prices['effectivePromotion'] else 'Ні',
                        per100=format((decimal(prices['salePrice'])/10).quantize(Decimal('.01'),rounding=ROUND_HALF_UP),'.2f') if p.get('unit')=='кг' else '',
                        priceAt=p.get('priceAt') or '',hidden='Так' if p.get('hidden') else 'Ні',id=document.path.split('/',1)[1])
                    yield row([values[field['key']] for field in export_fields])
    from django.db.models import Q
    result=StreamingHttpResponse(generate(),content_type='text/csv; charset=utf-8')
    result['Content-Disposition']='attachment; filename="catalogue.csv"';result['Cache-Control']='private, no-store'
    return result


def handle_portal(request,user):
    if request.path=='/api/v1/portal/create-identity' and request.method=='GET':
        from .legacy_create_identity import identity
        result=HttpResponse(json.dumps(identity(user,request.GET),ensure_ascii=False),content_type='application/json')
        result['Cache-Control']='private, no-store'
        return result
    from .views import response,legacy_state
    path=request.path
    if path=='/api/v1/portal/budget-template':
        from .budget_template import read, save
        if request.method=='GET':return response(read(user))
        if request.method=='PATCH':return save(request,user)
        return HttpResponse(status=405)
    if request.method=='GET':
        record=re.fullmatch(r'/api/v1/portal/records/(tasks|ideas|expenses)/([A-Za-z0-9_-]{1,120})',path)
        if record:
            from .legacy_records import read_record
            return response(read_record(user,*record.groups()))
        if path=='/api/v1/portal/metadata':
            from .state_polling import state_response
            from .portal_collections import metadata
            return state_response(request,user,metadata,metadata=True,contract='portal-metadata-v2')
        if path.startswith('/api/v1/portal/collections/'):
            from .portal_collections import page,task,summary as collection_summary
            name=path.removeprefix('/api/v1/portal/collections/')
            if name=='summary':return response(collection_summary(user,request.GET))
            if name.startswith('tasks/'):return response(task(user,name.removeprefix('tasks/')))
            if name in {'tasks','ideas','expenses'}:return response(page(user,name,request.GET))
        if path=='/api/v1/portal/state':
            from .state_polling import state_response
            return state_response(request,user,lambda actor,effective_day:legacy_state(actor,effective_day,include_products=False),metadata=True)
        if path=='/api/v1/portal/overview':return response(summary(user))
        if path=='/api/v1/portal/catalogue-model':return response(summary(user,model=True))
        if path=='/api/v1/portal/sales-margin':return response(sales_margin(user))
        if path=='/api/v1/portal/examples':return response(examples(user,request.GET))
        if path=='/api/v1/portal/catalogue.csv':return catalogue_csv(user,request.GET)
    if path=='/api/v1/portal/examples/delete' and request.method=='POST':return delete_examples(request,user)
    return HttpResponse(status=404)
