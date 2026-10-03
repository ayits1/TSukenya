"""Legacy budget validation and a count independent from label/ERP identities."""
from decimal import Decimal
from .services import dec, require


def valid_count(value):
    return type(value) is int and 1 <= value <= 1000


def budget_count(data):
    for key in ('budgetStores', 'stores'):
        if valid_count(data.get(key)):
            return data[key]
    for key in ('stores', 'storeNames'):
        value = data.get(key)
        if isinstance(value, list) and 1 <= len(value) <= 1000:
            return len(value)
    return 1


def freeze_budget(data):
    if not valid_count(data.get('budgetStores')):
        data['budgetStores'] = budget_count(data)
    return data


def valid_stale_days(value):
    return type(value) is int and 1 <= value <= 3650


def validate_settings(data, old=None):
    old = old or {}
    if 'budgetStores' in data:
        require(valid_count(data['budgetStores']), 'Кількість магазинів бюджету має бути цілим числом від 1 до 1000.')
    # Label Studio reads this term; an older stored value does not block unrelated saves.
    if 'staleDays' in data and ('staleDays' not in old or (type(data['staleDays']), data['staleDays']) != (type(old['staleDays']), old['staleDays'])):
        require(valid_stale_days(data['staleDays']), 'Термін перевірки ціни має бути цілим числом від 1 до 3650 днів.')
    return data


def validate_expense(data):
    name = data.get('name')
    require(isinstance(name, str) and 1 <= len(name.strip()) <= 250, 'Назва статті витрат має містити від 1 до 250 символів.')
    group = data.get('group')
    require(isinstance(group, str) and group in {'fixed', 'variable'}, 'Виберіть постійну або змінну статтю витрат.')
    raw = data.get('amount')
    require(type(raw) in {int, float}, 'Сума витрати має бути числом.')
    amount = dec(raw, 'Сума витрати')
    require(amount <= Decimal('99999999.99'), 'Сума витрати не може перевищувати 99 999 999,99 грн.')
    return {**data, 'name': name.strip(), 'amount': float(amount)}
