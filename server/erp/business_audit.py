"""Whitelisted business snapshots and request-local audit context (never raw HTTP/JSON data)."""
from contextvars import ContextVar
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import re
import uuid

request_id = ContextVar('business_audit_request_id', default=None)

FIELDS = {
    'voucher': ('id', 'kind', 'status', 'date', 'store_id', 'warehouse_id', 'target_id', 'party_id', 'employee_id', 'account_id', 'shift_id', 'reference_id', 'total', 'cost', 'note', 'revision', 'posted_at', 'reversed_at'),
    'entity': ('id', 'name', 'store_id', 'kind', 'active', 'shift_rate', 'bonus_percent', 'bonus_basis'),
    'work_shift': ('id', 'employee_id', 'store_id', 'date', 'units', 'shift_rate', 'bonus_percent', 'bonus_basis', 'cash_shift_id', 'payroll_id', 'basis_amount', 'accrued', 'note'),
    'product': ('name', 'type', 'category', 'pack', 'size', 'unit', 'barcode', 'cost', 'markup', 'price', 'manualPrice', 'promotion', 'promotionPrice', 'priceAt', 'minStock', 'hidden'),
    'settings': ('defaultMarkup', 'rounding', 'budgetStores', 'stores', 'storeNames', 'staleDays'),
    'budget': ('name', 'group', 'amount', 'category'),
    'order': ('state', 'revision', 'expected_date', 'minimum_order_amount'),
}
NUMBERS = {'total', 'cost', 'quantity', 'price', 'amount', 'shift_rate', 'bonus_percent', 'units', 'basis_amount', 'accrued', 'markup', 'promotionPrice', 'minStock', 'defaultMarkup', 'rounding', 'additional_cost', 'difference', 'value', 'rate', 'percent', 'fulfilled', 'remaining', 'reserved', 'used', 'released', 'minimum_order_amount', 'planned_budget', 'target_value', 'fact_value'}
LINE_FIELDS = ('id', 'line_key', 'product_id', 'name', 'unit', 'quantity', 'price', 'amount', 'cost', 'lot', 'expiry', 'reference_line_id')
PAYLOAD_FIELDS = ('category', 'expense_scope', 'due_date', 'discount_reason', 'additional_cost', 'difference', 'fiscal_ref', 'expected_date', 'minimum_order_amount', 'order_revision')


def scalar(value, field):
    if isinstance(value, (date, datetime)): return value.isoformat()
    if isinstance(value, uuid.UUID): return str(value)
    if value is None or type(value) is bool: return value
    if field in NUMBERS:
        try:
            number = Decimal(str(value))
            return format(number, 'f') if number.is_finite() else None
        except (ValueError, TypeError, InvalidOperation): return None
    if type(value) is float and not Decimal(str(value)).is_finite(): return None
    return value if type(value) in {str, int, float} else None


def select(value, fields):
    if isinstance(value, dict): return {key: scalar(value[key], key) for key in fields if key in value}
    return {key: scalar(getattr(value, key), key) for key in fields if hasattr(value, key)}


def snapshot(kind, value):
    if value is None: return None
    result = select(value, FIELDS[kind])
    if kind == 'order':
        result['order_lines'] = [select(row, ('line', 'name', 'unit', 'quantity', 'fulfilled', 'remaining', 'reserved')) for row in value.get('lines', []) if isinstance(row, dict)]
        if isinstance(value.get('reservation'), dict):
            result['reservation'] = select(value['reservation'], ('id', 'line', 'code', 'name', 'unit', 'expires_on', 'quantity', 'used', 'released', 'owner'))
    if kind == 'settings':
        for key in ('stores', 'storeNames'):
            source = value.get(key) if isinstance(value, dict) else None
            if isinstance(source, list): result[key] = [item for item in source if isinstance(item, str)]
    if kind == 'voucher':
        payload = value.get('payload', {}) if isinstance(value, dict) else value.payload
        if isinstance(payload, dict):
            safe = select(payload, PAYLOAD_FIELDS)
            if isinstance(payload.get('payments'), list): safe['payments'] = [select(row, ('account', 'amount')) for row in payload['payments'] if isinstance(row, dict)]
            if isinstance(payload.get('differences'), list): safe['differences'] = [select(row, ('product', 'quantity', 'value')) for row in payload['differences'] if isinstance(row, dict)]
            if isinstance(payload.get('calculation'), list): safe['calculation'] = [select(row, ('id', 'date', 'cash_shift', 'units', 'rate', 'percent', 'basis', 'basis_amount', 'accrued')) for row in payload['calculation'] if isinstance(row, dict)]
            result['payload'] = safe
        lines = value.get('lines', []) if isinstance(value, dict) else value.lines.order_by('pk') if value.pk else []
        result['lines'] = [select(line, LINE_FIELDS) for line in lines]
        if not isinstance(value, dict) and value.pk:
            result['allocations'] = [select(row, ('source_id', 'payment_id', 'amount')) for row in value.allocation_entries.order_by('pk')]
    return result


def change(before, after, *, observed=None, reason=None):
    """Inputs must be snapshots from this module; revisions never copy arbitrary body/header text."""
    detail = {'before': before, 'after': after}
    if type(observed) is int and observed > 0 or isinstance(observed, str) and re.fullmatch(r'(?:[0-9a-f]{32}|[0-9a-f]{64})', observed):
        detail['observed_revision'] = observed
    if isinstance(reason, str) and reason.strip(): detail['reason'] = reason.strip()[:4000]
    return detail


def context(detail=None):
    return {**(detail or {}), 'request_id': request_id.get() or str(uuid.uuid4())}
