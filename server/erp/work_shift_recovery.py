"""Read-only access and creator-bound confirmation for local timesheet drafts."""
import re

from .historical_reports import read_snapshot
from .models import Employee, LedgerLock, Store, WorkShift, WorkShiftCreateReceipt
from .browsing import positive_integer
from .services import Conflict, current_actor, get, require, request_fingerprint, scope
from .shift_browsing import work_shift_json

REQUEST_FIELDS = {'employee', 'date', 'cash_shift', 'units', 'shift_rate', 'bonus_percent', 'bonus_basis', 'note', 'idempotency_key'}


def authorize(user):
    require(user.profile.role in {'owner', 'accountant'}, 'Недостатньо прав для зарплати.')


def acknowledgement(identifier, request):
    return {'id': identifier, 'type': 'work_shift', 'request_key': request['idempotency_key'],
            'request': {key: value for key, value in request.items() if key in REQUEST_FIELDS}}


def recovery_context(user, params):
    require(set(params) <= {'id', 'store', 'employee'}, 'Некоректний контекст табеля.')
    with read_snapshot():
        user = current_actor(user)
        authorize(user)
        identifier = positive_integer(params['id'], 'ID табеля') if params.get('id') else None
        store = positive_integer(params['store'], 'ID магазину') if params.get('store') else None
        employee = positive_integer(params['employee'], 'ID працівника') if params.get('employee') else None
        row = WorkShift.objects.filter(pk=identifier).only('pk', 'store_id', 'employee_id', 'date', 'payroll_id').first() if identifier else None
        if row:
            require(store is None or row.store_id == store, 'Магазин табеля змінився; доступ відкликано.')
            require(employee is None or row.employee_id == employee, 'Працівник табеля змінився; доступ відкликано.')
            store, employee = row.store_id, row.employee_id
        if employee:
            person = Employee.objects.only('pk','store_id').filter(pk=employee).first()
            require(person is not None, 'Працівника більше немає.')
            require(store is None or person.store_id == store, 'Магазин працівника змінився; доступ відкликано.')
            store = person.store_id
        if store:
            scope(user, get(Store, store, 'Магазин'))
        elif user.profile.store_id:
            store = user.profile.store_id
        closed = LedgerLock.objects.filter(pk=1).values_list('closed_through', flat=True).first()
        return {'type': 'work_shift', 'id': identifier, 'store': store, 'employee': employee,
                'role': user.profile.role, 'storeId': user.profile.store_id,
                'networkOwner': user.profile.role == 'owner' and user.profile.store_id is None,
                'exists': row is not None if identifier else None,
                'canEdit': row is None or not row.payroll_id and (closed is None or row.date > closed)}


def identity(user, value):
    with read_snapshot():
        user = current_actor(user)
        authorize(user)
        require(isinstance(value, dict) and set(value) == {'request'}, 'Очікується початковий запит.')
        request = value['request']
        require(isinstance(request, dict) and set(request) <= REQUEST_FIELDS and {'employee', 'date', 'idempotency_key'} <= set(request), 'Некоректний початковий запит.')
        key = request['idempotency_key']
        require(isinstance(key, str) and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', key), 'Некоректний UUID початкового запиту.')
        person = get(Employee, request['employee'], 'Працівник')
        scope(user, person.store)
        receipt = WorkShiftCreateReceipt.objects.select_related('work_shift__store').filter(pk=key).first()
        if receipt is None:
            return {'confirmed': False, 'type': 'work_shift', 'request_key': key}
        scope(user, receipt.work_shift.store)
        require(receipt.work_shift.employee_id == person.pk and receipt.work_shift.store_id == person.store_id, 'Магазин табеля змінився; доступ відкликано.')
        if receipt.author_id != user.pk or receipt.fingerprint != request_fingerprint(user, request):
            raise Conflict('UUID уже використано для іншого початкового запиту.', 'idempotency_conflict')
        return {'confirmed': True, **acknowledgement(receipt.work_shift_id, request)}


def current(user, params):
    require(set(params) == {'id'}, 'Очікується ID табеля.')
    identifier = positive_integer(params['id'], 'ID табеля')
    with read_snapshot():
        user = current_actor(user)
        authorize(user)
        row = get(WorkShift, identifier, 'Табель')
        scope(user, get(Store, row.store_id, 'Магазин'))
        return {'items': [work_shift_json(row)], 'total': 1, 'page': 1, 'pages': 1}
