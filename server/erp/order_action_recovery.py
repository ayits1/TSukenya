"""Creator-bound order action recovery; OrderOperation remains the only receipt.

The legacy exact canonical body hash and financial/FEFO services are unchanged.
Historical ACKs are scalar confirmations, never a current editing baseline.
"""
import hashlib
import json
import uuid
from django.db import connection, transaction
from django.db.models.expressions import RawSQL
from .historical_reports import read_snapshot
from .models import OrderOperation, StockReservation, Voucher
from .orders import ORDER_KINDS, control, editable, mutate, order_json, reserve_limits
from .reservations import unused
from .services import BusinessError, Conflict, current_actor, ledger_lock, permission, require, scope

ACTIONS = {'reserve', 'release', 'expire', 'close', 'expected_date'}
STATES = {'draft', 'approved', 'partial', 'fulfilled', 'closed', 'cancelled'}


def positive(value):
    require(type(value) is int and 0 < value <= 9007199254740991, 'Некоректна ідентичність замовлення.')
    return value


def normalize(value):
    require(isinstance(value, dict) and set(value) == {'id', 'kind', 'store', 'body'}, 'Некоректні поля дії замовлення.')
    positive(value['id']); positive(value['store'])
    require(isinstance(value['kind'], str) and value['kind'] in ORDER_KINDS, 'Некоректний тип замовлення.')
    body = value['body']
    require(isinstance(body, dict), 'Очікується початковий запит.')
    action = body.get('action')
    require(isinstance(action, str) and action in ACTIONS, 'Невідома дія замовлення.')
    fields = {'action', 'revision', 'idempotencyKey'} | ({'expires_on', 'lines'} if action == 'reserve' else {'reservation', 'quantity', 'reason'} if action == 'release' else {'reason'} if action == 'close' else {'expected_date'} if action == 'expected_date' else set())
    require(set(body) == fields, 'Некоректні поля початкової дії.')
    positive(body['revision'])
    raw = body['idempotencyKey']
    require(isinstance(raw, str), 'Вкажіть UUID повтору.')
    try: require(str(uuid.UUID(raw)) == raw, 'Потрібен канонічний UUID повтору.')
    except (ValueError, AttributeError): raise BusinessError('Некоректний UUID повтору.')
    require(action != 'reserve' or value['kind'] == 'customer_order', 'Резерв доступний лише замовленню покупця.')
    require(action != 'expected_date' or value['kind'] == 'purchase_order', 'Очікувана дата доступна лише закупівлі.')
    for field in ('reason', 'quantity', 'expected_date', 'expires_on'):
        if field in body: require(isinstance(body[field], str) and len(body[field]) <= (4000 if field == 'reason' else 80), 'Некоректні raw поля дії.')
    if action == 'release': positive(body['reservation'])
    if action == 'reserve':
        require(isinstance(body['lines'], list) and len(body['lines']) <= 200, 'Забагато рядків резерву.')
        seen = set()
        for line in body['lines']:
            require(isinstance(line, dict) and set(line) == {'line', 'quantity'}, 'Некоректний рядок резерву.')
            positive(line['line']); require(line['line'] not in seen, 'Повторений рядок резерву.'); seen.add(line['line'])
            require(isinstance(line['quantity'], str) and len(line['quantity']) <= 80, 'Некоректна raw кількість.')
    return value


def target(user, terms):
    permission(user, terms['kind'])
    order = Voucher.objects.select_related('store').defer('payload').filter(pk=terms['id']).first()
    require(order is not None, 'Замовлення не знайдено.')
    scope(user, order.store); permission(user, order.kind)
    require(order.kind == terms['kind'] and order.store_id == terms['store'], 'Ідентичність замовлення змінилась; доступ відкликано.')
    require(editable(user, order), 'Доступ до дій цього замовлення відкликано.')
    return order


def digest(body):
    # Exactly orders.mutate's existing canonical hash; no normalized Decimal rewrite.
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def receipt(user, terms):
    row = OrderOperation.objects.filter(pk=terms['body']['idempotencyKey']).values('actor_id', 'order_id', 'payload_hash', 'result__id', 'result__order__revision', 'result__order__state').first()
    if row is None: return None
    if row['actor_id'] != user.pk or row['order_id'] != terms['id'] or row['payload_hash'] != digest(terms['body']):
        raise Conflict('UUID уже належить іншому початковому запиту.', 'idempotency_conflict')
    revision = row['result__order__revision']; state = row['result__order__state']
    require(row['result__id'] == terms['id'] and type(revision) is int and revision == terms['body']['revision'] + 1 and isinstance(state, str) and state in STATES, 'Історичне підтвердження не відповідає контракту.')
    return {'contract': 'order-action-v1', 'request': terms, 'outcome': {'id': terms['id'], 'revision': revision, 'state': state}}


@transaction.atomic
def perform(user, terms, completion):
    ledger_lock(); user = current_actor(user); target(user, terms)
    old = receipt(user, terms)
    if old is not None: completion['saved'] = True; return old
    completion['authorized'] = True
    mutate(user, terms['id'], terms['body'])
    completion['saved'] = True
    return receipt(user, terms)


def execute(user, value):
    terms = normalize(value)
    completion = {'saved': False, 'authorized': False}
    try: ack = perform(user, terms, completion)
    except Conflict as exc:
        if completion['saved'] or not completion['authorized'] or exc.code != 'order_revision_conflict': raise
        return {'error': str(exc), 'code': exc.code, 'write_rejected': True, 'request': terms}, 409
    except BusinessError as exc:
        if completion['saved'] or not completion['authorized'] or any(word in str(exc) for word in ('прав', 'роль', 'доступ', 'відкликано')): raise
        return {'error': str(exc), 'write_rejected': True, 'request': terms}, 400
    # Serialization is outside the transaction and never obtains a rollback proof.
    return ack, 200


def identity(user, value):
    require(isinstance(value, dict) and set(value) == {'request'}, 'Очікується початковий запит.')
    terms = normalize(value['request'])
    with read_snapshot():
        user = current_actor(user); target(user, terms)
        ack = receipt(user, terms)
        return {'confirmed': True, **ack} if ack is not None else {'contract': 'order-action-v1', 'confirmed': False, 'request': terms}


def legacy_expected_date(order):
    """Project only a bounded text scalar; never decode unknown historical JSON."""
    if connection.vendor == 'postgresql':
        value = "payload->'expected_date'"
        kind = f"jsonb_typeof({value})"
        text = "payload->>'expected_date'"
        falsy = f"({value} IS NULL OR {kind}='null' OR {value} IN ('false'::jsonb,'[]'::jsonb,'{{}}'::jsonb) OR (CASE WHEN {kind}='number' THEN ({text})::numeric=0 ELSE FALSE END) OR ({kind}='string' AND {text}=''))"
        valid = f"({falsy} OR ({kind}='string' AND octet_length({text})<=80))"
        selected = f"CASE WHEN {kind}='string' AND octet_length({text})<=80 THEN {text} ELSE NULL END"
    else:
        kind = "json_type(payload,'$.expected_date')"
        text = "json_extract(payload,'$.expected_date')"
        falsy = f"({kind} IS NULL OR {kind} IN ('null','false') OR ({kind}='array' AND json_array_length(payload,'$.expected_date')=0) OR ({kind}='object' AND NOT EXISTS(SELECT 1 FROM json_each(payload,'$.expected_date'))) OR ({kind} IN ('integer','real') AND {text}=0) OR ({kind}='text' AND {text}=''))"
        valid = f"({falsy} OR ({kind}='text' AND length(CAST({text} AS BLOB))<=80))"
        selected = f"CASE WHEN {kind}='text' AND length(CAST({text} AS BLOB))<=80 THEN {text} ELSE NULL END"
    row = Voucher.objects.filter(pk=order.pk).annotate(_valid=RawSQL(valid, []), _date=RawSQL(selected, [])).values('_valid', '_date').get()
    require(bool(row['_valid']), f'Замовлення № {order.pk}: історична очікувана дата не є підтримуваним обмеженим scalar полем.')
    return row['_date'] or None


def context(user, params):
    fields = {'id', 'kind', 'store', 'action'} | ({'reservation'} if params.get('action') == 'release' else set())
    require(set(params) == fields and (not hasattr(params, 'getlist') or all(len(params.getlist(key)) == 1 for key in params)), 'Некоректний контекст дії.')
    from .browsing import positive_integer
    terms = {'id': positive_integer(params['id'], 'ID замовлення'), 'store': positive_integer(params['store'], 'Магазин'), 'kind': params['kind']}
    positive(terms['id']); positive(terms['store'])
    action = params['action']
    require(action in ACTIONS and terms['kind'] in ORDER_KINDS, 'Некоректна дія або тип замовлення.')
    require(action != 'reserve' or terms['kind'] == 'customer_order', 'Некоректна дія для закупівлі.')
    require(action != 'expected_date' or terms['kind'] == 'purchase_order', 'Некоректна дія для замовлення покупця.')
    with read_snapshot():
        user = current_actor(user); order = target(user, terms)
        require(order.lines.count() <= 200, 'Замовлення перевищує підтримуваний розмір редактора.')
        # order_json only needs these legacy scalars, never the full document JSON.
        state = control(order)
        order.payload = {'expected_date': legacy_expected_date(order) if state is None else None, 'minimum_order_amount': None}
        data = order_json(order, user)
        selected = None
        if action == 'release':
            identifier = positive_integer(params['reservation'], 'ID резерву'); positive(identifier)
            row = StockReservation.objects.filter(pk=identifier, order_line__voucher=order).select_related('lot', 'order_line').first()
            require(row is not None, 'Резерв не належить замовленню.')
            selected = {'id': row.pk, 'line': row.order_line_id, 'name': row.order_line.name, 'code': row.lot.code, 'expires_on': row.expires_on.isoformat(), 'unused': str(unused(row))}
        state = control(order)
        return {'contract': 'order-action-context-v1', **terms, 'action': action,
            'revision': data['revision'], 'state': data['state'], 'date': order.date.isoformat(),
            'canExecute': order.status == 'posted' and (state is None or state.closed_at is None),
            'expected_date': data['expected_date'], 'lines': data['lines'], 'selected': selected,
            'limits': reserve_limits(order, user) if action == 'reserve' else [],
            'role': user.profile.role, 'storeId': user.profile.store_id}
