"""Read-only policy and exact intent identity for managed task recovery."""
import hashlib
import json
import re
import uuid

from django.core.exceptions import PermissionDenied

from .historical_reports import read_snapshot
from .managed_alerts import ACTIONS, task_revision, work_state
from .models import AlertTaskAction, Document
from .services import Conflict, current_actor, require
from .task_scope import task_permissions, task_visible


def readable_task(user, identifier):
    require(isinstance(identifier, str) and
            re.fullmatch(r'(?:auto_|reprint_)[a-f0-9]{32}', identifier),
            'Некоректна системна задача.')
    task = Document.objects.filter(pk='tasks/' + identifier).first()
    if task is None or not isinstance(task.data, dict) or not task_visible(user, task.data):
        raise PermissionDenied('Немає доступу до системної задачі.')
    return task


def recovery_context(user, identifier, params):
    require(not params, 'Некоректні параметри чернетки системної задачі.')
    with read_snapshot():
        user = current_actor(user)
        task = readable_task(user, identifier)
        data = task.data
        kind = 'auto' if identifier.startswith('auto_') else 'reprint'
        active = bool(data.get('_alertActive')) if kind == 'auto' else data.get('status') != 'done'
        cycle = data.get('_alertCycle') or 1
        require(type(cycle) is int and cycle > 0, 'Некоректний цикл системної задачі.')
        return {
            'contract': 'managed-alert-context-v1',
            'role': user.profile.role,
            'storeId': user.profile.store_id,
            'networkOwner': user.profile.role == 'owner' and user.profile.store_id is None,
            'task': {
                'id': identifier, 'kind': kind, 'title': data.get('title', ''),
                'revision': task_revision(task), 'scope': data.get('scope'),
                'store': data.get('store'), 'cycle': cycle, 'active': active,
                'workState': work_state(data), 'until': data.get('_alertDeferredUntil'),
                'reason': data.get('_alertDeferReason', ''),
            },
            # An inactive condition keeps a readable draft; only the actual
            # operation decides whether its lifecycle permits another write.
            'canAct': task_permissions(user, task.path, data)['canEdit'] and (active or kind == 'reprint'),
        }


def identity(user, identifier, value):
    with read_snapshot():
        user = current_actor(user)
        task = readable_task(user, identifier)
        require(isinstance(value, dict) and set(value) == {'request'},
                'Некоректний початковий запит системної задачі.')
        request = value['request']
        require(isinstance(request, dict) and
                {'action', 'revision', 'idempotencyKey'} <= set(request) and
                not (set(request) - {'action', 'revision', 'idempotencyKey', 'until', 'reason'}),
                'Некоректні реквізити дії задачі.')
        operation = request['action']
        require(isinstance(operation, str) and operation in ACTIONS,
                'Оберіть коректну дію задачі.')
        require(isinstance(request['revision'], str) and
                re.fullmatch(r'[a-f0-9]{32}', request['revision']),
                'Некоректна початкова версія задачі.')
        try:
            key = uuid.UUID(request['idempotencyKey']) if isinstance(request['idempotencyKey'], str) else None
        except ValueError:
            key = None
        require(key is not None, 'Некоректний ключ дії задачі.')
        # EXACT existing action() serialization, including the original UUID
        # spelling, raw reason and default JSON separators. Never normalize here.
        try:
            fingerprint = hashlib.sha256(json.dumps(
                request, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
        except (TypeError, ValueError):
            require(False, 'Некоректні реквізити дії задачі.')
        receipt = AlertTaskAction.objects.filter(pk=key).values(
            'author_id', 'task_id', 'fingerprint', 'applied_revision', 'cycle').first()
        result = {
            'contract': 'managed-alert-identity-v1', 'confirmed': receipt is not None,
            'key': str(key), 'task': identifier, 'action': operation,
            'observedRevision': request['revision'],
        }
        if receipt is not None:
            if (receipt['author_id'] != user.pk or receipt['task_id'] != task.pk or
                    receipt['fingerprint'] != fingerprint):
                raise Conflict('Ключ використано для іншої дії задачі.', 'idempotency_conflict')
            result.update(appliedRevision=receipt['applied_revision'], appliedCycle=receipt['cycle'])
        return result
