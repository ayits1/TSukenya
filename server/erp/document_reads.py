"""Bounded document viewer. No editor/receipt/posting serializer is changed here."""
import json
from decimal import Decimal, InvalidOperation
from django.db import connection
from django.db.models import Count, DecimalField, F, OuterRef, Q, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from .models import Voucher, VoucherLine, StockEntry, CashEntry, PaymentAllocation, StockReservation, OrderControl
from .services import BusinessError, ZERO, current_actor, money, permission, require
from .historical_reports import read_snapshot
from .browsing import positive_integer
from . import report_children as children
from .orders import editable
from .reservations import live, expiry_instant

CONTRACT = 'document-detail-v1'
SECTIONS = ('lines', 'stock_movements', 'cash_movements', 'allocations',
            'payroll_calculation', 'production_components', 'order_lines', 'reservations')
NEXT = {'purchase_order': 'receipt', 'customer_order': 'sale', 'sale': 'customer_return', 'receipt': 'supplier_return'}
JSON_SECTIONS = {'payroll_calculation': ('calculation',), 'production_components': ('production', 'components')}
SCALAR_LIMIT = 4096
SALARY = {'owner', 'accountant'}


def failure(pk):
    raise BusinessError(f'Документ {pk} має некоректні реквізити перегляду. Перевірте джерело.')


def json_expr(base, path):
    # Paths are internal constants only. Values/IDs and paging use parameters.
    assert all(part.isidentifier() for part in path)
    if connection.vendor == 'postgresql':
        value = base + ''.join("->'" + part + "'" for part in path)
        return value, 'jsonb_typeof(' + value + ')'
    if connection.vendor == 'sqlite':
        path = '$.' + '.'.join(path)
        return f"({base} -> '{path}')", f"json_type({base},'{path}')"
    raise BusinessError('Перегляд потребує PostgreSQL або SQLite QA.')


def scalar_values(pk, paths, *, ignore_containers=()):
    """Selected JSON scalars only, each bounded in SQL before cursor materialization."""
    expressions = []
    for path in paths:
        value, kind = json_expr('payload', path)
        value = f'({value})::text' if connection.vendor == 'postgresql' else value
        expressions.extend([f"CASE WHEN {kind} IN ('string','number','boolean','null','text','integer','real','true','false') AND LENGTH({value})<={SCALAR_LIMIT} THEN {value} END", f"CASE WHEN {kind} IN ('string','number','text','integer','real') AND LENGTH({value})>{SCALAR_LIMIT} THEN 'too_large' ELSE {kind} END"])
    with connection.cursor() as cursor:
        cursor.execute('SELECT ' + ','.join(expressions) + ' FROM erp_voucher WHERE id=%s', [pk])
        row = cursor.fetchone()
    if row is None: failure(pk)
    result = {}
    for index, path in enumerate(paths):
        raw, kind = row[index * 2:index * 2 + 2]
        if kind == 'too_large': failure(pk)
        if kind in {'object', 'array'}:
            if path not in ignore_containers: failure(pk)
            result[path] = None
        else:
            # PG JSONB cursor may already decode scalars; cast to text avoids guessing strings.
            result[path] = json.loads(raw) if isinstance(raw, str) else raw
    return result


def scalar_text(pk, value, default=''):
    if value is None: return default
    if not isinstance(value, str): failure(pk)
    return value


def selected_expense_scope(pk):
    # The legacy permission treats only exact string network as network.
    value, kind = json_expr('payload', ('expense_scope',))
    value = f'({value})::text' if connection.vendor == 'postgresql' else value
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT CASE WHEN {kind} IN ('string','text') AND {value}=%s THEN 'network' ELSE 'store' END FROM erp_voucher WHERE id=%s", ['"network"', pk])
        return cursor.fetchone()[0]



def readable_document(user, pk, *, bounded=False):
    """Caller owns read_snapshot and fresh actor. Permission precedes child/payload reads."""
    query = Voucher.objects.defer('payload')
    if bounded:
        from django.db.models.expressions import RawSQL
        query = query.defer('note').annotate(view_note=RawSQL('CASE WHEN LENGTH(note)<=%s THEN note END', [SCALAR_LIMIT]))
    v = query.filter(pk=pk).first()
    require(v is not None, 'Документ не знайдено.')
    permission(user, v.kind)
    require(user.profile.store_id is None or user.profile.store_id == v.store_id, 'Немає доступу до цього магазину.')
    if v.kind == 'expense' and selected_expense_scope(v.pk) == 'network':
        require(user.profile.role in SALARY, 'Мережеві витрати доступні лише власнику або бухгалтеру.')
    return v


def relation(model, identifier):
    if identifier is None: return None
    row = model.objects.filter(pk=identifier).values('id', 'name').first()
    require(row is not None, 'Довідник документа недоступний.')
    return row


def line_query(v):
    q = VoucherLine.objects.filter(voucher_id=v.pk)
    if v.kind not in NEXT:
        return q.annotate(used_quantity=Value(ZERO, output_field=DecimalField()), used_amount=Value(ZERO, output_field=DecimalField()))
    used = VoucherLine.objects.filter(reference_line_id=OuterRef('pk'), voucher__kind=NEXT[v.kind], voucher__status='posted').order_by().values('reference_line_id')
    return q.annotate(used_quantity=Coalesce(Subquery(used.annotate(n=Sum('quantity')).values('n')), Value(ZERO), output_field=DecimalField(max_digits=18, decimal_places=3)),
                      used_amount=Coalesce(Subquery(used.annotate(n=Sum('amount')).values('n')), Value(ZERO), output_field=DecimalField(max_digits=18, decimal_places=2)))


def order_summary(v, user):
    if v.kind not in {'purchase_order', 'customer_order'}: return None
    state = OrderControl.objects.filter(order_id=v.pk).first()
    totals = line_query(v).aggregate(quantity=Sum('quantity'), used=Sum('used_quantity'))
    fulfilled = totals['used'] or ZERO
    left = (totals['quantity'] or ZERO) - fulfilled
    lifecycle = 'draft' if v.status == 'draft' else 'cancelled' if v.status == 'reversed' else 'closed' if state and state.closed_at else 'fulfilled' if not left else 'partial' if fulfilled else 'approved'
    legacy = scalar_values(v.pk, ([('expected_date',)] if state is None else []) + [('minimum_order_amount',)]) if state is None or state.minimum_amount is None else {}
    return {'state': lifecycle, 'revision': state.revision if state else 1,
            'canManage': editable(user, v),
            'expectedDate': state.expected_date.isoformat() if state and state.expected_date else scalar_text(v.pk, legacy.get(('expected_date',)), None) if state is None else None,
            'minimumAmount': str(state.minimum_amount) if state and state.minimum_amount is not None else str(legacy[('minimum_order_amount',)]) if legacy.get(('minimum_order_amount',)) is not None else None}


def array_count(pk, path):
    value, kind = json_expr('payload', path)
    length = f'jsonb_array_length({value})' if connection.vendor == 'postgresql' else f'json_array_length({value})'
    with connection.cursor() as cursor:
        cursor.execute(f'SELECT {kind}, CASE WHEN {kind}=\'array\' THEN {length} END FROM erp_voucher WHERE id=%s', [pk])
        tag, count = cursor.fetchone()
    if tag is not None and tag != 'array':
        if tag in {'object'} or scalar_values(pk, [path])[path] not in (None, False, 0, ''): failure(pk)
    return count or 0


def counts(v, user):
    result = {'lines': v.lines.count(), 'stock_movements': v.stock_entries.count(), 'cash_movements': v.cash_entries.count()}
    if v.kind in {'payment', 'advance_allocation'}: result['allocations'] = v.allocation_entries.count()
    if v.kind == 'payroll' and user.profile.role in SALARY: result['payroll_calculation'] = array_count(v.pk, JSON_SECTIONS['payroll_calculation'])
    if v.kind == 'production': result['production_components'] = array_count(v.pk, JSON_SECTIONS['production_components'])
    if v.kind in {'purchase_order', 'customer_order'}: result['order_lines'] = result['lines']
    if v.kind == 'customer_order': result['reservations'] = StockReservation.objects.filter(order_line__voucher_id=v.pk).count()
    return result


def production_summary(v):
    if v.kind != 'production': return None
    paths = [('production', *path) for path in [('source',), ('terms', 'version'), ('terms', 'outputQuantity'), ('terms', 'unit'), ('plannedOutput',), ('actualOutput',), ('result', 'lossQuantity'), ('result', 'overrunQuantity'), ('result', 'materialCost'), ('result', 'expiry'), ('result', 'expirySource'), ('varianceReason',), ('expiryOverride', 'reason'), ('expiryOverride', 'approvedBy')]]
    raw = scalar_values(v.pk, paths)
    if raw[('production', 'terms', 'outputQuantity')] is None: return None
    names = ['source', 'version', 'outputQuantity', 'unit', 'plannedOutput', 'actualOutput', 'lossQuantity', 'overrunQuantity', 'materialCost', 'expiry', 'expirySource', 'varianceReason', 'expiryReason', 'expiryApprovedBy']
    return {name: value if name == 'version' else None if value is None else str(value) for name, value in zip(names, (raw[p] for p in paths))}


def header(v, user):
    from .models import Store, Warehouse, Counterparty, Employee, CashAccount
    from django.contrib.auth.models import User
    cost = user.profile.role != 'cashier'
    outstanding = children.obligations([v], None)[v.pk] if v.kind in {'receipt', 'sale', 'debt_opening'} and v.status == 'posted' else None
    unallocated = children.advances([v], None)[v.pk] if v.kind == 'payment' and v.status == 'posted' else None
    order = order_summary(v, user)
    remaining = line_query(v).filter(quantity__gt=F('used_quantity')).exists() if v.kind in NEXT else False
    expense_scope = selected_expense_scope(v.pk) if v.kind == 'expense' else None
    actions = []
    if v.status == 'draft': actions += ['edit', 'post', 'delete']
    if v.status == 'posted':
        if user.profile.role in {'owner', 'manager', 'accountant'}: actions.append('reverse')
        if remaining and (order is None or order['state'] != 'closed'):
            actions.append({'purchase_order': 'receipt', 'customer_order': 'sale', 'sale': 'customer_return', 'receipt': 'supplier_return'}[v.kind])
        if unallocated is not None and unallocated > ZERO: actions += ['use_advance', 'refund_advance']
        from .services import ROLE_KINDS
        if outstanding is not None and outstanding > ZERO and 'payment' in ROLE_KINDS[user.profile.role]: actions.append('pay_debt')
    if v.kind == 'receipt' and v.status in {'draft', 'posted'} and user.profile.role in {'owner', 'manager', 'warehouse'}: actions.append('receipt_pricing')
    if order and order['canManage'] and v.status == 'posted' and order['state'] not in {'closed', 'cancelled'}:
        actions += ['order_expire', 'order_close']
        if v.kind == 'purchase_order': actions.append('order_date')
        else:
            held = live().filter(order_line_id=OuterRef('pk')).order_by().values('order_line_id').annotate(n=Sum(F('quantity') - F('used') - F('released'))).values('n')
            if line_query(v).annotate(held=Coalesce(Subquery(held), Value(ZERO), output_field=DecimalField())).filter(quantity__gt=F('used_quantity') + F('held')).exists(): actions.append('order_reserve')
    return {'id': v.pk, 'number': f'{v.pk:06d}', 'kind': v.kind, 'status': v.status, 'date': v.date.isoformat(),
            'store': relation(Store, v.store_id), 'warehouse': relation(Warehouse, v.warehouse_id), 'target': relation(Warehouse, v.target_id),
            'party': relation(Counterparty, v.party_id), 'employee': relation(Employee, v.employee_id), 'account': relation(CashAccount, v.account_id),
            'shift': v.shift_id, 'reference': v.reference_id, 'revision': v.revision, 'total': str(v.total), 'cost': str(v.cost) if cost else None,
            'note': scalar_text(v.pk, v.view_note) if v.view_note is not None else failure(v.pk), 'createdBy': User.objects.values_list('username', flat=True).get(pk=v.created_by_id),
            'createdAt': v.created_at.isoformat(), 'postedAt': v.posted_at.isoformat() if v.posted_at else None,
            'fiscalRef': scalar_text(v.pk, scalar_values(v.pk, [('fiscal_ref',)])[( 'fiscal_ref',)]),
            'expenseScope': expense_scope, 'outstanding': str(outstanding) if outstanding is not None else None,
            'unallocated': str(unallocated) if unallocated is not None else None, 'order': order,
            'production': production_summary(v), 'actions': actions}


def origin_map(v, lines):
    """Exactly unique positive nonreversal origin; legacy fallback remains unambiguous."""
    ids = [l.pk for l in lines]
    products = [l.product_id for l in lines]
    positive = StockEntry.objects.filter(voucher_id=v.pk, quantity__gt=0, is_reversal=False)
    annotated = {r['line_id']: r for r in positive.filter(line_id__in=ids).values('line_id').annotate(n=Count('pk'), source=Sum('pk'))}
    legacy = {r['lot__product_id']: r for r in positive.filter(line_id__isnull=True, lot__product_id__in=products).values('lot__product_id').annotate(n=Count('pk'), source=Sum('pk'))}
    products_count = {r['product_id']: r['n'] for r in v.lines.filter(product_id__in=products).values('product_id').annotate(n=Count('pk'))}
    selected = {}
    for line in lines:
        row = annotated.get(line.pk)
        if row is None and products_count[line.product_id] == 1: row = legacy.get(line.product_id)
        if row and row['n'] == 1: selected[line.pk] = row['source']
    terms = {r['id']: r for r in StockEntry.objects.filter(pk__in=selected.values()).values('id', 'lot__code', 'lot__expiry')}
    return {key: terms[identifier] for key, identifier in selected.items()}


def line_rows(v, user, offset, limit, order=False):
    rows = list(line_query(v).order_by('pk')[offset:offset + limit])
    origins = origin_map(v, rows) if v.kind == 'receipt' and v.status == 'posted' else {}
    held = {r['order_line_id']: r['n'] for r in live().filter(order_line_id__in=[l.pk for l in rows]).values('order_line_id').annotate(n=Sum(F('quantity') - F('used') - F('released')))} if order else {}
    result = []
    for l in rows:
        if order:
            result.append({'id': l.pk, 'name': l.name, 'unit': l.unit, 'quantity': str(l.quantity), 'fulfilled': str(l.used_quantity), 'remaining': str(l.quantity - l.used_quantity), 'reserved': str(held.get(l.pk, ZERO))})
            continue
        origin = origins.get(l.pk)
        lot, expiry = (origin['lot__code'], origin['lot__expiry']) if origin else (l.lot, l.expiry)
        result.append({'id': l.pk, 'lineKey': str(l.line_key), 'referenceLine': l.reference_line_id, 'product': l.product_id.split('/', 1)[1], 'name': l.name, 'unit': l.unit,
                       'quantity': str(l.quantity), 'price': str(l.price), 'amount': str(l.amount), 'cost': str(l.cost) if user.profile.role != 'cashier' else None,
                       'lot': lot, 'expiry': expiry.isoformat() if expiry else None, 'originKnown': origin is not None if v.kind == 'receipt' and v.status == 'posted' else None,
                       'remaining': str(l.quantity - l.used_quantity) if v.kind in NEXT else None, 'remainingAmount': str(money(l.amount - l.used_amount)) if v.kind in NEXT else None})
    return result


def display_decimal(pk, value):
    if type(value) not in {str, int, float}: failure(pk)
    try:
        result = Decimal(str(value).replace(',', '.'))
        if not result.is_finite(): failure(pk)
        return result
    except (InvalidOperation, ValueError): failure(pk)


def json_rows(v, section, offset, limit):
    fields = ('id', 'date', 'cash_shift', 'rate', 'units', 'percent', 'basis_amount', 'accrued') if section == 'payroll_calculation' else ('product', 'name', 'unit', 'expectedQuantity', 'quantity', 'lot')
    value, _ = json_expr('v.payload', JSON_SECTIONS[section])
    if connection.vendor == 'postgresql':
        source = f'erp_voucher v CROSS JOIN LATERAL jsonb_array_elements({value}) WITH ORDINALITY j(item,n)'
        ordinal, item, item_kind = 'j.n', 'j.item', 'jsonb_typeof(j.item)'
    else:
        source = f'erp_voucher v JOIN json_each({value}) j'
        ordinal, item, item_kind = 'CAST(j.key AS INTEGER)+1', 'j.value', 'j.type'
    select = [ordinal, item_kind]
    for key in fields:
        val, kind = json_expr(item, (key,))
        val = f'({val})::text' if connection.vendor == 'postgresql' else val
        select += [f"CASE WHEN {item_kind}='object' THEN CASE WHEN {kind} IN ('string','number','text','integer','real') AND LENGTH({val})>{SCALAR_LIMIT} THEN 'too_large' ELSE {kind} END END", f"CASE WHEN {item_kind}='object' AND {kind} IN ('string','number','boolean','null','text','integer','real','true','false') AND LENGTH({val})<={SCALAR_LIMIT} THEN {val} END"]
    sql = 'SELECT ' + ','.join(select) + ' FROM ' + source + f' WHERE v.id=%s ORDER BY {ordinal} LIMIT %s OFFSET %s'
    result = []
    for row in children.cursor_rows(sql, [v.pk, limit, offset]):
        if row[1] != 'object': failure(v.pk)
        obj = {'ordinal': row[0]}
        for i, key in enumerate(fields):
            kind, raw = row[2 + i * 2:4 + i * 2]
            if kind in {'object', 'array', 'too_large'}: failure(v.pk)
            obj[key] = json.loads(raw) if isinstance(raw, str) else raw
        if section == 'payroll_calculation':
            require(type(obj['id']) is int and obj['id'] > 0, 'Некоректний табель розрахунку.')
            obj = {'id': obj['ordinal'], 'workShift': obj['id'], 'date': scalar_text(v.pk, obj['date']), 'cashShift': obj['cash_shift'],
                   'rate': str(display_decimal(v.pk, obj['rate'])), 'units': str(display_decimal(v.pk, obj['units'])), 'baseAmount': str(money(display_decimal(v.pk, obj['rate']) * display_decimal(v.pk, obj['units']))),
                   'percent': str(display_decimal(v.pk, obj['percent'])), 'basisAmount': str(display_decimal(v.pk, obj['basis_amount'])), 'accrued': str(display_decimal(v.pk, obj['accrued']))}
        else:
            obj = {'id': obj['ordinal'], 'product': scalar_text(v.pk, obj['product']), 'name': scalar_text(v.pk, obj['name']), 'unit': scalar_text(v.pk, obj['unit']),
                   'expectedQuantity': str(display_decimal(v.pk, obj['expectedQuantity'])), 'quantity': str(display_decimal(v.pk, obj['quantity'])), 'lot': scalar_text(v.pk, obj['lot'])}
        result.append(obj)
    return result


def rows(v, user, section, offset, limit):
    if section in {'lines', 'order_lines'}: return line_rows(v, user, offset, limit, section == 'order_lines')
    if section in JSON_SECTIONS: return json_rows(v, section, offset, limit)
    if section == 'stock_movements':
        return [{'id': r['id'], 'warehouse': {'id': r['lot__warehouse_id'], 'name': r['lot__warehouse__name']}, 'product': r['lot__product_id'].split('/', 1)[1], 'lot': r['lot__code'], 'line': r['line_id'], 'quantity': str(r['quantity']), 'value': str(r['value']) if user.profile.role != 'cashier' else None, 'reversal': r['is_reversal']} for r in StockEntry.objects.filter(voucher_id=v.pk).order_by('pk').values('id', 'lot__warehouse_id', 'lot__warehouse__name', 'lot__product_id', 'lot__code', 'line_id', 'quantity', 'value', 'is_reversal')[offset:offset + limit]]
    if section == 'cash_movements':
        return [{'id': r['id'], 'account': {'id': r['account_id'], 'name': r['account__name']}, 'amount': str(r['amount']), 'reversal': r['is_reversal']} for r in CashEntry.objects.filter(voucher_id=v.pk).order_by('pk').values('id', 'account_id', 'account__name', 'amount', 'is_reversal')[offset:offset + limit]]
    if section == 'allocations':
        return [{'id': r['id'], 'source': r['source_id'], 'number': f"{r['source_id']:06d}", 'amount': str(r['amount'])} for r in PaymentAllocation.objects.filter(settlement_id=v.pk).order_by('pk').values('id', 'source_id', 'amount')[offset:offset + limit]]
    if section == 'reservations':
        page = list(StockReservation.objects.filter(order_line__voucher_id=v.pk).order_by('-pk').values('id', 'order_line_id', 'order_line__name', 'order_line__unit', 'lot_id', 'lot__code', 'lot__expiry', 'owner__username', 'created_at', 'expires_on', 'quantity', 'used', 'released')[offset:offset + limit])
        active = set(live().filter(pk__in=[r['id'] for r in page]).values_list('pk', flat=True))
        return [{'id': r['id'], 'line': r['order_line_id'], 'name': r['order_line__name'], 'unit': r['order_line__unit'], 'lot': r['lot_id'], 'code': r['lot__code'], 'lotExpiry': r['lot__expiry'].isoformat() if r['lot__expiry'] else None, 'owner': r['owner__username'], 'createdAt': r['created_at'].isoformat(), 'expiresOn': r['expires_on'].isoformat(), 'expiresAt': expiry_instant(r['expires_on']), 'quantity': str(r['quantity']), 'used': str(r['used']), 'released': str(r['released']), 'active': r['id'] in active, 'available': str(max(ZERO, r['quantity'] - r['used'] - r['released']) if r['id'] in active else ZERO)} for r in reversed(page)]

    failure(v.pk)


def read(user, pk, params, *, page=False):
    require(not set(params) - ({'section', 'page', 'limit'} if page else set()), 'Невідомий параметр перегляду.')
    if hasattr(params, 'getlist'): require(all(len(params.getlist(k)) == 1 for k in params), 'Параметр повторюється.')
    number = positive_integer(params.get('page', '1'), 'Сторінка') if page else 1
    limit = positive_integer(params.get('limit', '30'), 'Розмір сторінки') if page else 30
    require(limit in {10, 30}, 'Доступно 10 або 30 записів.')
    with read_snapshot():
        user = current_actor(user)
        v = readable_document(user, pk, bounded=True)
        available = counts(v, user)
        result = {'contract': CONTRACT, 'context': {'document': v.pk, 'role': user.profile.role, 'scopeStore': user.profile.store_id, 'store': v.store_id, 'readAt': timezone.now().isoformat()}, 'document': header(v, user), 'sections': [{'key': key, 'total': total} for key, total in available.items()]}
        if page:
            section = params.get('section')
            require(section in SECTIONS, 'Невідома секція документа.')
            if section not in available: raise BusinessError('Цей вид документа не містить запитаної секції.')
            total = available[section]; pages = max(1, (total + limit - 1) // limit); number = min(number, pages)
            result['page'] = {'section': section, 'page': number, 'pages': pages, 'limit': limit, 'total': total, 'items': rows(v, user, section, (number - 1) * limit, limit) if total else []}
        return result
