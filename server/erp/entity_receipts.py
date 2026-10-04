"""B06 directory-create receipts. Reads never adopt the mutable row's revision."""
import hashlib
import json
import uuid

from .historical_reports import read_snapshot
from .models import EntityCreateReceipt, Store, Warehouse, CashAccount, Employee, Counterparty
from .services import Conflict, QTY, current_actor, dec, require

MODELS = {'stores': Store, 'warehouses': Warehouse, 'accounts': CashAccount, 'employees': Employee, 'parties': Counterparty}
CHILDREN = {'warehouses', 'accounts', 'employees'}


def authorize(user, resource):
    require(resource in MODELS, 'Невідомий довідник.')
    require(user.profile.role == 'owner' or resource == 'parties' and user.profile.role in {'manager', 'accountant'}, 'Недостатньо прав для довідника.')


def key_for(value):
    key = value.get('idempotency_key')
    require(isinstance(key, str), 'Вкажіть UUID початкового запиту.')
    try:
        parsed = uuid.UUID(key)
        require(str(parsed) == key, 'Некоректний UUID початкового запиту.')
        return parsed
    except (ValueError, AttributeError):
        require(False, 'Некоректний UUID початкового запиту.')


def normalize(user, resource, value, *, creating=False):
    authorize(user, resource)
    allowed = {'name', 'idempotency_key'}
    if resource in CHILDREN: allowed.add('store')
    if resource in {'parties', 'accounts'}: allowed.add('kind')
    if resource in {'stores', 'employees', 'parties'}: allowed.add('active')
    if resource == 'parties': allowed.update({'phone', 'email', 'notes'})
    if resource == 'employees': allowed.update({'shift_rate', 'bonus_percent', 'bonus_basis'})
    require(isinstance(value, dict) and not (set(value) - allowed), 'Некоректні поля початкового запиту.')
    require(isinstance(value.get('name'), str), 'Вкажіть назву.')
    result = {'name': value['name'].strip()}
    require(0 < len(result['name']) <= 160, 'Вкажіть назву (до 160 символів).')
    if resource == 'stores' and creating:
        require(user.profile.store_id is None, 'Нові магазини може створювати лише власник мережі.')
    if resource in CHILDREN:
        sent = value.get('store')
        require(type(sent) is int or isinstance(sent, str) and sent.isdecimal(), 'Магазин: некоректний ID.')
        store = int(sent)
        require(0 < store <= 9007199254740991, 'Магазин: некоректний ID.')
        require(user.profile.store_id is None or user.profile.store_id == store, 'Немає доступу до цього магазину.')
        result['store'] = store
    if resource in {'parties', 'accounts'}:
        options = {'customer', 'supplier'} if resource == 'parties' else {'cash', 'bank', 'terminal'}
        require(isinstance(value.get('kind'), str) and value['kind'] in options, 'Виберіть тип запису.')
        result['kind'] = value['kind']
    if resource in {'stores', 'employees', 'parties'}:
        active = value.get('active', True)
        require(type(active) is bool, 'Некоректний стан запису.')
        result['active'] = active
    if resource == 'parties':
        for field, maximum in [('phone', 80), ('email', 254), ('notes', 4000)]:
            require(isinstance(value.get(field, ''), str) and len(value.get(field, '')) <= maximum, 'Текстове поле завелике або некоректне.')
            result[field] = value.get(field, '')
    if resource == 'employees':
        result['shift_rate'] = str(dec(value.get('shift_rate', 0), 'Ставка за зміну'))
        result['bonus_percent'] = str(dec(value.get('bonus_percent', 0), 'Відсоток', QTY))
        require(dec(result['bonus_percent'], 'Відсоток', QTY) <= 100, 'Відсоток не може перевищувати 100.')
        basis = value.get('bonus_basis', 'store')
        require(isinstance(basis, str) and basis in {'store', 'personal', 'profit'}, 'Некоректна база нарахування.')
        result['bonus_basis'] = basis
    return result


def fingerprint(user, resource, normalized):
    return hashlib.sha256(json.dumps([user.pk, resource, normalized], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def match_receipt(user, resource, key, normalized):
    receipt = EntityCreateReceipt.objects.filter(pk=key).first()
    if receipt is None: return None
    if receipt.author_id != user.pk or receipt.resource != resource or receipt.fingerprint != fingerprint(user, resource, normalized):
        raise Conflict('UUID уже використано для іншого початкового запиту.', 'idempotency_conflict')
    require(receipt.store_id_snapshot is None or user.profile.store_id is None or receipt.store_id_snapshot == user.profile.store_id, 'Немає доступу до цього магазину.')
    return receipt


def acknowledgement(receipt):
    return {'id': str(receipt.object_id), 'type': receipt.resource, 'request_key': str(receipt.key), 'original': receipt.original}


def create(user, resource, value, save):
    # Caller holds the ledger lock and has refreshed the actor before this lookup.
    key = key_for(value)
    normalized = normalize(user, resource, value, creating=True)
    receipt = match_receipt(user, resource, key, normalized)
    if receipt is not None: return acknowledgement(receipt)
    from .directories import item
    result = json.loads(save(user, resource, normalized).content)
    obj = MODELS[resource].objects.get(pk=result['id'])
    original = {'type': resource, **item(user, resource, obj)}
    receipt = EntityCreateReceipt.objects.create(key=key, author=user, resource=resource, object_id=obj.pk,
        store_id_snapshot=obj.pk if resource == 'stores' else getattr(obj, 'store_id', None),
        fingerprint=fingerprint(user, resource, normalized), original=original)
    return acknowledgement(receipt)


def identity(user, resource, value):
    # This is a CSRF-protected read, with authorization and all metadata from the same RR snapshot.
    with read_snapshot():
        user = current_actor(user)
        authorize(user, resource)
        require(isinstance(value, dict) and set(value) == {'request'}, 'Очікується початковий запит.')
        request = value['request']
        require(isinstance(request, dict), 'Некоректний початковий запит.')
        key = key_for(request)
        normalized = normalize(user, resource, request)
        receipt = match_receipt(user, resource, key, normalized)
        if receipt is None: return {'confirmed': False, 'request_key': str(key), 'type': resource}
        obj = MODELS[resource].objects.filter(pk=receipt.object_id).first()
        # Never disclose a moved row or permit mutation using the original scope.
        require(obj is None or resource not in CHILDREN or obj.store_id == receipt.store_id_snapshot, 'Магазин запису змінився; доступ відкликано.')
        return {'confirmed': True, **acknowledgement(receipt), 'exists': obj is not None}


def recovery_context(user, resource, params):
    """Authorize a local raw draft without validating its newer form fields."""
    from .services import get, scope
    from .browsing import positive_integer
    require(set(params) <= {'id', 'store'}, 'Некоректний контекст довідника.')
    with read_snapshot():
        user = current_actor(user)
        authorize(user, resource)
        original_id = positive_integer(params['id'], 'ID запису') if params.get('id') else None
        store_id = positive_integer(params['store'], 'ID магазину') if params.get('store') else None
        obj = MODELS[resource].objects.filter(pk=original_id).only('pk', *(['store'] if resource in CHILDREN else [])).first() if original_id else None
        if resource == 'stores' and original_id:
            require(user.profile.store_id is None or original_id == user.profile.store_id, 'Немає доступу до цього магазину.')
        if resource in CHILDREN:
            if obj is not None:
                require(store_id is None or obj.store_id == store_id, 'Магазин запису змінився; доступ відкликано.')
                store_id = obj.store_id
            if store_id:
                scope(user, get(Store, store_id, 'Магазин'))
            elif user.profile.store_id is not None:
                store_id = user.profile.store_id
        return {'type': resource, 'id': str(original_id) if original_id else None,
                'store': store_id if resource in CHILDREN else None,
                'role': user.profile.role, 'storeId': user.profile.store_id,
                'networkOwner': user.profile.role == 'owner' and user.profile.store_id is None,
                'canCreate': resource != 'stores' or user.profile.store_id is None,
                'exists': obj is not None if original_id else None}
