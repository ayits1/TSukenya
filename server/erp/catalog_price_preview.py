"""Read-only editor pricing using exactly the product write validator and Decimal formula."""
import re
from decimal import Decimal
from .catalog import (EDIT_ROLES, defaults, new_product_data, normalise_product, plain,
                      pricing_revision, promotion_amount, regular_price, revision, sale_price)
from .models import Document
from .services import require

PRICE_INPUTS = {'cost', 'markup', 'manualPrice', 'price', 'promotion', 'promotionPrice', 'priceReviewed'}


def preview_product_price(request, user):
    from .views import body, response
    require(user.profile.role in EDIT_ROLES, 'Недостатньо прав для редагування товарів.')
    value = body(request)
    require(not (set(value) - PRICE_INPUTS - {'id', 'revision'}), 'Запит містить невідомі поля ціни.')
    config = defaults()
    if 'id' in value:
        require(isinstance(value['id'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,120}', value['id']), 'Некоректний ID товару.')
        document = Document.objects.filter(pk='products/' + value['id']).first()
        if document is None:
            return response({'error': 'Товар не знайдено.', 'code': 'not_found'}, 404)
        if 'revision' in value and (not isinstance(value['revision'], str) or value['revision'] != revision(document, config)):
            return response({'error': 'Товар уже змінено з іншого пристрою. Оновіть дані перед розрахунком.', 'code': 'revision_conflict'}, 409)
        old, path = dict(document.data), document.path
        fields = {key: item for key, item in value.items() if key in PRICE_INPUTS}
    else:
        require('revision' not in value, 'Версія товару потребує ID.')
        old, path = new_product_data(config), 'products/__price_preview__'
        fields = {'name': 'Попередній розрахунок', **value}
    data = normalise_product(fields, old, path, validate_references=False, bind_references=False, config=config, old_config=config)
    regular = regular_price(data, config)
    promotion = promotion_amount(data)
    valid = bool(data.get('promotion') and promotion is not None and 0 < promotion < regular)
    warnings = []
    if data.get('promotion') and not valid:
        warnings.append('Збережена акція не має чинної акційної ціни. Застосовується звичайна ціна; для зміни умов вкажіть акційну ціну.')
    return response({'regularPrice': format(regular, 'f'), 'salePrice': format(sale_price(data, config), 'f'),
        'config': {'markup': plain(config['markup']), 'rounding': plain(config['rounding'] if config['rounding'] > 0 else Decimal('.5'))},
        'pricingRevision': pricing_revision(config), 'warnings': warnings, 'promotionValid': valid})
