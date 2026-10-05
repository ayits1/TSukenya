"""Bounded, conservative v2 preview guard. Not a cashier-visible activity token.

All input reads belong to caller RR or the atomic ledger transaction. This binds
current catalogue inputs, including losing current campaign candidates, rather
than materializing products x store resolver outputs. Old preview tokens fail
the existing409 guard; immutable committed receipt replay still precedes it.
"""
import hashlib
import hmac
from django.conf import settings
from django.db.models import Q
from .catalog_import import canonical

SNAPSHOT_BATCH = 50
MAX_DOCUMENT_BYTES = 256 * 1024
MAX_CANDIDATE_BYTES = 16 * 1024 * 1024


def bounded_documents(query, *, limit=None, total_limit=None):
    """Full revision inputs, SQL guarded before decoding; not the scalar cap."""
    from django.db import connection
    from django.db.models import BinaryField, Case, F, Func, IntegerField, JSONField, TextField, Value, When
    from django.db.models.functions import Cast, Length
    from .models import Document
    from .services import require
    encoded = Cast('data', TextField())
    size = Func(encoded, function='octet_length', output_field=IntegerField()) if connection.vendor == 'postgresql' else Length(Cast(encoded, BinaryField()))
    projected = query.annotate(document_bytes=size).annotate(guarded_data=Case(When(document_bytes__lte=MAX_DOCUMENT_BYTES, then=F('data')), default=Value(None), output_field=JSONField())).values_list('path', 'guarded_data', 'document_bytes')
    if limit is not None: projected = projected[:limit]
    iterator = projected.iterator(chunk_size=SNAPSHOT_BATCH)
    retained = 0
    try:
        for path, data, count in iterator:
            require(data is not None, 'Повний запис каталогу перевищує ліміт 256 КіБ для перевіреного знімка цін.')
            retained += count
            require(total_limit is None or retained <= total_limit, 'Вибір цін перевищує ліміт 16 МіБ повних записів. Зменшіть вибір.')
            yield Document(path=path, data=data)
    finally:
        iterator.close()


def snapshot(documents, config, *, day=None):
    from .catalog import plain, revision
    from .promotion_prices import kyiv_day
    from .models import PromotionCampaign, PromotionPrice, Store
    day = day or kyiv_day()
    digest = hmac.new(settings.SECRET_KEY.encode(), digestmod=hashlib.sha256)
    def record(tag, value):
        encoded = canonical([tag, value]).encode()
        digest.update(len(encoded).to_bytes(8, 'big'))
        digest.update(encoded)
    record('version', 'catalogue-snapshot-v2')
    record('pricing', {key: plain(value) for key, value in config.items()})
    record('day', day.isoformat())
    iterator = bounded_documents(documents) if hasattr(documents, 'iterator') else iter(documents)
    try:
        for document in iterator: record('product', [document.path, revision(document, config)])
    finally:
        if hasattr(iterator, 'close'): iterator.close()
    for identifier in Store.objects.filter(active=True).order_by('pk').values_list('pk', flat=True).iterator(chunk_size=200):
        record('store', identifier)
    campaigns = PromotionCampaign.objects.filter(active=True, archived=False, starts_on__lte=day, ends_on__gte=day).filter(Q(scope='network') | Q(scope='stores', stores__active=True)).distinct()
    for item in campaigns.order_by('pk').values('id', 'name', 'scope', 'revision', 'starts_on', 'ends_on').iterator(chunk_size=200):
        record('campaign', {key: str(value) for key, value in item.items()})
    memberships = PromotionCampaign.stores.through.objects.filter(promotioncampaign_id__in=campaigns.values('pk'), store__active=True)
    for item in memberships.order_by('promotioncampaign_id', 'store_id').values_list('promotioncampaign_id', 'store_id').iterator(chunk_size=200):
        record('membership', [str(item[0]), item[1]])
    prices = PromotionPrice.objects.filter(campaign_id__in=campaigns.values('pk'), product__path__startswith='products/')
    for campaign, product, amount in prices.order_by('campaign_id', 'product_id', 'pk').values_list('campaign_id', 'product_id', 'price').iterator(chunk_size=200):
        record('amount', [str(campaign), product, str(amount)])
    return digest.hexdigest()
