"""Exact assortment save receipts; fresh scalar recovery reads, no financial changes."""
import hashlib
import json
import re
import uuid
from types import SimpleNamespace
from django.db import connection, transaction
from . import assortment
from .historical_reports import read_snapshot
from .models import Assortment, Document, Warehouse
from .services import BusinessError, Conflict, current_actor, ledger_lock, require

PREFIX = 'assortment_action_receipts/'
CONTRACT = 'assortment-action-v1'


class Denied(BusinessError):
    pass


def selection(value, query=False):
    require(isinstance(value, dict) or hasattr(value, 'getlist'), 'Некоректний контекст асортименту.')
    if query:
        require(set(value) == {'warehouse', 'product'}, 'Некоректні параметри асортименту.')
        if hasattr(value, 'getlist'): require(all(len(value.getlist(k)) == 1 for k in value), 'Параметр має бути однозначним.')
    w = value.get('warehouse'); p = value.get('product')
    require((isinstance(w, int) and not isinstance(w, bool) and w > 0) or
            (query and isinstance(w, str) and re.fullmatch(r'[1-9][0-9]*', w)), 'Потрібен склад.')
    require(int(w) <= 9007199254740991, 'Некоректний склад.')
    require(isinstance(p, str) and 0 < len(p) <= 120 and '/' not in p and all(ord(c) >= 32 for c in p), 'Некоректний товар.')
    return int(w), p


def request(value):
    require(isinstance(value, dict) and set(value) == {'key', 'warehouse', 'product', 'revision', 'unit', 'terms'}, 'Некоректний запит асортименту.')
    warehouse, product = selection(value)
    try: key = str(uuid.UUID(value['key']))
    except (ValueError, TypeError, AttributeError): raise BusinessError('Потрібен UUID запиту.')
    require(value['key'] == key, 'Некоректний UUID запиту.')
    require(value['revision'] is None or isinstance(value['revision'], str) and re.fullmatch(r'[a-f0-9]{32}', value['revision']), 'Некоректна версія асортименту.')
    require(isinstance(value['unit'], str) and 0 < len(value['unit']) <= 64, 'Некоректна одиниця товару.')
    terms = value['terms']
    require(isinstance(terms, dict) and set(terms) == {'sold', 'min_stock'} and isinstance(terms['sold'], bool), 'Некоректні умови асортименту.')
    require(terms['min_stock'] is None or isinstance(terms['min_stock'], str) and len(terms['min_stock']) <= 40, 'Некоректний мінімальний залишок.')
    fingerprint = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    return key, warehouse, product, fingerprint


def grant(user, warehouse):
    user = current_actor(user)
    if user.profile.role not in assortment.ROLES: raise Denied('Недостатньо прав для асортименту складу.')
    w = Warehouse.objects.only('id', 'store_id').filter(pk=warehouse).first()
    if w is None or user.profile.store_id is not None and user.profile.store_id != w.store_id:
        raise Denied('Склад недоступний у поточному контексті.')
    return user, w


def projection(path, fields, maximum=8192):
    """Typed JSON object preserves SQLite JSON-looking strings and bounds driver data.

    Only hard-coded callers choose field names. Unknown historical JSON stays SQL.
    """
    table = connection.ops.quote_name(Document._meta.db_table)
    names = ','.join("'" + k + "'" for k in fields)
    if connection.vendor == 'postgresql':
        projected = f"(SELECT coalesce(jsonb_object_agg(key,value),'{{}}'::jsonb) FROM jsonb_each(data) WHERE key IN ({names}))"
        size = f'octet_length(({projected})::text)'; kind = 'jsonb_typeof(data)'
    else:
        projected = f"(SELECT coalesce(json_group_object(key,json(CASE WHEN type IN ('true','false','null') THEN type WHEN type IN ('object','array') THEN value ELSE json_quote(value) END)),'{{}}') FROM json_each(data) WHERE key IN ({names}))"
        size = f'length(CAST(({projected}) AS BLOB))'; kind = 'json_type(data)'
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT CASE WHEN {kind}='object' THEN CASE WHEN {size}<=%s THEN {projected} END END FROM {table} WHERE path=%s", [maximum, path])
        row = cursor.fetchone()
    if row is None: return None
    require(row[0] is not None, 'Реквізити асортименту некоректні або перевищують дозволений розмір.')
    return json.loads(row[0]) if isinstance(row[0], str) else row[0]


def product(identifier):
    data = projection('products/' + identifier, ('name', 'unit', 'minStock'))
    if data is None: return None
    require(isinstance(data.get('name', ''), str) and len(data.get('name', '')) <= 1000,
            'Некоректна назва товару для асортименту.')
    require(isinstance(data.get('unit', 'шт'), str) and 0 < len(data.get('unit', 'шт')) <= 64,
            'Некоректна одиниця товару для асортименту.')
    return SimpleNamespace(pk='products/' + identifier, data=data)


def context(user, params):
    warehouse, identifier = selection(params, query=True)
    with read_snapshot():
        user, w = grant(user, warehouse)
        p = product(identifier)
        row = Assortment.objects.filter(warehouse_id=w.pk, product_id='products/' + identifier).first() if p else None
        return {'contract': 'assortment-context-v1', 'warehouse': w.pk, 'product': identifier, 'store': w.store_id,
                'role': user.profile.role, 'storeId': user.profile.store_id, 'exists': p is not None,
                'row': assortment.row_json(p, row) if p else None}


def receipt(user, key, warehouse, identifier, fingerprint):
    saved = projection(PREFIX + key, ('author', 'fingerprint', 'warehouse', 'product', 'revision', 'sold', 'min_stock', 'unit'))
    if saved is None: return None
    if saved.get('author') != user.pk or saved.get('fingerprint') != fingerprint or saved.get('warehouse') != warehouse or saved.get('product') != identifier:
        raise Conflict('Ключ асортименту вже використано іншим запитом.', 'idempotency_conflict')
    require(isinstance(saved.get('revision'), str) and re.fullmatch(r'[a-f0-9]{32}', saved['revision']), 'Квитанція асортименту пошкоджена.')
    return {k: saved[k] for k in ('warehouse', 'product', 'revision', 'sold', 'min_stock', 'unit')}


def identity(user, value):
    require(isinstance(value, dict) and set(value) == {'request'}, 'Некоректний запит підтвердження.')
    key, warehouse, identifier, fingerprint = request(value['request'])
    with read_snapshot():
        user, _ = grant(user, warehouse)
        original = receipt(user, key, warehouse, identifier, fingerprint)
        return {'contract': CONTRACT, 'key': key, 'warehouse': warehouse, 'product': identifier,
                'confirmed': original is not None, **({'original': original} if original else {})}


def execute(user, value):
    key, warehouse, identifier, fingerprint = request(value)
    with transaction.atomic():
        ledger_lock(); user, w = grant(user, warehouse)
        original = receipt(user, key, warehouse, identifier, fingerprint)
        if original is not None:
            return {'contract': CONTRACT, 'key': key, 'warehouse': warehouse, 'product': identifier, 'ok': True, 'original': original}, 200
        try:
            with transaction.atomic():
                p = product(identifier)
                require(p is not None, 'Товар більше недоступний.')
                require(p.data.get('unit', 'шт') == value['unit'], 'Одиницю товару змінено. Відкиньте стару чернетку перед новим введенням.')
                row = assortment.apply(user, {'revision': value['revision'], **value['terms']}, w, p)
                original = {'warehouse': w.pk, 'product': identifier, 'revision': row['revision'], 'sold': row['sold'], 'min_stock': row['min_stock'], 'unit': value['unit']}
                Document.objects.create(path=PREFIX + key, data={'author': user.pk, 'fingerprint': fingerprint, **original})
        except BusinessError as error:
            if isinstance(error, Conflict) and error.code != 'revision_conflict': raise
            status = 409 if isinstance(error, Conflict) else 400
            return {'error': str(error), 'code': error.code if isinstance(error, Conflict) else 'validation_error',
                    'write_rejected': True, 'contract': CONTRACT, 'key': key, 'warehouse': warehouse, 'product': identifier}, status
    return {'contract': CONTRACT, 'key': key, 'warehouse': warehouse, 'product': identifier, 'ok': True, 'original': original}, 200


def handle(request_, user):
    from .views import body, response
    try:
        action = request_.path.rsplit('/', 1)[-1]
        if request_.method == 'GET' and action in {'recovery-context', 'current'}: return response(context(user, request_.GET))
        if request_.method == 'POST' and action == 'identity': return response(identity(user, body(request_)))
        if request_.method == 'POST' and action == 'execute':
            result, status = execute(user, body(request_)); return response(result, status)
        return response({'error': 'Метод недоступний.'}, 405)
    except Denied as error: return response({'error': str(error)}, 403)
