"""Readonly identity of a legacy CREATE; no latest revision becomes an original baseline."""
import re
from .models import Document, LegacyCreateReceipt
from .services import Conflict, current_actor, require
from .historical_reports import read_snapshot
from .financial_scope import require_network_owner
from .legacy_records import FIELDS, RESOURCES, read_record


def original_snapshot(user, collection, document):
    from .managed_alerts import task_revision
    from .task_scope import task_permissions
    allowed = FIELDS[collection] | {'order', 'byOwner'} | ({'scope', 'store', 'ideaId'} if collection == 'tasks' else set())
    data = {key: value for key, value in document.data.items() if key in allowed and type(value) in {str, int, float, bool, type(None)}}
    if collection == 'expenses':
        from .services import dec
        data['amount'] = str(dec(data['amount']))
    return {'collection': collection, 'id': document.pk.split('/', 1)[1], 'revision': task_revision(document),
            'data': data, 'permissions': task_permissions(user, document.pk, data) if collection == 'tasks' else {'canEdit': True, 'canDelete': True},
            'managed': False, 'initiative': None}


def authorize(user, collection):
    require(collection in RESOURCES, 'Невідомий тип створення.')
    require(user.profile.role == 'owner' or collection == 'tasks' and user.profile.role == 'manager', 'Недостатньо прав для початкового створення.')
    if collection == 'expenses': require_network_owner(user)


def identity(user, params):
    require(set(params) == {'collection', 'createKey'}, 'Очікується колекція й ключ початкового створення.')
    collection, key = params.get('collection'), params.get('createKey')
    require(isinstance(collection, str) and isinstance(key, str) and re.fullmatch(r'[A-Za-z0-9_-]{16,80}', key), 'Некоректне початкове створення.')
    with read_snapshot():
        user = current_actor(user)
        authorize(user, collection)
        receipt = LegacyCreateReceipt.objects.filter(pk=key).first()
        result = {'collection': collection, 'createKey': key, 'confirmed': False}
        if receipt is None: return result
        if receipt.author_id != user.pk or receipt.collection != collection:
            raise Conflict('Ключ належить іншому початковому запиту.', 'create_key_conflict')
        document = Document.objects.filter(pk=receipt.document_path).first()
        if collection == 'tasks':
            from .task_scope import authorize_task
            if receipt.original is not None:
                authorize_task(user, receipt.original['data'])
            elif user.profile.role != 'owner' and user.profile.store_id is not None:
                require(False, 'Немає доказу початкового магазину історичної задачі; доступ до квитанції недоступний.')
        from .views import legacy_create_fingerprint
        deleted = receipt.deleted_at is not None or document is None
        state = 'deleted' if deleted else 'unchanged' if receipt.created_fingerprint == legacy_create_fingerprint(document.data) else 'changed'
        # Current record access is checked in the same snapshot, including project/managed policies.
        current = None if deleted else read_record(user, collection, receipt.document_path.split('/', 1)[1])
        if current is not None:
            allowed = FIELDS[collection] | {'order', 'byOwner'} | ({'scope', 'store', 'ideaId'} if collection == 'tasks' else set())
            current['data'] = {key: value for key, value in current['data'].items() if key in allowed and type(value) in {str, int, float, bool, type(None)}}
        return {**result, 'confirmed': True, 'id': receipt.document_path.split('/', 1)[1], 'state': state,
                'original': receipt.original, 'current': current}
