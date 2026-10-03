"""Versioned label settings and read-only, authoritative print snapshots."""
import hashlib
import hmac
import json
import math
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from .models import Document
from .services import require, ledger_lock, audit
from .catalog import base_query, defaults, serialize

FIELDS = {'promo', 'chain', 'store', 'custom', 'name', 'pack', 'psize', 'price', 'oldPrice', 'unit', 'per100', 'category', 'date'}
FLAGS = {'chain', 'store', 'name', 'nameBig', 'pack', 'psize', 'price', 'oldPrice', 'kop', 'unit', 'per100', 'category', 'date', 'customEnabled', 'promo'}


def sign(value):
    return hmac.new(settings.SECRET_KEY.encode(), json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()


def identity(data):
    names = data.get('storeNames', [])
    return {'chainName': str(data.get('chainName') or ''), 'storeNames': names if isinstance(names, list) else [], 'staleDays': data.get('staleDays', 30)}


def revision(data):
    return sign({'config': data.get('tag', {}), 'settings': identity(data)})


def workspace(user, csrf):
    document = Document.objects.filter(pk='settings/main').first()
    data = document.data if document else {}
    return {'config': data.get('tag', {}), 'settings': identity(data), 'revision': revision(data), 'canEdit': user.profile.role == 'owner', 'csrf': csrf}


def validate_config(value):
    require(isinstance(value, dict), 'Некоректний макет.')
    require(not (set(value) - FLAGS - {'size', 'border', 'storeIdx', 'custom', 'styles', 'styleVersion'}), 'Макет містить невідомі параметри.')
    require(value.get('styleVersion') == 2, 'Оновіть версію макета перед збереженням.')
    require(value.get('size') in {'s', 'm', 'l'}, 'Невідомий формат цінника.')
    require(value.get('border') in {'dash', 'solid', 'none'}, 'Невідомий тип рамки.')
    for key in FLAGS:
        if key == 'oldPrice' and key not in value: continue  # Existing v2 clients remain compatible.
        require(isinstance(value.get(key), bool), f'{key}: очікується логічне значення.')
    index = value.get('storeIdx')
    require(type(index) is int and 0 <= index <= 100, 'Некоректний магазин.')
    require(isinstance(value.get('custom'), str) and len(value['custom']) <= 40, 'Додатковий напис має бути до 40 символів.')
    styles = value.get('styles', {})
    require(isinstance(styles, dict) and not (set(styles) - FIELDS), 'Некоректні елементи макета.')
    import re
    for key, style in styles.items():
        require(isinstance(style, dict) and not (set(style) - {'font', 'size', 'color', 'weight', 'align'}), f'{key}: некоректне оформлення.')
        if 'font' in style: require(style['font'] in {'rubik', 'arial', 'georgia', 'courier'}, 'Невідомий шрифт.')
        if 'size' in style:
            size = style['size']
            require(type(size) in {int, float} and math.isfinite(size) and 5 <= size <= 72, 'Розмір шрифту має бути від 5 до 72 pt.')
        if 'color' in style: require(isinstance(style['color'], str) and bool(re.fullmatch(r'#[0-9a-fA-F]{6}', style['color'])), 'Некоректний колір.')
        if 'weight' in style: require(style['weight'] in {'400', '600', '700'}, 'Некоректна насиченість шрифту.')
        if 'align' in style: require(style['align'] in {'left', 'center', 'right'}, 'Некоректне вирівнювання.')
    return value


@transaction.atomic
def save_workspace(request, user):
    from .views import body, response
    require(user.profile.role == 'owner', 'Недостатньо прав. Макет може змінювати лише власник.')
    ledger_lock()
    value = body(request)
    require(set(value) == {'revision', 'config', 'settings'}, 'Некоректні поля запиту макета.')
    document = Document.objects.filter(pk='settings/main').first()
    data = dict(document.data) if document else {}
    if not isinstance(value['revision'], str) or value['revision'] != revision(data):
        return response({'error': 'Макет уже змінено в іншій вкладці. Чернетку збережено на екрані; завантажте актуальний макет перед повторним збереженням.', 'code': 'revision_conflict'}, 409)
    config = validate_config(value['config'])
    info = value['settings']
    require(isinstance(info, dict) and set(info) == {'chainName', 'storeNames', 'staleDays'}, 'Некоректні реквізити цінника.')
    require(isinstance(info['chainName'], str) and len(info['chainName']) <= 160, 'Назва мережі має бути до 160 символів.')
    require(isinstance(info['storeNames'], list) and len(info['storeNames']) <= 100 and all(isinstance(name, str) and len(name) <= 160 for name in info['storeNames']), 'Некоректний список магазинів.')
    require(type(info['staleDays']) is int and 1 <= info['staleDays'] <= 3650, 'Некоректний термін перевірки ціни.')
    require(config['storeIdx'] == 0 or config['storeIdx'] < len(info['storeNames']), 'Магазин відсутній у реквізитах макета.')
    from .budget import freeze_budget
    freeze_budget(data)
    data.update(info)
    data['tag'] = config
    Document.objects.update_or_create(pk='settings/main', defaults={'data': data})
    audit(user, 'label_layout_changed', 'settings/main', {'styleVersion': 2})
    return response(workspace(user, request.portal_session.csrf))


@transaction.atomic
def prepare(request, user):
    from .views import body, response
    # Freeze one consistent read with the same lock used by catalogue/pricing writes.
    ledger_lock()
    value = body(request)
    require(set(value) == {'selection'}, 'Некоректні параметри друку.')
    selection = value['selection']
    require(isinstance(selection, list) and 0 < len(selection) <= 1000, 'Оберіть товари для друку.')
    ids = []
    quantities = []
    for row in selection:
        require(isinstance(row, dict) and set(row) == {'id', 'quantity'}, 'Некоректний рядок друку.')
        require(isinstance(row['id'], str) and 0 < len(row['id']) <= 120, 'Некоректний товар.')
        require(type(row['quantity']) is int and 1 <= row['quantity'] <= 500, 'Кількість має бути від 1 до 500.')
        ids.append(row['id']); quantities.append(row['quantity'])
    require(len(set(ids)) == len(ids), 'Товар повторюється у списку друку.')
    require(sum(quantities) <= 1000, 'За один раз можна підготувати до 1000 цінників.')
    documents = {item.path.split('/', 1)[1]: item for item in base_query().filter(pk__in=['products/' + identifier for identifier in ids]).order_by('data__type', 'data__category', 'data__name', 'path')}
    require(len(documents) == len(ids), 'Деякі товари видалені або приховані. Оновіть вибір товарів.')
    quantities_by_id = dict(zip(ids, quantities))
    ids = list(documents)
    quantities = [quantities_by_id[identifier] for identifier in ids]
    selection = [{'id': identifier, 'quantity': quantities_by_id[identifier]} for identifier in ids]
    pricing = defaults()
    products = [serialize(documents[identifier], user, pricing) for identifier in ids]
    current = workspace(user, request.portal_session.csrf)
    date = timezone.localdate().isoformat()
    snapshot = sign({'workspace': current['revision'], 'date': date, 'selection': [{'id': item['id'], 'revision': item['revision'], 'quantity': quantity} for item, quantity in zip(products, quantities)]})
    return response({**current, 'products': products, 'selection': selection, 'date': date, 'snapshot': snapshot})


def handle_labels(request, user):
    from .views import response
    path = request.path.rstrip('/')
    if path == '/api/v1/labels/workspace':
        if request.method == 'GET': return response(workspace(user, request.portal_session.csrf))
        if request.method == 'PATCH': return save_workspace(request, user)
    if path == '/api/v1/labels/prepare' and request.method == 'POST': return prepare(request, user)
    return response({'error': 'Метод або маршрут не підтримується.', 'code': 'unsupported_route'}, 405)
