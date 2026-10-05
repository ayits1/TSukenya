"""Reviewed dictionary mutations, serialized with catalogue/import/accounting writes."""
import copy
import hashlib
import hmac
import json
import re
import uuid
from django.conf import settings
from django.db import transaction
from .catalog_references import FIELDS, LABELS, clean, find_reference, identity, keys, public, reference_records
from .models import Document
from .services import Conflict, audit, ledger_lock, require

OPERATIONS = {'rename', 'merge', 'archive', 'restore'}
ID = re.compile(r'[A-Za-z0-9_-]{1,120}')


def sign(value):
    signer = hmac.new(settings.SECRET_KEY.encode(), digestmod=hashlib.sha256)
    for chunk in json.JSONEncoder(ensure_ascii=False,sort_keys=True,separators=(',',':')).iterencode(value):
        from .catalog_budget import check
        check()
        signer.update(chunk.encode())
    return signer.hexdigest()


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
    from .catalog_reference_index import ReferenceIndex
    records=ReferenceIndex();opened=[records]
    try:return _plan(payload,records,opened)
    except BaseException:
        for index in opened:index.close()
        raise


def _plan(payload,records,opened):
    from .catalog import unit_in_use
    from .catalog_reference_index import ReferenceIndex
    from .catalog_reference_plan import Changes
    source = records.get(payload['sourceId'])
    require(source is not None, 'Запис довідника не знайдено. Оновіть список.')
    if item_revision(source) != payload['revision']:
        raise Conflict('Довідник уже змінено. Оновіть список та перегляньте вплив знову.', 'revision_conflict')
    operation = payload['operation']
    require(source['state'] == ('archived' if operation == 'restore' else 'active'), 'Дія недоступна для поточного стану довідника.')
    updated = records.clone();opened.append(updated)
    changed = Changes(updated);changed.add(source['id'])
    next_source = updated[source['id']]
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
        changed.redirect(source['id'],target['id'])
        changed.add(target['id'])  # Pin a legacy target before source products cease to expose it.
    else:
        if operation == 'restore':
            collision = records.collisions(source)
            require(collision is None, 'Активний запис із такою назвою або попередньою назвою вже існує в цій групі. Відкрийте його або спочатку перейменуйте активний запис, щоб звільнити назву.')
        next_source['state'] = 'archived' if operation == 'archive' else 'active'
    updated.put(next_source)
    if source['field'] == 'type' and operation in {'rename', 'merge'}:
        for child in records.values():
            if child['field'] != 'category' or child['state'] == 'merged' or child.get('parentId') != source['id']: continue
            next_child = updated[child['id']]
            remember(next_child); changed.add(child['id'])
            if operation == 'rename': next_child['parentType'] = next_source['value']
            else:
                collision = records.lookup('category',child['value'],target['value']) if child['state']=='active' else None
                if collision and not (collision['state']=='active' and collision.get('parentId')==target['id'] and identity('category',collision['value'],collision['parentType'])==identity('category',child['value'],target['value'])):collision=None
                if collision:
                    next_child['state'] = 'merged'; next_child['mergedInto'] = collision['id']
                    changed.redirect(child['id'],collision['id']);changed.add(collision['id'])
                    changed.coalesce(child['id'],collision['id'],child['value'])
                else:
                    next_child['parentType'] = target['value']; next_child['parentId'] = target['id']
            updated.put(next_child)
    changed.scan(source,operation,records)
    from .catalog_source_guard import snapshot as source_snapshot
    from .catalog import defaults
    from .promotion_prices import kyiv_day
    snapshot = sign({'request':payload,'source':source_snapshot(defaults(),day=kyiv_day())})
    result={'snapshot':snapshot,'operation':operation,'source':serialize(source),
        'target':serialize(target) if target else None,'productCount':changed.count('changes'),
        'usageCount':changed.count('usage'),'referenceCount':len(changed),
        'coalescedCategories':changed.coalesced_examples(),'coalescedCount':changed.count('coalesced'),
        'examples':changed.examples(),'blocked':changed.blocked_examples(),'blockedCount':changed.count('blocked'),
        'warnings':['Історичні назви й одиниці в облікових рядках та партіях залишаться незмінними.']}
    if operation=='archive':result['warnings'].append('Наявні товари зберігають значення. Новий вибір архівованого запису буде заборонено.')
    return result,updated,changed,changed.products(),records


def preview(request, user):
    from .catalog import EDIT_ROLES
    from .views import body, response
    from .historical_reports import read_snapshot
    from .services import current_actor
    from .catalog_budget import budget
    with budget(),read_snapshot():
        user=current_actor(user)
        require(user.profile.role in EDIT_ROLES,'Недостатньо прав для керування довідниками.')
        result,updated,changed,products,before=plan(request_value(body(request)))
        try:return response(result)
        finally:updated.close();before.close()


from .catalog_budget import bounded,check

@bounded
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
    result, records, changed, products, before_records = plan(payload)
    try:
        if result['snapshot'] != value['snapshot']:
            raise Conflict('Вплив зміни довідника змінився. Перегляньте його знову.', 'snapshot_conflict')
        require(not result['blockedCount'], 'Зміну одиниці обліку заблоковано: ' + ' '.join(result['blocked']))
        from .catalog_projection import merge_document,save_reference
        reference_examples=[]
        for identifier in changed:
            check();item=records[identifier]
            save_reference(item,before_records.get(identifier))
            detail={'before':serialize(before_records[identifier]),'after':serialize(item)}
            if len(reference_examples)<10:reference_examples.append(detail)
            else:audit(user,'catalog_reference_detail','catalog_refs/'+identifier,{'run':key,'sourceId':payload['sourceId'],'operation':payload['operation'],**detail})
        for document,data in products:
            check();merge_document(document.path,data)
        audit(user, 'catalog_reference_changed', 'catalog_refs/' + payload['sourceId'],
              {'operation': payload['operation'], 'productCount': result['productCount'], 'referenceCount': result['referenceCount'], 'coalescedCategories': result['coalescedCategories'], 'snapshot': result['snapshot'],
               'references':reference_examples,'referenceDetailCount':max(0,len(changed)-10),'coalescedCount':result['coalescedCount']})
        response_value = {**result, 'ok': True}
        Document.objects.create(path=run_path, data={'owner': user.pk, 'payloadHash': digest, 'result': response_value})
        check()
        return response(response_value)
    finally:records.close();before_records.close()


def handle(request, user):
    from .views import response
    if request.path.rstrip('/').endswith('/manage') and request.method == 'GET':
        return response({'error':'Повний довідник замінено сторінками та вибраними ID.','code':'bounded_read_required'},410)
    if request.path.rstrip('/').endswith('/preview') and request.method == 'POST': return preview(request, user)
    if request.path.rstrip('/').endswith('/commit') and request.method == 'POST': return commit(request, user)
    return response({'error': 'Метод довідника не підтримується.', 'code': 'unsupported_route'}, 405)
