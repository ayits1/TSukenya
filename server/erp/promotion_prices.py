"""Single effective-price rule for current catalogue, discounts and print proofs."""
from datetime import date
from zoneinfo import ZoneInfo
from django.db.models import Q
from django.utils import timezone
from .models import PromotionPrice, Store
from .services import require


def kyiv_day():
    return timezone.localdate(timezone=ZoneInfo('Europe/Kyiv'))


def context_store(user, value=None):
    """None is the network context; label store names never identify ERP stores."""
    own = user.profile.store_id
    if value is None or value == '':
        return Store.objects.filter(pk=own).first() if own is not None else None
    require(type(value) is int or isinstance(value, str) and value.isascii() and value.isdigit(), 'Некоректний магазин ціни.')
    identifier = int(value)
    require(0 < identifier <= 9223372036854775807 and (own is None or identifier == own), 'Немає доступу до ціни цього магазину.')
    store = Store.objects.filter(pk=identifier, active=True).first()
    require(store is not None, 'Магазин ціни відсутній або неактивний.')
    return store


class PriceResolver:
    def __init__(self, config=None, store=None, effective_day=None, *, product_paths=None):
        from .catalog import defaults
        self.config = defaults() if config is None else config
        self.store = store
        self.day = kyiv_day() if effective_day is None else effective_day
        require(isinstance(self.day, date), 'Некоректна дата визначення ціни.')
        area = Q(campaign__scope='network')
        if store is not None:
            area |= Q(campaign__scope='stores', campaign__stores=store.pk)
        # One SQL statement reads campaign terms and amounts together: no header/price prefetch race.
        prices = PromotionPrice.objects.filter(area, campaign__active=True, campaign__archived=False,
            campaign__starts_on__lte=self.day, campaign__ends_on__gte=self.day).select_related('campaign').distinct()
        if product_paths is not None:
            prices = prices.filter(product_id__in=set(product_paths))
        self.candidates = {}
        for item in prices:
            campaign = item.campaign
            self.candidates.setdefault(item.product_id, []).append((item.price, str(campaign.pk), campaign))

    def resolve(self, document):
        from .catalog import regular_price, promotion_amount
        from .labels import sign
        regular = regular_price(document.data, self.config)
        candidates = []
        legacy = promotion_amount(document.data)
        if document.data.get('promotion') and legacy is not None and 0 < legacy < regular:
            candidates.append((legacy, '0:legacy', {'source': 'legacy', 'id': None, 'name': 'Акція товару',
                'price': format(legacy, 'f'), 'startsOn': None, 'endsOn': None, 'revision': None}))
        for amount, identifier, campaign in self.candidates.get(document.path, []):
            if 0 < amount < regular:
                candidates.append((amount, '1:' + identifier, {'source': 'campaign', 'id': identifier,
                    'name': campaign.name, 'price': format(amount, 'f'), 'startsOn': campaign.starts_on.isoformat(),
                    'endsOn': campaign.ends_on.isoformat(), 'revision': campaign.revision}))
        selected = min(candidates, key=lambda item: (item[0], item[1])) if candidates else None
        terms = {'regularPrice': format(regular, 'f'), 'salePrice': format(selected[0] if selected else regular, 'f'),
                 'effectivePromotion': selected[2] if selected else None}
        return {**terms, 'effectiveDay': self.day.isoformat(), 'priceContext': {'storeId': self.store.pk if self.store else None,
                'storeName': self.store.name if self.store else None},
                'effectivePriceRevision': sign({'terms': terms, 'day': self.day.isoformat(), 'store': self.store.pk if self.store else None})}
