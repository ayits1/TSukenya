"""Scoped conditional legacy state. A cheap validator never scans the catalogue.

Standalone full reads use one read-only repeatable-read snapshot. Existing caller
transactions retain the legacy body but receive no validator unless already RR/RO.
"""
import hashlib
import hmac
import json
from django.conf import settings
from django.db import connection
from django.db.models import Q, Subquery, OuterRef, Value, CharField
from django.db.models.functions import Cast, Concat, Coalesce
from django.http import HttpResponse, JsonResponse
from .historical_reports import read_snapshot
from .models import StateVersion, Document, PromotionCampaign
from .promotion_prices import kyiv_day

DOMAINS = ('products', 'references', 'tasks', 'ideas', 'expenses', 'settings/main', 'project/state')


def selection(user):
    role, store = user.profile.role, user.profile.store_id
    exact = {'catalog','references','labels','pricing'}
    prefixes = []
    if store is None:
        exact.add('stores_all')
        query = Q()
    else:
        exact.add('store:'+str(store))
        query = Q()
    if role == 'owner':
        exact |= {'owner_tasks','owner_ideas','owner_sync','project_state'}
        if store is None:
            exact |= {'expenses','private_settings','task_links','idea_links'}
            prefixes += ['owner_due:']
        else:
            exact |= {'owner_due:'+str(store),'task_links:'+str(store),'idea_links:'+str(store)}
    else:
        exact |= {'ops_tasks','ops_ideas'}
        if store is None:prefixes += ['ops_tasks:']
        else:exact.add('ops_tasks:'+str(store))
        if role in {'manager','accountant'}:
            if store is None:prefixes += ['finance_due:']
            else:exact.add('finance_due:'+str(store))
    query |= Q(key__in=exact)
    for prefix in prefixes:query |= Q(key__startswith=prefix)
    return query


def versions(user, csrf, day):
    rows = dict(StateVersion.objects.filter(selection(user)).order_by('key').values_list('key','revision'))
    # Mutation-time date predicates cannot survive a commit crossing midnight.
    # Always bump per campaign; select only currently visible headers here. Keep
    # explicit ID/revision0 when no register row exists, so deletion cannot leave
    # an unchanged validator for a pre-migration campaign. This SELECT is inside
    # the same RR snapshot as the full body and never reads PromotionPrice.
    area = Q(scope='network') | (Q(scope='stores',stores__active=True) if user.profile.store_id is None else Q(scope='stores',stores=user.profile.store_id))
    current = PromotionCampaign.objects.filter(area,active=True,archived=False,starts_on__lte=day,ends_on__gte=day).annotate(
        state_key=Concat(Value('campaign:'),Cast('pk',CharField()))).annotate(
        state_revision=Coalesce(Subquery(StateVersion.objects.filter(pk=OuterRef('state_key')).values('revision')[:1]),Value(0))).order_by('state_key').values_list('state_key','state_revision').distinct()
    rows.update(current)
    identity = ['legacy-state-v1',user.pk,user.profile.role,user.profile.store_id,csrf,day.isoformat()]
    def sign(value):
        return hmac.new(settings.SECRET_KEY.encode(),json.dumps(value,sort_keys=True,separators=(',',':')).encode(),hashlib.sha256).hexdigest()
    domains = {name:{} for name in DOMAINS}
    role=user.profile.role
    for key,value in rows.items():
        if key=='catalog' or key=='pricing' or key.startswith(('campaign:','store')):domains['products'][key]=value
        if key=='references':domains['references'][key]=value
        if key.startswith(('owner_tasks','ops_tasks','owner_due:','finance_due:','task_links')):domains['tasks'][key]=value
        if key.startswith(('owner_ideas','ops_ideas','idea_links')):domains['ideas'][key]=value
        if key=='expenses':domains['expenses'][key]=value
        if key in {'labels','private_settings','owner_sync'} or key=='pricing' and role!='cashier':domains['settings/main'][key]=value
        if key=='project_state':domains['project/state'][key]=value
    return '"tsukenya-state-v1-'+sign([identity,rows])+'"', {name:sign([identity,name,values]) for name,values in domains.items()}


def can_validate():
    if not connection.in_atomic_block or connection.vendor!='postgresql':return True
    with connection.cursor() as cursor:
        cursor.execute('SHOW transaction_isolation'); isolation=cursor.fetchone()[0]
        cursor.execute('SHOW transaction_read_only'); readonly=cursor.fetchone()[0]
    return isolation in {'repeatable read','serializable'} and readonly=='on'


def state_response(request, user, build_state, *, metadata=False):
    from .labels import revision as label_revision
    csrf=request.portal_session.csrf
    conditional=can_validate()
    # An inherited READ COMMITTED caller keeps the old read contract without a
    # potentially inconsistent ETag. No runtime/test detection and no GET writes.
    if conditional:
        day=kyiv_day()
        token, domains=versions(user,csrf,day)
        if metadata:token=token.replace("tsukenya-state-v1-","tsukenya-portal-v1-")
        if request.headers.get('If-None-Match')==token:
            result=HttpResponse(status=304)
            result['ETag']=token
            result['Vary']='Cookie'
            return result
    with read_snapshot(strict=conditional):
        day=kyiv_day()
        if conditional:
            token,domains=versions(user,csrf,day)
            if metadata:token=token.replace("tsukenya-state-v1-","tsukenya-portal-v1-")
        document=Document.objects.filter(pk='settings/main').first()
        payload={'data':build_state(user,effective_day=day),'csrf':csrf,'role':user.profile.role,
            'networkOwner':user.profile.role=='owner' and user.profile.store_id is None,
            'labelRevision':label_revision(document.data if document else {})}
        if metadata:payload['contract']='portal-metadata-v1'
        if conditional:payload['stateVersions']=domains
    result=JsonResponse(payload, json_dumps_params={'ensure_ascii':False,'sort_keys':True})
    if conditional:result['ETag']=token
    result['Vary']='Cookie'
    return result
