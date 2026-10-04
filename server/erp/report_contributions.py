"""One financial contribution formula shared by period totals and their source rows."""
from decimal import Decimal, InvalidOperation
from .services import BusinessError

ZERO = Decimal('0')
PROFIT_WEIGHTS = {'revenue': 1, 'cogs': -1, 'expenses': -1, 'payroll': -1, 'writeoffs': -1,
                  'inventory_adjustment': 1, 'supplier_return_variance': 1, 'cash_difference': 1}
GROSS_WEIGHTS = {'revenue': 1, 'cogs': -1}


def voucher_contributions(voucher, sign, *, scoped=False):
    try:
        result = _voucher_contributions(voucher, sign, scoped=scoped)
        if not all(value.is_finite() for value in result.values()):
            raise InvalidOperation
        return result
    except (AttributeError, KeyError, TypeError, ValueError, InvalidOperation):
        raise BusinessError(f'Документ {voucher.pk} має некоректні реквізити показника; перевірте регістри.') from None


def _voucher_contributions(voucher, sign, *, scoped=False):
    """Network expense is a separate network contribution; a selected store excludes it."""
    total, cost = sign * voucher.total, sign * voucher.cost
    if voucher.kind == 'sale': return {'revenue': total, 'cogs': cost}
    if voucher.kind == 'customer_return': return {'revenue': -total, 'cogs': -cost}
    if voucher.kind == 'expense':
        if voucher.payload.get('expense_scope', 'store') == 'network': return {} if scoped else {'unallocated_expenses': total}
        return {'expenses': total}
    if voucher.kind == 'payroll': return {'payroll': total}
    if voucher.kind == 'writeoff': return {'writeoffs': cost}
    if voucher.kind == 'supplier_return': return {'supplier_return_variance': total - cost}
    if voucher.kind == 'inventory': return {'inventory_adjustment': sign * sum((Decimal(item['value']) for item in voucher.payload.get('differences', [])), ZERO)}
    if voucher.kind == 'cash_difference': return {'cash_difference': sign * Decimal(voucher.payload.get('difference', '0'))}
    return {}


def profit(row):
    return sum((row[key] * weight for key, weight in PROFIT_WEIGHTS.items()), ZERO)
