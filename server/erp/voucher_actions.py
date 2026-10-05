"""Exact, creator-bound acknowledgements for standalone voucher actions.

Accounting remains in services. Receipts contain identity/terms, never a document
snapshot or a permission grant; DELETE receipts survive their scalar target.
"""
import hashlib
import json
import uuid
from django.db import transaction
from .historical_reports import read_snapshot
from .models import Voucher, VoucherActionReceipt, Store, LedgerLock
from .services import (BusinessError, Conflict, audit, current_actor, expense_permission,
    get, ledger_lock, permission, post_voucher, require, require_voucher_revision,
    reverse_voucher, scope)
from .business_audit import snapshot, change

ACTIONS = {'post', 'reverse', 'delete'}
FIELDS = {'key', 'action', 'id', 'kind', 'store', 'expenseScope', 'revision', 'reason'}


def normalize(value):
    require(isinstance(value, dict) and set(value) == FIELDS, 'Некоректні поля дії документа.')
    require(isinstance(value['key'], str), 'Вкажіть UUID дії.')
    try:
        key = uuid.UUID(value['key'])
        require(str(key) == value['key'], 'Некоректний UUID дії.')
    except (ValueError, AttributeError):
        raise BusinessError('Некоректний UUID дії.')
    require(isinstance(value['action'], str) and value['action'] in ACTIONS, 'Некоректна дія документа.')
    for field in ('id', 'store', 'revision'):
        require(type(value[field]) is int and 0 < value[field] <= 9007199254740991, 'Некоректна ідентичність документа.')
    require(isinstance(value['kind'], str) and value['kind'] in dict(Voucher.KIND), 'Некоректний тип документа.')
    require(value['expenseScope'] in ('store', 'network') and (value['kind'] == 'expense' or value['expenseScope'] == 'store'), 'Некоректна належність витрати.')
    require(isinstance(value['reason'], str) and len(value['reason']) <= 4000, 'Некоректна причина дії.')
    require(value['action'] == 'reverse' or value['reason'] == '', 'Причина допустима лише для скасування.')
    return dict(value)


def authorize(user, terms):
    permission(user, terms['kind'])
    scope(user, get(Store, terms['store'], 'Магазин'))
    require(terms['action'] != 'reverse' or user.profile.role in {'owner', 'manager', 'accountant'}, 'Скасування недоступне цій ролі.')
    require(terms['kind'] != 'expense' or terms['expenseScope'] != 'network' or user.profile.role in {'owner', 'accountant'}, 'Мережеві витрати недоступні цій ролі.')


def fingerprint(user, terms):
    return hashlib.sha256(json.dumps([user.pk, terms], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def receipt_for(user, terms):
    receipt = VoucherActionReceipt.objects.filter(pk=terms['key']).first()
    if receipt is not None and (receipt.author_id != user.pk or receipt.fingerprint != fingerprint(user, terms)):
        raise Conflict('UUID уже належить іншому початковому запиту.', 'idempotency_conflict')
    return receipt


def acknowledgement(receipt):
    return {'contract': 'voucher-action-v1', 'request': receipt.request, 'outcome': receipt.outcome}


def target(user, terms):
    v = get(Voucher, terms['id'], 'Документ')
    scope(user, v.store); permission(user, v.kind); expense_permission(user, v)
    require(v.kind == terms['kind'] and v.store_id == terms['store'] and
        (v.payload.get('expense_scope', 'store') if v.kind == 'expense' and isinstance(v.payload, dict) else 'store') == terms['expenseScope'], 'Ідентичність документа змінилась; доступ відкликано.')
    return v


@transaction.atomic
def perform(user, terms, *, completion):
    ledger_lock(); user = current_actor(user); authorize(user, terms)
    old = receipt_for(user, terms)
    if old is not None:
        completion['saved'] = True
        return old
    v = target(user, terms)
    completion['authorized'] = True
    require_voucher_revision(v, terms['revision'])
    expected = 'posted' if terms['action'] == 'reverse' else 'draft'
    if v.status != expected:
        raise Conflict('Стан документа вже змінився. Перевірте його окремо.', 'revision_conflict')
    if terms['action'] == 'post':
        post_voucher(user, v.pk, expected_revision=terms['revision'])
        outcome = 'posted'
    elif terms['action'] == 'reverse':
        # Existing nonblank reason/period/dependencies/stock/cash guards are authoritative.
        reverse_voucher(user, v.pk, terms['reason'])
        outcome = 'reversed'
    else:
        audit(user, 'draft_deleted', f'voucher/{v.pk}', change(snapshot('voucher', v), None, observed=terms['revision']))
        v.delete(); outcome = 'deleted'
    receipt = VoucherActionReceipt.objects.create(key=terms['key'], author=user, target_id=terms['id'],
        store_id_snapshot=terms['store'], kind=terms['kind'], action=terms['action'],
        expense_scope=terms['expenseScope'], fingerprint=fingerprint(user, terms), request=terms, outcome=outcome)
    completion['saved'] = True
    return receipt


def execute(user, value):
    terms = normalize(value)
    # Authorization failures never receive the rollback proof. The fresh check is
    # repeated under the ledger by perform(), before receipt replay or execution.
    user = current_actor(user); authorize(user, terms)
    completion = {'saved': False, 'authorized': False}
    try:
        receipt = perform(user, terms, completion=completion)
    except Conflict as exc:
        if completion['saved'] or not completion['authorized']: raise
        if exc.code != 'revision_conflict': raise
        return {'error': str(exc), 'code': exc.code, 'write_rejected': True, 'request': terms}, 409
    except BusinessError as exc:
        if completion['saved'] or not completion['authorized']: raise
        if any(s in str(exc) for s in ('прав', 'роль', 'доступ', 'відкликано', 'Мережеві')): raise
        return {'error': str(exc), 'write_rejected': True, 'request': terms}, 400
    # Outside atomic: any serialization/on_commit failure is not a no-write proof.
    return acknowledgement(receipt), 200


def identity(user, value):
    require(isinstance(value, dict) and set(value) == {'request'}, 'Очікується початковий запит.')
    terms = normalize(value['request'])
    with read_snapshot():
        user = current_actor(user); authorize(user, terms)
        receipt = receipt_for(user, terms)
        if receipt is None:
            return {'contract': 'voucher-action-v1', 'confirmed': False, 'request': terms}
        return {'confirmed': True, **acknowledgement(receipt)}


def context(user, params):
    require(set(params) == {'id', 'kind', 'store', 'expenseScope', 'action'} and
        (not hasattr(params, 'getlist') or all(len(params.getlist(key)) == 1 for key in params)), 'Некоректний контекст дії.')
    from .browsing import positive_integer
    terms = {'id': positive_integer(params['id'], 'ID документа'), 'kind': params['kind'],
        'store': positive_integer(params['store'], 'Магазин'), 'expenseScope': params['expenseScope'], 'action': params['action']}
    require(isinstance(terms['action'], str) and terms['action'] in ACTIONS, 'Некоректна дія.')
    require(terms['kind'] in dict(Voucher.KIND), 'Некоректний тип документа.')
    require(terms['expenseScope'] in {'store', 'network'} and (terms['kind'] == 'expense' or terms['expenseScope'] == 'store'), 'Некоректна належність витрати.')
    with read_snapshot():
        user = current_actor(user); authorize(user, terms)
        v = Voucher.objects.filter(pk=terms['id']).values('kind','store_id','status','revision','date','store__active','payload__expense_scope').first()
        closed = LedgerLock.objects.filter(pk=1).values_list('closed_through', flat=True).first()
        if v is not None:
            actual_scope = (v['payload__expense_scope'] or 'store') if v['kind'] == 'expense' else 'store'
            require(v['kind'] == terms['kind'] and v['store_id'] == terms['store'] and actual_scope == terms['expenseScope'], 'Ідентичність документа змінилась; доступ відкликано.')
        eligible = bool(v and v['status'] == ('posted' if terms['action'] == 'reverse' else 'draft'))
        if terms['action'] != 'delete': eligible = bool(eligible and (closed is None or v['date'] > closed))
        if terms['action'] == 'post': eligible = bool(eligible and v['store__active'])
        return {'contract': 'voucher-action-context-v1', **terms, 'exists': v is not None,
            'status': v['status'] if v else None, 'revision': v['revision'] if v else None,
            'date': v['date'].isoformat() if v else None, 'canExecute': eligible,
            'closedThrough': closed.isoformat() if closed else None,
            'role': user.profile.role, 'storeId': user.profile.store_id}
