"""Owner-only, bounded catalogue price plans and atomic retry-safe changes."""
import hashlib
import hmac
import re
from decimal import Decimal
from django.core.exceptions import RequestDataTooBig
from django.db import transaction
from .catalog import defaults, normalise_product, plain, revision, serialize
from .catalog_import import MAX_ENTRIES, UUID_PATTERN, canonical, snapshot
from .models import Document
from .services import BusinessError, audit, dec, ledger_lock, require

ROUNDING = {'0.01', '0.1', '0.5', '1'}


def pricing_body(request):
    from .views import body
    try:
        return body(request)
    except RequestDataTooBig:
        raise BusinessError('Запит зміни цін завеликий. Дозволено до 1000 товарів і 1 МіБ JSON.')


def validate_payload(payload, *, committing=False):
    kind = payload.get('kind')
    require(isinstance(kind, str) and kind in {'markup', 'rounding'}, 'Невідомий вид зміни цін.')
    fields = {'kind', 'ids', 'markup', 'resetManualPrices', 'updateDefault'} if kind == 'markup' else {'kind', 'rounding'}
    if committing:
        fields |= {'snapshot', 'idempotencyKey'}
    require(set(payload) == fields, 'Запит містить невідомі поля або не всі параметри зміни цін.')
    if kind == 'markup':
        require(isinstance(payload['markup'], str) and re.fullmatch(r'[0-9]+(?:\.[0-9]{1,4})?', payload['markup']), 'Націнка має бути невід’ємним десятковим рядком до 4 знаків після коми.')
        markup = dec(payload['markup'], 'Націнка', Decimal('.0001'))
        require(markup <= Decimal('99999999.99'), 'Націнка завелика.')
        require(type(payload['resetManualPrices']) is bool and type(payload['updateDefault']) is bool, 'Очікуються логічні параметри зміни цін.')
        ids = payload['ids']
        require(ids is None or isinstance(ids, list) and 0 < len(ids) <= MAX_ENTRIES, 'Виберіть від 1 до 1000 товарів або всі активні товари.')
        if ids is not None:
            require(all(isinstance(identifier, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,120}', identifier) for identifier in ids), 'Некоректний ID товару.')
            require(len(set(ids)) == len(ids), 'Список товарів містить повторені ID.')
        require(not payload['updateDefault'] or ids is None, 'Змінити націнку за замовчуванням можна лише для всіх активних товарів.')
    else:
        require(isinstance(payload['rounding'], str) and payload['rounding'] in ROUNDING, 'Виберіть округлення: 0.01, 0.1, 0.5 або 1.')
    if committing:
        require(isinstance(payload['snapshot'], str) and re.fullmatch(r'[0-9a-f]{64}', payload['snapshot']), 'Відсутній перевірений знімок зміни цін.')
        require(isinstance(payload['idempotencyKey'], str) and re.fullmatch(UUID_PATTERN, payload['idempotencyKey']), 'Ключ повтору має бути UUID у нижньому регістрі.')


def price_pair(document, user, config):
    product = serialize(document, user, config)
    return {'regularPrice': product['regularPrice'], 'salePrice': product['salePrice']}


def settings_pair(config):
    return {'defaultMarkup': plain(config['markup']), 'rounding': plain(config['rounding'])}


def plan(payload, user):
    validate_payload(payload)
    before_config = defaults()
    after_config = dict(before_config)
    documents = list(Document.objects.filter(path__startswith='products/').order_by('path'))
    active = {document.path.split('/', 1)[1]: document for document in documents if document.data.get('hidden') is not True}
    kind = payload['kind']
    if kind == 'markup':
        ids = payload['ids']
        if ids is not None:
            require(all(identifier in active for identifier in ids), 'Вибраний товар не існує або прихований. Оновіть каталог.')
        selected = set(active) if ids is None else set(ids)
        if payload['updateDefault']:
            after_config['markup'] = dec(payload['markup'], 'Націнка', Decimal('.0001'))
        # Pin the previous fallback for every excluded product, including hidden
        # products and skipped manual prices, before changing a future default.
        candidates = [document for document in documents if document.path.split('/', 1)[1] in selected
                      or payload['updateDefault'] and 'markup' not in document.data]
    else:
        selected = set()
        after_config['rounding'] = Decimal(payload['rounding'])
        candidates = documents
    require(len(candidates) <= MAX_ENTRIES, 'Зміна цін охоплює понад 1000 товарів. Зменшіть вибір; глобальне округлення потребує меншого каталогу.')
    entries = []
    prepared = []
    changed_prices = changed_records = skipped_manual = errors = 0
    for document in candidates:
        identifier = document.path.split('/', 1)[1]
        old = document.data
        before = price_pair(document, user, before_config)
        entry = {'id': identifier, 'name': str(old.get('name') or ''), 'hidden': bool(old.get('hidden')),
                 'action': 'unchanged', 'before': before, 'after': dict(before)}
        try:
            values = {}
            skipping = kind == 'markup' and identifier in selected and bool(old.get('manualPrice')) and not payload['resetManualPrices']
            if kind == 'markup':
                if identifier in selected and not skipping:
                    values.update(markup=payload['markup'])
                    if payload['resetManualPrices']:
                        values.update(manualPrice=False, price=None)
                elif payload['updateDefault'] and 'markup' not in old:
                    values['markup'] = format(before_config['markup'], 'f')
            entry['after'] = price_pair(Document(path=document.path, data={**old, **values}), user, after_config)
            data = normalise_product(values, old, document.path, validate_references=False, config=after_config)
            entry['after'] = price_pair(Document(path=document.path, data=data), user, after_config)
            # Only stored changes are written and audited; equal numbers compare alike (30 == 30.0).
            record_changed = data != old
            price_changed = before != entry['after']
            changed_records += record_changed
            changed_prices += price_changed
            entry['action'] = 'skip' if skipping else 'update' if record_changed else 'unchanged'
            skipped_manual += skipping
            prepared.append((document, data, entry, record_changed))
        except BusinessError as exc:
            errors += 1
            entry.update(action='error', error=str(exc))
        entries.append(entry)
    settings = {'before': settings_pair(before_config), 'after': settings_pair(after_config)}
    summary = {'candidates': len(entries), 'changedPrices': changed_prices, 'changedRecords': changed_records,
               'skippedManual': skipped_manual, 'errors': errors}
    return {'valid': errors == 0, 'kind': kind, 'snapshot': snapshot(documents, before_config),
            'entries': entries, 'summary': summary, 'settings': settings}, prepared, after_config


def preview_pricing(request, user):
    from .views import response
    require(user.profile.role == 'owner', 'Недостатньо прав. Зміна цін доступна лише власнику.')
    result, _, _ = plan(pricing_body(request), user)
    return response(result)


@transaction.atomic
def commit_pricing(request, user):
    from .views import response
    require(user.profile.role == 'owner', 'Недостатньо прав. Зміна цін доступна лише власнику.')
    payload = pricing_body(request)
    validate_payload(payload, committing=True)
    digest = hashlib.sha256(canonical(payload).encode()).hexdigest()
    path = 'pricing_runs/' + payload['idempotencyKey']
    ledger_lock()
    previous = Document.objects.filter(pk=path).first()
    if previous:
        if previous.data.get('owner') != user.pk or previous.data.get('payloadHash') != digest:
            return response({'error': 'Ключ повтору вже використано для іншої зміни цін.', 'code': 'idempotency_conflict'}, 409)
        return response(previous.data['result'])
    original_payload = {key: value for key, value in payload.items() if key not in {'snapshot', 'idempotencyKey'}}
    result, prepared, config = plan(original_payload, user)
    if not hmac.compare_digest(payload['snapshot'], result['snapshot']):
        return response({'error': 'Каталог або налаштування цін уже змінено. Оновіть попередній перегляд.', 'code': 'revision_conflict'}, 409)
    if not result['valid']:
        return response({**result, 'error': 'Зміна цін містить помилки. Жодного товару чи налаштування не збережено.', 'code': 'invalid_pricing'}, 400)
    settings = result['settings']
    if config != defaults():  # Decimal values: '30' and 30 are the same setting.
        document, _ = Document.objects.get_or_create(pk='settings/main', defaults={'data': {}})
        document.data = {**document.data, 'defaultMarkup': float(config['markup']), 'rounding': float(config['rounding'])}
        document.save()
        audit(user, 'pricing_settings_changed', document.path, {'run': payload['idempotencyKey'], **settings})
    committed_entries = []
    for document, data, entry, record_changed in prepared:
        if record_changed:
            document.data = data
            document.save()
            audit(user, 'catalog_changed', document.path, {'method': 'PRICING', 'contract': 'v1', 'run': payload['idempotencyKey']})
        committed_entries.append({'id': entry['id'], 'action': entry['action'], 'revision': revision(document, config)})
    committed = {'ok': True, 'idempotencyKey': payload['idempotencyKey'], 'kind': result['kind'],
                 'summary': result['summary'], 'settings': settings, 'entries': committed_entries}
    Document.objects.create(path=path, data={'owner': user.pk, 'payloadHash': digest, 'result': committed})
    audit(user, 'catalog_pricing_changed', path, result['summary'])
    return response(committed)
