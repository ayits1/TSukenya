"""Versioned catalogue boundary over existing documents; posting remains in ERP services."""
import hashlib
import hmac
from django.conf import settings
import json
import re
import secrets
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_HALF_UP
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from .models import Document
from .services import require, dec, day, ledger_lock, audit

EDIT_ROLES = {'owner', 'manager', 'warehouse'}
TEXT_FIELDS = {'name': 250, 'type': 160, 'category': 160, 'pack': 160, 'size': 160, 'unit': 30, 'barcode': 80}
PRICE_FIELDS = {'cost', 'markup', 'price', 'manualPrice', 'promotionPrice'}


def revision(document, config=None):
    config = defaults() if config is None else config
    material = {'path': document.path, 'data': document.data,
        'pricing': {key: str(value) for key, value in config.items()}}
    return hmac.new(settings.SECRET_KEY.encode(), json.dumps(material, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()


def defaults():
    document = Document.objects.filter(pk='settings/main').first()
    data = document.data if document else {}
    return {'markup': decimal(data.get('defaultMarkup', 30)), 'rounding': decimal(data.get('rounding', .5))}


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


def serialize(document, user, config):
    data = document.data
    cost = decimal(data.get('cost'))
    markup = decimal(data.get('markup', config['markup']))
    manual = bool(data.get('manualPrice'))
    regular = regular_price(data, config)
    promotion = promotion_amount(data)
    price = promotion if data.get('promotion') and promotion is not None and 0 < promotion < regular else regular
    private = user.profile.role != 'cashier'
    return {
        'id': document.path.split('/', 1)[1], 'revision': revision(document, config),
        **{key: str(data.get(key) or ('шт' if key == 'unit' else '')) for key in TEXT_FIELDS},
        'cost': format(cost, 'f') if private else None,
        'markup': format(markup, 'f') if private else None,
        'price': format(decimal(data.get('price')), 'f') if manual else None,
        'regularPrice': format(regular, 'f'),
        'promotionPrice': format(promotion, 'f') if promotion is not None else None,
        'salePrice': format(price, 'f'),
        'manualPrice': manual, 'promotion': bool(data.get('promotion')),
        'priceAt': str(data.get('priceAt') or ''), 'minStock': format(decimal(data.get('minStock')), 'f'),
    }


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
    if promotion == 'yes': query = query.filter(data__promotion=True)
    if promotion == 'no': query = query.filter(Q(data__promotion__isnull=True) | ~Q(data__promotion=True))
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
    return response({'items': [serialize(document, user, config) for document in documents],
        'total': count, 'page': page, 'pages': pages, 'limit': limit, 'facets': facets,
        'canEdit': user.profile.role in EDIT_ROLES, 'defaultMarkup': format(config['markup'], 'f')})


@transaction.atomic
def save_product(request, user, identifier=None):
    from .views import body, response, validate_product
    require(user.profile.role in EDIT_ROLES, 'Недостатньо прав для редагування товарів.')
    ledger_lock()  # Same serialization boundary as legacy import and ERP posting.
    value = body(request)
    if identifier:
        document = Document.objects.filter(pk='products/' + identifier).first()
        if document is None: return response({'error': 'Товар не знайдено.', 'code': 'not_found'}, 404)
        if not isinstance(value.get('revision'), str) or value['revision'] != revision(document):
            return response({'error': 'Товар уже змінено з іншого пристрою. Оновіть дані перед збереженням.', 'code': 'revision_conflict'}, 409)
        data = dict(document.data)
    else:
        identifier = secrets.token_urlsafe(18).replace('-', '_')
        document = Document(path='products/' + identifier)
        data = {'unit': 'шт', 'markup': float(defaults()['markup']), 'cost': 0, 'manualPrice': False, 'price': None}
    allowed = set(TEXT_FIELDS) | PRICE_FIELDS | {'promotion', 'priceAt', 'revision', 'priceReviewed', 'minStock'}
    require(not (set(value) - allowed), 'Запит містить невідомі поля товару.')
    if request.method == 'DELETE':
        from .models import VoucherLine, StockLot
        require(not VoucherLine.objects.filter(product=document).exists() and not StockLot.objects.filter(product=document).exists(), 'Товар уже використовується в обліку. Його не можна видалити.')
        require(not any(any(str(row.get('product')) == identifier for row in item.data.get('recipe', [])) for item in Document.objects.filter(path__startswith='products/')), 'Товар використовується у рецептурі.')
        subject = document.path; document.delete(); audit(user, 'catalog_changed', subject, {'method': 'DELETE', 'contract': 'v1'})
        return response({'ok': True})
    old = dict(data)
    for key, maximum in TEXT_FIELDS.items():
        if key in value:
            require(isinstance(value[key], str) and len(value[key].strip()) <= maximum, f'{key}: некоректний текст.')
            data[key] = value[key].strip()
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
    if not data.get('manualPrice'): data['price'] = None
    if 'priceAt' in value:
        require(isinstance(value['priceAt'], str), 'Некоректна дата ціни.')
        if value['priceAt']:
            reviewed = day(value['priceAt']); require(reviewed <= timezone.localdate(), 'Дата ціни не може бути в майбутньому.')
        data['priceAt'] = value['priceAt']
    config = defaults()
    def price_terms(item):
        manual = bool(item.get('manualPrice'))
        return (decimal(item.get('cost')), decimal(item.get('markup', config['markup'])), manual, decimal(item.get('price')) if manual else Decimal(0), bool(item.get('promotion')), promotion_amount(item))
    # A legacy badge-only record can receive metadata edits without inventing an old
    # price. New promotions and pricing changes require an explicit discount.
    if data.get('promotion') and data.get('promotionPrice') is None:
        require(bool(old.get('promotion')) and old.get('promotionPrice') is None and price_terms(old) == price_terms(data), 'Вкажіть акційну ціну, меншу за звичайну.')
    if value.get('priceReviewed') or price_terms(old) != price_terms(data):
        data['priceAt'] = timezone.localdate().isoformat()
    validate_product(data, document.path)
    require(not data.get('barcode') or not Document.objects.filter(path__startswith='products/').exclude(pk=document.pk).filter(data__barcode=data['barcode']).exists(), 'Цей штрихкод уже використовується.')
    document.data = data; document.save()
    audit(user, 'catalog_changed', document.path, {'method': request.method, 'contract': 'v1'})
    return response(serialize(document, user, defaults()), 200 if old.get('name') else 201)


def handle_catalog(request, user):
    from .views import response
    path = request.path.rstrip('/')
    collection = '/api/v1/catalog/products'
    if path == '/api/v1/session' and request.method == 'GET':
        return response({'role': user.profile.role, 'csrf': request.portal_session.csrf})
    if path == collection:
        if request.method == 'GET': return list_products(request, user)
        if request.method == 'POST': return save_product(request, user)
    match = re.fullmatch(re.escape(collection) + r'/([A-Za-z0-9_-]{1,120})', path)
    if match:
        if request.method == 'GET':
            document = base_query().filter(pk='products/' + match[1]).first()
            if not document: return response({'error': 'Товар не знайдено.', 'code': 'not_found'}, 404)
            return response(serialize(document, user, defaults()))
        if request.method in {'PATCH', 'DELETE'}: return save_product(request, user, match[1])
    return response({'error': 'Метод або маршрут не підтримується.', 'code': 'unsupported_route'}, 405)
