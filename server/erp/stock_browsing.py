"""B24 paged stock reads. Posting/alerts keep the authoritative accounting services.

SQL computes the same current lot/reservation/assortment facts without bringing
all product×warehouse pairs or historical lots into Python. Summary is over the
whole filtered set; page rows never determine it.
"""
import csv
import io
from datetime import timedelta
from decimal import Decimal

from django.db import connection
from django.http import StreamingHttpResponse
from django.utils import timezone

from .browsing import PAGE_SIZE, page_bounds, page_number, positive_integer
from .csv_format import MARKER, guarded
from .historical_reports import read_snapshot
from .services import require, current_actor

ROLES = {'owner', 'manager', 'warehouse', 'accountant', 'cashier'}


def options(user, params):
    require(user.profile.role in ROLES, 'Недостатньо прав для залишків.')
    search = params.get('q', '').strip()
    require(len(search) <= 250, 'Пошуковий запит задовгий.')
    view = params.get('view', 'totals')
    require(view in {'totals', 'lots'}, 'Невідомий вид залишків.')
    require(not params.get('sort') or params['sort'] == 'warehouse_product', 'Невідоме сортування залишків.')
    result = {'q': search, 'view': view, 'page': page_number(params)}
    for key in ('store', 'warehouse'):
        result[key] = positive_integer(params[key], 'ID магазину' if key == 'store' else 'ID складу') if params.get(key) else None
    result['scope'] = user.profile.store_id
    return result


def source_sql(value):
    """Only backend syntax is interpolated; user values are always parameters."""
    pg = connection.vendor == 'postgresql'
    if not pg:
        connection.ensure_connection()
        connection.connection.create_function('tsukenya_stock_casefold', 1, lambda text: str(text or '').casefold(), deterministic=True)
    extract = (lambda key: f"d.data->>'{key}'") if pg else (lambda key: f"json_extract(d.data,'$.{key}')")
    name = f"COALESCE({extract('name')},'')"
    lower = f'LOWER({name})' if pg else f'tsukenya_stock_casefold({name})'
    predicates, parameters = [], []
    for key, column in [('scope', 'w.store_id'), ('store', 'w.store_id'), ('warehouse', 'w.id')]:
        if value[key] is not None:
            predicates.append(f'{column}=%s'); parameters.append(value[key])
    where = ' AND '.join(predicates) or 'TRUE'
    product_where = "d.path LIKE 'products/%%'"
    if value['q']:
        product_where += f" AND {lower} LIKE %s ESCAPE '\\'"
        escaped = value['q'].lower() if pg else value['q'].casefold()
        parameters.append('%' + escaped.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%')
    today = timezone.localdate()
    parameters.extend([today, today, today])
    # The LEFT JOIN permits legacy posted orders without OrderControl, exactly
    # like reservations.live(order_control__closed_at__isnull=True).
    # Inline product/warehouse selectors so lot joins use the document PK.
    # Group metadata with the lot facts, instead of rejoining the full catalog.
    # Membership below uses non-null warehouse/product FK keys: PostgreSQL can
    # hash them once even just after bulk inserts with stale row estimates.
    inline = 'NOT MATERIALIZED' if pg else ''
    sql = f"""WITH warehouses AS {inline} (
      SELECT w.id,w.name,w.store_id FROM erp_warehouse w WHERE {where}
    ), products AS {inline} (
      SELECT d.path,{name} AS name,COALESCE({extract('unit')},'шт') AS unit,
        CAST(COALESCE(NULLIF({extract('minStock')},''),'0') AS NUMERIC) AS minimum
      FROM erp_document d WHERE {product_where}
    ), holds AS (
      SELECT r.lot_id,SUM(r.quantity-r.used-r.released) AS held
      FROM erp_stockreservation r JOIN erp_voucherline line ON line.id=r.order_line_id
      JOIN erp_voucher v ON v.id=line.voucher_id
      LEFT JOIN erp_ordercontrol oc ON oc.order_id=v.id
      JOIN erp_stocklot held_lot ON held_lot.id=r.lot_id
      JOIN warehouses held_w ON held_w.id=held_lot.warehouse_id
      JOIN products held_p ON held_p.path=held_lot.product_id
      WHERE r.expires_on>=%s AND v.status='posted' AND oc.closed_at IS NULL
        AND r.quantity>r.used+r.released
      GROUP BY r.lot_id
    ), lots AS (
      SELECT l.id,l.warehouse_id,l.product_id,l.code,l.expiry,l.quantity,l.value,p.name,p.unit,p.minimum,
        COALESCE(h.held,0) AS reserved,
        CASE WHEN l.expiry IS NULL OR l.expiry>=%s THEN
          CASE WHEN l.quantity>COALESCE(h.held,0) THEN l.quantity-COALESCE(h.held,0) ELSE 0 END ELSE 0 END AS available,
        CASE WHEN l.expiry IS NULL OR l.expiry>=%s THEN COALESCE(h.held,0) ELSE 0 END AS valid_reserved
      FROM erp_stocklot l JOIN warehouses w ON w.id=l.warehouse_id
      JOIN products p ON p.path=l.product_id LEFT JOIN holds h ON h.lot_id=l.id
    ), grouped AS (
      SELECT warehouse_id,product_id,name,unit,minimum,SUM(quantity) AS quantity,SUM(value) AS value,
        SUM(available) AS available,SUM(valid_reserved) AS reserved
      FROM lots GROUP BY warehouse_id,product_id,name,unit,minimum
    ), totals AS (
      SELECT w.id AS warehouse,w.name AS warehouse_name,g.product_id AS product,g.name,g.unit,
        COALESCE(g.quantity,0) AS quantity,COALESCE(g.value,0) AS value,
        COALESCE(g.available,0) AS available,COALESCE(g.reserved,0) AS reserved,
        COALESCE(a.min_stock,g.minimum) AS minimum,COALESCE(a.sold,TRUE) AS sold,
        (COALESCE(a.sold,TRUE) AND COALESCE(g.available,0)<COALESCE(a.min_stock,g.minimum)) AS low
      FROM grouped g JOIN warehouses w ON w.id=g.warehouse_id
      LEFT JOIN erp_assortment a ON a.warehouse_id=w.id AND a.product_id=g.product_id
      UNION ALL
      SELECT w.id,w.name,p.path,p.name,p.unit,0,0,0,0,
        COALESCE(a.min_stock,p.minimum),COALESCE(a.sold,TRUE),TRUE
      FROM warehouses w CROSS JOIN products p
      LEFT JOIN erp_assortment a ON a.warehouse_id=w.id AND a.product_id=p.path
      WHERE COALESCE(a.sold,TRUE) AND COALESCE(a.min_stock,p.minimum)>0
        AND (w.id,p.path) NOT IN (SELECT warehouse_id,product_id FROM lots)
    ) """
    return sql, parameters, today


def decimal_text(value, places):
    return format(Decimal(str(value or 0)).quantize(Decimal(1).scaleb(-places)), 'f')


def rows(cursor):
    columns = [column[0] for column in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def total_json(row, private):
    result = {key: row[key] for key in ('warehouse', 'name', 'unit')}
    result.update(product=row['product'].split('/', 1)[1], sold=bool(row['sold']), low=bool(row['low']))
    for key in ('quantity', 'available', 'reserved', 'minimum'):
        result[key] = decimal_text(row[key], 3)
    if private: result['value'] = decimal_text(row['value'], 2)
    return result


def lot_json(row, private, today):
    expiry = str(row['expiry']) if row['expiry'] else None
    result = {'id': row['id'], 'warehouse': row['warehouse_id'], 'product': row['product_id'].split('/', 1)[1],
              'name': row['name'], 'unit': row['unit'], 'lot': row['code'], 'expiry': expiry,
              'expired': bool(expiry and expiry < today.isoformat())}
    for key in ('quantity', 'available', 'reserved'): result[key] = decimal_text(row[key], 3)
    if private: result['value'] = decimal_text(row['value'], 2)
    return result


def stock_page(user, params):
    with read_snapshot():
        user = current_actor(user)
        value = options(user, params)
        private = user.profile.role != 'cashier'
        sql, arguments, today = source_sql(value)
        with connection.cursor() as cursor:
            cursor.execute(sql + """SELECT COUNT(*) AS total,COALESCE(SUM(value),0) AS value,
              COALESCE(SUM(CASE WHEN low THEN 1 ELSE 0 END),0) AS low,
              (SELECT COUNT(*) FROM lots WHERE quantity>0) AS lots,
              (SELECT COUNT(*) FROM lots WHERE quantity>0 AND expiry<=%s) AS expiry
              FROM totals""", arguments + [today + timedelta(days=7)])
            summary = rows(cursor)[0]
            total = summary['total'] if value['view'] == 'totals' else summary['lots']
            page, pages, offset = page_bounds(total, value['page'])
            if value['view'] == 'totals':
                cursor.execute(sql + 'SELECT * FROM totals ORDER BY warehouse,product LIMIT %s OFFSET %s', arguments + [PAGE_SIZE, offset])
                items = [total_json(row, private) for row in rows(cursor)]
            else:
                cursor.execute(sql + 'SELECT * FROM lots WHERE quantity>0 ORDER BY warehouse_id,product_id,expiry,id LIMIT %s OFFSET %s', arguments + [PAGE_SIZE, offset])
                items = [lot_json(row, private, today) for row in rows(cursor)]
        return {'items': items, 'total': total, 'page': page, 'pages': pages, 'limit': PAGE_SIZE, 'view': value['view'], 'asOf': today.isoformat(),
                'summary': {'products': summary['total'], 'low': summary['low'], 'lots': summary['lots'], 'expiry': summary['expiry'],
                            **({'value': decimal_text(summary['value'], 2)} if private else {})}}


def stock_csv(user, params):
    # Validate before returning HTTP headers; revalidate when streaming begins.
    with read_snapshot():
        options(current_actor(user), params)
        require(params.get('view', 'totals') == 'totals', 'CSV доступний для підсумків товарів.')
    def generate():
        buffer = io.StringIO(newline='')
        writer = csv.writer(buffer, delimiter=';', quoting=csv.QUOTE_ALL, lineterminator='\r\n')
        def record(values):
            buffer.seek(0); buffer.truncate(0); writer.writerow(values); return buffer.getvalue()
        def text(value):
            value = str(value or ''); return '\t' + value if guarded(value) else value
        # Cursor fetches bounded batches; the generator owns its entire RR snapshot.
        with read_snapshot():
            actor = current_actor(user)
            value = options(actor, params)
            private = actor.profile.role != 'cashier'
            sql, arguments, _ = source_sql(value)
            yield '\ufeff' + record(['Товар' + MARKER, 'Склад', 'Кількість', 'Доступно', 'Од.', *(['Вартість'] if private else [])])
            # PostgreSQL server-side cursor is required: ordinary psycopg cursors
            # buffer all rows even if Python uses fetchmany().
            if connection.vendor == 'postgresql':
                cursor = connection.chunked_cursor()
            else: cursor = connection.cursor()
            with cursor:
                cursor.execute(sql + 'SELECT * FROM totals ORDER BY warehouse,product', arguments)
                columns = [column[0] for column in cursor.description]
                while batch := cursor.fetchmany(100):
                    for raw in batch:
                        row = dict(zip(columns, raw))
                        yield record([text(row['name']), text(row['warehouse_name']), decimal_text(row['quantity'], 3),
                                      decimal_text(row['available'], 3), text(row['unit']), *([decimal_text(row['value'], 2)] if private else [])])
    response = StreamingHttpResponse(generate(), content_type='text/csv; charset=utf-8')
    response['Content-Disposition'] = 'attachment; filename="stock.csv"'
    response['Cache-Control'] = 'private, no-store'
    return response
