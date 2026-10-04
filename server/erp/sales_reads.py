"""Read-only sales workspace: at most 30 scalar headers in one fresh RR snapshot."""
from zoneinfo import ZoneInfo

from django.db.models.functions import TruncDate

from .browsing import PAGE_SIZE, filter_search, page_bounds, page_number, positive_integer
from .historical_reports import read_snapshot
from .models import CashShift, Voucher, Setting
from .reporting import scoped
from .services import current_actor, day, permission, require

KINDS = ('sale', 'customer_return', 'customer_order')
KYIV = ZoneInfo('Europe/Kyiv')


def policy(user):
    permission(user, 'sale')
    return {'role': user.profile.role, 'store': user.profile.store_id, 'documentKinds': list(KINDS)}


def options(params, fields):
    require(not set(params) - fields, 'Невідомий параметр продажів.')
    require(all(isinstance(value, str) for value in params.values()), 'Некоректні параметри продажів.')
    if hasattr(params, 'getlist'):
        require(all(len(params.getlist(key)) == 1 for key in params), 'Параметр продажів повторюється.')
    start, end = params.get('from', ''), params.get('to', '')
    if start: require(day(start).isoformat() == start, 'Дата має формат РРРР-ММ-ДД.')
    if end: require(day(end).isoformat() == end, 'Дата має формат РРРР-ММ-ДД.')
    require(not start or not end or start <= end, 'Початкова дата пізніша за кінцеву.')
    query = {'store': positive_integer(params['store'], 'ID магазину') if params.get('store') else None,
             'from': start, 'to': end, 'status': params.get('status', '')}
    return query


def paged(query, params):
    total = query.count()
    page, pages, offset = page_bounds(total, page_number(params))
    return {'total': total, 'page': page, 'pages': pages, 'limit': PAGE_SIZE}, offset


def documents(user, params):
    selected = options(params, {'q', 'store', 'status', 'kind', 'from', 'to', 'page'})
    kind = params.get('kind', '')
    require(kind in ('', *KINDS), 'Невідомий вид продажу.')
    require(selected['status'] in {'', 'draft', 'posted', 'reversed'}, 'Невідомий стан документа.')
    selected.update(q=params.get('q', '').strip(), kind=kind)
    with read_snapshot():
        user = current_actor(user)
        auth = policy(user)
        query = scoped(Voucher.objects.filter(kind__in=KINDS), user)
        for key, field in [('store', 'store_id'), ('status', 'status'), ('kind', 'kind')]:
            if selected[key]: query = query.filter(**{field: selected[key]})
        query = filter_search(query, params)
        bounds, offset = paged(query, params)
        rows = query.order_by('-date', '-pk').values('id', 'kind', 'status', 'date', 'store_id', 'store__name',
                 'party_id', 'party__name', 'employee_id', 'employee__name', 'total', 'revision')[offset:offset + PAGE_SIZE]
        return {**bounds, 'policy': auth, 'query': selected,
                'fiscalRequired': Setting.objects.filter(key='fiscal_required', value='true').exists(),
                'items': [{'id': r['id'], 'number': f"{r['id']:06}", 'kind': r['kind'], 'status': r['status'],
                           'date': r['date'].isoformat(), 'store': r['store_id'], 'storeName': r['store__name'],
                           'party': r['party_id'], 'partyName': r['party__name'] or '',
                           'employee': r['employee_id'], 'employeeName': r['employee__name'] or '',
                           'total': format(r['total'], '.2f'), 'revision': r['revision']} for r in rows]}


def cash_shifts(user, params):
    selected = options(params, {'store', 'employee', 'status', 'from', 'to', 'page'})
    selected['employee'] = positive_integer(params['employee'], 'ID працівника') if params.get('employee') else None
    require(selected['status'] in {'', 'open', 'closed'}, 'Невідомий стан зміни.')
    with read_snapshot():
        user = current_actor(user)
        auth = policy(user)
        query = scoped(CashShift.objects.all(), user).annotate(opened_day=TruncDate('opened_at', tzinfo=KYIV))
        for key in ('store', 'employee'):
            if selected[key]: query = query.filter(**{key + '_id': selected[key]})
        if selected['status']: query = query.filter(closed_at__isnull=selected['status'] == 'open')
        if selected['from']: query = query.filter(opened_day__gte=selected['from'])
        if selected['to']: query = query.filter(opened_day__lte=selected['to'])
        bounds, offset = paged(query, params)
        rows = query.order_by('-pk').values('id', 'store_id', 'store__name', 'account_id', 'account__name',
                 'employee_id', 'employee__name', 'opened_by_id', 'opened_by__username', 'opened_at', 'closed_at',
                 'opening_cash', 'expected_cash', 'counted_cash')[offset:offset + PAGE_SIZE]
        return {**bounds, 'query': selected, 'policy': auth, 'items': [shift_row(r, user) for r in rows]}


def shift_row(row, user):
    def amount(key):
        value = row[key]
        return format(value, '.2f') if value is not None else None
    complete = row['expected_cash'] is not None and row['counted_cash'] is not None
    return {'id': row['id'], 'store': row['store_id'], 'storeName': row['store__name'],
            'account': row['account_id'], 'accountName': row['account__name'],
            'employee': row['employee_id'], 'employeeName': row['employee__name'] or '',
            'openedAt': row['opened_at'].isoformat(), 'closedAt': row['closed_at'].isoformat() if row['closed_at'] else None,
            'openedBy': row['opened_by__username'], 'openingCash': amount('opening_cash'),
            'expectedCash': amount('expected_cash'), 'countedCash': amount('counted_cash'),
            'difference': format(row['counted_cash'] - row['expected_cash'], '.2f') if complete else None,
            'canClose': row['closed_at'] is None and (user.profile.role != 'cashier' or row['opened_by_id'] == user.pk)}
