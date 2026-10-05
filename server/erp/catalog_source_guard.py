"""Opaque conservative source guard in the caller's same RR/ledger snapshot.

Transactional product/ref counters cover direct/bulk/delete writes. Current
campaign headers/memberships/amounts, stores, config and frozen Kyiv day stream
into HMAC without product x store materialization. This is not a read cache or
public activity stamp. Exact committed request replay precedes a new guard.
"""
import hashlib
import hmac
import json
from django.conf import settings
from django.db.models import Q
from .models import StateVersion,Store,PromotionCampaign,PromotionPrice


def snapshot(config,*,day):
    from .catalog_budget import check
    from .catalog import plain
    signer=hmac.new(settings.SECRET_KEY.encode(),digestmod=hashlib.sha256)
    def frame(tag,value):
        check()
        encoded=json.dumps([tag,value],ensure_ascii=False,sort_keys=True,separators=(',',':'),default=str).encode()
        signer.update(len(encoded).to_bytes(8,'big'));signer.update(encoded)
    frame('version','catalogue-source-v3');frame('day',day.isoformat())
    frame('pricing',{key:plain(value) for key,value in config.items()})
    counters=dict(StateVersion.objects.filter(pk__in=('catalog','references')).values_list('key','revision'))
    frame('catalog',counters.get('catalog',0));frame('references',counters.get('references',0))
    for value in Store.objects.order_by('pk').values_list('pk','active').iterator(chunk_size=200):frame('store',value)
    campaigns=PromotionCampaign.objects.filter(active=True,archived=False,starts_on__lte=day,ends_on__gte=day).filter(Q(scope='network')|Q(scope='stores',stores__active=True)).distinct()
    for row in campaigns.order_by('pk').values('id','name','scope','revision','starts_on','ends_on').iterator(chunk_size=200):frame('campaign',row)
    members=PromotionCampaign.stores.through.objects.filter(promotioncampaign_id__in=campaigns.values('pk'))
    for row in members.order_by('promotioncampaign_id','store_id').values_list('promotioncampaign_id','store_id').iterator(chunk_size=200):frame('member',row)
    amounts=PromotionPrice.objects.filter(campaign_id__in=campaigns.values('pk'))
    for row in amounts.order_by('campaign_id','product_id','pk').values_list('campaign_id','product_id','price').iterator(chunk_size=200):frame('amount',row)
    return signer.hexdigest()
