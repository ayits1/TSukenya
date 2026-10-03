"""Legacy task access; alert identity belongs to the server producer."""
from .models import Store
from .services import require

TASK_SCOPES = {'operations', 'development'}
TASK_STATUSES = {'todo', 'doing', 'done'}


# Overdue-payment alerts carry counterparty names and debt amounts.
FINANCE_ALERT_ROLES = {'owner', 'manager', 'accountant'}


def task_visible(user, data):
    if user.profile.role == 'owner':
        return True
    if data.get('scope') != 'operations':
        return False
    if str(data.get('_alertKey', '')).startswith('due:') and user.profile.role not in FINANCE_ALERT_ROLES:
        return False
    store = data.get('store')
    if store is None:
        return True  # Network tasks are visible, but not writable by store managers.
    return type(store) is int and store > 0 and (
        user.profile.store_id is None or store == user.profile.store_id)


def authorize_task(user, data):
    if user.profile.role == 'owner':
        return
    require(user.profile.role == 'manager' and data.get('scope') == 'operations',
            'Недостатньо прав для редагування цієї задачі.')
    if user.profile.store_id is not None:
        require(type(data.get('store')) is int and data['store'] == user.profile.store_id,
                'Немає доступу до редагування задачі цього магазину або мережі.')


def alert_task(path, data):
    return path.startswith('tasks/auto_') or any(key.startswith('_alert') for key in data)


def task_permissions(user, path, data):
    role = user.profile.role
    writable = role == 'owner' or role == 'manager' and data.get('scope') == 'operations' and (
        user.profile.store_id is None or
        type(data.get('store')) is int and data['store'] == user.profile.store_id)
    return {'canEdit': writable, 'canDelete': writable and not alert_task(path, data)}


def delete_task(user, path, data):
    authorize_task(user, data)
    require(not alert_task(path, data),
            'Системну задачу не можна видалити. Її закриває перевірка облікової умови.')


def prepare_task(user, path, data, previous=None):
    if previous is not None:
        authorize_task(user, previous)
    value = dict(data)
    # A missing legacy scope remains a development task for its owner.
    require(isinstance(value.get('scope'), str) and value['scope'] in TASK_SCOPES or
            user.profile.role == 'owner' and 'scope' not in value,
            'Виберіть простір задачі: операційна робота або розвиток бізнесу.')
    require(not any(key in value for key in ('permissions', '_canEdit', '_canDelete')),
            'Права задачі визначає лише сервер.')
    if previous is None and user.profile.role == 'manager' and value.get('store') is None:
        value['store'] = user.profile.store_id
    authorize_task(user, value)

    if previous is not None and alert_task(path, previous):
        require({k: v for k, v in value.items() if k != 'status'} ==
                {k: v for k, v in previous.items() if k != 'status'},
                'Реквізити системної задачі змінює лише перевірка облікової умови.')
    else:
        require(not alert_task(path, value), 'Системні реквізити задачі встановлює лише сервер.')

    if value.get('store') is not None:
        store = value['store']
        require(type(store) is int and 0 < store <= 9223372036854775807 and
                Store.objects.filter(pk=store).exists(), 'Магазин задачі: запис не знайдено.')
    if 'status' in value:
        require(isinstance(value['status'], str) and value['status'] in TASK_STATUSES,
                'Виберіть коректний статус задачі.')
    return value
