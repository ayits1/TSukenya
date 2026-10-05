"""Creator-bound compact receipts over existing campaign writes; no pricing rules."""
import copy
import hashlib
import json
import uuid
from django.db import transaction
from django.http import QueryDict
from .historical_reports import read_snapshot
from .models import Document, PromotionCampaign
from .services import BusinessError, Conflict, current_actor, ledger_lock, require

PREFIX = 'campaign_action_receipts/'
OPERATIONS = {'create', 'update', 'archive'}


def canonical_uuid(value):
    try: parsed = str(uuid.UUID(value)) if isinstance(value, str) else None
    except (ValueError, AttributeError): parsed = None
    require(parsed is not None and parsed == value, 'Потрібен canonical UUID акції.')
    return parsed


def authorize(user):
    require(user.profile.role == 'owner' and user.profile.store_id is None,
            'Акціями мережі керує власник із мережевим доступом.')


def context_value(value):
    require(isinstance(value, dict) and set(value) == {'operation', 'target'}, 'Некоректний контекст акції.')
    require(isinstance(value['operation'], str) and value['operation'] in OPERATIONS, 'Невідома дія акції.')
    if value['operation'] == 'create': require(value['target'] is None, 'Створення не приймає ID наявної акції.')
    else: canonical_uuid(value['target'])
    return value


def envelope(value):
    from .promotions import FIELDS
    require(isinstance(value, dict) and set(value) == {'key', 'operation', 'target', 'request'}, 'Некоректний первісний запит акції.')
    canonical_uuid(value['key']);context_value({k: value[k] for k in ('operation','target')})
    body = value['request'];operation = value['operation']
    expected = {'revision','reason'} if operation == 'archive' else FIELDS | ({'idempotencyKey'} if operation == 'create' else {'revision'})
    require(isinstance(body, dict) and set(body) == expected, 'Невідомі або відсутні поля первісної акції.')
    if operation == 'create': require(body['idempotencyKey'] == value['key'], 'UUID не відповідає первісному створенню.')
    else: require(type(body['revision']) is int and body['revision'] > 0, 'Некоректна первісна версія акції.')
    require(isinstance(body['reason'],str) and len(body['reason']) <= 1000, 'Некоректна первісна причина акції.')
    if operation != 'archive':
        require(all(isinstance(body[k],str) and len(body[k]) <= 1000 for k in ('name','startsOn','endsOn','scope')), 'Некоректні текстові умови акції.')
        require(type(body['active']) is bool, 'Некоректний первісний стан акції.')
        require(isinstance(body['stores'],list) and len(body['stores']) <= 100 and all(type(v) is int and v > 0 for v in body['stores']), 'Некоректні первісні магазини.')
        require(isinstance(body['prices'],list) and len(body['prices']) <= 1000, 'Некоректні первісні рядки акції.')
        for row in body['prices']:
            require(isinstance(row,dict) and set(row) == {'product','price'} and all(isinstance(row[k],str) and len(row[k]) <= 1000 for k in row), 'Некоректний первісний рядок акції.')
    return value


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def acknowledgement(value, target):
    return {'confirmed': True, 'key': value['key'], 'operation': value['operation'], 'target': target,
            'requestHash': fingerprint(value), 'outcome': {'create':'created','update':'saved','archive':'archived'}[value['operation']]}


def matching(user, value):
    from .promotions import campaign_fingerprint
    receipt = Document.objects.filter(pk=PREFIX + value['key']).values_list('data', flat=True).first()
    if receipt is not None:
        if receipt['author'] != user.pk or receipt['fingerprint'] != fingerprint(value):
            raise Conflict('UUID використано іншим автором або з іншими умовами.', 'idempotency_conflict')
        return receipt['acknowledgement']
    if value['operation'] == 'create':
        # Only these immutable scalar fields prove legacy original creation.
        original = PromotionCampaign.objects.filter(pk=value['key']).values('author_id','request_fingerprint').first()
        if original is not None:
            if original['author_id'] != user.pk or original['request_fingerprint'] != campaign_fingerprint(value['request']):
                raise Conflict('UUID використано для іншого створення акції.', 'idempotency_conflict')
            return acknowledgement(value, value['key'])
    return None


def perform(request, user, value):
    from .promotions import save_campaign, archive_campaign
    cloned = copy.copy(request);cloned._body = json.dumps(value['request'], ensure_ascii=False).encode();cloned.GET = QueryDict()
    cloned.path = '/api/v1/promotions/campaigns' + ('/' + value['target'] if value['target'] else '')
    cloned.method = {'create':'POST','update':'PATCH','archive':'DELETE'}[value['operation']]
    return archive_campaign(cloned,user,value['target']) if value['operation'] == 'archive' else save_campaign(cloned,user,value['target'])


def execute(request, user):
    from .views import body, response
    value = envelope(body(request))
    with transaction.atomic():
        ledger_lock();user=current_actor(user);authorize(user)
        ack = matching(user,value);status=200
        if ack is None:
            error = None
            try:
                with transaction.atomic():
                    result = perform(request,user,value)
                    if result.status_code >= 400:
                        error = (json.loads(result.content),result.status_code);transaction.set_rollback(True)
                    else:
                        # ID is determined by immutable request lineage, never returned mutable DTO terms.
                        target = value['key'] if value['operation'] == 'create' else value['target']
                        ack=acknowledgement(value,target)
                        Document.objects.create(path=PREFIX+value['key'],data={'author':user.pk,'fingerprint':fingerprint(value),'acknowledgement':ack})
            except Conflict as cause:
                if cause.code == 'idempotency_conflict':raise
                error=({'error':str(cause),'code':cause.code,**cause.extra},409)
            except BusinessError as cause:
                if any(word in str(cause) for word in ('прав','доступ','роль')):raise
                error=({'error':str(cause)},400)
            if error is not None:
                ack,status=error
                if status in {400,409} and ack.get('code') != 'idempotency_conflict':
                    ack={**ack,'write_rejected':True,'key':value['key'],'operation':value['operation'],'requestHash':fingerprint(value)}
    # Outer commit/on_commit/serialization is outside the rollback-proof catch.
    return response(ack,status)


def identity(request,user):
    from .views import body,response
    value=envelope(body(request))
    with read_snapshot():
        user=current_actor(user);authorize(user)
        result=matching(user,value)
        if result is None:result={'confirmed':False,'key':value['key'],'operation':value['operation'],'target':value['target'],'requestHash':fingerprint(value),'outcome':'unresolved'}
        return response(result)


def parameters(request,keys):
    params=request.GET
    require(set(params)<=keys and all(len(params.getlist(k))==1 for k in params),'Некоректні параметри відновлення акції.')
    return params


def context(request,user):
    from .views import response
    params=parameters(request,{'operation','target'})
    value=context_value({'operation':params.get('operation'),'target':params.get('target') or None})
    with read_snapshot():
        user=current_actor(user);authorize(user)
        return response({**value,'exists':PromotionCampaign.objects.filter(pk=value['target']).exists() if value['target'] else None,
            'editing':{'role':user.profile.role,'storeId':None,'networkOwner':True,'canWrite':True}})


def current(request,user):
    from .views import response
    from .promotions import campaign_json
    params=parameters(request,{'id'});identifier=canonical_uuid(params.get('id'))
    with read_snapshot():
        user=current_actor(user);authorize(user)
        campaign=PromotionCampaign.objects.select_related('author').prefetch_related('stores','prices').filter(pk=identifier).first()
        if campaign is None:return response({'error':'Акцію не знайдено.','code':'not_found'},404)
        return response({'campaign':campaign_json(campaign),'editing':{'role':'owner','storeId':None,'networkOwner':True,'canWrite':not campaign.archived}})


def handle(request,user):
    from .views import response
    path=request.path.rstrip('/')
    if path == '/api/v1/promotions/recovery/context' and request.method=='GET':return context(request,user)
    if path == '/api/v1/promotions/recovery/current' and request.method=='GET':return current(request,user)
    require(not request.GET,'Невідомі параметри дії акції.')
    if path == '/api/v1/promotions/recovery/identity' and request.method=='POST':return identity(request,user)
    if path == '/api/v1/promotions/recovery/execute' and request.method=='POST':return execute(request,user)
    return response({'error':'Метод відновлення акції не підтримується.','code':'unsupported_route'},405)
