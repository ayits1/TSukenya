"""Read-only grants and immutable operation identity for initiative drafts.

ProjectOperation already owns replay identity. These readers never replay an
operation, expose its historical project payload, or adopt a current revision.
"""
import hashlib
import json
import re
import uuid

from django.core.exceptions import PermissionDenied

from .historical_reports import read_snapshot
from .initiatives import PLAN_FIELDS, access, identifier, read_owner, token
from .models import Document, IdeaProject, ProjectExpense, ProjectOperation, ProjectTask, Store, Voucher
from .services import Conflict, require
from .task_scope import task_visible


EXTRAS = {
    'create': PLAN_FIELDS | {'idea', 'ideaRevision', 'store'},
    'edit': PLAN_FIELDS,
    'start': set(),
    'complete': {'resultSummary', 'resultDate', 'factValue'},
    'result_edit': {'resultSummary', 'resultDate', 'factValue'},
    'cancel': set(),
    'task_create': {'title', 'phase', 'stage'},
    'task_link': {'task', 'taskRevision', 'phase'},
    'task_update': {'task', 'taskRevision', 'status'},
    'expense_attach': {'voucher', 'voucherRevision'},
    'expense_detach': {'voucher'},
}


def canonical_uuid(value):
    try:
        parsed = uuid.UUID(value) if isinstance(value, str) else None
    except ValueError:
        parsed = None
    require(parsed is not None and str(parsed) == value, 'Потрібен канонічний UUID.')
    return value


def positive(value):
    require(type(value) is int and 0 < value <= 999999999999, 'Некоректний ID або версія.')
    return value


def query_id(value):
    require(isinstance(value, str) and re.fullmatch(r'[1-9][0-9]{0,11}', value), 'Некоректний ID.')
    return positive(int(value))


def revision(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value), 'Некоректна версія джерела.')
    return value


def readable_project(user, project_id):
    project = IdeaProject.objects.select_related('responsible').filter(pk=canonical_uuid(project_id)).first()
    if project is None:
        raise PermissionDenied('Немає доступу до проєкту.')
    access(user, project)
    return project


def readable_idea(idea_id):
    document = Document.objects.filter(pk='ideas/' + identifier(idea_id, 'Ідея')).first()
    if document is None or not isinstance(document.data, dict):
        raise PermissionDenied('Немає доступу до початкової ідеї.')
    return document


def project_terms(project):
    return {
        'id': str(project.pk), 'idea': project.idea_id.partition('/')[2],
        'store': project.store_id, 'title': project.title, 'problem': project.problem,
        'hypothesis': project.hypothesis, 'responsible': project.responsible_id,
        'responsibleName': project.responsible.username if project.responsible else None,
        'responsibleActive': project.responsible.is_active if project.responsible else None,
        'state': project.state, 'revision': project.revision,
        'plannedBudget': str(project.planned_budget) if project.planned_budget is not None else None,
        'metric': project.metric, 'metricUnit': project.metric_unit,
        'targetValue': str(project.target_value) if project.target_value is not None else None,
        'factValue': str(project.fact_value) if project.fact_value is not None else None,
        'resultSummary': project.result_summary,
        'resultDate': project.result_date.isoformat() if project.result_date else None,
        'cancelReason': project.cancel_reason,
    }


def selected_store(user, selected):
    if user.profile.store_id is not None and selected != user.profile.store_id:
        raise PermissionDenied('Немає доступу до магазину проєкту.')
    return selected is None or Store.objects.filter(pk=selected, active=True).exists()


def task_terms(user, project, task_id, action):
    document = Document.objects.filter(pk='tasks/' + identifier(task_id, 'Задача')).first()
    if document is None or not isinstance(document.data, dict):
        return None
    data = document.data
    if not task_visible(user, data):
        raise PermissionDenied('Немає доступу до задачі.')
    link = ProjectTask.objects.filter(document=document).select_related('project').first()
    if link:
        access(user, link.project)
    # Ineligible/missing sources preserve the authorized primary project's raw;
    # their arbitrary payload is not a recovery grant or an editable task bypass.
    if (data.get('scope') not in (None, 'development') or
            document.path.startswith(('tasks/auto_', 'tasks/reprint_')) or
            any(k.startswith(('_alert', '_price')) for k in data) or
            not isinstance(data.get('title'), str) or not data['title'].strip() or
            len(data['title']) > 250 or data.get('status', 'todo') not in ('todo', 'doing', 'done')):
        return None
    linked_here = bool(link and link.project_id == project.pk)
    return {'kind': 'task', 'id': task_id, 'title': data['title'],
            'status': data.get('status', 'todo'), 'revision': token(document),
            'linkedHere': linked_here,
            'available': linked_here if action == 'task_update' else link is None}


def expense_terms(user, project, voucher_id, action):
    value = Voucher.objects.filter(pk=voucher_id).values(
        'id', 'kind', 'date', 'total', 'status', 'revision', 'store_id',
        'payload__expense_scope', 'payload__category').first()
    if value is None:
        return None
    scope = value['payload__expense_scope']
    if (user.profile.store_id is not None and
            (value['store_id'] != user.profile.store_id or scope not in (None, 'store'))):
        raise PermissionDenied('Немає доступу до витрати.')
    if (project.store_id is not None and
            (value['store_id'] != project.store_id or scope not in (None, 'store'))):
        raise PermissionDenied('Витрата не належить магазину проєкту.')
    if value['kind'] != 'expense':
        return None
    link = ProjectExpense.objects.filter(voucher_id=voucher_id).values('project_id').first()
    linked_here = bool(link and link['project_id'] == project.pk)
    category = value['payload__category']
    return {'kind': 'expense', 'id': voucher_id, 'number': f'{voucher_id:06d}',
            'date': value['date'].isoformat(), 'amount': str(value['total']),
            'status': value['status'], 'revision': value['revision'], 'store': value['store_id'],
            'category': category if isinstance(category, str) else 'Інше',
            'linkedHere': linked_here,
            'available': linked_here if action == 'expense_detach' else
                         value['status'] == 'posted' and link is None}


def recovery_context(user, params):
    with read_snapshot():
        user = read_owner(user)
        operation = params.get('action')
        require(isinstance(operation, str) and operation in EXTRAS, 'Некоректна дія проєкту.')
        keys = {'action', 'idea', 'store'} if operation == 'create' else {'action', 'project'}
        if operation in {'task_link', 'task_update'}:
            keys.add('task')
        if operation in {'expense_attach', 'expense_detach'}:
            keys.add('voucher')
        require(set(params) == keys and all(isinstance(params[k], str) for k in keys) and
                (not hasattr(params, 'getlist') or all(len(params.getlist(k)) == 1 for k in keys)),
                'Некоректні параметри чернетки проєкту.')
        project = idea = source = None
        if operation == 'create':
            document = readable_idea(params['idea'])
            existing = IdeaProject.objects.filter(idea=document).values('id', 'store_id').first()
            visible_existing = existing and (user.profile.store_id is None or
                                            user.profile.store_id == existing['store_id'])
            idea = {'id': params['idea'],
                    'title': document.data.get('title') if isinstance(document.data.get('title'), str) else '',
                    'text': document.data.get('text') if isinstance(document.data.get('text'), str) else '',
                    'reaction': document.data.get('reaction') if document.data.get('reaction') in
                                ('yes', 'no', None) else None,
                    'revision': token(document),
                    'project': str(existing['id']) if visible_existing else None}
            permitted = selected_store(user, query_id(params['store']) if params['store'] else None)
            can_write = permitted and idea['reaction'] == 'yes' and existing is None
        else:
            current = readable_project(user, params['project'])
            project = project_terms(current)
            can_write = ({'start': current.state == 'planned', 'complete': current.state == 'active',
                          'result_edit': current.state == 'completed'}.get(operation,
                         True if operation.startswith('expense_') else current.state in {'planned', 'active'}))
            if operation in {'task_link', 'task_update'}:
                source = task_terms(user, current, params['task'], operation)
                can_write = can_write and source is not None and source['available']
            if operation.startswith('expense_'):
                source = expense_terms(user, current, query_id(params['voucher']), operation)
                can_write = can_write and source is not None and source['available']
        return {'contract': 'initiative-recovery-context-v1', 'role': user.profile.role,
                'storeId': user.profile.store_id, 'networkOwner': user.profile.store_id is None,
                'selection': {'project': params.get('project'), 'idea': params.get('idea'),
                              'task': params.get('task'),
                              'voucher': query_id(params['voucher']) if 'voucher' in params else None,
                              'store': query_id(params['store']) if params.get('store') else None},
                'action': operation, 'project': project, 'idea': idea, 'source': source,
                'canWrite': bool(can_write),
                'reason': '' if can_write else 'Поточний стан не дозволяє цю дію. Введення збережено.'}


def operation_identity(user, value):
    with read_snapshot():
        user = read_owner(user)
        require(isinstance(value, dict) and set(value) == {'project', 'request'},
                'Некоректна перевірка початкової дії.')
        route = canonical_uuid(value['project']) if value['project'] is not None else None
        request = value['request']
        require(isinstance(request, dict), 'Потрібен початковий запит.')
        action = request.get('action')
        require(isinstance(action, str) and action in EXTRAS and
                not set(request) - EXTRAS[action] - {'action', 'revision', 'reason', 'idempotencyKey'},
                'Некоректні реквізити початкової дії.')
        require((action == 'create') == (route is None), 'Дія не відповідає маршруту проєкту.')
        key = canonical_uuid(request.get('idempotencyKey'))
        observed = positive(request.get('revision')) if route else None
        idea_revision = revision(request.get('ideaRevision')) if route is None else None
        if route:
            readable_project(user, route)
        else:
            readable_idea(request.get('idea'))
            selected_store(user, positive(request['store']) if request.get('store') is not None else None)
        # EXACT mutate() serializer; whitespace, decimal spelling and null/omitted
        # fields stay part of the creator-bound immutable operation identity.
        try:
            fingerprint = hashlib.sha256(json.dumps(
                [route, request], sort_keys=True, separators=(',', ':'),
                ensure_ascii=False, allow_nan=False).encode()).hexdigest()
        except (TypeError, ValueError):
            require(False, 'Некоректний початковий запит.')
        receipt = ProjectOperation.objects.filter(pk=key).values(
            'actor_id', 'project_id', 'project__store_id', 'fingerprint',
            'result__project__id', 'result__project__revision').first()
        result = {'contract': 'initiative-operation-identity-v1', 'confirmed': receipt is not None,
                  'key': key, 'action': action, 'routeProject': route,
                  'observedRevision': observed, 'observedIdeaRevision': idea_revision}
        if receipt is not None:
            if user.profile.store_id is not None and receipt['project__store_id'] != user.profile.store_id:
                raise PermissionDenied('Немає доступу до проєкту цієї дії.')
            if (receipt['actor_id'] != user.pk or receipt['fingerprint'] != fingerprint or
                    route is not None and str(receipt['project_id']) != route):
                raise Conflict('Ключ повтору використано з іншим змістом.', 'idempotency_conflict')
            applied = receipt['result__project__revision']
            require(receipt['result__project__id'] == str(receipt['project_id']) and
                    type(applied) is int and applied > 0, 'Некоректне підтвердження початкової дії.')
            result.update(project=str(receipt['project_id']), appliedRevision=applied)
        return result
