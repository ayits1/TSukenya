"""React Stock contracts. Reads share a current-policy RR snapshot; mutations
remain in the authoritative assortment service. No receipt is invented for it.
"""
from . import assortment, stock_browsing
from .browsing import PAGE_SIZE, page_bounds, page_number, positive_integer
from .historical_reports import read_snapshot
from .models import Voucher
from .reporting import scoped, alert_status
from .services import current_actor, require, ROLE_KINDS

KINDS = ('opening', 'transfer', 'writeoff', 'inventory', 'production')


def policy(user):
    return {'role': user.profile.role, 'store': user.profile.store_id,
            'costVisible': user.profile.role != 'cashier',
            'canEditAssortment': user.profile.role in assortment.ROLES,
            'documentKinds': [kind for kind in KINDS if kind in ROLE_KINDS.get(user.profile.role, set())],
            'canControl': user.profile.role in {'owner', 'manager'},
            'canLegacyRecipes': user.profile.role in {'owner', 'manager', 'warehouse'},
            'canRecipeVersions': user.profile.role in {'owner', 'manager'},
            'canReplenish': 'purchase_order' in ROLE_KINDS.get(user.profile.role, set())}


def validate_query(query, allowed):
    require(set(query).issubset(allowed), 'Невідомий параметр запиту залишків.')


def stock(user, query):
    validate_query(query, {'q', 'store', 'warehouse', 'page', 'view', 'sort'})
    with read_snapshot():
        user = current_actor(user)
        value = stock_browsing.options(user, query)
        result = stock_browsing.stock_page(user, query)
        return {**result, 'query': {key: value[key] for key in ('q', 'store', 'warehouse', 'view')},
                'policy': policy(user),
                'alerts': alert_status() if user.profile.role in {'owner', 'manager'} else None}


def assortment_page(user, query):
    validate_query(query, {'warehouse', 'q', 'product', 'page', 'sort'})
    with read_snapshot():
        user = current_actor(user)
        result = assortment.assortment(user, query)
        return {**result, 'query': {'q': query.get('q', '').strip(), 'product': query.get('product', '')}, 'policy': policy(user)}


def documents(user, query):
    validate_query(query, {'store', 'status', 'page'})
    with read_snapshot():
        user = current_actor(user)
        require(user.profile.role in stock_browsing.ROLES, 'Недостатньо прав для залишків.')
        status = query.get('status', '')
        require(status in {'', 'draft', 'posted', 'reversed'}, 'Невідомий стан документа.')
        store = positive_integer(query['store'], 'ID магазину') if query.get('store') else None
        # The stock journal needs neither full payload/children nor settlements.
        qs = scoped(Voucher.objects.filter(kind__in=set(KINDS) & ROLE_KINDS.get(user.profile.role, set())), user)
        if status: qs = qs.filter(status=status)
        if store: qs = qs.filter(store_id=store)
        total = qs.count(); page, pages, offset = page_bounds(total, page_number(query))
        rows = qs.order_by('-date', '-pk').values('id', 'kind', 'status', 'date', 'store_id', 'party_id', 'employee_id', 'total', 'revision')[offset:offset + PAGE_SIZE]
        return {'items': [{'id': row['id'], 'number': f"{row['id']:06}", 'kind': row['kind'], 'status': row['status'],
                           'date': row['date'].isoformat(), 'store': row['store_id'], 'party': row['party_id'], 'employee': row['employee_id'],
                           'total': format(row['total'], '.2f'), 'revision': row['revision']} for row in rows],
                'total': total, 'page': page, 'pages': pages, 'limit': PAGE_SIZE,
                'query': {'store': store, 'status': status}, 'policy': policy(user)}


def handle(request, user):
    from .views import response, body
    path = request.path
    if request.method == 'GET':
        if path.endswith('/stock.csv'):
            validate_query(request.GET, {'q', 'store', 'warehouse', 'view', 'sort'})
            return stock_browsing.stock_csv(user, request.GET)
        if path.endswith('/stock/documents'): return response(documents(user, request.GET))
        if path.endswith('/assortment'): return response(assortment_page(user, request.GET))
        if path.endswith('/stock'): return response(stock(user, request.GET))
    if request.method == 'POST' and path.endswith('/assortment'):
        value = body(request)
        validate_query(value, {'warehouse', 'product', 'sold', 'min_stock', 'revision'})
        row = assortment.save_assortment(user, value)
        with read_snapshot():
            user = current_actor(user)
            assortment.warehouse_for(user, value.get('warehouse'))
            return response({'warehouse': int(value['warehouse']), 'row': row, 'policy': policy(user)})
    return response({'error': 'Метод недоступний.'}, 405)
