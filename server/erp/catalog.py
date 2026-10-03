"""Versioned catalogue boundary over existing documents; posting remains in ERP services."""
import hashlib
import hmac
from django.conf import settings
import json
import re
import secrets
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_HALF_UP
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from .models import Document
from .services import require, dec, day, ledger_lock, audit

EDIT_ROLES = {'owner', 'manager', 'warehouse'}
TEXT_FIELDS = {'name': 250, 'type': 160, 'category': 160, 'pack': 160, 'size': 160, 'unit': 30, 'barcode': 80}
PRICE_FIELDS = {'cost', 'markup', 'price', 'manualPrice', 'promotionPrice'}
PRODUCT_FIELDS = set(TEXT_FIELDS) | PRICE_FIELDS | {'promotion', 'priceAt', 'priceReviewed', 'minStock'}
PRICE_DATE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')


def plain(value):
    """One spelling per value: 30, 30.0 and Decimal('30.0000') compare and hash alike."""
    return format(value.normalize(), 'f')


def revision(document, config=None):
    config = defaults() if config is None else config
    material = {'path': document.path, 'data': document.data,
        'pricing': {key: plain(value) for key, value in config.items()}}
    return hmac.new(settings.SECRET_KEY.encode(), json.dumps(material, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()


def pricing_config(data):
    return {'markup': decimal(data.get('defaultMarkup', 30)), 'rounding': decimal(data.get('rounding', .5))}


def defaults():
    document = Document.objects.filter(pk='settings/main').first()
    return pricing_config(document.data if document else {})


def pricing_revision(config=None):
    """Opaque version of the effective defaults; never exposes private settings."""
    config = defaults() if config is None else config
    material = json.dumps({key: plain(value) for key, value in config.items()}, sort_keys=True, separators=(',', ':'))
    return hmac.new(settings.SECRET_KEY.encode(), material.encode(), hashlib.sha256).hexdigest()


def new_product_data(config):
    return {'unit': 'шт', 'markup': float(config['markup']), 'cost': 0, 'manualPrice': False, 'price': None}


def keep_pricing_settings(value, old):
    """Legacy settings writes cannot change prices outside the pricing preview/commit flow."""
    require(pricing_config(value) == pricing_config(old), 'Націнку за замовчуванням і округлення змінюйте через попередній перегляд масової зміни цін.')
    for key in ('defaultMarkup', 'rounding'):
        # Equal values keep their stored spelling, so revisions do not change.
        if key in old: value[key] = old[key]
        else: value.pop(key, None)
    return value


def name_key(value):
    """The key the catalogue import matches existing products by."""
    from .catalog_references import clean
    return clean(value).casefold() if isinstance(value, str) else ''


def duplicate_name(data, old, path):
    """Whether a new or renamed product would make the import name match ambiguous."""
    key = name_key(data.get('name'))
    if not key or old.get('name') and key == name_key(old.get('name')):
        return False  # Existing duplicates stay editable until renamed.
    # Whole documents decode names alike on every backend (SQLite turns "123" into a number).
    documents = Document.objects.filter(path__startswith='products/').exclude(pk=path).values_list('data', flat=True)
    return any(isinstance(item, dict) and name_key(item.get('name')) == key for item in documents)


DUPLICATE_NAME = {'error': 'Товар із такою назвою вже є в каталозі. Змініть назву або відкрийте наявний товар.', 'code': 'duplicate_name'}


def price_date(value):
    # The API exposes YYYY-MM-DD or an empty date; older documents may use another ISO spelling.
    try:
        return date.fromisoformat(value).isoformat() if isinstance(value, str) and value else ''
    except ValueError:
        return ''


def decimal(value):
    try:
        result = Decimal(str(value if value is not None else 0))
        return result if result.is_finite() else Decimal(0)
    except (InvalidOperation, ValueError):
        return Decimal(0)


def regular_price(data, config=None):
    """Current regular price, before an optional explicit promotion discount."""
    config = defaults() if config is None else config
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


def serialize(document, user, config, resolver=None):
    from .promotion_prices import PriceResolver, context_store
    resolver = resolver or PriceResolver(config, context_store(user))
    resolved = resolver.resolve(document)
    data = document.data
    cost = decimal(data.get('cost'))
    markup = decimal(data.get('markup', config['markup']))
    manual = bool(data.get('manualPrice'))
    promotion = promotion_amount(data)
    private = user.profile.role != 'cashier'
    return {
        'id': document.path.split('/', 1)[1], 'revision': revision(document, config),
        'referenceIds': reference_bindings(data),
        **{key: str(data.get(key) or ('шт' if key == 'unit' else '')) for key in TEXT_FIELDS},
        'cost': format(cost, 'f') if private else None,
        'markup': format(markup, 'f') if private else None,
        'price': format(decimal(data.get('price')), 'f') if manual else None,
        'regularPrice': resolved['regularPrice'],
        'promotionPrice': format(promotion, 'f') if promotion is not None else None,
        'salePrice': resolved['salePrice'],
        'manualPrice': manual, 'promotion': bool(data.get('promotion')), **resolved,
        'priceAt': price_date(data.get('priceAt')), 'minStock': format(decimal(data.get('minStock')), 'f'),
    }


def reference_bindings(data):
    from .catalog_references import FIELDS, legacy_item
    stored = data.get('referenceIds') if isinstance(data.get('referenceIds'), dict) else {}
    bindings = {}
    for field in FIELDS:
        text = data.get(field) or ('шт' if field == 'unit' else '')
        if not isinstance(text, str) or not text: continue
        identifier = stored.get(field)
        parent = data.get('type', '') if field == 'category' else ''
        parent = parent if isinstance(parent, str) else ''
        bindings[field] = identifier if isinstance(identifier, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,120}', identifier) else legacy_item(field, text, parent)['id']
    return bindings


def base_query():
    return Document.objects.filter(path__startswith='products/').filter(Q(data__hidden__isnull=True) | ~Q(data__hidden=True))


def list_products(request, user):
    from .views import response
    try:
        page = int(request.GET.get('page', 1)); limit = int(request.GET.get('limit', 20))
    except ValueError:
        return response({'error': 'Некоректна сторінка.', 'code': 'invalid_page'}, 400)
    require(page >= 1 and limit in {10, 20, 50}, 'Некоректна сторінка або розмір списку.')
    query = base_query()
    words = request.GET.get('q', '').strip()[:250].split()
    for word in words:
        query = query.filter(Q(data__name__icontains=word) | Q(data__barcode__icontains=word))
    promotion = request.GET.get('promotion', '')
    require(promotion in {'', 'yes', 'no'}, 'Некоректний фільтр акції.')
    from .promotion_prices import PriceResolver, context_store
    config = defaults()
    resolver = PriceResolver(config, context_store(user, request.GET.get('store')))
    if promotion:
        matched = [d.pk for d in query if bool(resolver.resolve(d)['effectivePromotion']) == (promotion == 'yes')]
        query = query.filter(pk__in=matched)
    # Each following choice is constrained by its parents, never by itself.
    facets = {}
    for key in ('type', 'category', 'pack'):
        values = query.order_by().values_list('data__' + key, flat=True).distinct()
        facets[key] = sorted({str(value) for value in values if value}, key=str.casefold)
        selected = request.GET.get(key, '')
        require(len(selected) <= 160, 'Значення фільтра задовге.')
        if selected: query = query.filter(**{'data__' + key: selected})
    count = query.count()
    pages = max(1, (count + limit - 1) // limit)
    page = min(page, pages)
    documents = query.order_by('data__type', 'data__category', 'data__name', 'path')[(page - 1) * limit:page * limit]
    config = defaults()
    return response({'items': [serialize(document, user, config, resolver=resolver) for document in documents],
        'total': count, 'page': page, 'pages': pages, 'limit': limit, 'facets': facets,
        'canEdit': user.profile.role in EDIT_ROLES, 'defaultMarkup': format(config['markup'], 'f')})


@transaction.atomic
def save_product(request, user, identifier=None):
    from .views import body, response
    require(user.profile.role in EDIT_ROLES, 'Недостатньо прав для редагування товарів.')
    ledger_lock()  # Same serialization boundary as legacy import and ERP posting.
    value = body(request)
    config = defaults()
    if 'pricingRevision' in value and (not isinstance(value['pricingRevision'], str) or value['pricingRevision'] != pricing_revision(config)):
        return response({'error': 'Налаштування ціни вже змінено. Оновіть попередній розрахунок перед збереженням.', 'code': 'pricing_revision_conflict'}, 409)
    if identifier:
        document = Document.objects.filter(pk='products/' + identifier).first()
        if document is None: return response({'error': 'Товар не знайдено.', 'code': 'not_found'}, 404)
        if not isinstance(value.get('revision'), str) or value['revision'] != revision(document, config):
            return response({'error': 'Товар уже змінено з іншого пристрою. Оновіть дані перед збереженням.', 'code': 'revision_conflict'}, 409)
        data = dict(document.data)
    else:
        identifier = secrets.token_urlsafe(18).replace('-', '_')
        document = Document(path='products/' + identifier)
        data = new_product_data(config)
    require(not (set(value) - PRODUCT_FIELDS - {'revision', 'pricingRevision'}), 'Запит містить невідомі поля товару.')
    if request.method == 'DELETE':
        from .models import VoucherLine, StockLot, PromotionPrice
        require(not PromotionPrice.objects.filter(product=document).exists(), 'Товар використовується в історії акцій. Приховайте його замість видалення.')
        require(not VoucherLine.objects.filter(product=document).exists() and not StockLot.objects.filter(product=document).exists(), 'Товар уже використовується в обліку. Його не можна видалити.')
        require(not any(any(str(row.get('product')) == identifier for row in item.data.get('recipe', [])) for item in Document.objects.filter(path__startswith='products/')), 'Товар використовується у рецептурі.')
        subject = document.path; document.delete(); audit(user, 'catalog_changed', subject, {'method': 'DELETE', 'contract': 'v1'})
        return response({'ok': True})
    old = dict(data)
    data = normalise_product({key: item for key, item in value.items() if key not in {'revision', 'pricingRevision'}}, old, document.path, config=config, old_config=config)
    if duplicate_name(data, old, document.path): return response(DUPLICATE_NAME, 409)
    from .promotion_history import observe_prices
    if old.get('name'):observe_prices(user,[document],'catalog','Редагування товару',seed=True)
    document.data = data; document.save()
    observe_prices(user,[document],'catalog','Редагування товару')
    audit(user, 'catalog_changed', document.path, {'method': request.method, 'contract': 'v1'})
    from .promotion_prices import PriceResolver, context_store
    return response(serialize(document, user, config, resolver=PriceResolver(config, context_store(user, request.GET.get('store')))), 200 if old.get('name') else 201)


def unit_in_use(path, data):
    """Why the base unit is fixed: stock quantities and recipes are counted in it. None when it is still free."""
    from .models import VoucherLine, StockLot
    if VoucherLine.objects.filter(product_id=path).exists() or StockLot.objects.filter(product_id=path).exists():
        return 'товар уже є в облікових документах або на складі'
    if data.get('recipe'):
        return 'для товару задано рецептуру'
    identifier = path.split('/', 1)[1]
    recipes = Document.objects.filter(path__startswith='products/').exclude(pk=path).values_list('data', flat=True)
    if any(isinstance(item, dict) and isinstance(item.get('recipe'), list) and any(isinstance(row, dict) and str(row.get('product')) == identifier for row in item['recipe']) for item in recipes):
        return 'товар використовується як інгредієнт у рецептурі'
    return None


def normalise_product(value, old, path, *, validate_references=True, config=None, old_config=None, references=None, bind_references=True):
    """One strict write validator shared by the editor and atomic legacy imports."""
    from .views import validate_product
    require(isinstance(value, dict) and not (set(value) - PRODUCT_FIELDS), 'Запит містить невідомі поля товару.')
    data = dict(old)
    for key, maximum in TEXT_FIELDS.items():
        if key in value:
            require(isinstance(value[key], str) and len(value[key].strip()) <= maximum, f'{key}: некоректний текст.')
            data[key] = value[key].strip()
    def guard_unit():
        # Give the accounting constraint before an unrelated picker error, and recheck canonical aliases.
        if old.get('name') and (data.get('unit') or 'шт') != (old.get('unit') or 'шт'):
            reason = unit_in_use(path, old)
            require(reason is None, f'Одиницю обліку «{old.get("unit") or "шт"}» змінити не можна: {reason}. Для іншої фасовки створіть окремий товар.')
    guard_unit()
    from .catalog_references import reference_records
    references = reference_records() if references is None and (validate_references or bind_references) else references
    if validate_references:
        from .catalog_references import validate_reference_fields
        validate_reference_fields(data, old, creating=not bool(old.get('name')), references=references)
    if 'minStock' in value: data['minStock'] = float(dec(value['minStock'], 'Мінімальний залишок', Decimal('.001')))
    for key in ('cost', 'markup', 'price', 'promotionPrice'):
        if key in value:
            if key in {'price', 'promotionPrice'} and value[key] is None: data[key] = None
            else:
                number = dec(value[key], key, Decimal('.0001') if key == 'markup' else Decimal('.01'))
                require(number <= Decimal('99999999.99'), 'Число завелике.')
                # Explicit compatibility adapter: existing document consumers expect numbers.
                data[key] = float(number)
    for key in ('manualPrice', 'promotion', 'priceReviewed'):
        if key in value:
            require(isinstance(value[key], bool), f'{key}: очікується логічне значення.')
            if key != 'priceReviewed': data[key] = value[key]
    require(not data.get('manualPrice') or decimal(data.get('price')) > 0, 'Ручна ціна має бути більшою за нуль.')
    # Clear a calculated product's price only when asked to; absent and null mean the same.
    if not data.get('manualPrice') and data.get('price') is not None and {'manualPrice', 'price'} & set(value): data['price'] = None
    if 'priceAt' in value:
        require(isinstance(value['priceAt'], str), 'Некоректна дата ціни.')
        if value['priceAt']:
            require(PRICE_DATE.fullmatch(value['priceAt']), 'Вкажіть дату у форматі РРРР-ММ-ДД.')
            reviewed = day(value['priceAt']); require(reviewed <= timezone.localdate(), 'Дата ціни не може бути в майбутньому.')
        data['priceAt'] = value['priceAt']
    old_config = defaults() if old_config is None else old_config
    config = old_config if config is None else config
    def price_terms(item, pricing):
        manual = bool(item.get('manualPrice'))
        return (decimal(item.get('cost')), decimal(item.get('markup', pricing['markup'])), manual, decimal(item.get('price')) if manual else Decimal(0), bool(item.get('promotion')), promotion_amount(item))
    # A legacy badge-only record can receive metadata edits without inventing an old
    # price. New promotions and pricing changes require an explicit discount.
    pricing_changed = price_terms(old, old_config) != price_terms(data, config) or regular_price(old, old_config) != regular_price(data, config)
    if data.get('promotion') and data.get('promotionPrice') is None:
        require(bool(old.get('promotion')) and old.get('promotionPrice') is None and not pricing_changed, 'Вкажіть акційну ціну, меншу за звичайну.')
    if value.get('priceReviewed') or pricing_changed:
        data['priceAt'] = timezone.localdate().isoformat()
    # Unchanged price terms keep an existing discount editable after an older settings change.
    validate_product(data, path, config, check_promotion=pricing_changed or bool(value.get('priceReviewed')))
    require(not data.get('barcode') or not Document.objects.filter(path__startswith='products/').exclude(pk=path).filter(data__barcode=data['barcode']).exists(), 'Цей штрихкод уже використовується.')
    from .catalog_references import bind_reference_fields
    if bind_references and (data != old or not old.get('name')):
        bind_reference_fields(data, old, references=references)
    guard_unit()
    return data


def normalise_legacy(value, old, path):
    """Legacy /api/docs writes: only the sent keys change, with the v1 rules and free-text choices."""
    # The old portal clears text and the review date with null; v1 stores an empty string.
    if 'referenceIds' in value:
        require(value['referenceIds'] == old.get('referenceIds', {}), 'ID довідників визначає сервер; їх не можна змінювати вручну.')
        value = {key: item for key, item in value.items() if key != 'referenceIds'}
    value = {key: '' if item is None and (key in TEXT_FIELDS or key == 'priceAt') else item for key, item in value.items()}
    return normalise_product(value, dict(old), path, validate_references=False)


def handle_catalog(request, user):
    from .views import response
    path = request.path.rstrip('/')
    collection = '/api/v1/catalog/products'
    if path in {'/api/v1/catalog/references/manage', '/api/v1/catalog/references/preview', '/api/v1/catalog/references/commit'}:
        from .catalog_reference_management import handle
        return handle(request, user)
    if path in {'/api/v1/catalog/pricing/preview', '/api/v1/catalog/pricing/commit'} and request.method == 'POST':
        from .catalog_pricing import preview_pricing, commit_pricing
        return preview_pricing(request, user) if path.endswith('/preview') else commit_pricing(request, user)
    if path in {'/api/v1/catalog/import/preview', '/api/v1/catalog/import/commit'} and request.method == 'POST':
        from .catalog_import import preview_import, commit_import
        return preview_import(request, user) if path.endswith('/preview') else commit_import(request, user)
    if path == '/api/v1/catalog/references':
        from .catalog_references import get_references, create_reference
        if request.method == 'GET': return get_references(user)
        if request.method == 'POST': return create_reference(request, user)
    if path == '/api/v1/session' and request.method == 'GET':
        return response({'role': user.profile.role, 'csrf': request.portal_session.csrf})
    if path == collection + '/price-preview' and request.method == 'POST':
        from .catalog_price_preview import preview_product_price
        return preview_product_price(request, user)
    if path == collection:
        if request.method == 'GET': return list_products(request, user)
        if request.method == 'POST': return save_product(request, user)
    match = re.fullmatch(re.escape(collection) + r'/([A-Za-z0-9_-]{1,120})', path)
    if match:
        if request.method == 'GET':
            document = base_query().filter(pk='products/' + match[1]).first()
            if not document: return response({'error': 'Товар не знайдено.', 'code': 'not_found'}, 404)
            from .promotion_prices import PriceResolver, context_store
            config=defaults()
            return response(serialize(document, user, config, resolver=PriceResolver(config, context_store(user, request.GET.get('store')))))
        if request.method in {'PATCH', 'DELETE'}: return save_product(request, user, match[1])
    return response({'error': 'Метод або маршрут не підтримується.', 'code': 'unsupported_route'}, 405)
