"""Frozen SQLite price projection oracle for migration0024; never posting authority."""
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_HALF_UP

def pricing_config(data):
    return {'markup': decimal(data.get('defaultMarkup', 30)), 'rounding': decimal(data.get('rounding', .5))}


def decimal(value):
    try:
        result = Decimal(str(value if value is not None else 0))
        return result if result.is_finite() else Decimal(0)
    except (InvalidOperation, ValueError):
        return Decimal(0)


def regular_price(data, config=None):
    """Current regular price, before an optional explicit promotion discount."""
    # The frozen trigger always supplies its explicitly read settings config.
    if config is None: raise ValueError("Explicit migration price config required")
    if data.get('manualPrice'):
        price = decimal(data.get('price'))
    else:
        price = decimal(data.get('cost')) * (1 + decimal(data.get('markup', config['markup'])) / 100)
        rounding = config['rounding'] if config['rounding'] > 0 else Decimal('.5')
        price = (price / rounding).to_integral_value(rounding=ROUND_CEILING) * rounding
    return price.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)


def promotion_amount(data):
    value = data.get('promotionPrice')
    if value is None: return None
    # Reads tolerate existing malformed legacy records; writes validate strictly.
    try:
        amount = Decimal(str(value).replace(',', '.'))
        if not amount.is_finite() or not Decimal(0) < amount <= Decimal('99999999.99'): return None
        rounded = amount.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
        return rounded if amount == rounded else None
    except (InvalidOperation, ValueError):
        return None


def sale_price(data, config=None):
    """Effective selling price: a valid promotion below the regular price, otherwise the regular price."""
    regular = regular_price(data, config)
    promotion = promotion_amount(data)
    return promotion if data.get('promotion') and promotion is not None and 0 < promotion < regular else regular


