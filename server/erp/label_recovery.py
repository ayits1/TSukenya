"""Label workspace save receipts. Identity reads never mutate settings or receipts."""
import hashlib
import json
import uuid
from django.db import transaction
from .models import Document
from .services import BusinessError, Conflict, current_actor, ledger_lock, require
from .historical_reports import read_snapshot

PREFIX = 'label_layout_runs/'
CONTRACT = 'label-layout-save-v1'


def owner(user):
    user = current_actor(user)
    require(user.profile.role == 'owner', 'Недостатньо прав. Макет може змінювати лише власник.')
    return user


def request_value(value):
    require(isinstance(value, dict) and set(value) == {'key', 'revision', 'config', 'settings'}, 'Некоректні поля запиту макета.')
    try: key = str(uuid.UUID(value.get('key', '')))
    except (ValueError, TypeError, AttributeError): raise BusinessError('Потрібен ключ запиту UUID.')
    require(value['key'] == key, 'Некоректний ключ запиту UUID.')
    require(isinstance(value['revision'], str) and len(value['revision']) == 64, 'Потрібна версія макета.')
    try: encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    except (TypeError, ValueError): raise BusinessError('Некоректні параметри макета.')
    return key, hashlib.sha256(encoded.encode()).hexdigest()


def receipt(user, key, fingerprint):
    # Only these immutable scalar fields are read; the generic document API
    # rejects this prefix for all GET/write/delete operations.
    row = Document.objects.filter(pk=PREFIX + key).values_list('data__author', 'data__fingerprint', 'data__appliedRevision').first()
    if row is None: return None
    if row[0] != user.pk or row[1] != fingerprint:
        raise Conflict('Ключ макета вже використано іншим запитом.', 'idempotency_conflict')
    require(isinstance(row[2], str) and len(row[2]) == 64, 'Підтвердження макета пошкоджено.')
    return row[2]


def context(user):
    with read_snapshot():
        user = owner(user)
        return {'contract': 'label-layout-context-v1', 'resource': 'settings/main',
                'role': user.profile.role, 'storeId': user.profile.store_id,
                'networkOwner': user.profile.store_id is None, 'canWrite': True}


def identity(user, value):
    require(isinstance(value, dict) and set(value) == {'request'}, 'Некоректний запит підтвердження макета.')
    key, fingerprint = request_value(value['request'])
    with read_snapshot():
        user = owner(user)
        applied = receipt(user, key, fingerprint)
        return {'contract': CONTRACT, 'key': key, 'confirmed': applied is not None,
                **({'appliedRevision': applied} if applied is not None else {})}


def execute(user, value):
    key, fingerprint = request_value(value)
    with transaction.atomic():
        ledger_lock()
        user = owner(user)
        applied = receipt(user, key, fingerprint)
        if applied is not None:
            return {'contract': CONTRACT, 'key': key, 'appliedRevision': applied, 'ok': True}, 200
        # Definite rejection describes only this live rolled-back attempt. A
        # client with an earlier unknown result cannot retire its frozen intent.
        try:
            with transaction.atomic():
                from .labels import apply_workspace
                applied = apply_workspace(user, value)
        except Conflict as error:
            if error.code != 'revision_conflict': raise
            return {'error': str(error), 'code': error.code, 'write_rejected': True, 'key': key}, 409
        except BusinessError as error:
            return {'error': str(error), 'write_rejected': True, 'key': key}, 400
        Document.objects.create(path=PREFIX + key, data={'author': user.pk, 'fingerprint': fingerprint, 'appliedRevision': applied})
        return {'contract': CONTRACT, 'key': key, 'appliedRevision': applied, 'ok': True}, 200
