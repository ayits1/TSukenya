"""Owner-managed period/store campaigns; effective pricing is a separate read-only resolver."""
import hashlib
import json
import re
import uuid
from decimal import Decimal
from django.db import transaction
from .models import Document, PromotionCampaign, PromotionPrice, PriceChange, Store
from .promotion_prices import context_store, kyiv_day
from .promotion_history import observe_prices
from .services import audit, day, dec, ledger_lock, require

FIELDS = {'name', 'startsOn', 'endsOn', 'active', 'scope', 'stores', 'prices', 'reason'}


def campaign_json(campaign):
    today = kyiv_day()
    status = 'archived' if campaign.archived else 'disabled' if not campaign.active else 'scheduled' if today < campaign.starts_on else 'expired' if today > campaign.ends_on else 'active'
    return {'id': str(campaign.pk), 'name': campaign.name, 'startsOn': campaign.starts_on.isoformat(),
        'endsOn': campaign.ends_on.isoformat(), 'active': campaign.active, 'archived': campaign.archived,
        'scope': campaign.scope, 'stores': list(campaign.stores.order_by('pk').values_list('pk', flat=True)),
        'prices': [{'product': item.product_id.split('/', 1)[1], 'name': str(item.product.data.get('name') or ''),
                    'price': format(item.price, 'f')} for item in campaign.prices.select_related('product').order_by('product_id')],
        'reason': campaign.reason, 'revision': campaign.revision, 'status': status, 'author': campaign.author.username}


def validate(value):
    from .catalog import base_query, regular_price
    require(isinstance(value.get('name'), str) and 0 < len(value['name'].strip()) <= 160, 'Вкажіть назву акції до 160 символів.')
    require(isinstance(value.get('reason'), str) and 0 < len(value['reason'].strip()) <= 500, 'Вкажіть причину зміни акції до 500 символів.')
    require(all(isinstance(value.get(key), str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value[key]) for key in ('startsOn', 'endsOn')), 'Вкажіть початок і закінчення акції.')
    starts, ends = day(value['startsOn']), day(value['endsOn'])
    require(starts <= ends, 'Закінчення акції не може бути раніше початку.')
    require(type(value.get('active')) is bool, 'Некоректний стан акції.')
    require(value.get('scope') in {'network', 'stores'}, 'Виберіть мережу або магазини.')
    stores = value.get('stores')
    require(isinstance(stores, list) and len(stores) <= 100 and all(type(item) is int and 0 < item <= 9223372036854775807 for item in stores) and len(set(stores)) == len(stores), 'Некоректний список магазинів.')
    require(not stores if value['scope'] == 'network' else bool(stores), 'Для всієї мережі магазини не вибираються; для магазинної акції оберіть магазин.')
    require(Store.objects.filter(pk__in=stores, active=True).count() == len(stores), 'Деякі магазини відсутні або неактивні.')
    prices = value.get('prices')
    require(isinstance(prices, list) and 0 < len(prices) <= 1000, 'Оберіть від 1 до 1000 товарів акції.')
    identifiers = []
    amounts = []
    for row in prices:
        require(isinstance(row, dict) and set(row) == {'product', 'price'}, 'Некоректний рядок акції.')
        require(isinstance(row['product'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,120}', row['product']), 'Некоректний товар акції.')
        require(isinstance(row['price'], str) and len(row['price'])<=11 and re.fullmatch(r'[0-9]+(?:\.[0-9]{1,2})?', row['price']), 'Акційна ціна має бути десятковим рядком до двох знаків.')
        amount = dec(row['price'], 'Акційна ціна', minimum=Decimal('.01'))
        require(amount <= Decimal('99999999.99'), 'Акційна ціна завелика.')
        identifiers.append(row['product']); amounts.append(amount)
    require(len(set(identifiers)) == len(identifiers), 'Товар повторюється в акції.')
    products = {item.path.split('/', 1)[1]: item for item in base_query().filter(pk__in=['products/' + identifier for identifier in identifiers])}
    require(len(products) == len(identifiers), 'Деякі товари відсутні або приховані.')
    for identifier, amount in zip(identifiers, amounts):
        require(amount < regular_price(products[identifier].data), 'Акційна ціна має бути меншою за звичайну.')
    return starts, ends, stores, [(products[identifier], amount) for identifier, amount in zip(identifiers, amounts)]


@transaction.atomic
def save_campaign(request, user, identifier=None):
    from .views import body, response
    require(user.profile.role == 'owner' and user.profile.store_id is None, 'Акціями мережі керує власник із мережевим доступом.')
    ledger_lock()
    value = body(request)
    require(set(value) == FIELDS | ({'revision'} if identifier else {'idempotencyKey'}), 'Некоректні параметри акції.')
    if identifier is None:
        require(isinstance(value['idempotencyKey'], str) and re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', value['idempotencyKey']), 'Ключ створення акції має бути UUID.')
        identifier = uuid.UUID(value['idempotencyKey'])
        fingerprint = hashlib.sha256(json.dumps({key: value[key] for key in sorted(FIELDS)}, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        campaign = PromotionCampaign.objects.filter(pk=identifier).first()
        if campaign:
            if campaign.author_id != user.pk or campaign.request_fingerprint != fingerprint:
                return response({'error': 'Ключ створення вже використано для іншої акції.', 'code': 'idempotency_conflict'}, 409)
            if campaign.revision != 1 or campaign.archived:
                return response({'error': 'Акцію вже створено й змінено. Перегляньте її актуальний стан.', 'code': 'create_changed', 'id': str(campaign.pk)}, 409)
            return response(campaign_json(campaign))
    else:
        campaign = PromotionCampaign.objects.filter(pk=identifier).first()
        require(campaign is not None, 'Акцію не знайдено.')
        if type(value['revision']) is not int or value['revision'] != campaign.revision:
            return response({'error': 'Акцію вже змінено. Чернетку збережено; відкрийте актуальні умови.', 'code': 'revision_conflict'}, 409)
        require(not campaign.archived, 'Архівну акцію не можна редагувати.')
    starts, ends, stores, rows = validate(value)
    old = campaign_json(campaign) if campaign else None
    paths = {item.path for item, _ in rows} | ({item.product_id for item in campaign.prices.all()} if campaign else set())
    products = list(Document.objects.filter(pk__in=paths))
    observe_prices(user, products, 'campaign', value['reason'], seed=True)
    if campaign is None:
        campaign = PromotionCampaign(id=identifier, author=user, request_fingerprint=fingerprint)
    else:
        campaign.revision += 1
    campaign.name = value['name'].strip(); campaign.reason = value['reason'].strip()
    campaign.starts_on = starts; campaign.ends_on = ends; campaign.active = value['active']; campaign.scope = value['scope']
    campaign.save(); campaign.stores.set(stores)
    campaign.prices.all().delete()
    PromotionPrice.objects.bulk_create([PromotionPrice(campaign=campaign, product=product, price=amount) for product, amount in rows])
    current = campaign_json(campaign)
    audit(user, 'promotion_changed', 'campaigns/' + str(campaign.pk), {'before': old, 'after': current, 'source': 'campaign', 'reason': campaign.reason})
    observe_prices(user, products, 'campaign', campaign.reason)
    return response(current)


@transaction.atomic
def archive_campaign(request, user, identifier):
    from .views import body, response
    require(user.profile.role == 'owner' and user.profile.store_id is None, 'Акціями мережі керує власник із мережевим доступом.')
    ledger_lock(); value = body(request)
    require(set(value) == {'revision', 'reason'} and isinstance(value['reason'], str) and 0 < len(value['reason'].strip()) <= 500, 'Вкажіть причину архівування.')
    campaign = PromotionCampaign.objects.filter(pk=identifier).first()
    require(campaign is not None, 'Акцію не знайдено.')
    if type(value['revision']) is not int or value['revision'] != campaign.revision:
        return response({'error': 'Акцію вже змінено. Оновіть дані перед архівуванням.', 'code': 'revision_conflict'}, 409)
    old = campaign_json(campaign); products = [item.product for item in campaign.prices.select_related('product')]
    observe_prices(user, products, 'campaign_archive', value['reason'], seed=True)
    campaign.archived = True; campaign.active = False; campaign.revision += 1; campaign.reason = value['reason'].strip()
    campaign.save()
    current = campaign_json(campaign)
    audit(user, 'promotion_archived', 'campaigns/' + str(campaign.pk), {'before': old, 'after': current, 'reason': campaign.reason})
    observe_prices(user, products, 'campaign_archive', campaign.reason)
    return response(current)


def handle_promotions(request, user):
    from .views import response
    path = request.path.rstrip('/')
    if path == '/api/v1/promotions/context' and request.method == 'GET':
        store = context_store(user, request.GET.get('store'))
        stores = Store.objects.filter(active=True).order_by('pk')
        if user.profile.store_id is not None: stores = stores.filter(pk=user.profile.store_id)
        return response({'storeId': store.pk if store else None, 'storeName': store.name if store else None,
            'effectiveDay': kyiv_day().isoformat(), 'stores': list(stores.values('id', 'name')),
            'canSelectNetwork': user.profile.store_id is None, 'canViewHistory': user.profile.role in {'owner','manager'}, 'canManage': user.profile.role == 'owner' and user.profile.store_id is None,
            'csrf': request.portal_session.csrf})
    if path == '/api/v1/promotions/history' and request.method == 'GET':
        require(user.profile.role in {'owner', 'manager'}, 'Журнал цін доступний власнику й керівнику.')
        store = context_store(user, request.GET.get('store'))
        records = PriceChange.objects.filter(store=store).select_related('author').order_by('-pk')
        identifier = request.GET.get('product')
        if identifier:
            require(re.fullmatch(r'[A-Za-z0-9_-]{1,120}', identifier), 'Некоректний товар.')
            records = records.filter(product_path='products/' + identifier)
        return response({'items': [{'id': row.pk, 'product': row.product_path.split('/', 1)[1],
            'storeId': row.store_id, 'before': row.before, 'after': row.after, 'author': row.author.username,
            'source': row.source, 'reason': row.reason, 'at': row.at.isoformat()} for row in records[:200]]})
    require(user.profile.role == 'owner' and user.profile.store_id is None, 'Акціями мережі керує власник із мережевим доступом.')
    if path == '/api/v1/promotions/campaigns':
        if request.method == 'GET': return response({'items': [campaign_json(item) for item in PromotionCampaign.objects.select_related('author').order_by('-created_at')[:200]]})
        if request.method == 'POST': return save_campaign(request, user)
    match = re.fullmatch(r'/api/v1/promotions/campaigns/([0-9a-f-]{36})', path)
    if match:
        try: identifier = uuid.UUID(match[1])
        except ValueError: require(False, 'Некоректний ID акції.')
        if request.method == 'PATCH': return save_campaign(request, user, identifier)
        if request.method == 'DELETE': return archive_campaign(request, user, identifier)
    return response({'error': 'Метод або маршрут не підтримується.', 'code': 'unsupported_route'}, 405)
