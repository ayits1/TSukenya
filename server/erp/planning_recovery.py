"""B06 creator-bound planning identity. GET/identity use one genuinely read-only snapshot."""
import hashlib
import json
from decimal import Decimal
from .models import ExpenseCategory, MonthlyBudget, PlanningCreateReceipt
from .services import Conflict, current_actor, require
from .historical_reports import read_snapshot


def helpers():
    from . import monthly_budgets
    return monthly_budgets


def normalize(user, resource, body):
    b = helpers()
    b.owner(user)
    require(isinstance(body, dict), 'Некоректний початковий запит.')
    if resource == 'category':
        require('semantic_key' not in body and 'aliases' not in body, 'Системний ключ та історичні назви незмінні.')
        name = body.get('name')
        require(isinstance(name, str) and 0 < len(name.strip()) <= 160, 'Вкажіть назву статті до 160 символів.')
        active = body.get('active', True)
        require(type(active) is bool, 'Некоректний стан статті.')
        key = str(b.identity(body.get('id')))
        return key, {'id': key, 'name': name.strip(), 'active': active}
    require(resource == 'monthly_budget', 'Невідомий ресурс планування.')
    start = b.month(body.get('month')); store = b.store_for(user, body.get('store'))
    key = body.get('idempotency_key')
    require(isinstance(key, str) and 1 <= len(key) <= 100, 'Потрібен стабільний ключ створення бюджету.')
    raw = body.get('lines'); require(isinstance(raw, list) and len(raw) <= 200, 'Потрібен список до 200 рядків бюджету.')
    lines = []; seen = set()
    for line in raw:
        require(isinstance(line, dict), 'Некоректний рядок бюджету.')
        lid = str(b.identity(line['id'])) if line.get('id') else None
        require(lid is None or lid not in seen, 'Рядок повторюється.'); seen.add(lid)
        mode = line.get('mode')
        require(isinstance(mode, str) and mode in {'fixed_amount', 'variable_amount', 'revenue_rate'}, 'Виберіть спосіб планування.')
        require(line.get('base', 'revenue') == 'revenue', 'Підтримано лише базу «Виторг».')
        amount = b.decimal(line.get('amount', '0'), 'Планова сума')
        rate = b.decimal(line.get('rate', '0'), 'Відсоток', Decimal('.001'))
        require(rate <= 100 and (amount == 0 if mode == 'revenue_rate' else rate == 0), 'Некоректна сума або відсоток.')
        lines.append({'id': lid, 'category': str(b.identity(line.get('category'))), 'mode': mode, 'amount': str(amount), 'rate': str(rate), 'base': 'revenue'})
    return key, {'month': start.strftime('%Y-%m'), 'store': store.pk if store else None,
                 'planned_revenue': str(b.decimal(body.get('planned_revenue', '0'), 'Плановий виторг')), 'lines': lines}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def projection(resource, value):
    if resource == 'category': return {key: value[key] for key in ('id', 'name', 'active')}
    return {**{key: value[key] for key in ('month', 'store', 'planned_revenue')},
            'lines': [{key: row[key] for key in ('id', 'category', 'mode', 'amount', 'rate', 'base')} for row in value['lines']]}


def scoped(user, receipt, target=None):
    b = helpers(); b.owner(user)
    if receipt.resource == 'monthly_budget':
        require(user.profile.store_id is None or receipt.store_id == user.profile.store_id, 'Немає доступу до цього магазину.')
        require(target is None or (target.month == receipt.month and target.store_id == receipt.store_id), 'Період або магазин запису змінено.')


def match(user, resource, key, normalized):
    receipt = PlanningCreateReceipt.objects.filter(pk=key).first()
    if receipt is None: return None
    if receipt.resource != resource or receipt.author_id != user.pk or receipt.request_fingerprint != fingerprint(normalized):
        raise Conflict('Ключ уже використано для іншого початкового запиту.', 'idempotency_conflict')
    scoped(user, receipt)
    return receipt


def target_for(receipt):
    model = ExpenseCategory if receipt.resource == 'category' else MonthlyBudget
    linked = receipt.category_id if receipt.resource == 'category' else receipt.budget_id
    return model.objects.filter(pk=linked).first() if linked else None


def acknowledge(user, receipt):
    target = target_for(receipt); scoped(user, receipt, target)
    if target is None:
        raise Conflict('Первісний запис видалено. Повтор не створить його заново.', 'original_request_deleted',
                       original_request_confirmed=True, id=str(receipt.target_uuid), request_key=receipt.key, resource=receipt.resource)
    b = helpers(); result = b.category_json(target) if receipt.resource == 'category' else b.budget_json(target)
    if target.revision != 1 or fingerprint(projection(receipt.resource, result)) != receipt.created_fingerprint:
        raise Conflict('Первісне створення підтверджено; запис уже змінено. Прочитайте його перед узгодженням.', 'original_request_confirmed',
                       original_request_confirmed=True, id=str(receipt.target_uuid), request_key=receipt.key, resource=receipt.resource)
    return {**result, 'resource': receipt.resource, 'request_key': receipt.key}


def record(user, resource, key, normalized, target, result):
    receipt = PlanningCreateReceipt.objects.create(key=key, resource=resource, author=user, target_uuid=target.pk,
        category=target if resource == 'category' else None, budget=target if resource == 'monthly_budget' else None,
        month=getattr(target, 'month', None), store_id=getattr(target, 'store_id', None),
        request_fingerprint=fingerprint(normalized), created_fingerprint=fingerprint(projection(resource, result)))
    return {**result, 'resource': resource, 'request_key': receipt.key}


def current(user, resource, key):
    with read_snapshot():
        user = current_actor(user); b = helpers()
        require(user.profile.role in {'owner', 'manager', 'accountant'} if resource == 'category' else user.profile.role == 'owner', 'Недостатньо прав.')
        model = ExpenseCategory if resource == 'category' else MonthlyBudget
        target = b.get(model, b.identity(key), 'Запис')
        if resource == 'monthly_budget': b.store_for(user, target.store_id)
        result = b.category_json(target) if resource == 'category' else b.budget_json(target)
        return {'resource': resource, 'record': result, 'permissions': {'canEdit': user.profile.role == 'owner'}}


def identity(user, resource, body):
    with read_snapshot():
        user = current_actor(user)
        require(isinstance(body, dict) and set(body) == {'request'}, 'Передайте початковий запит.')
        key, normalized = normalize(user, resource, body['request'])
        receipt = match(user, resource, key, normalized)
        result = {'resource': resource, 'request_key': key, 'confirmed': receipt is not None, 'status': 'legacy_unknown'}
        if receipt is None: return result
        target = target_for(receipt); scoped(user, receipt, target)
        result.update(status='present' if target else 'deleted', id=str(receipt.target_uuid))
        if target:
            result['revision'] = target.revision
            result['permissions'] = {'canEdit': True}
        if resource == 'monthly_budget': result.update(month=receipt.month.strftime('%Y-%m'), store=receipt.store_id)
        return result


def category_context(user, params):
    """Authorization of stored raw fields is independent of Save and mutable captions."""
    with read_snapshot():
        user = current_actor(user)
        require(user.profile.role in {'owner', 'manager', 'accountant'}, 'Недостатньо прав.')
        require(set(params) <= {'id'}, 'Невідомий параметр відновлення.')
        raw = params.get('id')
        key = str(helpers().identity(raw)) if raw else None
        exists = ExpenseCategory.objects.filter(pk=key).exists() if key else None
        return {'resource': 'category', 'id': key, 'exists': exists,
                'role': user.profile.role, 'storeId': user.profile.store_id,
                'networkOwner': user.profile.role == 'owner' and user.profile.store_id is None,
                'canEdit': user.profile.role == 'owner'}


def monthly_context(user, params):
    """Read authorization uses frozen period/scope, never invalid newer raw filters."""
    with read_snapshot():
        user = current_actor(user); b = helpers(); b.owner(user)
        require(set(params) <= {'id', 'month', 'store'}, 'Невідомий параметр відновлення.')
        start = b.month(params.get('month')); store = b.store_for(user, params.get('store'))
        raw = params.get('id'); key = str(b.identity(raw)) if raw else None
        target = MonthlyBudget.objects.filter(pk=key).only('month', 'store_id').first() if key else None
        require(target is None or (target.month == start and target.store_id == (store.pk if store else None)), 'Період або магазин запису змінено.')
        return {'resource': 'monthly_budget', 'id': key, 'month': start.strftime('%Y-%m'),
                'store': store.pk if store else None, 'exists': target is not None if key else None,
                'role': user.profile.role, 'storeId': user.profile.store_id,
                'networkOwner': user.profile.store_id is None, 'canEdit': True}
