"""Persistent catalogue choices, merged with compatible legacy product text values."""
import hashlib
import json
from django.db import transaction
from .models import Document
from .services import audit, ledger_lock, require

FIELDS = {'type': 160, 'category': 160, 'pack': 160, 'size': 160, 'unit': 30}
LABELS = {'type': 'Група', 'category': 'Категорія', 'pack': 'Пакування', 'size': 'Об’єм / вага', 'unit': 'Одиниця обліку'}


def clean(value):
    return ' '.join(value.split())


def identity(field, value, parent=''):
    return field, clean(value).casefold(), clean(parent).casefold() if field == 'category' else ''


def legacy_item(field, value, parent=''):
    key = identity(field, value, parent)
    identifier = 'legacy_' + hashlib.sha256(json.dumps(key, ensure_ascii=False).encode()).hexdigest()
    return {'id': identifier, 'field': field, 'value': clean(value), 'parentType': clean(parent) if field == 'category' else ''}


def reference_items():
    # Stored choices win, providing stable spelling and IDs after source products disappear.
    items = {}
    for document in Document.objects.filter(path__startswith='catalog_refs/').order_by('path'):
        value = document.data
        field = value.get('field')
        text = value.get('value')
        parent = value.get('parentType', '')
        if field not in FIELDS or not isinstance(text, str) or not clean(text) or not isinstance(parent, str):
            continue
        item = {'id': document.path.split('/', 1)[1], 'field': field, 'value': text, 'parentType': parent if field == 'category' else ''}
        items.setdefault(identity(field, text, parent), item)
    for document in Document.objects.filter(path__startswith='products/').order_by('path').only('data'):
        data = document.data
        parent = data.get('type', '')
        parent = parent if isinstance(parent, str) else ''
        for field, maximum in FIELDS.items():
            text = data.get(field)
            if not isinstance(text, str) or not clean(text) or len(clean(text)) > maximum:
                continue
            item = legacy_item(field, text, parent)
            items.setdefault(identity(field, text, parent), item)
    unit = legacy_item('unit', 'шт')
    items.setdefault(identity('unit', 'шт'), unit)
    # Category parents use the same canonical display string as the group picker.
    groups = {identity('type', item['value'])[1]: item['value'] for item in items.values() if item['field'] == 'type'}
    for item in items.values():
        if item['field'] == 'category':
            item['parentType'] = groups.get(clean(item['parentType']).casefold(), item['parentType'])
    return sorted(items.values(), key=lambda item: (item['field'], item['parentType'].casefold(), item['value'].casefold(), item['id']))


def get_references(user):
    from .catalog import EDIT_ROLES
    from .views import response
    return response({'items': reference_items(), 'canEdit': user.profile.role in EDIT_ROLES})


def persist_choice(item, user):
    path = 'catalog_refs/' + item['id']
    if not Document.objects.filter(pk=path).exists():
        Document.objects.create(path=path, data={key: item[key] for key in ('field', 'value', 'parentType')})
        audit(user, 'catalog_reference_created', path, {key: item[key] for key in ('field', 'value', 'parentType')})


@transaction.atomic
def create_reference(request, user):
    from .catalog import EDIT_ROLES
    from .views import body, response
    require(user.profile.role in EDIT_ROLES, 'Недостатньо прав для редагування довідників.')
    ledger_lock()
    payload = body(request)
    require(not (set(payload) - {'field', 'value', 'parentType'}), 'Запит містить невідомі поля довідника.')
    field = payload.get('field')
    require(isinstance(field, str) and field in FIELDS, 'Невідомий довідник.')
    text = payload.get('value')
    require(isinstance(text, str) and 0 < len(clean(text)) <= FIELDS[field] and len(text) <= 1000, f'{LABELS[field]}: вкажіть коректну назву.')
    text = clean(text)
    parent = payload.get('parentType', '')
    require(isinstance(parent, str) and len(parent) <= 160, 'Некоректна група категорії.')
    items = reference_items()
    if field == 'category':
        match = next((item for item in items if item['field'] == 'type' and identity('type', item['value']) == identity('type', parent)), None)
        require(match is not None, 'Спочатку виберіть наявну групу для категорії.')
        parent = match['value']
    else:
        require(not clean(parent), 'Група дозволена лише для категорії.')
        parent = ''
    duplicate = next((item for item in items if identity(item['field'], item['value'], item['parentType']) == identity(field, text, parent)), None)
    item = duplicate or legacy_item(field, text, parent)
    # A persistent category also keeps its parent selectable after the last legacy
    # source product is deleted. Pin both atomically under the same ledger lock.
    if field == 'category':
        persist_choice(match, user)
    persist_choice(item, user)
    return response(item, 200 if duplicate else 201)


def validate_reference_fields(data, old, *, creating=False):
    """v1 requires explicit choices; unchanged historical values can still be edited."""
    changed = {field for field in FIELDS if creating or data.get(field, '') != old.get(field, '')}
    if 'type' in changed:
        changed.add('category')
    if not changed:
        return
    items = reference_items()
    # Canonicalize the parent before validating the dependent category.
    for field in ('type', 'category', 'pack', 'size', 'unit'):
        text = data.get(field, '')
        if field not in changed or not text:
            continue
        parent = data.get('type', '') if field == 'category' else ''
        key = identity(field, text, parent)
        match = next((item for item in items if identity(item['field'], item['value'], item['parentType']) == key), None)
        require(match is not None, f'{LABELS[field]}: виберіть запис довідника або спочатку додайте його.')
        if field == 'category':
            require(bool(parent), 'Для категорії потрібно вибрати групу.')
        data[field] = match['value']
