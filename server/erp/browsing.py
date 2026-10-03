"""Scoped, read-only source selection; destination posting permissions stay separate."""
import re
from decimal import Decimal

from django.db.models import DecimalField, Exists, F, OuterRef, Prefetch, Subquery, Sum, Value
from django.db.models.functions import Coalesce

from .models import Voucher, VoucherLine
from .reporting import scoped
from .services import day, obligation, permission, require

PAGE_SIZE = 30
SOURCE_KINDS = {
    'payment': ('receipt', 'sale', 'debt_opening'),
    'receipt': ('purchase_order',),
    'sale': ('customer_order',),
    'customer_return': ('sale',),
    'supplier_return': ('receipt',),
}


def positive_integer(value, label):
    require(isinstance(value, str) and re.fullmatch(r'[0-9]{1,12}', value) is not None,
            f'{label}: некоректне число.')
    result = int(value)
    require(result > 0, f'{label}: число має бути додатним.')
    return result


def page_number(params):
    return positive_integer(params.get('page', '1'), 'Номер сторінки')


def page_bounds(total, requested):
    pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
    page = min(requested, pages)
    start = (page - 1) * PAGE_SIZE
    return page, pages, start


def filter_search(query, params):
    start = day(params['from']) if params.get('from') else None
    end = day(params['to']) if params.get('to') else None
    require(not start or not end or start <= end, 'Початкова дата пізніша за кінцеву.')
    if start:
        query = query.filter(date__gte=start)
    if end:
        query = query.filter(date__lte=end)
    search = params.get('q', '').strip()
    require(len(search) <= 250, 'Пошуковий запит задовгий.')
    number = search.lstrip('№').strip()
    if re.fullmatch(r'[0-9]+', number or ''):
        require(len(number) <= 12, 'Номер документа задовгий.')
        query = query.filter(pk=int(number))
    elif search:
        query = query.filter(party__name__icontains=search)
    return query


def with_settlements(query):
    return query.prefetch_related(Prefetch(
        'voucher_set',
        queryset=Voucher.objects.filter(status='posted', kind__in=['customer_return', 'supplier_return', 'payment']),
        to_attr='browse_settlements',
    ))


def references(user, params):
    purpose = params.get('purpose', '')
    require(purpose in SOURCE_KINDS, 'Невідоме призначення вихідного документа.')
    permission(user, purpose)
    requested = page_number(params)
    query = scoped(Voucher.objects.filter(status='posted', kind__in=SOURCE_KINDS[purpose]), user)
    for parameter, field in [('store', 'store_id'), ('party', 'party_id'), ('id', 'pk')]:
        value = params.get(parameter, '')
        if value:
            query = query.filter(**{field: positive_integer(value, 'ID документа' if parameter == 'id' else 'ID довідника')})
    query = filter_search(query, params)
    query = with_settlements(query.select_related('party')).order_by('-pk')
    if purpose == 'payment':
        # Reuse the authoritative obligation calculation, including returns and
        # embedded sale payments; these sources do not expose line/cost details.
        eligible = []
        for voucher in query:
            outstanding = obligation(voucher, settlements=voucher.browse_settlements)
            if outstanding > 0:
                eligible.append((voucher, outstanding))
        total = len(eligible)
        page, pages, offset = page_bounds(total, requested)
        selected = eligible[offset:offset + PAGE_SIZE]
    else:
        quantity_field = DecimalField(max_digits=18, decimal_places=3)
        used = VoucherLine.objects.filter(
            reference_line_id=OuterRef('pk'), voucher__kind=purpose,
            voucher__status='posted',
        ).order_by().values('reference_line_id').annotate(amount=Sum('quantity')).values('amount')
        remaining = VoucherLine.objects.filter(voucher_id=OuterRef('pk')).annotate(
            used=Coalesce(Subquery(used), Value(Decimal('0')), output_field=quantity_field),
        ).filter(quantity__gt=F('used'))
        query = query.annotate(has_remaining=Exists(remaining)).filter(has_remaining=True)
        total = query.count()
        page, pages, offset = page_bounds(total, requested)
        selected = [(voucher, obligation(voucher, settlements=voucher.browse_settlements) if voucher.kind in {'receipt', 'sale', 'debt_opening'} else None)
                    for voucher in query[offset:offset + PAGE_SIZE]]
    return {
        'items': [{
            'id': voucher.pk, 'number': f'{voucher.pk:06d}', 'kind': voucher.kind,
            'date': voucher.date.isoformat(), 'store': voucher.store_id,
            'party': voucher.party_id, 'total': str(voucher.total),
            'outstanding': str(outstanding) if outstanding is not None else None,
            'warehouse': voucher.warehouse_id,
        } for voucher, outstanding in selected],
        'total': total, 'page': page, 'pages': pages,
    }
