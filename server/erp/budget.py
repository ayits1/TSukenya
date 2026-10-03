"""Legacy budget validation and a count independent from label/ERP identities."""
from calendar import monthrange
from datetime import date
from decimal import Decimal
import re

from django.db.models import Sum
from django.utils import timezone

from .services import ZERO, dec, money, require

# Categories of the expense document form (app/erp.js) plus payroll accruals, which are their own documents.
EXPENSE_CATEGORIES = ['Оренда', 'Комунальні', 'Логістика', 'Обслуговування', 'Маркетинг', 'Податки', 'Інше']
BUDGET_CATEGORIES = EXPENSE_CATEGORIES[:-1] + ['Зарплата', 'Інше']


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
    category = data.get('category')
    require(category is None or category in BUDGET_CATEGORIES, 'Невідома категорія обліку для статті витрат.')
    return {**data, 'name': name.strip(), 'amount': float(amount)}


def budget_fact(user, params):
    """Actual expenses of one month by accounting category, for the budget plan-versus-fact view."""
    from .models import Voucher
    from .reporting import scoped
    require(user.profile.role == 'owner', 'Бюджет витрат доступний власнику мережі.')
    today = timezone.localdate()
    raw = str(params.get('month') or today.strftime('%Y-%m'))
    match = re.fullmatch(r'(\d{4})-(\d{2})', raw)
    require(match and 1 <= int(match[2]) <= 12, 'Місяць має бути у форматі РРРР-ММ.')
    year, month = int(match[1]), int(match[2])
    start, end = date(year, month, 1), date(year, month, monthrange(year, month)[1])
    posted = scoped(Voucher.objects.filter(status='posted', date__gte=start, date__lte=end), user)
    facts = {category: ZERO for category in BUDGET_CATEGORIES}
    for voucher in posted.filter(kind='expense').only('total', 'payload'):
        category = voucher.payload.get('category')
        facts[category if category in EXPENSE_CATEGORIES else 'Інше'] += voucher.total
    facts['Зарплата'] += posted.filter(kind='payroll').aggregate(n=Sum('total'))['n'] or ZERO
    passed = 0 if today < start else (end - start).days + 1 if today > end else (today - start).days + 1
    return {'month': f'{year:04d}-{month:02d}', 'from': start.isoformat(), 'to': end.isoformat(),
            'days_passed': passed, 'days_total': (end - start).days + 1, 'categories': BUDGET_CATEGORIES,
            'facts': {category: str(money(amount)) for category, amount in facts.items()}}
