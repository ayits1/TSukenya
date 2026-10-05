"""Creator-scoped durable imports. Each bounded apply step is its own transaction."""
import hashlib
import hmac
import re
import uuid
from time import monotonic
from datetime import timedelta
from decimal import Decimal
from django.conf import settings
from django.contrib.auth.models import User
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from .catalog import (EDIT_ROLES, TEXT_FIELDS, defaults, name_key,
                      new_product_data, normalise_product, plain, pricing_revision, revision, serialize)
from .catalog_access import revalidate_actor
from . import catalog_price_results as price_results
from .catalog_import import canonical, UUID_PATTERN
from .import_models import CatalogImportRun, CatalogImportRow, CatalogImportChunk, CatalogImportIndex, counts, planned
from .models import Document
from .import_index import drain, indexed_duplicate, legacy_recipe_lookup, IndexLimit
from .import_references import ReferenceCache, ReferenceLimit
from .services import BusinessError, dec, ledger_lock, require
from .catalog_budget import bounded,check as budget_check,BudgetExceeded

LIMITS={'maxRows':100000,'uploadRows':200,'workerRows':100,'maxEntryBytes':16384,
        'maxTotalBytes':52428800,'maxChunkBytes':1048576}
STATUSES={'uploading','queued','running','ready','invalid','completed','completed_with_issues','blocked','failed','cancelled'}
ROW_STATUSES={'uploaded','planned','invalid','created','updated','skipped','conflicted','failed'}
LEASE_SECONDS=120


class JobError(BusinessError):
    def __init__(self,message,code='invalid_import',status=400):
        super().__init__(message);self.code=code;self.status=status


def check(test,message,code='invalid_import',status=400):
    if not test:raise JobError(message,code,status)


def digest(value):return hashlib.sha256(canonical(value).encode()).hexdigest()
def name_hash(value):return hashlib.sha256(name_key(value).encode()).hexdigest() if name_key(value) else ''
def iso(value):return value.isoformat() if value else None

def uuid_value(value):
    check(isinstance(value,str) and re.fullmatch(UUID_PATTERN,value),'Некоректний UUID імпорту.');return uuid.UUID(value)

def fields(value,allowed):check(isinstance(value,dict) and not(set(value)-set(allowed)),'Запит містить невідомі поля.')

def actor(user):revalidate_actor(user,EDIT_ROLES,'Недостатньо прав для імпорту каталогу.')

def get_run(user,identifier,*,lock=False):
    query=CatalogImportRun.objects.select_for_update() if lock else CatalogImportRun.objects
    result=query.filter(pk=identifier,owner_id=user.pk).first()
    check(result is not None,'Імпорт не знайдено.','not_found',404)
    if result.price_context is not None:price_results.scope_context(user,result.price_context)
    return result


def public(run):
    return {'id':str(run.pk),'mode':run.mode,'fileName':run.file_name,'expectedRows':run.expected_rows,
            'uploadedRows':run.uploaded_rows,'inputBytes':run.input_bytes,'inputHash':run.input_hash or None,
            'priceContext':run.price_context,'planRevision':run.plan_revision or None,'sourceHash':run.source_hash or None,'defaultMarkup':run.default_markup or None,'genericAs':run.generic_as or None,'status':run.status,'phase':run.phase,
            'progress':{'done':run.phase_done,'total':run.phase_total},'counts':run.counts,'planned':run.planned,'indexedPaths':run.indexed_paths,
            'canApply':run.mode=='chunked' and run.status=='ready','canResume':run.mode=='chunked' and run.status in {'failed','blocked'},
            'canCancel':run.mode=='chunked' and run.status in {'uploading','queued','running','ready','failed','blocked'},
            'createdAt':iso(run.created_at),'updatedAt':iso(run.updated_at),'startedAt':iso(run.started_at),
            'finishedAt':iso(run.finished_at),'error':run.error,'limits':LIMITS}


def row_public(row):
    return {'ordinal':row.ordinal,'line':row.line,'status':row.status,'action':row.action or None,
            'id':row.product_path.split('/',1)[1] if row.product_path else None,'revision':row.revision or None,
            'currentRevision':row.current_revision or None,'values':row.preview.get('values',{}),
            'regularPrice':row.preview.get('regularPrice'),'salePrice':row.preview.get('salePrice'),'error':row.error,
            'priceResult':row.price_result,'priceComparison':row.preview.get('priceComparison')}


def page(query,raw,size,serializer):
    check(isinstance(raw,str) and re.fullmatch(r'[0-9]{1,10}',raw) and int(raw)>0,'Некоректна сторінка.')
    total=query.count();pages=max(1,(total+size-1)//size);number=min(int(raw),pages)
    return {'items':[serializer(x) for x in query[(number-1)*size:number*size]],'total':total,'page':number,'pages':pages}


@transaction.atomic
def create(user,payload):
    fields(payload,{'idempotencyKey','fileName','expectedRows','defaultMarkup','sourceHash','genericAs','priceContext'})
    identifier=uuid_value(payload.get('idempotencyKey'))
    check(isinstance(payload.get('fileName'),str) and len(payload['fileName'].strip())<=250,'Некоректна назва файлу.')
    check(type(payload.get('expectedRows')) is int and 0<payload['expectedRows']<=LIMITS['maxRows'],'Імпорт має містити 1–100000 рядків.')
    if 'sourceHash' in payload:check(isinstance(payload['sourceHash'],str) and re.fullmatch('[0-9a-f]{64}',payload['sourceHash']),'Некоректний відбиток файлу.')
    if 'genericAs' in payload:check(isinstance(payload['genericAs'],str) and payload['genericAs'] in {'cost','price'},'Некоректне трактування ціни файлу.')
    if 'defaultMarkup' in payload:
        check(isinstance(payload['defaultMarkup'],str) and len(payload['defaultMarkup'])<=32,'Націнка має бути десятковим рядком.')
        require(dec(payload['defaultMarkup'],'Націнка',Decimal('.0001'))<=Decimal('99999999.99'),'Націнка завелика.')
    if 'priceContext' in payload:price_results.validate_context(payload['priceContext'])
    ledger_lock();actor(user)
    old=CatalogImportRun.objects.filter(pk=identifier).first()
    if old:
        check(old.owner_id==user.pk,'Імпорт не знайдено.','not_found',404)
        check(old.mode=='chunked' and old.metadata_hash==digest(payload),'Ключ повтору вже використано.','idempotency_conflict',409)
        if old.price_context is not None:price_results.scope_context(user,old.price_context)
        return old.create_receipt
    check(not Document.objects.filter(pk='import_runs/'+str(identifier)).exists(),'Ключ повтору вже використано.','idempotency_conflict',409)
    context=price_results.capture_context(price_results.resolve_context(user,payload))
    receipt={'ok':True,'priceContext':context,'id':str(identifier),'status':'uploading','expectedRows':payload['expectedRows'],'sourceHash':payload.get('sourceHash'),'limits':LIMITS}
    CatalogImportRun.objects.create(id=identifier,owner=user,file_name=payload['fileName'].strip(),expected_rows=payload['expectedRows'],
        price_context=context,metadata_hash=digest(payload),default_markup=payload.get('defaultMarkup',''),source_hash=payload.get('sourceHash',''),generic_as=payload.get('genericAs',''),create_receipt=receipt,
        phase_total=payload['expectedRows'],counts={**counts(),'pending':payload['expectedRows']})
    return receipt


@transaction.atomic
def upload(user,identifier,payload):
    fields(payload,{'offset','entries'})
    offset=payload.get('offset');entries=payload.get('entries')
    check(type(offset) is int and 0<=offset<LIMITS['maxRows'],'Некоректне зміщення пакета.')
    check(isinstance(entries,list) and 0<len(entries)<=LIMITS['uploadRows'],'Пакет має містити 1–200 рядків.')
    encoded=[canonical(x).encode() for x in entries]
    check(all(len(x)<=LIMITS['maxEntryBytes'] for x in encoded),'Окремий рядок перевищує 16 КіБ.')
    check(len(canonical(payload).encode())<=LIMITS['maxChunkBytes'],'Пакет перевищує 1 МіБ.')
    chunk_hash=digest(payload)
    ledger_lock();actor(user);run=get_run(user,identifier,lock=True)
    check(run.mode=='chunked','Атомарний імпорт не приймає пакети.')
    old=CatalogImportChunk.objects.filter(run=run,offset=offset).first()
    if old:
        check(old.digest==chunk_hash,'Пакет із цим зміщенням уже має інші дані.','idempotency_conflict',409)
        return old.receipt
    check(run.status=='uploading','Завантаження вже завершено.','invalid_state',409)
    check(offset==run.uploaded_rows,'Спочатку завантажте попередній пакет.','upload_gap',409)
    check(offset+len(entries)<=run.expected_rows,'Пакет перевищує заявлену кількість рядків.')
    size=sum(map(len,encoded));check(run.input_bytes+size<=LIMITS['maxTotalBytes'],'Файл перевищує 50 МіБ.')
    rows=[]
    for position,value in enumerate(entries):
        raw=value if isinstance(value,dict) else {};values=raw.get('values');values=values if isinstance(values,dict) else {}
        line=raw.get('line');line=line if type(line) is int and 0<line<=1000000 else None
        barcode=values.get('barcode');barcode=barcode.strip() if isinstance(barcode,str) and len(barcode.strip())<=80 else ''
        rows.append(CatalogImportRow(run=run,ordinal=offset+position+1,line=line,input=value,input_hash=hashlib.sha256(encoded[position]).hexdigest(),
            name_hash=name_hash(values.get('name')),barcode=barcode))
    for row in rows:run.upload_hash=digest([run.upload_hash,row.input_hash])
    CatalogImportRow.objects.bulk_create(rows,batch_size=200)
    run.uploaded_rows+=len(entries);run.input_bytes+=size;run.phase_done=run.uploaded_rows;run.save()
    receipt={'ok':True,'id':str(run.pk),'offset':offset,'count':len(entries),'uploadedRows':run.uploaded_rows,'chunkHash':chunk_hash}
    CatalogImportChunk.objects.create(run=run,offset=offset,digest=chunk_hash,receipt=receipt)
    return receipt


@transaction.atomic
def seal(user,identifier,payload):
    fields(payload,set());ledger_lock();actor(user);run=get_run(user,identifier,lock=True)
    if run.seal_receipt:return run.seal_receipt
    check(run.mode=='chunked' and run.status=='uploading','Імпорт не готовий до перевірки.','invalid_state',409)
    check(run.uploaded_rows==run.expected_rows,'Завантажте всі заявлені рядки.','incomplete_upload',409)
    config=defaults();run.pricing_config={key:plain(value) for key,value in config.items()};run.pricing_revision=pricing_revision(config)
    run.input_hash=run.upload_hash
    run.status='queued';run.phase='indexing';run.phase_done=0;run.phase_total=Document.objects.filter(path__startswith='products/').count()
    run.seal_receipt={'ok':True,'id':str(run.pk),'inputHash':run.input_hash,'status':'queued','phase':'indexing'};run.save()
    return run.seal_receipt


@transaction.atomic
def approve(user,identifier,payload):
    fields(payload,{'planRevision'});check(isinstance(payload.get('planRevision'),str) and re.fullmatch('[0-9a-f]{64}',payload['planRevision']),'Відсутня версія плану.')
    ledger_lock();actor(user);run=get_run(user,identifier,lock=True)
    check(run.plan_revision and hmac.compare_digest(payload['planRevision'],run.plan_revision),'План імпорту вже змінено.','revision_conflict',409)
    if run.apply_receipt:return run.apply_receipt
    check(run.status=='ready','Імпорт не готовий до застосування.','invalid_state',409)
    check(pricing_revision()==run.pricing_revision,'Налаштування ціни вже змінено. Створіть новий план.','pricing_revision_conflict',409)
    run.status='queued';run.phase='applying';run.row_cursor=0;run.phase_done=0;run.phase_total=run.expected_rows
    run.apply_receipt={'ok':True,'id':str(run.pk),'planRevision':run.plan_revision,'status':'queued','phase':'applying'};run.save()
    return run.apply_receipt


@transaction.atomic
def control(user,identifier,payload,action):
    fields(payload,{'planRevision'} if action=='resume' else set());ledger_lock();actor(user);run=get_run(user,identifier,lock=True)
    check(run.mode=='chunked','Атомарний імпорт уже завершено.','invalid_state',409)
    if action=='cancel':
        check(public(run)['canCancel'] or run.status=='cancelled','Імпорт уже завершено.','invalid_state',409)
        run.status='cancelled';run.finished_at=timezone.now()
    else:
        check(run.status in {'failed','blocked'},'Імпорт не потребує відновлення.','invalid_state',409)
        if run.phase=='applying':check(payload.get('planRevision')==run.plan_revision,'Відсутня початкова версія плану.','revision_conflict',409)
        run.status='queued';run.error=None
    run.lease_token=None;run.lease_until=None;run.save();return public(run)


def handle(request,user):
    from .views import response
    from .catalog_import import import_body
    try:
        actor(user);prefix='/api/v1/catalog/import';path=request.path.rstrip('/')
        if path==prefix+'/history' and request.method=='GET':
            check(not(set(request.GET)-{'page','status','mode'}),'Невідомий фільтр журналу.')
            query=CatalogImportRun.objects.filter(owner=user).order_by('-created_at','-id')
            if user.profile.store_id is not None:
                query=query.filter(Q(price_context__isnull=True)|Q(price_context__storeId=user.profile.store_id))
            if 'mode' in request.GET:
                check(request.GET['mode'] in {'atomic','chunked'},'Некоректний режим.');query=query.filter(mode=request.GET['mode'])
            if 'status' in request.GET:
                check(request.GET['status'] in STATUSES,'Некоректний стан.');query=query.filter(status=request.GET['status'])
            from .service_health import import_worker_status
            worker=import_worker_status()
            return response(page(query,request.GET.get('page','1'),30,lambda run:{**public(run),'worker':worker}))
        if path==prefix+'/runs' and request.method=='POST':return response(create(user,import_body(request)))
        match=re.fullmatch(re.escape(prefix)+r'/runs/('+UUID_PATTERN+r')(?:/(rows|chunks|seal|apply|resume|cancel))?',path)
        if match:
            identifier=uuid.UUID(match[1]);action=match[2]
            if request.method=='GET' and action in {None,'rows','chunks'}:
                run=get_run(user,identifier)
                if action is None:
                    check(not request.GET,'Невідомий фільтр імпорту.')
                    from .service_health import import_worker_status
                    return response({**public(run),'worker':import_worker_status()})
                if action=='chunks':
                    check(not(set(request.GET)-{'page'}),'Невідомий фільтр пакетів.')
                    return response(page(CatalogImportChunk.objects.filter(run=run).order_by('offset'),request.GET.get('page','1'),100,lambda item:item.receipt))
                check(not(set(request.GET)-{'page','status'}),'Невідомий фільтр рядків.');query=run.rows.order_by('ordinal')
                if 'status' in request.GET:
                    check(request.GET['status'] in ROW_STATUSES,'Некоректний стан рядка.');query=query.filter(status=request.GET['status'])
                return response(page(query,request.GET.get('page','1'),100,row_public))
            if request.method=='POST':
                payload=import_body(request)
                if action=='chunks':return response(upload(user,identifier,payload))
                if action=='seal':return response(seal(user,identifier,payload))
                if action=='apply':return response(approve(user,identifier,payload))
                if action in {'resume','cancel'}:return response(control(user,identifier,payload,action))
        return response({'error':'Метод або маршрут не підтримується.','code':'unsupported_route'},405)
    except JobError as exc:return response({'error':str(exc),'code':exc.code},exc.status)
    except RecursionError:return response({'error':'JSON містить надто глибоку вкладеність.','code':'invalid_import'},400)




def config_for(run):return {key:Decimal(value) for key,value in run.pricing_config.items()}


def prepare(run,row,user,*,references=None):
    budget_check()
    value=row.input;fields(value,{'line','id','revision','values'})
    check(row.line is not None,'Некоректний номер рядка.')
    for field,value_key in [('line',row.line),('name_hash',row.name_hash),('barcode',row.barcode)]:
        if value_key:check(run.rows.filter(**{field:value_key}).count()==1,'Номер рядка, назва або штрихкод повторюється у файлі.')
    values=value.get('values');check(isinstance(values,dict),'Відсутні значення товару.')
    check(isinstance(values.get('name'),str) and row.name_hash,'Вкажіть назву товару.')
    identifier=value.get('id');expected=value.get('revision')
    check(identifier is None or isinstance(identifier,str) and re.fullmatch('[A-Za-z0-9_-]{1,120}',identifier),'Некоректний ID товару.')
    check(expected is None or isinstance(expected,str) and re.fullmatch('[0-9a-f]{64}',expected),'Некоректна версія товару.')
    matches=list(CatalogImportIndex.objects.filter(run=run,name_hash=row.name_hash)[:2])
    check(len(matches)<=1,'У каталозі кілька товарів із цією назвою.')
    from .catalog_projection import projected_document
    existing=projected_document(matches[0].product_path,config=config_for(run),with_recipe=True) if matches else None
    config=config_for(run)
    if matches:check(existing is not None and name_hash(existing.data.get('name'))==row.name_hash and revision(existing,config)==matches[0].revision,'Каталог змінено під час побудови плану.')
    if identifier is not None:check(existing is not None and existing.path=='products/'+identifier,'Назва та ID товару не відповідають каталогу.')
    if existing:
        captured=revision(existing,config);check(expected is None or expected==captured,'Товар уже змінено. Створіть новий план.')
        old=dict(existing.data);path=existing.path
    else:
        check(identifier is None and expected is None,'Товар для оновлення більше не існує.')
        captured='';old=new_product_data(config)
        if run.default_markup:old['markup']=float(Decimal(run.default_markup))
        path='products/'+str(uuid.uuid5(run.pk,str(row.line))).replace('-','_')
        check(not Document.objects.filter(pk=path).exists(),'ID нового товару вже використовується.')
    for field in ('cost','markup','price','promotionPrice','minStock'):
        if field in values:check(isinstance(values[field],str) or field in {'price','promotionPrice'} and values[field] is None,f'{field}: очікується десятковий рядок.')
    data=normalise_product(values,old,path,validate_references=False,config=config,references=(references or ReferenceCache()).scope(old,values),legacy_recipe_lookup=legacy_recipe_lookup)
    check(name_hash(data.get('name'))==row.name_hash,'Нормалізація назви змінила відповідність рядка.')
    check(not indexed_duplicate(data,old,path),'Товар із такою назвою вже існує.')
    from .promotion_prices import PriceResolver
    resolver=PriceResolver(config,price_results.stored_store(user,run.price_context),product_paths=[path])
    doc=Document(path=path,data=data);product=serialize(doc,user,config,resolver=resolver)
    action='skip' if existing and canonical(data)==canonical(old) else ('update' if existing else 'create')
    return path,captured,data,action,{'values':{key:product[key] for key in (*TEXT_FIELDS,'cost','markup','price','manualPrice','promotion','promotionPrice','priceAt','minStock')},'regularPrice':product['regularPrice'],'salePrice':product['salePrice'],
        'priceComparison':price_results.comparison(existing,doc,config,resolver) if run.price_context is not None else None},resolver.resolve(doc)['effectivePriceRevision']


def update_counts(run):
    grouped={row['status']:row['n'] for row in run.rows.values('status').annotate(n=Count('pk'))}
    run.counts={**counts(),**{key:grouped.get(key,0) for key in counts() if key!='pending'},'pending':grouped.get('uploaded',0)+grouped.get('planned',0)}
    run.planned={key:run.rows.filter(action=key).count() for key in planned()}


def row_material(row):
    return {'ordinal':row.ordinal,'status':row.status,'action':row.action,'path':row.product_path,'revision':row.revision,'data':row.data,'effective':row.effective_revision}


def plan_hash(run):
    return hmac.new(settings.SECRET_KEY.encode(),canonical({'id':str(run.pk),'input':run.input_hash,'pricing':run.pricing_revision,'context':run.price_context,'rows':run.plan_material}).encode(),hashlib.sha256).hexdigest()


@transaction.atomic
def claim(identifier=None):
    now=timezone.now();query=CatalogImportRun.objects.filter(mode='chunked').filter(Q(status='queued')|Q(status='running',lease_until__lte=now))
    if identifier is not None:query=query.filter(pk=identifier)
    run=query.select_for_update(skip_locked=True).order_by('created_at').first()
    if not run:return None
    run.status='running';run.lease_token=uuid.uuid4();run.lease_until=now+timedelta(seconds=LEASE_SECONDS)
    run.started_at=run.started_at or now;run.save();return run.pk,run.lease_token


def lease_valid(run,token):return run.status=='running' and run.lease_token==token and run.lease_until is not None and run.lease_until>timezone.now()


@bounded
@transaction.atomic
def step(identifier,token):
    ledger_lock();run=CatalogImportRun.objects.select_for_update().get(pk=identifier)
    if not lease_valid(run,token):return False
    user=User.objects.get(pk=run.owner_id)
    try:
        actor(user)
        price_results.stored_store(user,run.price_context)
    except BusinessError:
        run.status='blocked';run.error={'code':'access_revoked','message':'Доступ автора змінено. Відновлення потребує чинних прав.'};run.lease_token=None;run.lease_until=None;run.save();return False
    config=config_for(run)
    drained,dirty=drain();run.indexed_paths+=drained
    if dirty:
        run.status='queued';run.lease_token=None;run.lease_until=None;run.save();return True
    started=monotonic()
    if run.phase in {'indexing','validating'} and pricing_revision()!=run.pricing_revision:
        run.status='failed';run.error={'code':'pricing_revision_conflict','message':'Налаштування ціни змінено. Створіть новий імпорт.'};run.lease_token=None;run.lease_until=None;run.save();return False
    if run.phase=='indexing':
        from .catalog_projection import projected_document
        paths=list(Document.objects.filter(path__startswith='products/',path__gt=run.catalog_cursor).order_by('path').values_list('path',flat=True)[:200])
        docs=[]
        for path in paths:
            budget_check();docs.append(projected_document(path,config=config))
        CatalogImportIndex.objects.bulk_create([CatalogImportIndex(run=run,product_path=doc.path,name_hash=name_hash(doc.data.get('name')) if isinstance(doc.data,dict) else '',revision=revision(doc,config)) for doc in docs],batch_size=200)
        if docs:run.catalog_cursor=docs[-1].path;run.phase_done+=len(docs);run.phase_total=max(run.phase_total,run.phase_done)
        if len(docs)<200:run.phase='validating';run.phase_done=0;run.phase_total=run.expected_rows;run.row_cursor=0
    elif run.phase=='validating':
        rows=list(run.rows.filter(ordinal__gt=run.row_cursor).order_by('ordinal')[:LIMITS['workerRows']])
        references=ReferenceCache()
        for row in rows:
            try:
                path,captured,data,action,preview,price_version=prepare(run,row,user,references=references)
                row.product_path=path;row.revision=captured;row.data=data;row.action=action;row.preview=preview;row.effective_revision=price_version;row.status='planned'
            except BudgetExceeded:raise
            except BusinessError as exc:row.status='invalid';row.error={'code':'invalid_import_row','message':str(exc)}
            row.save();run.plan_material=digest([run.plan_material,row_material(row)]);run.row_cursor=row.ordinal;run.phase_done+=1
            if monotonic()-started>=5:break
        update_counts(run)
        if run.row_cursor>=run.expected_rows:
            run.plan_revision=plan_hash(run);run.status='invalid' if run.counts['invalid'] else 'ready';run.finished_at=timezone.now() if run.status=='invalid' else None
    elif run.phase=='applying':
        rows=list(run.rows.filter(status='planned',ordinal__gt=run.row_cursor).order_by('ordinal')[:LIMITS['workerRows']])
        references=ReferenceCache()
        for row in rows:
            apply_row(run,row,user,config,references=references);run.row_cursor=row.ordinal;run.phase_done+=1
            if monotonic()-started>=5:break
        update_counts(run)
        if not run.counts['pending']:
            run.status='completed_with_issues' if run.counts['conflicted'] or run.counts['failed'] else 'completed';run.phase='finished';run.finished_at=timezone.now()
    else:raise JobError('Некоректна фаза імпорту.')
    # The run row remains locked throughout this transaction: a competing claim
    # skips it. Expiry fences entry to the step, not a completed unit's commit.
    check(run.lease_token==token,'Час виконання пакета вичерпано.','lease_expired',409)
    if run.status=='running':run.status='queued'
    run.lease_token=None;run.lease_until=None;run.save();budget_check();return True


def apply_row(run,row,user,config,*,references=None):
    budget_check()
    from .catalog_projection import projected_document,save_projection
    existing=projected_document(row.product_path,config=config,with_recipe=True);row.current_revision=revision(existing,config) if existing else ''
    if pricing_revision()!=run.pricing_revision or (row.action=='create' and existing is not None) or (row.action!='create' and (existing is None or row.current_revision!=row.revision)):
        row.status='conflicted';row.error={'code':'revision_conflict','message':'Товар або налаштування ціни змінено після перевірки.'};row.save();return
    try:
        with transaction.atomic():
            old=existing.data if existing else new_product_data(config)
            if existing is None and run.default_markup:old['markup']=float(Decimal(run.default_markup))
            data=normalise_product(row.input['values'],old,row.product_path,validate_references=False,config=config,references=(references or ReferenceCache()).scope(old,row.input['values']),legacy_recipe_lookup=legacy_recipe_lookup)
            from .promotion_prices import PriceResolver
            resolver=PriceResolver(config,price_results.stored_store(user,run.price_context),product_paths=[row.product_path])
            check(canonical(data)==canonical(row.data) and resolver.resolve(Document(path=row.product_path,data=data))['effectivePriceRevision']==row.effective_revision,'Розрахована ціна або план уже змінені.','revision_conflict',409)
            check(name_hash(data.get('name'))==row.name_hash,'Нормалізація назви змінила відповідність рядка.','revision_conflict',409)
            check(not indexed_duplicate(data,old,row.product_path),'Товар із такою назвою вже існує.','revision_conflict',409)
            before_price=price_results.terms(existing,config,resolver) if existing else None
            if row.action!='skip':
                from .promotion_history import observe_prices
                from .business_audit import snapshot,change
                from .services import audit
                before=snapshot('product',existing.data) if existing else None
                if existing:observe_prices(user,[existing],'import','Імпорт товарів',seed=True,product_paths=[row.product_path])
                document=existing or Document(path=row.product_path)
                if existing:save_projection(document,data,config=config)
                else:document.data=data;document.save()
                observe_prices(user,[document],'import','Імпорт товарів',product_paths=[row.product_path])
                audit(user,'catalog_changed',document.path,{'method':'IMPORT','contract':'v1','run':str(run.pk),'line':row.line,**change(before,snapshot('product',data),observed=run.plan_revision,reason='Імпорт товарів')})
                row.current_revision=revision(document,config)
            row.status={'create':'created','update':'updated','skip':'skipped'}[row.action]
            if run.price_context is not None:
                after_price=price_results.terms(existing if row.action=='skip' else document,config,resolver)
                row.price_result=price_results.result(row.product_path.split('/',1)[1],row.status,price_results.compare_terms(before_price,after_price),resolver,line=row.line,ordinal=row.ordinal)
            row.error=None;row.save()
    except BudgetExceeded:raise
    except BusinessError as exc:
        row.status='conflicted' if isinstance(exc,JobError) and exc.code=='revision_conflict' else 'failed'
        row.error={'code':'revision_conflict' if row.status=='conflicted' else 'apply_validation_failed','message':str(exc)};row.save()


def process_one(identifier=None):
    claimed=claim(identifier)
    if not claimed:return False
    identifier,token=claimed
    try:step(identifier,token)
    except Exception as exc:
        # The failed step already rolled back. Only the technical error state is committed.
        with transaction.atomic():
            run=CatalogImportRun.objects.select_for_update().get(pk=identifier)
            if run.lease_token==token:
                run.status='failed';run.lease_token=None;run.lease_until=None;run.error={'code':'catalog_index_limit' if isinstance(exc,IndexLimit) else 'reference_limit' if isinstance(exc,ReferenceLimit) else 'worker_failed','message':str(exc) if isinstance(exc,(IndexLimit,ReferenceLimit,BudgetExceeded)) else 'Пакет не записано. Повторіть виконання з журналу.'};run.save()
    return True


def mirror_atomic(user,identifier,payload_hash,result,*,price_context=None):
    """Called in the existing small commit transaction; does not add business audit events."""
    existing=CatalogImportRun.objects.filter(pk=identifier).first()
    check(existing is None or existing.mode=='atomic' and existing.owner_id==user.pk and existing.metadata_hash==payload_hash,
          'Ключ повтору вже використано для іншого імпорту.','idempotency_conflict',409)
    if existing:return
    entries=result['entries'];now=timezone.now()
    actual={**counts(),'created':result['counts']['created'],'updated':result['counts']['updated']}
    run=CatalogImportRun.objects.create(id=identifier,owner=user,mode='atomic',expected_rows=len(entries),uploaded_rows=len(entries),
        price_context=price_context,metadata_hash=payload_hash,input_hash=payload_hash,status='completed',phase='finished',phase_done=len(entries),phase_total=len(entries),
        counts=actual,planned={'create':actual['created'],'update':actual['updated'],'skip':0},started_at=now,finished_at=now)
    CatalogImportRow.objects.bulk_create([CatalogImportRow(run=run,ordinal=index+1,line=item['line'],status='created' if item['action']=='create' else 'updated',
        action=item['action'],product_path='products/'+item['id'],revision=item['revision'],current_revision=item['revision'],input_hash='',price_result=item.get('priceResult')) for index,item in enumerate(entries)],batch_size=200)
