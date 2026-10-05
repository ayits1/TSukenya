"""Paged staff workspace projections; salary posting remains in the ledger services."""
from django.db.models import Case, When, F, Value, TextField
from django.db.models.functions import Length

from . import directories
from .browsing import PAGE_SIZE, page_bounds, page_number, positive_integer
from .historical_reports import read_snapshot
from .models import LedgerLock, Store, WorkShift, Voucher
from .reporting import scoped
from .services import current_actor, day, record_revision, require

KINDS = ('payroll', 'payroll_payment')
FIELDS = {'employees': {'q', 'store'}, 'work-shifts': {'store', 'employee', 'from', 'to'},
          'documents': {'store', 'status'}}


def options(resource, params):
    require(resource in FIELDS and not set(params) - FIELDS[resource] - {'page'}, 'Невідомий параметр команди.')
    require(all(isinstance(v, str) for v in params.values()), 'Некоректні параметри команди.')
    if hasattr(params, 'getlist'):
        require(all(len(params.getlist(k)) == 1 for k in params), 'Параметр повторюється.')
    result = {key: None if key in {'store', 'employee'} else '' for key in sorted(FIELDS[resource])}
    for key in result:
        value = params.get(key, '')
        if key in {'store', 'employee'}:
            result[key] = positive_integer(value, 'ID довідника') if value else None
        elif key in {'from', 'to'}:
            require(not value or day(value).isoformat() == value, 'Дата має формат РРРР-ММ-ДД.')
            result[key] = value
        else:
            result[key] = value.strip() if key == 'q' else value
    require(len(result.get('q', '')) <= 250, 'Пошуковий запит задовгий.')
    require(not result.get('from') or not result.get('to') or result['from'] <= result['to'], 'Початкова дата пізніша за кінцеву.')
    require(result.get('status', '') in {'', 'draft', 'posted', 'reversed'}, 'Невідомий стан документа.')
    page_number(params)
    return result


def policy(user):
    require(user.profile.role in {'owner', 'accountant'}, 'Недостатньо прав для зарплати.')
    closed = LedgerLock.objects.filter(pk=1).values_list('closed_through', flat=True).first()
    return {'role': user.profile.role, 'store': user.profile.store_id,
            'canManageEmployees': user.profile.role == 'owner', 'canWriteWorkShifts': True,
            'documentKinds': list(KINDS), 'closedThrough': closed.isoformat() if closed else None}


def bounds(query, params):
    total = query.count()
    selected, pages, offset = page_bounds(total, page_number(params))
    return {'total': total, 'page': selected, 'pages': pages, 'limit': PAGE_SIZE}, offset


def employees(user, params, selected, auth):
    raw = directories.page(user, 'employees', {**params, 'purpose': 'finance'})
    names = dict(Store.objects.filter(pk__in={x['store_id'] for x in raw['items']}).values_list('pk', 'name'))
    return {key: raw[key] for key in ('total', 'page', 'pages', 'limit')} | {'items': [
        {'id': int(x['id']), 'name': x['name'], 'store': x['store_id'], 'storeName': names[x['store_id']],
         'active': x['active'], 'shiftRate': x['shift_rate'], 'bonusPercent': x['bonus_percent'],
         'bonusBasis': x['bonus_basis'], 'payrollDebt': x['payroll_debt'], 'revision': x.get('revision')}
        for x in raw['items']]}


def work_shifts(user, params, selected, auth):
    query = scoped(WorkShift.objects.all(), user)
    for key, field in [('store', 'store_id'), ('employee', 'employee_id')]:
        if selected[key]:
            query = query.filter(**{field: selected[key]})
    if selected['from']:
        query = query.filter(date__gte=day(selected['from']))
    if selected['to']:
        query = query.filter(date__lte=day(selected['to']))
    page, offset = bounds(query, params)
    # HMAC versions include note. Refuse oversized historical metadata in SQL rather than
    # loading arbitrary text or silently truncating it into a different revision.
    columns = [f.attname for f in WorkShift._meta.concrete_fields if f.attname != 'note']
    rows = query.annotate(note_length=Length('note'), selected_note=Case(
        When(note_length__lte=2000, then=F('note')), default=Value(None), output_field=TextField()
    )).order_by('-date', '-pk').values(*columns, 'selected_note', 'employee__name', 'employee__active',
                                    'store__name')[offset:offset + PAGE_SIZE]
    items = []
    for row in rows:
        require(isinstance(row['selected_note'], str), 'Історична примітка табеля перевищує межу 2000 символів.')
        source = WorkShift(**{key: row[key] for key in columns}, note=row['selected_note'])
        can_edit = row['payroll_id'] is None and (auth['closedThrough'] is None or row['date'].isoformat() > auth['closedThrough'])
        items.append({'id': row['id'], 'employee': row['employee_id'], 'employeeName': row['employee__name'],
                      'employeeActive': row['employee__active'], 'store': row['store_id'], 'storeName': row['store__name'],
                      'date': row['date'].isoformat(), 'cashShift': row['cash_shift_id'],
                      'units': format(row['units'], '.2f'), 'shiftRate': format(row['shift_rate'], '.2f'),
                      'bonusPercent': format(row['bonus_percent'], '.3f'), 'bonusBasis': row['bonus_basis'],
                      'basisAmount': format(row['basis_amount'], '.2f'), 'accrued': format(row['accrued'], '.2f'),
                      'payroll': row['payroll_id'], 'revision': record_revision(source), 'canEdit': can_edit})
    return {**page, 'items': items}


def documents(user, params, selected, auth):
    query = scoped(Voucher.objects.filter(kind__in=KINDS), user)
    if selected['store']:
        query = query.filter(store_id=selected['store'])
    if selected['status']:
        query = query.filter(status=selected['status'])
    page, offset = bounds(query, params)
    values = query.order_by('-pk').values('id', 'kind', 'status', 'date', 'store_id', 'store__name',
                                        'employee_id', 'employee__name', 'total', 'revision')[offset:offset + PAGE_SIZE]
    return {**page, 'items': [
        {'id': x['id'], 'number': f"{x['id']:06d}", 'kind': x['kind'], 'status': x['status'],
         'date': x['date'].isoformat(), 'store': x['store_id'], 'storeName': x['store__name'],
         'employee': x['employee_id'], 'employeeName': x['employee__name'] or '',
         'total': format(x['total'], '.2f'), 'revision': x['revision']} for x in values]}


READERS = {'employees': employees, 'work-shifts': work_shifts, 'documents': documents}


def read(user, resource, params):
    selected = options(resource, params)
    with read_snapshot():
        user = current_actor(user)
        auth = policy(user)
        query = {key: str(value) for key, value in selected.items() if value is not None and value != ''}
        query['page'] = str(page_number(params))
        return {**READERS[resource](user, query, selected, auth), 'query': selected, 'policy': auth}
