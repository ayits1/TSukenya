"""Read-only paginated cash-shift and payroll attendance browsing."""
from zoneinfo import ZoneInfo

from django.db.models import Q
from django.db.models.functions import TruncDate
from django.utils import timezone

from .browsing import PAGE_SIZE, page_bounds, page_number, positive_integer
from .models import CashShift, WorkShift
from .reporting import scoped
from .services import ROLE_KINDS, day, require

WORK_FIELDS = (
    'id', 'employee_id', 'store_id', 'date', 'cash_shift_id', 'units',
    'shift_rate', 'bonus_percent', 'bonus_basis', 'accrued', 'basis_amount',
    'payroll_id', 'note',
)


def cash_shift_json(shift):
    return {
        'id': shift.pk, 'store_id': shift.store_id, 'account_id': shift.account_id,
        'employee_id': shift.employee_id, 'opened_at': shift.opened_at.isoformat(),
        'closed_at': shift.closed_at.isoformat() if shift.closed_at else None,
        'opening_cash': str(shift.opening_cash),
        'expected_cash': str(shift.expected_cash) if shift.expected_cash is not None else None,
        'counted_cash': str(shift.counted_cash) if shift.counted_cash is not None else None,
        'opened_by': shift.opened_by.username,
    }


def filters(query, params, date_field):
    for parameter, field in [('store', 'store_id'), ('employee', 'employee_id'), ('id', 'pk')]:
        value = params.get(parameter, '')
        if value:
            query = query.filter(**{field: positive_integer(value, 'ID зміни' if parameter == 'id' else 'ID довідника')})
    start = day(params['from']) if params.get('from') else None
    end = day(params['to']) if params.get('to') else None
    require(not start or not end or start <= end, 'Початкова дата пізніша за кінцеву.')
    if start:
        query = query.filter(**{date_field + '__gte': start})
    if end:
        query = query.filter(**{date_field + '__lte': end})
    return query


def cash_shifts(user, params):
    require(user.profile.role in ROLE_KINDS, 'Недостатньо прав для касових змін.')
    requested = page_number(params)
    query = scoped(CashShift.objects.select_related('opened_by'), user).annotate(
        opened_day=TruncDate('opened_at', tzinfo=ZoneInfo('Europe/Kyiv')),
        closed_day=TruncDate('closed_at', tzinfo=ZoneInfo('Europe/Kyiv')),
    )
    query = filters(query, params, 'opened_day')
    status = params.get('status', '')
    require(status in {'', 'open', 'closed'}, 'Некоректний стан касової зміни.')
    if status:
        query = query.filter(closed_at__isnull=status == 'open')
    if params.get('day'):
        target = day(params['day'])
        require(target <= timezone.localdate(), 'День касової зміни не може бути в майбутньому.')
        query = query.filter(opened_day__lte=target).filter(Q(closed_day__gte=target) | Q(closed_at__isnull=True))
    total = query.count()
    page, pages, offset = page_bounds(total, requested)
    return {'items': [cash_shift_json(shift) for shift in query.order_by('-pk')[offset:offset + PAGE_SIZE]],
            'total': total, 'page': page, 'pages': pages}


def work_shifts(user, params):
    require(user.profile.role in {'owner', 'accountant'}, 'Недостатньо прав для зарплати.')
    requested = page_number(params)
    query = filters(scoped(WorkShift.objects.all(), user), params, 'date')
    if params.get('ids'):
        values = params['ids'].split(',')
        require(len(values) <= 1000, 'Завеликий перелік змін.')
        identifiers = {positive_integer(value, 'ID зміни') for value in values}
        query = query.filter(pk__in=identifiers)
    eligible = params.get('eligible', '')
    require(eligible in {'', 'payroll'}, 'Невідомий режим вибору табеля.')
    if eligible:
        query = query.filter(payroll__isnull=True).filter(Q(cash_shift__isnull=True) | Q(cash_shift__closed_at__isnull=False))
    total = query.count()
    page, pages, offset = page_bounds(total, requested)
    return {'items': list(query.order_by('-date', '-pk')[offset:offset + PAGE_SIZE].values(*WORK_FIELDS)),
            'total': total, 'page': page, 'pages': pages}
