"""Read-only ABC analytics. Exact money, bounded ORM projection and private disk spool."""
import csv
import io
import json
import re
from contextlib import contextmanager
from decimal import Decimal
from types import SimpleNamespace
from django.http import StreamingHttpResponse
from django.db.models import Case, When, Value, BooleanField
from django.utils import timezone
from .bounded_reports import Spool, actor, NOTICE
from .browsing import page_number, page_bounds
from .csv_format import guarded
from .historical_reports import KYIV, read_snapshot, stores_for, period_documents, period_sign, require_reversal_dates
from .models import VoucherLine
from .services import day, money, require, ZERO

CONTRACT = 'trading-abc-v1'
CLASSES = ('A', 'B', 'C', 'unclassified')


def threshold(value):
    require(isinstance(value, str) and bool(re.fullmatch(r'\d{1,2}(?:\.\d{1,2})?', value)), 'Межі ABC мають бути відсотками з не більш ніж двома десятковими знаками.')
    return Decimal(value)


def context(user, params):
    today = timezone.localdate(timezone=KYIV)
    start = day(params.get('from') or today.replace(day=1).isoformat())
    end = day(params.get('to') or today.isoformat())
    require(start <= end <= today, 'Період має закінчуватись не раніше початку й не пізніше сьогодні.')
    a, b = threshold(params.get('aThreshold', '80')), threshold(params.get('bThreshold', '95'))
    require(ZERO < a < b < 100, 'Межі ABC мають задовольняти 0 < A < B < 100.')
    q = params.get('q', '').strip()
    require(len(q) <= 250, 'Пошук перевищує 250 символів.')
    selected = params.get('class', '')
    require(selected in ('', *CLASSES), 'Невідомий клас ABC.')
    stores, scoped = stores_for(user, params)
    return start, end, a, b, q, selected, stores, scoped


def percent(value, pool):
    return str((value * 100 / pool).quantize(Decimal('.0001'))) if pool else None


def populate(current,params,spool,start,end,a,b,stores,scoped,normalized):
    ids=[s.pk for s in stores]
    documents = period_documents(ids, start, end, kinds=['sale', 'customer_return'])
    query = VoucherLine.objects.filter(voucher_id__in=documents.values('pk')).annotate(
        hidden_current=Case(When(product__data__hidden=True,then=Value(True)),default=Value(False),output_field=BooleanField())
    ).order_by('pk').values(
        'product_id', 'name', 'unit', 'quantity', 'amount', 'cost', 'voucher__date',
        'voucher__reversed_at', 'voucher__kind', 'hidden_current')
    iterator = query.iterator(chunk_size=200)
    try:
        for line in iterator:
            sign = period_sign(SimpleNamespace(date=line['voucher__date'], reversed_at=line['voucher__reversed_at']), start, end)
            if not sign: continue
            direction = sign * (-1 if line['voucher__kind'] == 'customer_return' else 1)
            key = line['product_id']
            row = spool.get('aggregate', key) or {
                'product': key.removeprefix('products/'), 'name': line['name'], 'unit': line['unit'],
                'unitConflicted': False, 'hiddenCurrent': line['hidden_current'],
                'quantity': '0', 'netRevenue': '0', 'netCogs': '0'}
            if row['unit'] != line['unit']: row['unitConflicted'] = True
            for field, value in [('quantity', line['quantity']), ('netRevenue', line['amount']), ('netCogs', line['cost'])]:
                row[field] = str(Decimal(row[field]) + direction * value)
            spool.put('aggregate', key, row)
    finally: iterator.close()
    spool.db.execute('CREATE TABLE abc (key TEXT PRIMARY KEY, value TEXT, revenue TEXT, name TEXT)')
    spool.db.execute('CREATE INDEX abc_revenue ON abc(revenue COLLATE decimal DESC,key)')
    spool.db.execute('CREATE TABLE groups (revenue TEXT PRIMARY KEY, count INTEGER, classification TEXT, before_share TEXT, after_share TEXT)')
    spool.db.execute('CREATE INDEX groups_revenue ON groups(revenue COLLATE decimal DESC)')
    summary = {k: 0 for k in ('productCount', 'positiveCount', 'zeroCount', 'negativeCount', 'mixedUnitCount', 'hiddenCount')}
    pool = total = cogs = negative = ZERO
    for key, row in spool.scan('aggregate'):
        revenue, cost = money(Decimal(row['netRevenue'])), money(Decimal(row['netCogs']))
        total += revenue; cogs += cost; summary['productCount'] += 1
        summary['mixedUnitCount'] += int(row['unitConflicted']); summary['hiddenCount'] += int(row['hiddenCurrent'])
        summary['positiveCount' if revenue > 0 else 'negativeCount' if revenue < 0 else 'zeroCount'] += 1
        if revenue > 0:
            pool += revenue
            spool.db.execute('INSERT INTO groups(revenue,count) VALUES (?,1) ON CONFLICT(revenue) DO UPDATE SET count=count+1', (str(revenue),))
        elif revenue < 0: negative += revenue
        row.update(netRevenue=str(revenue), netCogs=str(cost), grossProfit=str(money(revenue-cost)),
                   quantity=None if row['unitConflicted'] else str(Decimal(row['quantity']).quantize(Decimal('.001'))),
                   unit=None if row['unitConflicted'] else row['unit'])
        spool.db.execute('INSERT INTO abc VALUES (?,?,?,?)', (key, json.dumps(row, ensure_ascii=False), str(revenue), row['name']))
    classes = {k: {'count': 0, 'netRevenue': ZERO, 'share': None} for k in CLASSES}
    cumulative = ZERO
    cursor = spool.db.execute('SELECT revenue,count FROM groups ORDER BY revenue COLLATE decimal DESC')
    for revenue, count in cursor:
        revenue = Decimal(revenue)
        label = 'A' if cumulative * 100 < pool * a else 'B' if cumulative * 100 < pool * b else 'C'
        after = cumulative + revenue * count
        spool.db.execute('UPDATE groups SET classification=?,before_share=?,after_share=? WHERE revenue=?', (label, percent(cumulative,pool),percent(after,pool),str(revenue)))
        classes[label]['count'] += count; classes[label]['netRevenue'] += revenue * count
        cumulative = after
    classes['unclassified'].update(count=summary['zeroCount']+summary['negativeCount'], netRevenue=negative)
    for label, values in classes.items():
        values['share'] = percent(values['netRevenue'],pool) if label != 'unclassified' else None
        values['netRevenue'] = str(money(values['netRevenue']))
    summary.update(netRevenue=str(money(total)), positivePoolRevenue=str(money(pool)), negativeRevenue=str(money(negative)),
                   netCogs=str(money(cogs)), grossProfit=str(money(total-cogs)), classes=classes)
    data = {'contract':CONTRACT,'from':start.isoformat(),'to':end.isoformat(),'store':normalized['store'],
            'scopeName':stores[0].name if scoped and stores else 'Усі доступні магазини' if not scoped else 'Магазин поза доступним контекстом',
            'aThreshold':str(a.quantize(Decimal('.01'))),'bThreshold':str(b.quantize(Decimal('.01'))),
            'basis':'net_revenue','reversalPolicy':'kyiv_reversed_at','snapshot':'current','snapshotNotice':NOTICE,
            'generatedAt':timezone.now().isoformat(),'tiePolicy':'before_group','captionBasis':'first_contributing_line','summary':summary}
    return data


@contextmanager
def built(user,params):
    from . import report_result_cache as cache
    with read_snapshot(), cache.read_limits() as deadline:
        current=actor(user)
        start,end,a,b,q,selected,stores,scoped=context(current,params)
        require_reversal_dates([s.pk for s in stores],end)
        normalized={'store':int(params['store']) if params.get('store') else current.profile.store_id,
                    'from':start.isoformat(),'to':end.isoformat(),'aThreshold':str(a.quantize(Decimal('.01'))),'bThreshold':str(b.quantize(Decimal('.01')))}
        def build(spool):return populate(current,params,spool,start,end,a,b,stores,scoped,normalized)
        with cache.image(current,'abc',normalized,stores,timezone.localdate(timezone=KYIV),build,deadline) as (spool,data):
            yield spool,data,q,selected


def query(q, selected):
    where, args = [], []
    if q:
        where.append("fold(a.name) LIKE ? ESCAPE '\\'")
        args.append('%'+q.casefold().replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%')
    if selected:
        where.append("COALESCE(g.classification,'unclassified')=?"); args.append(selected)
    return (' WHERE '+' AND '.join(where) if where else ''), args


def records(spool, pool, where, args, limit=None, offset=0):
    sql = 'SELECT a.value,g.classification,g.before_share,g.after_share FROM abc a LEFT JOIN groups g ON a.revenue=g.revenue'+where+' ORDER BY a.revenue COLLATE decimal DESC,a.key'
    if limit is not None: sql += ' LIMIT ? OFFSET ?'; args=[*args,limit,offset]
    cursor = spool.db.execute(sql,args)
    try:
        while batch := cursor.fetchmany(100):
            for raw, label, before, after in batch:
                spool.checkpoint();row=json.loads(raw)
                row.update(classification=label or 'unclassified', share=percent(Decimal(row['netRevenue']),pool) if label else None,
                           cumulativeBefore=before,cumulativeAfter=after)
                yield row
    finally: cursor.close()


def report(user, params):
    requested = page_number(params)
    with built(user,params) as (spool,data,q,selected):
        where,args=query(q,selected)
        total=spool.db.execute('SELECT COUNT(*) FROM abc a LEFT JOIN groups g ON a.revenue=g.revenue'+where,args).fetchone()[0]
        page,pages,offset=page_bounds(total,requested)
        return {**data,'q':q,'class':selected,'total':total,'page':page,'pages':pages,'limit':30,
                'items':list(records(spool,Decimal(data['summary']['positivePoolRevenue']),where,args,30,offset))}


FIELDS=[('product','ID товару'),('name','Товар'),('classification','Клас'),('netRevenue','Чистий виторг, грн'),('share','Частка позитивного виторгу, %'),('cumulativeBefore','Накопичено до групи, %'),('cumulativeAfter','Накопичено після групи, %'),('quantity','Чиста кількість'),('unit','Одиниця'),('unitConflicted','Різні одиниці'),('hiddenCurrent','Прихований зараз'),('netCogs','Чиста собівартість, грн'),('grossProfit','Валовий прибуток, грн')]


def export_csv(user,params):
    current=actor(user);context(current,params)
    def generate():
        with built(user,params) as (spool,data,q,selected):
            buffer=io.StringIO(newline='');writer=csv.writer(buffer,delimiter=';',quoting=csv.QUOTE_ALL,lineterminator='\r\n')
            def record(values):
                buffer.seek(0);buffer.truncate();writer.writerow(values);return buffer.getvalue()
            yield '\ufeff'
            yield record(['ABC — чистий виторг',('\t'+data['scopeName'] if guarded(data['scopeName']) else data['scopeName']),data['from'],data['to'],'A '+data['aThreshold']+'%; B '+data['bThreshold']+'%',data['generatedAt'],data['snapshotNotice']])
            yield record(['Позитивний пул',data['summary']['positivePoolRevenue'],'Непозитивних SKU',data['summary']['zeroCount']+data['summary']['negativeCount'],'Лише проведені системні продажі/повернення. Назви: перший рядок проведення; прихованість: зараз; рівні виторги: клас до групи. Повноту касових вигрузок/історичних закупівель не оцінено.'])
            yield record([label for _,label in FIELDS])
            where,args=query(q,selected)
            for row in records(spool,Decimal(data['summary']['positivePoolRevenue']),where,args):
                yield record(['' if row[key] is None else '\t'+str(row[key]) if key in {'product','name','unit'} and guarded(str(row[key])) else row[key] for key,_ in FIELDS])
    response=StreamingHttpResponse(generate(),content_type='text/csv; charset=utf-8')
    response['Content-Disposition']='attachment; filename="abc-report.csv"';response['Cache-Control']='private, no-store'
    return response
