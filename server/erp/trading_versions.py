"""Cheap scoped read validators. Counters are committed atomically with source writes.

A response is one fresh-actor READ ONLY RR snapshot, not a persisted immutable
snapshot. Token selection never reads voucher/product/line arrays. The current
campaign selection is commit-safe across midnight (durable per-ID revisions).
"""
import hashlib
import hmac
import json
import re
import time
from django.conf import settings
from django.db.models import Q, OuterRef, Subquery, Value, CharField
from django.db.models.functions import Cast, Concat, Coalesce
from django.http import JsonResponse, HttpResponse
from .models import TradingVersion, StateVersion, PromotionCampaign, PortalSession
from .historical_reports import read_snapshot
from .promotion_prices import kyiv_day
from .services import current_actor, BusinessError
from .browsing import positive_integer
from .trading_version_spec import RESOURCES

CONTRACT = 'trading-versions-v1'
MAX_RESOURCES = 8
PRICE_RESOURCES = {'stock','assortment','replenishment','directories'}


def sign(value):
    raw=json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
    return hmac.new(settings.SECRET_KEY.encode(),raw,hashlib.sha256).hexdigest()


def query(user, params):
    if set(params)-{'resources','store'}:raise BusinessError('Невідомий параметр версій обліку.')
    if hasattr(params,'getlist') and any(len(params.getlist(k))!=1 for k in params):raise BusinessError('Параметр повторюється.')
    raw=params.get('resources','')
    if not isinstance(raw,str):raise BusinessError('Некоректний перелік ресурсів.')
    resources=raw.split(',')
    if not 1<=len(resources)<=MAX_RESOURCES or len(set(resources))!=len(resources) or any(r not in RESOURCES for r in resources):
        raise BusinessError('Некоректний перелік ресурсів.')
    if any(user.profile.role not in RESOURCES[r] for r in resources):return None
    raw_store=params.get('store','')
    store=positive_integer(raw_store,'ID магазину') if raw_store else user.profile.store_id
    if user.profile.store_id is not None and store!=user.profile.store_id:return None
    return sorted(resources),store


def values(user, resources, store, day):
    role=user.profile.role
    keys=[]
    for resource in resources:
        prefix=resource+':'+role+':'
        keys.extend((prefix+'global',prefix+('all' if store is None else 'store:'+str(store))))
    counters=dict(TradingVersion.objects.filter(pk__in=keys).values_list('key','revision'))
    # Explicit zero keys avoid absence/first-create/deletion equivalence. No global
    # private sequence or hidden-store key is included in a scoped validator.
    projected={r:{k:counters.get(k,0) for k in keys if k.startswith(r+':')} for r in resources}
    if set(resources)&PRICE_RESOURCES:
        area=Q(scope='network')|(Q(scope='stores',stores__active=True) if store is None else Q(scope='stores',stores=store))
        campaigns=PromotionCampaign.objects.filter(area,active=True,archived=False,starts_on__lte=day,ends_on__gte=day).annotate(
            counter=Concat(Value('campaign:'),Cast('pk',CharField()))).annotate(
            version=Coalesce(Subquery(StateVersion.objects.filter(pk=OuterRef('counter')).values('revision')[:1]),Value(0))).order_by('counter').values_list('counter','version').distinct()
        campaign_values=dict(campaigns)
        for resource in set(resources)&PRICE_RESOURCES:projected[resource]['campaigns']=campaign_values
    return projected


def wire_version(value):
    match=re.fullmatch(r'(?:W/)?"tsukenya-trading-v1-([a-f0-9]{64})(?:-(?:gzip|br|zstd))?"',value or '')
    return match.group(1) if match else None


def response(request, user):
    result=None
    with read_snapshot():
        # An authentication cache established before the snapshot is not a grant.
        try:user=current_actor(user)
        except BusinessError:return JsonResponse({'error':'Доступ відкликано.'},status=403)
        session=PortalSession.objects.filter(pk=request.portal_session.pk,user_id=user.pk,expires__gt=int(time.time()),csrf=request.portal_session.csrf).first()
        if session is None:return JsonResponse({'error':'Сеанс завершився.'},status=401)
        selected=query(user,request.GET)
        if selected is None:return JsonResponse({'error':'Ресурс або магазин недоступний.'},status=403)
        resources,store=selected
        day=kyiv_day()
        identity={'role':user.profile.role,'scopeStore':user.profile.store_id,'store':store,
                  'session':sign(['trading-session-v1',user.pk,session.pk,session.csrf])}
        projection=values(user,resources,store,day)
        material=[CONTRACT,identity,day.isoformat(),projection]
        digest=sign(material)
        token='"tsukenya-trading-v1-'+digest+'"'
        if wire_version(request.headers.get('If-None-Match'))==digest:
            result=HttpResponse(status=304)
        else:
            result=JsonResponse({'contract':CONTRACT,'identity':identity,'day':day.isoformat(),
                'versions':{r:sign([CONTRACT,identity,day.isoformat(),r,p]) for r,p in projection.items()}},json_dumps_params={'sort_keys':True})
        result['ETag']=token
        result['Vary']='Cookie'
        result['Cache-Control']='private, no-store'
    return result
