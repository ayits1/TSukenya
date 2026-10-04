"""Immutable operation price deltas. Reading a receipt is not current-price authority."""
from decimal import Decimal
import re
from django.utils import timezone
from .services import require, current_actor
from .promotion_prices import context_store
from .catalog import EDIT_ROLES, revision

GROUPS = {'all', 'retail', 'display', 'new'}
UUID_PATTERN = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'


def validate_context(value):
    require(isinstance(value, dict) and set(value) == {'storeId'}, 'Некоректний контекст ціни.')
    identifier = value['storeId']
    require(identifier is None or type(identifier) is int and 0 < identifier <= 9007199254740991,
            'Некоректний ID магазину ціни.')


def scope_context(user, context):
    # NULL means the network, never the current actor's newly assigned store.
    identifier = context['storeId']
    require(user.profile.store_id is None or identifier == user.profile.store_id,
            'Немає доступу до контексту ціни цього результату.')


def resolve_context(user, payload, *, selection_store=None):
    if 'priceContext' in payload:
        value = payload['priceContext']; validate_context(value); scope_context(user, value)
        store = context_store(user, value['storeId'])
        if selection_store is not None:
            selected = context_store(user, selection_store)
            require((selected.pk if selected else None) == value['storeId'], 'Контекст ціни не відповідає фільтру магазину.')
    else:
        store = context_store(user, selection_store)
    return store


def capture_context(store):
    return {'storeId': store.pk if store else None, 'storeName': store.name if store else None}


def stored_store(user, context):
    if context is None:  # Old runs have no frozen context; don't claim a recovered comparison.
        return context_store(user)
    scope_context(user, context)
    return context_store(user, context['storeId'])


def terms(document, config, resolver):
    value = resolver.resolve(document)
    promotion = Decimal(value['salePrice']) < Decimal(value['regularPrice'])
    return {'productRevision': revision(document, config), 'effectivePriceRevision': value['effectivePriceRevision'],
            **{key: value[key] for key in ('regularPrice', 'salePrice', 'effectivePromotion')},
            'display': {'promotion': promotion, 'oldPrice': value['regularPrice'] if promotion else None}}


def comparison(before, after, config, resolver):
    previous = terms(before, config, resolver) if before else None
    latest = terms(after, config, resolver)
    return compare_terms(previous, latest)


def compare_terms(before, after):
    retail = before is not None and Decimal(before['salePrice']) != Decimal(after['salePrice'])
    display = before is not None and (before['display']['promotion'] != after['display']['promotion'] or
        (Decimal(before['display']['oldPrice']) if before['display']['oldPrice'] is not None else None) !=
        (Decimal(after['display']['oldPrice']) if after['display']['oldPrice'] is not None else None))
    return {'before': before, 'after': after, 'retailChanged': retail, 'displayChanged': display, 'created': before is None}


def result(identifier, outcome, compared, resolver, *, line=None, ordinal=1, committed_at=None):
    return {'id': identifier, 'line': line, 'ordinal': ordinal, 'outcome': outcome,
            'context': {**capture_context(resolver.store), 'effectiveDay': resolver.day.isoformat()},
            'committedAt': (committed_at or timezone.now()).isoformat(), **compared}


def selected(row, group):
    if group == 'all': return True
    if group == 'retail': return row['retailChanged']
    if group == 'display': return row['displayChanged'] and not row['retailChanged']
    return row['created']


def page_params(params):
    require(not(set(params)-{'page', 'group'}), 'Невідомі параметри результату ціни.')
    group = params.get('group', 'all'); raw = params.get('page', '1')
    require(group in GROUPS, 'Невідома група змін ціни.')
    require(isinstance(raw, str) and re.fullmatch('[0-9]{1,9}', raw) and int(raw) > 0, 'Некоректна сторінка результату.')
    return int(raw), group


def read_result(request, user, kind, identifier):
    """Creator/current-role scope and data share one repeatable-read, read-only snapshot."""
    from .models import Document
    from .import_models import CatalogImportRun
    from .historical_reports import read_snapshot
    from .views import response
    number, group = page_params(request.GET)
    with read_snapshot():
        user = current_actor(user)
        require(user.profile.role in ({'owner'} if kind == 'pricing' else EDIT_ROLES), 'Недостатньо прав для результату зміни цін.')
        if kind == 'pricing':
            receipt = Document.objects.filter(pk='pricing_runs/'+identifier, data__owner=user.pk).first()
            if receipt is None: return response({'error': 'Результат не знайдено.', 'code': 'not_found'}, 404)
            context = receipt.data.get('priceContext')
            if context is not None: scope_context(user, context)
            available = context is not None
            rows = [entry['priceResult'] for entry in receipt.data['result']['entries'] if entry.get('priceResult')] if available else []
            rows = [row for row in rows if selected(row, group)]
            total = len(rows); pages = max(1, (total+99)//100); number = min(number, pages)
            items = rows[(number-1)*100:number*100]; status = 'completed'
        else:
            run = CatalogImportRun.objects.filter(pk=identifier, owner=user).first()
            if run is None: return response({'error': 'Результат не знайдено.', 'code': 'not_found'}, 404)
            context = run.price_context
            if context is not None: scope_context(user, context)
            available = context is not None
            rows = run.rows.filter(status__in=['created', 'updated', 'skipped'], price_result__isnull=False).order_by('ordinal')
            if not available: rows = rows.none()
            if group == 'retail': rows = rows.filter(price_result__retailChanged=True)
            elif group == 'display': rows = rows.filter(price_result__displayChanged=True, price_result__retailChanged=False)
            elif group == 'new': rows = rows.filter(price_result__created=True)
            total = rows.count(); pages = max(1, (total+99)//100); number = min(number, pages)
            items = list(rows.values_list('price_result', flat=True)[(number-1)*100:number*100]); status = run.status
        return response({'operation': {'kind': kind, 'id': identifier}, 'comparisonUnavailable': not available,
            'priceContext': context, 'status': status, 'group': group, 'total': total, 'page': number,
            'pages': pages, 'limit': 100, 'items': items})
