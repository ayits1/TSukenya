"""Reviewed dictionary mutations, serialized with catalogue/import/accounting writes."""
import copy
import hashlib
import hmac
import json
import re
import uuid
from django.conf import settings
from django.db import transaction
from .catalog_references import FIELDS, LABELS, clean, find_reference, identity, public, reference_records
from .models import Document
from .services import Conflict, audit, ledger_lock, require

OPERATIONS = {'rename', 'merge', 'archive', 'restore'}
ID = re.compile(r'[A-Za-z0-9_-]{1,120}')


def sign(value):
    material = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    return hmac.new(settings.SECRET_KEY.encode(), material, hashlib.sha256).hexdigest()


def item_revision(item):
    return sign(item)


def serialize(item):
    return {**public(item), 'state': item['state'], 'parentId': item.get('parentId'),
            'mergedInto': item.get('mergedInto'), 'revision': item_revision(item)}


def management(user, csrf):
    from .catalog import EDIT_ROLES
    return {'items': [serialize(item) for item in sorted(reference_records().values(), key=lambda item: (item['field'], item['parentType'].casefold(), item['value'].casefold(), item['id']))],
            'canEdit': user.profile.role in EDIT_ROLES, 'csrf': csrf}


def request_value(value):
    require(isinstance(value, dict) and not (set(value) - {'sourceId', 'revision', 'operation', 'value', 'targetId'}), 'Некоректні поля зміни довідника.')
    require(isinstance(value.get('sourceId'), str) and ID.fullmatch(value['sourceId']), 'Некоректний ID довідника.')
    require(isinstance(value.get('revision'), str) and value['revision'], 'Потрібна актуальна версія довідника.')
    require(isinstance(value.get('operation'), str) and value['operation'] in OPERATIONS, 'Невідома дія довідника.')
    result = {key: value[key] for key in ('sourceId', 'revision', 'operation')}
    if value['operation'] == 'rename':
        require(set(value) == {'sourceId', 'revision', 'operation', 'value'} and isinstance(value['value'], str) and len(value['value']) <= 1000, 'Вкажіть нову назву довідника.')
        result['value'] = clean(value['value'])
    elif value['operation'] == 'merge':
        require(set(value) == {'sourceId', 'revision', 'operation', 'targetId'} and isinstance(value['targetId'], str) and ID.fullmatch(value['targetId']), 'Виберіть цільовий запис для об’єднання.')
        result['targetId'] = value['targetId']
    else: require(set(value) == {'sourceId', 'revision', 'operation'}, 'Ця дія не приймає назву чи цільовий запис.')
    return result


def remember(item):
    alias = {'value': item['value'], 'parentType': item['parentType']}
    if alias not in item['aliases']: item['aliases'].append(alias)


def plan(payload):
    from .catalog import unit_in_use
    records = reference_records()
    source = records.get(payload['sourceId'])
    require(source is not None, 'Запис довідника не знайдено. Оновіть список.')
    if item_revision(source) != payload['revision']:
        raise Conflict('Довідник уже змінено. Оновіть список та перегляньте вплив знову.', 'revision_conflict')
    operation = payload['operation']
    require(source['state'] == ('archived' if operation == 'restore' else 'active'), 'Дія недоступна для поточного стану довідника.')
    updated = copy.deepcopy(records)
    next_source = updated[source['id']]
    changed, redirects, coalesced = {source['id']}, {}, []
    target = None
    if operation == 'rename':
        text = payload['value']
        require(0 < len(text) <= FIELDS[source['field']], f'{LABELS[source["field"]]}: некоректна назва.')
        duplicate = find_reference(records, source['field'], text, source['parentType'])
        require(duplicate is None or duplicate['id'] == source['id'], 'Така назва вже існує або архівована. Виберіть об’єднання чи відновлення.')
        remember(next_source); next_source['value'] = text
    elif operation == 'merge':
        target = records.get(payload['targetId'])
        require(target is not None and target['state'] == 'active' and target['id'] != source['id'] and target['field'] == source['field'], 'Ціль має бути іншим активним записом того самого довідника.')
        if source['field'] == 'category':
            require(source.get('parentId') == target.get('parentId') and identity('type', source['parentType']) == identity('type', target['parentType']), 'Категорії можна об’єднувати лише в одній групі.')
        remember(next_source); next_source['state'] = 'merged'; next_source['mergedInto'] = target['id']
        redirects[source['id']] = target['id']
        changed.add(target['id'])  # Pin a legacy target before source products cease to expose it.
    else:
        next_source['state'] = 'archived' if operation == 'archive' else 'active'
    if source['field'] == 'type' and operation in {'rename', 'merge'}:
        for child in records.values():
            if child['field'] != 'category' or child['state'] == 'merged' or child.get('parentId') != source['id']: continue
            next_child = updated[child['id']]
            remember(next_child); changed.add(child['id'])
            if operation == 'rename': next_child['parentType'] = next_source['value']
            else:
                collision = next((other for other in records.values() if other['field'] == 'category' and other['state'] == 'active' and other.get('parentId') == target['id'] and clean(other['value']).casefold() == clean(child['value']).casefold()), None) if child['state'] == 'active' else None
                if collision:
                    next_child['state'] = 'merged'; next_child['mergedInto'] = collision['id']
                    redirects[child['id']] = collision['id']; changed.add(collision['id'])
                    coalesced.append({'sourceId': child['id'], 'targetId': collision['id'], 'value': child['value']})
                else:
                    next_child['parentType'] = target['value']; next_child['parentId'] = target['id']
    products, usage, blocked = [], [], []
    for document in Document.objects.filter(path__startswith='products/').order_by('path'):
        old = document.data
        if not isinstance(old, dict): continue
        value, matched = copy.deepcopy(old), {}
        for field in FIELDS:
            text = old.get(field) or ('шт' if field == 'unit' else '')
            if not isinstance(text, str) or not text: continue
            parent = old.get('type', '') if field == 'category' else ''
            if not isinstance(parent, str): parent = ''
            stored = old.get('referenceIds', {})
            item = records.get(stored.get(field)) if isinstance(stored, dict) else None
            if not item or item['field'] != field:
                item = find_reference(records, field, text, parent)
            if item and item['id'] in changed: matched[field] = item['id']
        if not matched: continue
        # Archive/restore never rewrite existing display values or product revisions.
        if source['id'] in matched.values(): usage.append(document.path)
        if operation in {'rename', 'merge'}:
            bindings = dict(old.get('referenceIds', {})) if isinstance(old.get('referenceIds'), dict) else {}
            for field, identifier in matched.items():
                next_item = updated[redirects.get(identifier, identifier)]
                value[field] = next_item['value']; bindings[field] = next_item['id']
            value['referenceIds'] = bindings
            if source['field'] == 'unit' and source['id'] in matched.values():
                reason = unit_in_use(document.path, old)
                if reason: blocked.append(f'{old.get("name", document.path)}: {reason}. Для іншої одиниці створіть окремий товар.')
            if value != old: products.append((document, value))
    material = {'request': payload, 'references': records, 'usage': usage,
                'products': [{'path': document.path, 'before': document.data, 'after': value} for document, value in products], 'blocked': blocked}
    snapshot = sign(material)
    result = {'snapshot': snapshot, 'operation': operation, 'source': serialize(source),
              'target': serialize(target) if target else None, 'productCount': len(products),
              'usageCount': len(usage), 'referenceCount': len(changed), 'coalescedCategories': coalesced,
              'examples': [{'id': document.path.split('/', 1)[1], 'name': str(document.data.get('name', ''))} for document, _ in products[:10]],
              'blocked': blocked[:10], 'blockedCount': len(blocked),
              'warnings': ['Історичні назви й одиниці в облікових рядках та партіях залишаться незмінними.']}
    if operation == 'archive': result['warnings'].append('Наявні товари зберігають значення. Новий вибір архівованого запису буде заборонено.')
    return result, updated, changed, products


def preview(request, user):
    from .catalog import EDIT_ROLES
    from .views import body, response
    require(user.profile.role in EDIT_ROLES, 'Недостатньо прав для керування довідниками.')
    result, _, _, _ = plan(request_value(body(request)))
    return response(result)


@transaction.atomic
def commit(request, user):
    from .catalog import EDIT_ROLES
    from .views import body, response
    require(user.profile.role in EDIT_ROLES, 'Недостатньо прав для керування довідниками.')
    ledger_lock()
    # A caller may have waited for another mutation; read current policy before retries too.
    user.refresh_from_db(fields=['is_active'])
    user.profile.refresh_from_db()
    require(user.is_active and user.profile.role in EDIT_ROLES, 'Недостатньо прав для керування довідниками.')
    value = body(request)
    require(not (set(value) - {'sourceId', 'revision', 'operation', 'value', 'targetId', 'snapshot', 'idempotencyKey'}), 'Некоректні поля підтвердження довідника.')
    require(isinstance(value.get('snapshot'), str) and value['snapshot'], 'Перегляньте вплив зміни перед підтвердженням.')
    try: key = str(uuid.UUID(value.get('idempotencyKey', '')))
    except (ValueError, TypeError, AttributeError): require(False, 'Потрібен ключ повторного запиту UUID.')
    require(value['idempotencyKey'] == key, 'Некоректний ключ повторного запиту UUID.')
    payload = request_value({field: item for field, item in value.items() if field not in {'snapshot', 'idempotencyKey'}})
    digest = sign({field: item for field, item in value.items() if field != 'idempotencyKey'})
    run_path = 'catalog_reference_runs/' + key
    previous = Document.objects.filter(pk=run_path).first()
    if previous:
        if previous.data.get('owner') != user.pk or previous.data.get('payloadHash') != digest:
            raise Conflict('Ключ зміни довідника вже використано з іншим запитом.', 'idempotency_conflict')
        return response(previous.data['result'])
    result, records, changed, products = plan(payload)
    if result['snapshot'] != value['snapshot']:
        raise Conflict('Вплив зміни довідника змінився. Перегляньте його знову.', 'snapshot_conflict')
    require(not result['blockedCount'], 'Зміну одиниці обліку заблоковано: ' + ' '.join(result['blocked']))
    for identifier in sorted(changed):
        item = records[identifier]
        Document.objects.update_or_create(pk='catalog_refs/' + identifier, defaults={'data': {field: val for field, val in item.items() if field != 'id'}})
    for document, data in products:
        document.data = data; document.save(update_fields=['data'])
    audit(user, 'catalog_reference_changed', 'catalog_refs/' + payload['sourceId'],
          {'operation': payload['operation'], 'productCount': result['productCount'], 'referenceCount': result['referenceCount'], 'coalescedCategories': result['coalescedCategories'], 'snapshot': result['snapshot']})
    response_value = {**result, 'ok': True}
    Document.objects.create(path=run_path, data={'owner': user.pk, 'payloadHash': digest, 'result': response_value})
    return response(response_value)


def handle(request, user):
    from .views import response
    if request.path.rstrip('/').endswith('/manage') and request.method == 'GET':
        return response(management(user, request.portal_session.csrf))
    if request.path.rstrip('/').endswith('/preview') and request.method == 'POST': return preview(request, user)
    if request.path.rstrip('/').endswith('/commit') and request.method == 'POST': return commit(request, user)
    return response({'error': 'Метод довідника не підтримується.', 'code': 'unsupported_route'}, 405)
