"""Compact creator receipts over existing catalogue mutations; no new economics."""
import copy
import hashlib
import json
import re
import uuid
from django.db import transaction
from django.http import QueryDict
from .catalog_budget import bounded, check
from .historical_reports import read_snapshot
from .models import Document, Store
from .services import BusinessError, Conflict, current_actor, ledger_lock, require

OPERATIONS = {'product_create', 'product_update', 'product_visibility', 'product_delete',
              'reference_create', 'reference_commit'}
CREATES = {'product_create', 'reference_create'}
ID = re.compile(r'[A-Za-z0-9_-]{1,120}')
PREFIX = 'catalog_action_receipts/'


def authorize(user, store):
    from .catalog import EDIT_ROLES
    require(user.profile.role in EDIT_ROLES, 'Недостатньо прав для відновлення каталогу.')
    require(store is None or type(store) is int and store > 0, 'Некоректний магазин.')
    if store is not None:
        require(user.profile.store_id is None or user.profile.store_id == store,
                'Недостатньо прав для цього магазину.')
        require(Store.objects.filter(pk=store).exists(), 'Магазин не знайдено.')


def context_value(value):
    require(isinstance(value, dict) and set(value) == {'operation', 'target', 'store'}, 'Некоректний контекст каталогу.')
    operation, target, store = (value[key] for key in ('operation', 'target', 'store'))
    require(isinstance(operation, str) and operation in OPERATIONS, 'Невідома дія каталогу.')
    require(target is None if operation in CREATES else isinstance(target, str) and ID.fullmatch(target),
            'Некоректний ID дії каталогу.')
    require(store is None or type(store) is int and store > 0, 'Некоректний магазин.')
    return {'operation': operation, 'target': target, 'store': store}


def envelope(value):
    from .catalog import PRODUCT_FIELDS, TEXT_FIELDS
    require(isinstance(value, dict) and set(value) == {'key', 'operation', 'target', 'store', 'request'}, 'Некоректний первісний запит каталогу.')
    key = value['key']
    try: parsed = str(uuid.UUID(key)) if isinstance(key, str) else None
    except (ValueError, AttributeError): parsed = None
    require(parsed is not None and parsed == key, 'Потрібен canonical UUID дії каталогу.')
    context = context_value({name: value[name] for name in ('operation', 'target', 'store')})
    request = value['request']; operation = context['operation']
    require(isinstance(request, dict), 'Очікується первісний JSON-об’єкт.')
    allowed = PRODUCT_FIELDS | {'revision', 'pricingRevision'}
    required = set()
    if operation == 'product_create': allowed -= {'revision'}
    elif operation == 'product_update': required = {'revision'}
    elif operation == 'product_visibility': allowed = required = {'revision', 'hidden'}
    elif operation == 'product_delete': allowed = required = {'revision'}
    elif operation == 'reference_create': allowed = {'field', 'value', 'parentType'}; required = {'field', 'value'}
    else: allowed = {'sourceId', 'revision', 'operation', 'value', 'targetId', 'snapshot', 'idempotencyKey'}; required = {'sourceId', 'revision', 'operation', 'snapshot', 'idempotencyKey'}
    require(not set(request) - allowed and required <= set(request), 'Невідомі або відсутні поля первісної дії.')
    for name, item in request.items():
        require(item is None or type(item) in {str, bool, int}, 'Первісна дія приймає лише scalar поля.')
        if isinstance(item, str): require(len(item) <= max(1000, TEXT_FIELDS.get(name, 128)), 'Поле первісної дії задовге.')
    if operation.startswith('product_'):
        for name in set(request) & TEXT_FIELDS.keys(): require(isinstance(request[name], str), 'Текстові поля товару мають бути рядками.')
        for name in set(request) & {'cost', 'markup', 'price', 'promotionPrice', 'minStock'}:
            require(request[name] is None or isinstance(request[name], str), 'Передайте десяткові поля рядками.')
        for name in set(request) & {'manualPrice', 'promotion', 'priceReviewed', 'hidden'}:
            require(type(request[name]) is bool, 'Передайте логічні поля без перетворення типу.')
        if 'expiryAlertDays' in request: require(request['expiryAlertDays'] is None or type(request['expiryAlertDays']) is int, 'Некоректний поріг придатності.')
    if operation == 'reference_commit':
        require(request['idempotencyKey'] == key and request['sourceId'] == context['target'], 'UUID або source ID не відповідає перевіреній дії.')
    return {'key': key, **context, 'request': request}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def matching(user, value):
    receipt = Document.objects.filter(pk=PREFIX + value['key']).values_list('data', flat=True).first()
    if receipt is None: return None
    if receipt['author'] != user.pk or receipt['fingerprint'] != fingerprint(value):
        raise Conflict('UUID використано іншим автором або з іншими умовами.', 'idempotency_conflict')
    return receipt['acknowledgement']


def request_copy(request, value):
    cloned = copy.copy(request)
    cloned._body = json.dumps(value['request'], ensure_ascii=False).encode()
    cloned.GET = QueryDict(mutable=True)
    if value['store'] is not None: cloned.GET['store'] = str(value['store'])
    operation, target = value['operation'], value['target']
    cloned.method = {'product_update': 'PATCH', 'product_visibility': 'PATCH', 'product_delete': 'DELETE'}.get(operation, 'POST')
    if operation.startswith('product_'):
        cloned.path = '/api/v1/catalog/products' + ('/' + target if target else '') + ('/visibility' if operation == 'product_visibility' else '')
    else: cloned.path = '/api/v1/catalog/references' + ('/commit' if operation == 'reference_commit' else '')
    return cloned


def perform(request, user, value):
    from .catalog import save_product, save_visibility
    from .catalog_references import create_reference
    from .catalog_reference_management import commit
    cloned = request_copy(request, value); operation = value['operation']
    if operation == 'product_visibility': result = save_visibility(cloned, user, value['target'])
    elif operation.startswith('product_'): result = save_product(cloned, user, value['target'])
    elif operation == 'reference_create': result = create_reference(cloned, user)
    else: result = commit(cloned, user)
    if result.status_code >= 400: return result, None
    data = json.loads(result.content)
    target = value['target'] if operation not in CREATES else data['id']
    require(isinstance(target, str) and ID.fullmatch(target), 'Не підтверджено ID результату каталогу.')
    outcome = 'deleted' if operation == 'product_delete' else 'committed' if operation == 'reference_commit' else 'created' if operation in CREATES else 'saved'
    return result, {'confirmed': True, 'key': value['key'], 'operation': operation, 'target': target,
                    'requestHash': fingerprint(value), 'outcome': outcome}


def rejected(value):
    return {'write_rejected': True, 'key': value['key'], 'operation': value['operation'], 'requestHash': fingerprint(value)}


@bounded
def execute(request, user):
    from .views import body, response
    value = envelope(body(request))
    with transaction.atomic():
        ledger_lock(); user = current_actor(user); authorize(user, value['store'])
        previous = matching(user, value)
        if previous is not None: acknowledgement = previous
        else:
            error = None
            try:
                with transaction.atomic():
                    result, acknowledgement = perform(request, user, value)
                    if acknowledgement is None:
                        error = (json.loads(result.content), result.status_code)
                        transaction.set_rollback(True)
                    else:
                        Document.objects.create(path=PREFIX + value['key'], data={'author': user.pk, 'fingerprint': fingerprint(value), 'acknowledgement': acknowledgement})
                        check()
            except Conflict as cause:
                if cause.code == 'idempotency_conflict': raise
                error = ({'error': str(cause), 'code': cause.code, **cause.extra}, 409)
            except BusinessError as cause:
                if any(word in str(cause) for word in ('прав', 'доступ', 'роль')): raise
                error = ({'error': str(cause)}, 400)
            if error is not None:
                message, status = error
                if status in {400, 409} and message.get('code') != 'idempotency_conflict': message = {**message, **rejected(value)}
                acknowledgement = message
            else: status = 200
        if previous is not None: status = 200
    # Outer commit/on_commit/response serialization failures never acquire rollback proof.
    return response(acknowledgement, status)


@bounded
def identity(request, user):
    from .views import body, response
    value = envelope(body(request))
    with read_snapshot():
        user = current_actor(user); authorize(user, value['store'])
        result = matching(user, value)
        if result is None:
            result = {'confirmed': False, 'key': value['key'], 'operation': value['operation'], 'target': value['target'], 'requestHash': fingerprint(value), 'outcome': 'unresolved'}
        return response(result)


@bounded
def context(request, user):
    from .views import response
    params = request.GET
    require(set(params) <= {'operation', 'target', 'store'} and all(len(params.getlist(key)) == 1 for key in params), 'Некоректні параметри контексту каталогу.')
    raw = params.get('store', '')
    require(not raw or re.fullmatch('[1-9][0-9]{0,14}', raw), 'Некоректний магазин.')
    value = context_value({'operation': params.get('operation'), 'target': params.get('target') or None, 'store': int(raw) if raw else None})
    with read_snapshot():
        user = current_actor(user); authorize(user, value['store'])
        prefix = 'products/' if value['operation'].startswith('product_') else 'catalog_refs/'
        exists = Document.objects.filter(pk=prefix + value['target']).exists() if value['target'] else None
        return response({**value, 'exists': exists, 'editing': {'role': user.profile.role, 'storeId': user.profile.store_id, 'networkOwner': user.profile.role == 'owner' and user.profile.store_id is None, 'canWrite': True}})


def handle(request, user):
    from .views import response
    require(not request.GET or request.path.endswith('/context'), 'Невідомі параметри дії каталогу.')
    if request.path.endswith('/execute') and request.method == 'POST': return execute(request, user)
    if request.path.endswith('/identity') and request.method == 'POST': return identity(request, user)
    if request.path.endswith('/context') and request.method == 'GET': return context(request, user)
    return response({'error': 'Метод відновлення каталогу не підтримується.', 'code': 'unsupported_route'}, 405)
