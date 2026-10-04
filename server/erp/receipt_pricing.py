"""Explicit invoice pricing proposals. Inventory facts never update catalogue prices implicitly."""
import hashlib
import hmac
import json
import re
import uuid
from django.db import transaction
from .models import Document, Voucher, Store
from .services import (BusinessError, Conflict, audit, current_actor, dec, get, ledger_lock,
                       permission, require, scope)
from .historical_reports import read_snapshot
from .catalog import EDIT_ROLES, defaults, normalise_product, pricing_revision, revision, serialize
from .catalog_price_results import (capture_context, comparison, result as price_result,
                                   resolve_context, scope_context, validate_context)
from .promotion_prices import PriceResolver
from .labels import sign
from .business_audit import snapshot as audit_snapshot, change as audit_change

FIELDS = {'cost', 'markup', 'manualPrice', 'price', 'priceReviewed'}
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
REVISION = r'[0-9a-f]{64}'


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def source_for(user, identifier):
    require(user.profile.role in EDIT_ROLES, 'Недостатньо прав для перегляду цін накладної.')
    permission(user, 'receipt')
    source = get(Voucher, identifier, 'Накладна')
    scope(user, source.store)
    require(source.kind == 'receipt', 'Для перегляду цін виберіть надходження.')
    return source


def source_data(source):
    rows = list(source.lines.order_by('pk')[:201])
    require(0 < len(rows) <= 200, 'Накладна має містити від 1 до 200 рядків.')
    value = {'id': source.pk, 'revision': source.revision, 'status': source.status,
             'date': source.date.isoformat(), 'store': source.store_id, 'storeName': source.store.name,
             'total': str(source.total), 'additionalCost': str(dec(source.payload.get('additional_cost', 0))),
             'lines': [{'id': row.pk, 'lineKey': str(row.line_key), 'product': row.product_id.split('/', 1)[1],
                        'name': row.name, 'unit': row.unit, 'quantity': str(row.quantity), 'price': str(row.price),
                        'amount': str(row.amount), 'landedAmount': str(row.cost) if source.status == 'posted' else None,
                        'lot': row.lot, 'expiry': row.expiry.isoformat() if row.expiry else ''} for row in rows]}
    return value, sign(value)


def context_for_get(user, source, params):
    require(not(set(params) - {'store'}), 'Невідомі параметри перегляду.')
    selected = params.get('store', str(source.store_id))
    if selected == 'network': selected = None
    elif isinstance(selected, str) and selected.isascii() and selected.isdigit(): selected = int(selected)
    return resolve_context(user, {'priceContext': {'storeId': selected}})


def current_data(request, user, identifier):
    with read_snapshot():
        user = current_actor(user); source = source_for(user, identifier)
        store = context_for_get(user, source, request.GET)
        value, snapshot = source_data(source)
        config = defaults()
        paths = sorted({'products/'+row['product'] for row in value['lines']})
        documents = list(Document.objects.filter(pk__in=paths).order_by('path'))
        resolver = PriceResolver(config, store, product_paths=paths)
        return {'source': value, 'sourceSnapshot': snapshot, 'priceContext': capture_context(store),
                'effectiveDay': resolver.day.isoformat(), 'csrf': request.portal_session.csrf,
                'canEdit': source.status in {'draft', 'posted'} and source.store.active,
                'canSelectNetwork': user.profile.store_id is None,
                'products': [serialize(document, user, config, resolver=resolver) for document in documents]}


def validate(value, *, committing=False):
    fields = {'sourceRevision', 'sourceSnapshot', 'priceContext', 'entries', 'reason'}
    if committing: fields |= {'snapshot', 'idempotencyKey'}
    require(isinstance(value, dict) and set(value) == fields, 'Некоректні поля перегляду цін.')
    require(type(value['sourceRevision']) is int and value['sourceRevision'] > 0, 'Некоректна версія накладної.')
    require(isinstance(value['sourceSnapshot'], str) and re.fullmatch(REVISION, value['sourceSnapshot']), 'Відсутній знімок накладної.')
    validate_context(value['priceContext'])
    reason = value['reason']
    require(isinstance(reason, str) and 0 < len(reason.strip()) <= 300, 'Вкажіть причину перегляду цін (до 300 символів).')
    entries = value['entries']
    require(isinstance(entries, list) and 0 < len(entries) <= 200, 'Виберіть від 1 до 200 товарів.')
    ids = set()
    for entry in entries:
        require(isinstance(entry, dict) and set(entry) == {'id', 'revision', 'sourceLine', 'values'}, 'Некоректний товар перегляду.')
        identifier = entry['id']
        require(isinstance(identifier, str) and re.fullmatch('[A-Za-z0-9_-]{1,120}', identifier) and identifier not in ids, 'Некоректний або повторений ID товару.')
        ids.add(identifier)
        require(isinstance(entry['revision'], str) and re.fullmatch(REVISION, entry['revision']), 'Відсутня версія товару.')
        source = entry['sourceLine']
        require(source is None or isinstance(source, dict) and set(source) == {'id', 'lineKey'} and type(source['id']) is int and source['id'] > 0 and isinstance(source['lineKey'], str) and re.fullmatch(UUID, source['lineKey']), 'Некоректний вихідний рядок.')
        data = entry['values']
        require(isinstance(data, dict) and set(data) == FIELDS, 'Перегляд змінює лише явні поля ціни.')
        for key in ('cost', 'markup', 'price'):
            require(isinstance(data[key], str) or key == 'price' and data[key] is None, 'Ціни мають бути десятковими рядками.')
        require(type(data['manualPrice']) is bool and type(data['priceReviewed']) is bool, 'Некоректні ознаки ціни.')
    if committing:
        require(isinstance(value['snapshot'], str) and re.fullmatch(REVISION, value['snapshot']), 'Відсутній перевірений план.')
        require(isinstance(value['idempotencyKey'], str) and re.fullmatch(UUID, value['idempotencyKey']), 'Ключ повтору має бути UUID.')


def plan(user, identifier, payload):
    validate(payload)
    source = source_for(user, identifier)
    value, snapshot = source_data(source)
    if source.revision != payload['sourceRevision'] or not hmac.compare_digest(snapshot, payload['sourceSnapshot']):
        raise Conflict('Накладну змінено. Прочитайте джерело повторно; ваша пропозиція збережена.', 'source_conflict')
    require(source.status in {'draft', 'posted'} and source.store.active, 'Доступ до зміни цін цього джерела обмежений.')
    store = resolve_context(user, payload)
    config = defaults()
    source_rows = {row['id']: row for row in value['lines']}
    source_products = {row['product'] for row in value['lines']}
    paths = ['products/'+entry['id'] for entry in payload['entries']]
    documents = {doc.path: doc for doc in Document.objects.filter(pk__in=paths)}
    resolver = PriceResolver(config, store, product_paths=paths)
    entries, prepared = [], []
    for entry in payload['entries']:
        record = {'id': entry['id'], 'revision': entry['revision'], 'sourceLine': entry['sourceLine']}
        try:
            require(entry['id'] in source_products, 'Товар не належить цій накладній.')
            document = documents.get('products/'+entry['id'])
            require(document is not None and document.data.get('hidden') is not True, 'Товар відсутній або прихований. Перевірте каталог окремо.')
            require(revision(document, config) == entry['revision'], 'Товар уже змінено. Прочитайте поточні поля й узгодьте пропозицію.')
            row = entry['sourceLine']
            if row is not None:
                bound = source_rows.get(row['id'])
                require(bound is not None and bound['lineKey'] == row['lineKey'] and bound['product'] == entry['id'], 'Вихідний рядок більше не відповідає товару.')
                require(bound['unit'] == str(document.data.get('unit') or 'шт'), 'Одиниця рядка відрізняється від каталогу. Введіть закупівлю явно; автоматичного перерахунку немає.')
                cost = dec(bound['price'], 'Закупівельна ціна джерела')
                require(dec(entry['values']['cost'], 'Закупівля каталогу') == cost, 'Обрана закупівельна ціна відрізняється від рядка. Використайте явне введення.')
            data = normalise_product(entry['values'], document.data, document.path, validate_references=False, bind_references=False, config=config, old_config=config)
            candidate = Document(path=document.path, data=data)
            serialized = serialize(candidate, user, config, resolver=resolver)
            record.update(values={key: serialized[key] for key in ('cost', 'markup', 'manualPrice', 'price')},
                          priceReviewed=entry['values']['priceReviewed'], comparison=comparison(document, candidate, config, resolver), error=None)
            prepared.append((record, document, data))
        except BusinessError as exc:
            record.update(error=str(exc), values=None, comparison=None, priceReviewed=entry['values']['priceReviewed'])
        entries.append(record)
    result = {'source': value, 'sourceSnapshot': snapshot, 'priceContext': capture_context(store),
              'effectiveDay': resolver.day.isoformat(), 'valid': all(row['error'] is None for row in entries), 'entries': entries}
    result['snapshot'] = sign({'actor': user.pk, 'source': snapshot, 'payload': payload, 'entries': entries,
                               'pricing': pricing_revision(config), 'day': resolver.day.isoformat()})
    return result, prepared, config, resolver


def preview(user, identifier, value):
    with read_snapshot():
        return plan(current_actor(user), identifier, value)[0]


def authorize_receipt(user, receipt):
    require(user.profile.role in EDIT_ROLES, 'Недостатньо прав для результату перегляду цін.')
    permission(user, 'receipt'); scope(user, get(Store, receipt['source']['store'], 'Магазин джерела'))
    scope_context(user, receipt['priceContext'])
    current = Voucher.objects.filter(pk=receipt['source']['id']).first()
    if current: scope(user, current.store)


def authorize_current(user, identifier, context=None):
    # Authorization precedes receipt existence/fingerprint disclosure, even on exact retry.
    require(user.profile.role in EDIT_ROLES, 'Недостатньо прав для перегляду цін накладної.')
    permission(user, 'receipt')
    if context is not None: scope_context(user, context)
    current = Voucher.objects.filter(pk=identifier).select_related('store').first()
    if current: scope(user, current.store)


@transaction.atomic
def commit(user, identifier, payload):
    validate(payload, committing=True)
    ledger_lock(); user = current_actor(user)
    authorize_current(user, identifier, payload['priceContext'])
    digest = hashlib.sha256(canonical({'source': identifier, 'payload': payload}).encode()).hexdigest()
    path = 'import_runs/'+payload['idempotencyKey']
    old = Document.objects.filter(pk=path).first()
    if old:
        if old.data.get('contract') == 'receipt-pricing-v1': authorize_receipt(user, old.data['result'])
        if old.data.get('contract') != 'receipt-pricing-v1' or old.data.get('owner') != user.pk or old.data.get('payloadHash') != digest:
            raise Conflict('Ключ повтору вже використано для іншого перегляду.', 'idempotency_conflict')
        return old.data['result']
    from .import_models import CatalogImportRun
    if CatalogImportRun.objects.filter(pk=payload['idempotencyKey']).exists():
        raise Conflict('Ключ повтору вже використано.', 'idempotency_conflict')
    request = {key: value for key, value in payload.items() if key not in {'idempotencyKey', 'snapshot'}}
    reviewed, prepared, config, resolver = plan(user, identifier, request)
    if not hmac.compare_digest(reviewed['snapshot'], payload['snapshot']):
        raise Conflict('Ціни, акція або день змінилися. Прочитайте й узгодьте перегляд повторно.', 'revision_conflict')
    require(reviewed['valid'], 'Перегляд містить помилки. Жодного товару не змінено.')
    from .promotion_history import observe_prices
    entries = []
    products = [document for _, document, _ in prepared]
    observe_prices(user, products, 'receipt-pricing', payload['reason'], seed=True)
    for ordinal, (record, document, data) in enumerate(prepared, 1):
        before = audit_snapshot('product', document.data)
        document.data = data; document.save()
        changed = price_result(record['id'], 'updated', record['comparison'], resolver, line=ordinal, ordinal=ordinal)
        entries.append({'line': ordinal, 'action': 'update', 'id': record['id'], 'revision': revision(document, config), 'priceResult': changed})
        audit(user, 'catalog_changed', document.path, {'contract':'receipt-pricing-v1', 'run':payload['idempotencyKey'],
              'source':{'id':identifier,'revision':reviewed['source']['revision'],'status':reviewed['source']['status']}, 'sourceLine':record['sourceLine'],
              **audit_change(before, audit_snapshot('product', data), observed=record['revision'], reason=payload['reason'])})
    observe_prices(user, products, 'receipt-pricing', payload['reason'])
    receipt = {'ok':True, 'idempotencyKey':payload['idempotencyKey'], 'source':reviewed['source'],
               'sourceSnapshot':reviewed['sourceSnapshot'], 'priceContext':reviewed['priceContext'],
               'counts':{'created':0, 'updated':len(entries), 'errors':0}, 'entries':entries}
    Document.objects.create(path=path, data={'contract':'receipt-pricing-v1', 'owner':user.pk, 'payloadHash':digest,
                                           'priceContext':receipt['priceContext'], 'result':receipt})
    from .import_jobs import mirror_atomic
    mirror_atomic(user, uuid.UUID(payload['idempotencyKey']), digest, receipt, price_context=receipt['priceContext'])
    audit(user, 'receipt_catalog_reviewed', path, {'source':reviewed['source'], 'count':len(entries), 'reason':payload['reason']})
    return receipt


def read_result(user, identifier, key):
    with read_snapshot():
        user = current_actor(user)
        authorize_current(user, identifier)
        value = Document.objects.filter(pk='import_runs/'+key, data__owner=user.pk, data__contract='receipt-pricing-v1').first()
        require(value is not None and value.data['result']['source']['id'] == identifier, 'Результат перегляду не знайдено.')
        receipt = value.data['result']; authorize_receipt(user, receipt)
        return receipt


def handle(request, user):
    from .views import body, response
    match = re.fullmatch(r'/api/v1/receipt-pricing/([1-9][0-9]{0,15})(?:/(preview|commit|results/('+UUID+')))?', request.path)
    if not match: return response({'error':'Шлях перегляду не знайдено.'},404)
    identifier, action, key = match.groups(); identifier = int(identifier)
    require(identifier <= 9007199254740991, 'Некоректний ID накладної.')
    if action is None and request.method == 'GET': return response(current_data(request, user, identifier))
    if action and action.startswith('results/') and request.method == 'GET': return response(read_result(user, identifier, key))
    require(request.method == 'POST' and action in {'preview','commit'}, 'Метод не підтримується.')
    value = body(request)
    return response(preview(user, identifier, value) if action == 'preview' else commit(user, identifier, value))
