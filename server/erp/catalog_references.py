"""Stable catalogue identities with a text adapter for existing documents/imports."""
import hashlib
import json
import re
from django.db import transaction
from .catalog_access import revalidate_actor
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


def public(item):
    return {key: item[key] for key in ('id', 'field', 'value', 'parentType')}


def keys(item):
    result = {identity(item['field'], item['value'], item['parentType'])}
    for alias in item.get('aliases', []):
        if isinstance(alias, dict) and isinstance(alias.get('value'), str) and isinstance(alias.get('parentType', ''), str):
            result.add(identity(item['field'], alias['value'], alias.get('parentType', '')))
    return result


def reference_records(*, legacy_values=None, explicit_records=None):
    """Read only. Explicit tombstones suppress legacy/default choices; unknown IDs do not."""
    records, claimed = {}, set()
    for doc in (explicit_records if explicit_records is not None else Document.objects.filter(path__startswith='catalog_refs/').order_by('path').iterator(chunk_size=200)):
        data = doc.data
        if not isinstance(data, dict): continue
        field, text, parent = data.get('field'), data.get('value'), data.get('parentType', '')
        if not isinstance(field, str) or field not in FIELDS or not isinstance(text, str) or not clean(text) or not isinstance(parent, str): continue
        item = {**data, 'id': doc.path.split('/', 1)[1], 'field': field, 'value': text,
                'parentType': parent if field == 'category' else '', 'state': data.get('state', 'active')}
        if item['state'] not in {'active', 'archived', 'merged'}: continue
        item['aliases'] = data.get('aliases') if isinstance(data.get('aliases'), list) else []
        records[item['id']] = item
        claimed.update(keys(item))
    groups = {}
    for item in records.values():
        if item['field'] == 'type':
            for key in keys(item): groups[key[1]] = item
    for item in records.values():
        if item['field'] == 'category':
            parent = records.get(item.get('parentId')) or groups.get(clean(item['parentType']).casefold())
            if parent and parent['field'] == 'type':
                item['parentId'] = parent['id']
                if item['parentType'] != parent['value']:
                    alias = {'value': item['value'], 'parentType': item['parentType']}
                    if alias not in item['aliases']: item['aliases'].append(alias)
                item['parentType'] = parent['value']
                claimed.update(keys(item))
    for doc in (legacy_values if legacy_values is not None else Document.objects.filter(path__startswith='products/').order_by('path').only('data').iterator(chunk_size=200)):
        if not isinstance(doc.data, dict): continue
        parent = doc.data.get('type', '')
        parent = parent if isinstance(parent, str) else ''
        for field, maximum in FIELDS.items():
            text = doc.data.get(field)
            if not isinstance(text, str) or not clean(text) or len(clean(text)) > maximum: continue
            item = legacy_item(field, text, parent)
            key = identity(field, text, parent)
            if key not in claimed:
                records[item['id']] = {**item, 'state': 'active', 'aliases': []}
                claimed.add(key)
    unit = legacy_item('unit', 'шт')
    if identity('unit', 'шт') not in claimed: records[unit['id']] = {**unit, 'state': 'active', 'aliases': []}
    groups = {clean(item['value']).casefold(): item for item in records.values() if item['field'] == 'type'}
    for item in records.values():
        if item['field'] == 'category' and not item.get('parentId'):
            parent = groups.get(clean(item['parentType']).casefold())
            if parent: item['parentId'] = parent['id']
    return records


def follow(item, records):
    visited = set()
    while item and item['state'] == 'merged':
        if item['id'] in visited: return None
        visited.add(item['id'])
        item = records.get(item.get('mergedInto'))
    return item


def find_reference(records, field, text, parent=''):
    if hasattr(records,'lookup'):return records.lookup(field,text,parent)
    key = identity(field, text, parent)
    ordered = sorted(records.values(), key=lambda item: item['state'] != 'active')
    match = next((item for item in ordered if identity(item['field'], item['value'], item['parentType']) == key), None)
    if match is None: match = next((item for item in ordered if key in keys(item)), None)
    return follow(match, records) or match


def reference_items(*, archived=False):
    records = reference_records()
    items, seen = [], set()
    for item in records.values():
        if item['state'] != ('archived' if archived else 'active'): continue
        key = identity(item['field'], item['value'], item['parentType'])
        if key not in seen:
            items.append(public(item)); seen.add(key)
    return sorted(items, key=lambda item: (item['field'], item['parentType'].casefold(), item['value'].casefold(), item['id']))


def get_references(user):
    from .catalog import EDIT_ROLES
    from .views import response
    return response({'items': reference_items(), 'archivedItems': reference_items(archived=True), 'canEdit': user.profile.role in EDIT_ROLES})


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
    revalidate_actor(user, EDIT_ROLES, 'Недостатньо прав для редагування довідників.')
    payload = body(request)
    require(not (set(payload) - {'field', 'value', 'parentType'}), 'Запит містить невідомі поля довідника.')
    field = payload.get('field')
    require(isinstance(field, str) and field in FIELDS, 'Невідомий довідник.')
    text = payload.get('value')
    require(isinstance(text, str) and 0 < len(clean(text)) <= FIELDS[field] and len(text) <= 1000, f'{LABELS[field]}: вкажіть коректну назву.')
    text = clean(text)
    parent = payload.get('parentType', '')
    require(isinstance(parent, str) and len(parent) <= 160, 'Некоректна група категорії.')
    from .catalog_reference_index import ReferenceIndex
    records = ReferenceIndex()
    if field == 'category':
        match = find_reference(records, 'type', parent)
        require(match is not None and match['state'] == 'active', 'Спочатку виберіть наявну групу для категорії.')
        parent = match['value']
    else:
        require(not clean(parent), 'Група дозволена лише для категорії.')
        parent = ''
    duplicate = find_reference(records, field, text, parent)
    require(duplicate is None or duplicate['state'] == 'active', 'Запис довідника архівовано. Відновіть його у керуванні довідниками або виберіть інший.')
    item = public(duplicate) if duplicate else legacy_item(field, text, parent)
    if field == 'category': persist_choice(public(match), user)
    persist_choice(item, user)
    return response(item, 200 if duplicate else 201)


def validate_reference_fields(data, old, *, creating=False, references=None):
    """Explicit active choices for new values; unchanged archived text stays editable."""
    changed = {field for field in FIELDS if creating or (data.get(field) or ('шт' if field == 'unit' else '')) != (old.get(field) or ('шт' if field == 'unit' else ''))}
    if 'type' in changed: changed.add('category')
    if not changed: return
    records = reference_records() if references is None else references
    for field in ('type', 'category', 'pack', 'size', 'unit'):
        text = data.get(field, '')
        if field not in changed or not text: continue
        parent = data.get('type', '') if field == 'category' else ''
        match = find_reference(records, field, text, parent)
        require(match is not None and match['state'] == 'active', f'{LABELS[field]}: виберіть активний запис довідника або спочатку додайте його.')
        if field == 'category': require(bool(parent), 'Для категорії потрібно вибрати групу.')
        data[field] = match['value']


def bind_reference_fields(data, old, *, references=None):
    """Server-owned IDs; legacy text follows renames/merges but never resurrects archives."""
    records, bindings = reference_records() if references is None else references, {}
    for field in ('type', 'category', 'pack', 'size', 'unit'):
        text = data.get(field) or ('шт' if field == 'unit' else '')
        if not isinstance(text, str) or not text: continue
        parent = data.get('type', '') if field == 'category' else ''
        item = find_reference(records, field, text, parent)
        unchanged = bool(old.get('name')) and text == (old.get(field) or ('шт' if field == 'unit' else '')) and (field != 'category' or parent == old.get('type', ''))
        stored = old.get('referenceIds', {})
        stored_id = stored.get(field) if unchanged and isinstance(stored, dict) else None
        if isinstance(stored_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,120}', stored_id) and stored_id not in records:
            bindings[field] = stored_id
            continue  # A missing ID is not evidence of a rename/archive; preserve the unchanged identity.
        pinned = records.get(stored_id) if isinstance(stored_id, str) else None
        if pinned and pinned['field'] == field: item = follow(pinned, records) or pinned
        require(item is None or item['state'] == 'active' or unchanged, f'{LABELS[field]}: запис архівовано, виберіть активне значення.')
        if item:
            bindings[field] = item['id']
            if item['state'] == 'active': data[field] = item['value']
        else: bindings[field] = legacy_item(field, text, parent)['id']
    data['referenceIds'] = bindings
    return data
