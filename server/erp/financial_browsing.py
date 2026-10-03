"""Scoped, paginated financial reads; all obligations use the posting calculator."""
import re
from zoneinfo import ZoneInfo

from datetime import timedelta
from decimal import Decimal

from django.db.models import Q, Case, When, F, DateField
from django.db.models.functions import TruncDate
from django.utils import timezone

from .browsing import PAGE_SIZE, filter_search, page_bounds, page_number, positive_integer, with_settlements
from .models import AuditEvent, CashEntry, Voucher
from .reporting import scoped
from .services import ZERO, day, money, obligation, require

FINANCE_ROLES = {'owner', 'manager', 'accountant'}


def financial_access(user):
    require(user.profile.role in FINANCE_ROLES, 'Недостатньо прав для фінансових даних.')


def date_filter(query, params, field):
    start = day(params['from']) if params.get('from') else None
    end = day(params['to']) if params.get('to') else None
    require(not start or not end or start <= end, 'Початкова дата пізніша за кінцеву.')
    if start:
        query = query.filter(**{field + '__gte': start})
    if end:
        query = query.filter(**{field + '__lte': end})
    return query


def ledger(user, params):
    financial_access(user)
    requested = page_number(params)
    query = scoped(CashEntry.objects.select_related('voucher', 'account'), user, 'account__store_id').annotate(
        entry_day=Case(When(is_reversal=True, then=TruncDate('voucher__reversed_at', tzinfo=ZoneInfo('Europe/Kyiv'))), default=F('voucher__date'), output_field=DateField()))
    if user.profile.role == 'manager':
        query = query.exclude(voucher__kind__in=['payroll', 'payroll_payment'])
    for parameter, field in [('store', 'account__store_id'), ('account', 'account_id')]:
        if params.get(parameter):
            query = query.filter(**{field: positive_integer(params[parameter], 'ID рахунку' if parameter == 'account' else 'ID магазину')})
    query = date_filter(query, params, 'entry_day')
    search = params.get('q', '').strip()
    require(len(search) <= 250, 'Пошуковий запит задовгий.')
    number = search.lstrip('№').strip()
    if re.fullmatch(r'[0-9]+', number or ''):
        require(len(number) <= 12, 'Номер документа задовгий.')
        query = query.filter(voucher_id=int(number))
    elif search:
        query = query.filter(Q(account__name__icontains=search) | Q(voucher__party__name__icontains=search) | Q(voucher__note__icontains=search))
    total = query.count()
    page, pages, offset = page_bounds(total, requested)
    return {'entries': [{
        'id': entry.pk, 'voucher': entry.voucher_id, 'date': entry.entry_day,
        'account': entry.account.name, 'account_id': entry.account_id,
        'store_id': entry.account.store_id, 'kind': entry.voucher.kind,
        'amount': str(entry.amount), 'note': entry.voucher.note, 'reversal': entry.is_reversal,
    } for entry in query.order_by('-pk')[offset:offset + PAGE_SIZE]],
        'total': total, 'page': page, 'pages': pages}


def audit_events(user, params):
    require(user.profile.role == 'owner', 'Недостатньо прав для журналу змін.')
    requested = page_number(params)
    query = AuditEvent.objects.select_related('user').annotate(
        local_day=TruncDate('at', tzinfo=ZoneInfo('Europe/Kyiv')),
    )
    query = date_filter(query, params, 'local_day')
    if params.get('user'):
        query = query.filter(user_id=positive_integer(params['user'], 'ID користувача'))
    action = params.get('action', '')
    require(len(action) <= 40, 'Назва дії задовга.')
    if action:
        query = query.filter(action=action)
    search = params.get('q', '').strip()
    require(len(search) <= 250, 'Пошуковий запит задовгий.')
    if re.fullmatch(r'[0-9]+', search or ''):
        require(len(search) <= 12, 'ID події задовгий.')
        query = query.filter(pk=int(search))
    elif search:
        query = query.filter(Q(user__username__icontains=search) | Q(action__icontains=search) | Q(subject__icontains=search))
    total = query.count()
    page, pages, offset = page_bounds(total, requested)
    return {'events': list(query.order_by('-pk')[offset:offset + PAGE_SIZE].values('id', 'at', 'user__username', 'action', 'subject', 'detail')),
            'total': total, 'page': page, 'pages': pages}


def current_debts(user, params):
    financial_access(user)
    query = scoped(Voucher.objects.filter(status='posted', kind__in=['receipt', 'sale', 'debt_opening'])
                   .filter(Q(party__isnull=False) | Q(kind='receipt')), user)
    for parameter, field in [('store', 'store_id'), ('party', 'party_id')]:
        if params.get(parameter):
            query = query.filter(**{field: positive_integer(params[parameter], 'ID довідника')})
    query = with_settlements(filter_search(query, params).select_related('party')).order_by('-pk')
    status = params.get('status', '')
    require(status in {'', 'overdue', 'not_overdue'}, 'Некоректний стан боргу.')
    due = day(params['due']).isoformat() if params.get('due') else None
    due_from = day(params['due_from']).isoformat() if params.get('due_from') else None
    due_to = day(params['due_to']).isoformat() if params.get('due_to') else None
    require(not due_from or not due_to or due_from <= due_to, 'Початковий строк оплати пізніший за кінцевий.')
    today = timezone.localdate().isoformat()
    rows = []
    owed_to_us, owed_by_us = ZERO, ZERO
    for voucher in query:
        amount = obligation(voucher, settlements=voucher.browse_settlements, allocations=voucher.browse_allocations)
        if not amount:
            continue
        deadline = voucher.payload.get('due_date', '')
        overdue = bool(deadline and deadline < today)
        if status and overdue != (status == 'overdue'):
            continue
        if due and deadline != due:
            continue
        if due_from and (not deadline or deadline < due_from):
            continue
        if due_to and (not deadline or deadline > due_to):
            continue
        kind = 'receipt' if voucher.kind == 'debt_opening' and voucher.party.kind == 'supplier' else 'sale' if voucher.kind == 'debt_opening' else voucher.kind
        if kind == 'receipt':
            owed_by_us += amount
        else:
            owed_to_us += amount
        rows.append({
            'voucher': voucher.pk, 'number': f'{voucher.pk:06d}', 'kind': kind,
            'original_kind': voucher.kind, 'store': voucher.store_id, 'date': voucher.date.isoformat(),
            'party': voucher.party.name if voucher.party else 'Роздрібний покупець', 'party_id': voucher.party_id,
            'total': str(voucher.total), 'amount': str(amount), 'due_date': deadline, 'overdue': overdue,
        })
    return rows, {'owed_to_us': str(money(owed_to_us)), 'owed_by_us': str(money(owed_by_us))}


def debts(user, params):
    financial_access(user)
    requested = page_number(params)
    rows, totals = current_debts(user, params)
    total = len(rows)
    page, pages, offset = page_bounds(total, requested)
    return {'items': rows[offset:offset + PAGE_SIZE], 'total': total, 'page': page, 'pages': pages,
            'debt_totals': totals}


CALENDAR_DAYS = 14


def debt_summary(user):
    """Overview card: overdue amounts both ways and supplier payments due in the next two weeks."""
    financial_access(user)
    rows, _ = current_debts(user, {})
    today = timezone.localdate()
    horizon = (today + timedelta(days=CALENDAR_DAYS - 1)).isoformat()
    overdue = {'to_us': {'amount': ZERO, 'count': 0}, 'by_us': {'amount': ZERO, 'count': 0}}
    payments = []
    for row in rows:
        amount = Decimal(row['amount'])
        if amount <= 0:
            continue
        side = overdue['by_us' if row['kind'] == 'receipt' else 'to_us']
        if row['overdue']:
            side['amount'] += amount
            side['count'] += 1
        elif row['kind'] == 'receipt' and row['due_date'] and row['due_date'] <= horizon:
            payments.append({key: row[key] for key in ('voucher', 'number', 'store', 'party', 'due_date')} | {'amount': str(amount)})
    payments.sort(key=lambda row: (row['due_date'], row['voucher']))
    return {
        'today': today.isoformat(), 'days': CALENDAR_DAYS,
        'overdue': {side: {'amount': str(money(value['amount'])), 'count': value['count']} for side, value in overdue.items()},
        'payments': payments, 'payments_total': str(money(sum((Decimal(row['amount']) for row in payments), ZERO))),
    }
