"""Read-only catalogue import plans and bounded, retry-safe atomic commits."""
import hashlib
import hmac
import json
import re
import uuid
from collections import Counter, defaultdict
from decimal import Decimal
from django.conf import settings
from django.db import transaction
from django.core.exceptions import RequestDataTooBig
from .catalog import EDIT_ROLES, TEXT_FIELDS, defaults, name_key, normalise_product, plain, revision, serialize
from .models import Document
from .services import BusinessError, audit, dec, ledger_lock, require

MAX_ENTRIES = 1000
UUID_PATTERN = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'


def canonical(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    except (TypeError, ValueError):
        raise BusinessError('Імпорт містить некоректні JSON-значення.')


def snapshot(documents, config):
    material = {'products': [(doc.path, revision(doc, config)) for doc in documents],
                'pricing': {key: plain(value) for key, value in config.items()}}
    return hmac.new(settings.SECRET_KEY.encode(), canonical(material).encode(), hashlib.sha256).hexdigest()


def validate_payload(payload, *, committing=False):
    allowed = {'entries', 'defaultMarkup'} | ({'snapshot', 'idempotencyKey'} if committing else set())
    require(not (set(payload) - allowed), 'Запит містить невідомі поля імпорту.')
    entries = payload.get('entries')
    require(isinstance(entries, list) and 0 < len(entries) <= MAX_ENTRIES,
            f'Імпорт має містити від 1 до {MAX_ENTRIES} рядків. Розділіть більший файл на окремі пакети.')
    if 'defaultMarkup' in payload:
        require(isinstance(payload['defaultMarkup'], str), 'Націнка імпорту має бути десятковим рядком.')
        markup = dec(payload['defaultMarkup'], 'Націнка', Decimal('.0001'))
        require(markup <= Decimal('99999999.99'), 'Націнка завелика.')
    if committing:
        require(isinstance(payload.get('snapshot'), str) and re.fullmatch(r'[0-9a-f]{64}', payload['snapshot']), 'Відсутній перевірений знімок імпорту.')
        require(isinstance(payload.get('idempotencyKey'), str) and re.fullmatch(UUID_PATTERN, payload['idempotencyKey']), 'Ключ повтору має бути UUID у нижньому регістрі.')
    return entries


def plan(payload, user):
    entries = validate_payload(payload)
    config = defaults()
    from .catalog_references import reference_records
    references = reference_records()
    documents = list(Document.objects.filter(path__startswith='products/').order_by('path'))
    by_id = {doc.path.split('/', 1)[1]: doc for doc in documents}
    by_name = defaultdict(list)
    for doc in documents:
        # The editor rejects new names that collide under this same key.
        key = name_key(doc.data.get('name'))
        if key:
            by_name[key].append(doc)
    names = Counter(name_key(row['values']['name']) for row in entries
                    if isinstance(row, dict) and isinstance(row.get('values'), dict) and isinstance(row['values'].get('name'), str))
    lines = Counter(row.get('line') for row in entries if isinstance(row, dict) and type(row.get('line')) is int)
    result = []
    prepared = []
    for row in entries:
        line = row.get('line') if isinstance(row, dict) and type(row.get('line')) is int else None
        entry = {'line': line, 'action': 'error', 'id': None, 'revision': None}
        try:
            require(isinstance(row, dict) and not (set(row) - {'line', 'id', 'revision', 'values'}), 'Рядок містить невідомі поля.')
            require(type(line) is int and 0 < line <= 1000000 and lines[line] == 1, 'Некоректний або повторений номер рядка.')
            value = row.get('values')
            require(isinstance(value, dict), 'Відсутні значення товару.')
            name = value.get('name')
            require(isinstance(name, str) and bool(name_key(name)), 'Вкажіть назву товару.')
            key = name_key(name)
            require(names[key] == 1, 'Назва повторюється у файлі. Залиште один рядок товару.')
            matches = by_name.get(key, [])
            require(len(matches) <= 1, 'У каталозі кілька товарів із цією назвою. Спочатку усуньте неоднозначність.')
            existing = matches[0] if matches else None
            identifier = row.get('id')
            expected = row.get('revision')
            require(identifier is None or isinstance(identifier, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,120}', identifier), 'Некоректний ID товару.')
            require(expected is None or isinstance(expected, str), 'Некоректна версія товару.')
            if identifier is not None:
                require(existing is not None and by_id.get(identifier) == existing, 'Назва та ID товару не відповідають поточному каталогу.')
            if existing:
                current_revision = revision(existing, config)
                require(expected is None or expected == current_revision, 'Товар уже змінено. Оновіть попередній перегляд імпорту.')
                old = dict(existing.data)
                path = existing.path
                entry.update(id=path.split('/', 1)[1], revision=current_revision)
            else:
                require(identifier is None and expected is None, 'Товар для оновлення більше не існує.')
                markup = payload.get('defaultMarkup', format(config['markup'], 'f'))
                old = {'unit': 'шт', 'markup': float(dec(markup, 'Націнка', Decimal('.0001'))),
                       'cost': 0, 'manualPrice': False, 'price': None}
                path = 'catalog_import_preview/' + str(line)
            for field in ('cost', 'markup', 'price', 'promotionPrice', 'minStock'):
                if field in value:
                    require(isinstance(value[field], str) or field in {'price', 'promotionPrice'} and value[field] is None,
                            f'{field}: очікується десятковий рядок.')
            # CSV/XLSX carry historical free text choices, like legacy catalogue writes.
            data = normalise_product(value, old, path, validate_references=False, references=references)
            product = serialize(Document(path=path, data=data), user, config)
            entry.update(action='update' if existing else 'create',
                         values={key: product[key] for key in (*TEXT_FIELDS, 'cost', 'markup', 'price', 'manualPrice', 'promotion', 'promotionPrice', 'priceAt', 'minStock')},
                         regularPrice=product['regularPrice'], salePrice=product['salePrice'])
            prepared.append((entry, existing, data))
        except BusinessError as exc:
            entry.update(error=str(exc), code='invalid_import_row')
        result.append(entry)
    # Check batch duplicates before any writes; keep both offending lines visible.
    barcodes = Counter(data.get('barcode') for _, _, data in prepared if data.get('barcode'))
    for entry, _, data in prepared:
        if data.get('barcode') and barcodes[data['barcode']] > 1:
            entry.update(action='error', error='Штрихкод повторюється у файлі.', code='invalid_import_row')
    counts = {'created': sum(row['action'] == 'create' for row in result),
              'updated': sum(row['action'] == 'update' for row in result),
              'errors': sum(row['action'] == 'error' for row in result)}
    return {'valid': counts['errors'] == 0, 'entries': result, 'counts': counts,
            'snapshot': snapshot(documents, config), 'defaultMarkup': payload.get('defaultMarkup', format(config['markup'], 'f'))}, prepared


def import_body(request):
    from .views import body
    try:
        return body(request)
    except RequestDataTooBig:
        raise BusinessError('Файл імпорту завеликий. Розділіть його на пакети до 1000 рядків і 1 МіБ JSON.')


def preview_import(request, user):
    from .views import response
    require(user.profile.role in EDIT_ROLES, 'Недостатньо прав для імпорту каталогу.')
    payload = import_body(request)
    result, _ = plan(payload, user)
    return response(result)


@transaction.atomic
def commit_import(request, user):
    from .views import response
    require(user.profile.role in EDIT_ROLES, 'Недостатньо прав для імпорту каталогу.')
    payload = import_body(request)
    validate_payload(payload, committing=True)
    digest = hashlib.sha256(canonical(payload).encode()).hexdigest()
    run_path = 'import_runs/' + payload['idempotencyKey']
    ledger_lock()
    previous = Document.objects.filter(pk=run_path).first()
    if previous:
        if previous.data.get('owner') != user.pk or previous.data.get('payloadHash') != digest:
            return response({'error': 'Ключ повтору вже використано для іншого імпорту.', 'code': 'idempotency_conflict'}, 409)
        return response(previous.data['result'])
    preview_payload = {key: value for key, value in payload.items() if key in {'entries', 'defaultMarkup'}}
    result, prepared = plan(preview_payload, user)
    if not hmac.compare_digest(payload['snapshot'], result['snapshot']):
        return response({'error': 'Каталог або налаштування цін уже змінено. Оновіть попередній перегляд імпорту.', 'code': 'revision_conflict'}, 409)
    if not result['valid']:
        return response({**result, 'error': 'Імпорт містить помилки. Жодного товару не збережено.', 'code': 'invalid_import'}, 400)
    config = defaults()
    saved = []
    for entry, document, data in prepared:
        if document is None:
            identifier = str(uuid.uuid5(uuid.UUID(payload['idempotencyKey']), str(entry['line']))).replace('-', '_')
            path = 'products/' + identifier
            # Prevent replacing any preexisting document at the deterministic create ID.
            require(not Document.objects.filter(pk=path).exists(), 'ID нового товару вже використовується.')
            document = Document(path=path)
        document.data = data
        document.save()
        audit(user, 'catalog_changed', document.path, {'method': 'IMPORT', 'contract': 'v1', 'run': payload['idempotencyKey'], 'line': entry['line']})
        product = serialize(document, user, config)
        saved.append({'line': entry['line'], 'action': entry['action'], 'id': product['id'], 'revision': product['revision']})
    committed = {'ok': True, 'idempotencyKey': payload['idempotencyKey'], 'counts': result['counts'], 'entries': saved}
    Document.objects.create(path=run_path, data={'owner': user.pk, 'payloadHash': digest, 'result': committed})
    audit(user, 'catalog_imported', run_path, result['counts'])
    return response(committed)
