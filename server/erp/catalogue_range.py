"""Catalogue scenarios, not a prediction of the unknown future sales mix."""
from decimal import Decimal, ROUND_HALF_UP


def catalogue_range(*, minimum, maximum, coverage, nonpositive, expenses):
    """Extrema need constant memory; nonpositive margins never get filtered away."""
    def rounded(value):
        result = value.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
        return format(abs(result) if result == 0 else result, '.2f')

    result = {
        'basis': 'catalogue_margin_extrema',
        'minPercent': rounded(minimum * 100) if coverage else None,
        'maxPercent': rounded(maximum * 100) if coverage else None,
        'nonpositiveCount': nonpositive,
        'monthlyLow': None,
        'monthlyHigh': None,
    }
    if expenses == 0:
        result.update(reason='no_expenses', monthlyLow='0.00', monthlyHigh='0.00')
    elif not coverage:
        result['reason'] = 'no_coverage'
    elif maximum <= 0:
        result['reason'] = 'nonpositive_margin'
    else:
        result.update(reason='unbounded' if minimum <= 0 else 'bounded',
                      monthlyLow=rounded(expenses / maximum))
        if minimum > 0:
            result['monthlyHigh'] = rounded(expenses / minimum)
    return result
