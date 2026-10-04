"""Bounded purchase journal and read-only replenishment projections.

The stock CTE is shared with Stock. SQL groups/counts; Python holds at most 30
headers, three previews per header, a 100-row cursor batch, or one 200-line draft
part. Full-group keyed digests fence lazy pages and explicit draft parts.
"""
import hashlib
import hmac
import json
from decimal import Context, Decimal

from django.conf import settings
from django.db import connection

from .browsing import PAGE_SIZE, filter_search, page_bounds, page_number, positive_integer
from .historical_reports import read_snapshot
from .models import Voucher
from .reporting import scoped
from .services import Conflict, current_actor, money, permission, require
from .stock_browsing import options as stock_options, source_sql

KINDS = ('purchase_order', 'receipt', 'supplier_return')
DRAFT_LIMIT = 200


def policy(user):
    permission(user, 'purchase_order')
    return {'role': user.profile.role, 'store': user.profile.store_id, 'documentKinds': list(KINDS)}


def validate(params, allowed):
    require(not set(params) - allowed, 'Невідомий параметр закупівель.')
    require(all(isinstance(value, str) for value in params.values()), 'Некоректні параметри закупівель.')
    if hasattr(params, 'getlist'):
        require(all(len(params.getlist(key)) == 1 for key in params), 'Параметр закупівель повторюється.')


def documents(user, params):
    validate(params, {'q', 'store', 'status', 'kind', 'from', 'to', 'page'})
    with read_snapshot():
        user = current_actor(user)
        auth = policy(user)
        kind, status = params.get('kind', ''), params.get('status', '')
        require(kind in ('', *KINDS), 'Невідомий вид закупівлі.')
        require(status in {'', 'draft', 'posted', 'reversed'}, 'Невідомий стан документа.')
        store = positive_integer(params['store'], 'ID магазину') if params.get('store') else None
        query = scoped(Voucher.objects.filter(kind__in=KINDS), user)
        if kind: query = query.filter(kind=kind)
        if status: query = query.filter(status=status)
        if store: query = query.filter(store_id=store)
        query = filter_search(query, params)
        total = query.count()
        page, pages, offset = page_bounds(total, page_number(params))
        rows = query.order_by('-date', '-pk').values('id', 'kind', 'status', 'date', 'store_id', 'store__name', 'party_id', 'party__name', 'total', 'revision')[offset:offset + PAGE_SIZE]
        return {'items': [{'id': row['id'], 'number': f"{row['id']:06}", 'kind': row['kind'], 'status': row['status'],
                           'date': row['date'].isoformat(), 'store': row['store_id'], 'storeName': row['store__name'],
                           'party': row['party_id'], 'partyName': row['party__name'] or '',
                           'total': format(row['total'], '.2f'), 'revision': row['revision']} for row in rows],
                'total': total, 'page': page, 'pages': pages, 'limit': PAGE_SIZE, 'policy': auth,
                'query': {'q': params.get('q', '').strip(), 'store': store, 'status': status, 'kind': kind,
                          'from': params.get('from', ''), 'to': params.get('to', '')}}


def decimal(value, places):
    # Scalar database decimals only. Invalid source values raise, never become 0.
    return format(Decimal(str(value)).quantize(Decimal(1).scaleb(-places)), 'f')


class DecimalSum:
    def __init__(self): self.value = Decimal(0)
    def step(self, value): self.value += Decimal(str(value))
    def finalize(self): return format(self.value, 'f')


def source(user, params):
    value = stock_options(user, {**{key: params[key] for key in ('store', 'warehouse') if key in params}, 'q': ''})
    search = params.get('q', '').strip()
    require(len(search) <= 250, 'Пошуковий запит задовгий.')
    sql, args, today = source_sql(value)
    pg = connection.vendor == 'postgresql'
    if not pg:
        db = connection.connection
        # Match Django's SQLite DecimalField conversion for the historical
        # price oracle; PostgreSQL retains the stored NUMERIC exactly.
        price_context = Context(prec=15)
        db.create_function('tsukenya_purchase_price', 1, lambda value:
                           None if value is None else format(price_context.create_decimal_from_float(value).quantize(Decimal('.0001')), 'f'))
        db.create_function('tsukenya_purchase_need', 3, lambda minimum, available, ordered:
                           decimal(Decimal(str(minimum)) - Decimal(str(available)) - Decimal(str(ordered)), 3))
        db.create_function('tsukenya_purchase_money', 2, lambda need, price: format(money(Decimal(str(need)) * Decimal(str(price))), '.2f'))
        db.create_aggregate('tsukenya_purchase_sum', 1, DecimalSum)
    need = 'minimum-available-on_order'
    # Decimal.quantize(QTY) uses HALF_EVEN; keep the legacy oracle even for old
    # catalogue minima with extra precision. PostgreSQL round alone is HALF_UP.
    qty = f"CASE WHEN ABS(({need})*1000-TRUNC(({need})*1000))=0.5 THEN (TRUNC(({need})*1000)+MOD(ABS(TRUNC(({need})*1000)),2)*SIGN({need}))/1000 ELSE ROUND({need},3) END" if pg else 'tsukenya_purchase_need(minimum,available,on_order)'
    amount = 'ROUND(need*price,2)' if pg else 'tsukenya_purchase_money(need,price)'
    summed = 'SUM(amount)' if pg else 'tsukenya_purchase_sum(amount)'
    nonnegative = 'GREATEST(0,COALESCE(o.ordered,0)-COALESCE(o.received,0))' if pg else 'MAX(0,COALESCE(o.ordered,0)-COALESCE(o.received,0))'
    source_price = 'line.price' if pg else 'tsukenya_purchase_price(line.price)'
    sql += f""", ordered AS (
      SELECT l.voucher_id,l.id,l.product_id,v.warehouse_id,l.quantity,
        COALESCE((SELECT SUM(r.quantity) FROM erp_voucherline r JOIN erp_voucher rv ON rv.id=r.voucher_id
          WHERE r.reference_line_id=l.id AND rv.kind='receipt' AND rv.status='posted'),0) AS received
      FROM erp_voucherline l JOIN erp_voucher v ON v.id=l.voucher_id
      LEFT JOIN erp_ordercontrol oc ON oc.order_id=v.id
      WHERE v.kind='purchase_order' AND v.status='posted' AND oc.closed_at IS NULL
    ), order_totals AS (
      SELECT warehouse_id,product_id,SUM(quantity) AS ordered,SUM(received) AS received
      FROM ordered GROUP BY warehouse_id,product_id
    ), candidates AS (
      SELECT t.*,w.store_id AS store,s.name AS store_name,
        {nonnegative} AS on_order,
        (SELECT line.id FROM erp_voucherline line JOIN erp_voucher v ON v.id=line.voucher_id
          WHERE line.product_id=t.product AND v.kind='receipt' AND v.status='posted' AND v.store_id=w.store_id
          ORDER BY CASE WHEN v.warehouse_id=t.warehouse THEN 0 ELSE 1 END,v.date DESC,v.id DESC,line.id ASC LIMIT 1) AS source_id
      FROM totals t JOIN erp_warehouse w ON w.id=t.warehouse JOIN erp_store s ON s.id=w.store_id
      LEFT JOIN order_totals o ON o.warehouse_id=t.warehouse AND o.product_id=t.product WHERE t.low
    ), priced AS (
      SELECT c.*,CASE WHEN p.active THEN p.id ELSE NULL END AS party,
        CASE WHEN p.active THEN p.name ELSE '' END AS party_name,
        COALESCE({source_price},0) AS price,(line.id IS NOT NULL) AS cost_known
      FROM candidates c LEFT JOIN erp_voucherline line ON line.id=c.source_id
      LEFT JOIN erp_voucher v ON v.id=line.voucher_id LEFT JOIN erp_counterparty p ON p.id=v.party_id
    ), needed AS (SELECT priced.*,{qty} AS need FROM priced),
    measured AS (SELECT needed.*,CASE WHEN CAST(need AS NUMERIC)>0 THEN {amount} ELSE 0 END AS amount FROM needed),
    required AS (SELECT * FROM measured WHERE CAST(need AS NUMERIC)>0),
    group_headers AS (
      SELECT warehouse,warehouse_name,store,store_name,party,party_name,
        SUM(CASE WHEN CAST(need AS NUMERIC)>0 THEN 1 ELSE 0 END) AS lines_count,
        SUM(CASE WHEN CAST(need AS NUMERIC)<=0 THEN 1 ELSE 0 END) AS covered,{summed} AS total
      FROM measured GROUP BY warehouse,warehouse_name,store,store_name,party,party_name
    ) """
    search_clause = ''
    if search:
        escaped = search.lower() if pg else search.casefold()
        like = '%' + escaped.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        lower = (lambda col: f'LOWER({col})') if pg else (lambda col: f'tsukenya_stock_casefold({col})')
        search_clause = f" WHERE ({lower('party_name')} LIKE %s ESCAPE '\\' OR {lower('warehouse_name')} LIKE %s ESCAPE '\\' OR {lower('store_name')} LIKE %s ESCAPE '\\' OR EXISTS (SELECT 1 FROM needed r WHERE r.warehouse=g.warehouse AND COALESCE(r.party,0)=COALESCE(g.party,0) AND {lower('r.name')} LIKE %s ESCAPE '\\'))"
        args += [like] * 4
    sql += ', selected AS (SELECT g.* FROM group_headers g' + search_clause + ') '
    return sql, args, today, {'q': search, 'store': value['store'], 'warehouse': value['warehouse']}


def records(cursor):
    keys = [column[0] for column in cursor.description]
    return [dict(zip(keys, row)) for row in cursor.fetchall()]


def stream(sql, args):
    # Ordinary psycopg cursors buffer their entire result despite fetchmany.
    cursor = connection.chunked_cursor() if connection.vendor == 'postgresql' else connection.cursor()
    with cursor:
        cursor.execute(sql, args)
        keys = [column[0] for column in cursor.description]
        while batch := cursor.fetchmany(100):
            for row in batch: yield dict(zip(keys, row))


def line(row):
    return {'product': row['product'].split('/', 1)[1], 'name': row['name'], 'unit': row['unit'],
            'quantity': decimal(row['need'], 3), 'price': decimal(row['price'], 4),
            'available': decimal(row['available'], 3), 'minimum': decimal(row['minimum'], 3),
            'onOrder': decimal(row['on_order'], 3), 'costKnown': bool(row['cost_known'])}


def group(row):
    return {'key': f"{row['warehouse']}:{row['party'] or 0}", 'store': row['store'], 'storeName': row['store_name'],
            'warehouse': row['warehouse'], 'warehouseName': row['warehouse_name'], 'party': row['party'], 'partyName': row['party_name'],
            'linesCount': row['lines_count'], 'total': decimal(row['total'], 2), 'preview': [],
            'parts': (row['lines_count'] + DRAFT_LIMIT - 1) // DRAFT_LIMIT}


def projections(sql, args, headers, auth, query, today):
    result = [group(row) for row in headers]
    hashes = {}
    by_key = {item['key']: item for item in result}
    for item in result:
        hashes[item['key']] = hmac.new(settings.SECRET_KEY.encode(), json.dumps(
            [auth, {**query, 'warehouse': item['warehouse']}, today.isoformat(), item], sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode(), hashlib.sha256)
    if result:
        clauses = ' OR '.join('(r.warehouse=%s AND COALESCE(r.party,0)=%s)' for _ in result)
        selected = [value for item in result for value in (item['warehouse'], item['party'] or 0)]
        for row in stream(sql + 'SELECT r.* FROM required r WHERE ' + clauses + ' ORDER BY r.warehouse,COALESCE(r.party,0),r.name,r.product', args + selected):
            item = by_key[f"{row['warehouse']}:{row['party'] or 0}"]
            entry = line(row)
            hashes[item['key']].update(json.dumps(entry, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode() + b'\n')
            if len(item['preview']) < 3: item['preview'].append(entry)
        for item in result: item['binding'] = hashes[item['key']].hexdigest()
    return result


def replenishment(user, params):
    validate(params, {'q', 'store', 'warehouse', 'page'})
    with read_snapshot():
        user = current_actor(user); auth = policy(user)
        sql, args, today, query = source(user, params)
        summed = 'SUM(total)' if connection.vendor == 'postgresql' else 'tsukenya_purchase_sum(total)'
        with connection.cursor() as cursor:
            cursor.execute(sql + f'SELECT COALESCE(SUM(CASE WHEN lines_count>0 THEN 1 ELSE 0 END),0) AS groups,COALESCE(SUM(lines_count),0) AS lines,COALESCE(SUM(covered),0) AS covered,COALESCE({summed},0) AS total FROM selected', args)
            summary = records(cursor)[0]
            summary['total'] = decimal(summary['total'], 2)
            page, pages, offset = page_bounds(summary['groups'], page_number(params))
            cursor.execute(sql + 'SELECT * FROM selected WHERE lines_count>0 ORDER BY CASE WHEN party IS NULL THEN 1 ELSE 0 END,party_name,warehouse,COALESCE(party,0) LIMIT %s OFFSET %s', args + [PAGE_SIZE, offset])
            headers = records(cursor)
        return {'items': projections(sql, args, headers, auth, query, today), 'total': summary['groups'], 'page': page, 'pages': pages,
                'limit': PAGE_SIZE, 'query': query, 'policy': auth, 'asOf': today.isoformat(), 'summary': summary}


def selected_group(user, params, draft=False):
    allowed = {'q', 'store', 'warehouse', 'party', 'binding', 'part' if draft else 'page'}
    validate(params, allowed)
    require(params.get('warehouse'), 'Оберіть склад групи поповнення.')
    party = params.get('party')
    require(party is not None, 'Оберіть постачальника групи поповнення.')
    party = 0 if party == '0' else positive_integer(party, 'ID постачальника')
    binding = params.get('binding', '')
    require(len(binding) == 64 and all(c in '0123456789abcdef' for c in binding), 'Некоректна версія групи поповнення.')
    with read_snapshot():
        user = current_actor(user); auth = policy(user)
        sql, args, today, query = source(user, params)
        with connection.cursor() as cursor:
            cursor.execute(sql + 'SELECT * FROM selected WHERE lines_count>0 AND COALESCE(party,0)=%s', args + [party])
            headers = records(cursor)
        items = projections(sql, args, headers, auth, query, today)
        if len(items) != 1 or not hmac.compare_digest(items[0]['binding'], binding):
            raise Conflict('Групу поповнення змінено. Оновіть її перед перенесенням у чернетку.', 'replenishment_changed')
        item = items[0]
        total = item['linesCount']
        if draft:
            part = positive_integer(params.get('part', '1'), 'Частина групи')
            require(part <= item['parts'], 'Такої частини групи поповнення немає.')
            offset, limit = (part - 1) * DRAFT_LIMIT, DRAFT_LIMIT
        else:
            page, pages, offset = page_bounds(total, page_number(params)); limit = PAGE_SIZE
        with connection.cursor() as cursor:
            cursor.execute(sql + 'SELECT * FROM required WHERE COALESCE(party,0)=%s ORDER BY name,product LIMIT %s OFFSET %s', args + [party, limit, offset])
            entries = [line(row) for row in records(cursor)]
        if draft:
            return {'group': item, 'binding': binding, 'lines': entries, 'policy': auth,
                    'part': part, 'parts': item['parts'], 'limit': DRAFT_LIMIT, 'total': total}
        return {'group': item, 'items': entries, 'total': total, 'page': page, 'pages': pages, 'limit': PAGE_SIZE,
                'binding': binding, 'policy': auth, 'asOf': today.isoformat(), 'query': {**query, 'party': party or None}}


def lines(user, params): return selected_group(user, params)
def draft(user, params): return selected_group(user, params, draft=True)
