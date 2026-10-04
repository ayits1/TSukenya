"""Create-only approved recipe versions. No edit route mutates already approved terms."""
import hashlib
import json
import re
import uuid
from django.db import transaction
from .models import Document, RecipeVersion, RecipeComponent
from .services import require, dec, QTY, ledger_lock, audit, Conflict

POLICIES = {'unspecified','components_min','minimum_with_shelf_life'}

def product_id(value):
    require(isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,120}',value), 'Некоректний товар рецептури.')
    return value

def terms(recipe):
    return {'id':str(recipe.pk),'product':recipe.product_id.split('/',1)[1],'version':recipe.version,
        'name':recipe.name,'unit':recipe.unit,'outputQuantity':str(recipe.output_quantity),
        'expiryPolicy':recipe.expiry_policy,'shelfLifeDays':recipe.shelf_life_days,
        'reason':recipe.reason,'approvedBy':recipe.approved_by.username,'approvedAt':recipe.approved_at.isoformat(),
        'components':[{'product':r.product_id.split('/',1)[1],'name':r.name,'unit':r.unit,'quantity':str(r.quantity)} for r in sorted(recipe.components.all(),key=lambda r:r.position)]}

@transaction.atomic
def create_version(request,user):
    from .views import body, response
    from .catalog import revision
    require(user.profile.role in {'owner','manager'}, 'Немає доступу до затвердження рецептури: потрібен власник або керівник.')
    ledger_lock()
    user.refresh_from_db(fields=['is_active'])
    user.profile.refresh_from_db()
    require(user.is_active and user.profile.role in {'owner','manager'}, 'Немає доступу до затвердження рецептури: потрібен власник або керівник.')
    value=body(request)
    fields={'idempotencyKey','product','expectedVersion','catalogRevision','outputQuantity','components','expiryPolicy','shelfLifeDays','reason'}
    require(set(value)==fields,'Некоректні реквізити версії рецептури.')
    try:identifier=uuid.UUID(value['idempotencyKey']) if isinstance(value['idempotencyKey'],str) else None
    except ValueError:identifier=None
    require(identifier is not None,'Некоректний ключ створення рецептури.')
    try:fingerprint=hashlib.sha256(json.dumps({k:v for k,v in value.items() if k!='idempotencyKey'},sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest()
    except (ValueError,TypeError):require(False,'Некоректні реквізити рецептури.')
    existing=RecipeVersion.objects.select_related('approved_by').prefetch_related('components').filter(pk=identifier).first()
    if existing:
        if existing.approved_by_id!=user.pk or existing.request_fingerprint!=fingerprint:raise Conflict('Ключ уже використано для іншого створення рецептури.','idempotency_conflict')
        return response(terms(existing))
    product=Document.objects.filter(pk='products/'+product_id(value['product'])).first()
    require(product and product.data.get('name') and not product.data.get('hidden'), 'Готовий товар відсутній або прихований.')
    require(isinstance(value['catalogRevision'],str),'Некоректна версія товару.')
    if value['catalogRevision']!=revision(product):raise Conflict('Товар змінено. Завантажте актуальні реквізити перед затвердженням.','revision_conflict')
    latest=RecipeVersion.objects.filter(product=product).order_by('-version').first()
    if value['expectedVersion']!=(str(latest.pk) if latest else None):raise Conflict('Рецептуру вже затверджено в іншому вікні. Чернетку збережено.','revision_conflict')
    output=dec(value['outputQuantity'],'Нормативний вихід',QTY,minimum=QTY)
    require(output<=999999999999999,'Нормативний вихід завеликий.')
    policy=value['expiryPolicy'];require(isinstance(policy,str) and policy in POLICIES,'Оберіть явну технологічну політику придатності.')
    shelf=value['shelfLifeDays']
    require((policy=='minimum_with_shelf_life' and type(shelf) is int and 1<=shelf<=3650) or (policy!='minimum_with_shelf_life' and shelf is None),'Вкажіть технологічний строк цілим числом днів або залиште порожнім для іншої політики.')
    require(isinstance(value['reason'],str) and 0<len(value['reason'].strip())<=500,'Вкажіть причину затвердження версії.')
    rows=value['components'];require(isinstance(rows,list) and 1<=len(rows)<=100,'Додайте від 1 до 100 інгредієнтів.')
    normalized=[];seen=set()
    for row in rows:
        require(isinstance(row,dict) and set(row)=={'product','quantity'},'Некоректний інгредієнт рецептури.')
        path='products/'+product_id(row['product']);require(path!=product.pk and path not in seen,'Інгредієнт не може повторюватися або збігатися з готовим товаром.');seen.add(path)
        ingredient=Document.objects.filter(pk=path).first();require(ingredient and ingredient.data.get('name') and not ingredient.data.get('hidden'),'Інгредієнт відсутній або прихований.')
        qty=dec(row['quantity'],'Кількість інгредієнта',QTY,minimum=QTY);require(qty<=999999999999999,'Кількість інгредієнта завелика.')
        normalized.append((ingredient,qty))
    recipe=RecipeVersion.objects.create(id=identifier,product=product,version=latest.version+1 if latest else 1,name=str(product.data['name'])[:250],unit=str(product.data.get('unit','шт'))[:30],output_quantity=output,expiry_policy=policy,shelf_life_days=shelf,reason=value['reason'].strip(),approved_by=user,request_fingerprint=fingerprint)
    for index,(ingredient,qty) in enumerate(normalized):RecipeComponent.objects.create(recipe=recipe,product=ingredient,name=str(ingredient.data['name'])[:250],unit=str(ingredient.data.get('unit','шт'))[:30],quantity=qty,position=index)
    snapshot=terms(recipe);audit(user,'recipe_version_approved','recipe/'+str(recipe.pk),{'before':None,'after':snapshot,'reason':recipe.reason,'observedVersion':value['expectedVersion']})
    return response(snapshot,201)

def handle_versions(request,user):
    if request.method=='GET':
        from .historical_reports import read_snapshot
        with read_snapshot():
            from .services import current_actor
            return _handle_versions(request,current_actor(user))
    return _handle_versions(request,user)

def _handle_versions(request,user):
    from .views import response
    from .catalog import revision
    require(user.profile.role in {'owner','manager','warehouse'},'Недостатньо прав для рецептур.')
    path=request.path.rstrip('/')
    if path=='/api/erp/recipes/versions':
        if request.method=='POST':return create_version(request,user)
        if request.method=='GET':
            product=Document.objects.filter(pk='products/'+product_id(request.GET.get('product'))).first();require(product is not None,'Готовий товар не знайдено.')
            recipes=RecipeVersion.objects.filter(product=product).select_related('approved_by').prefetch_related('components').order_by('-version')
            from .promotions import paginate
            rows,page=paginate(request,recipes)
            latest=recipes.first()
            return response({**page,'items':[terms(r) for r in rows],'product':{'id':product.path.split('/',1)[1],'name':str(product.data.get('name') or ''),'unit':str(product.data.get('unit','шт'))},'catalogRevision':revision(product),'latestVersion':str(latest.pk) if latest else None,'legacyRecipe':product.data.get('recipe',[]),'canApprove':user.profile.role in {'owner','manager'}})
    match=re.fullmatch(r'/api/erp/recipes/versions/([0-9a-f-]{36})',path)
    if match and request.method=='GET':
        try:identifier=uuid.UUID(match[1])
        except ValueError:require(False,'Некоректна версія рецептури.')
        recipe=RecipeVersion.objects.select_related('approved_by').prefetch_related('components').filter(pk=identifier).first()
        if not recipe:return response({'error':'Версію рецептури не знайдено.'},404)
        return response(terms(recipe))
    return response({'error':'Метод рецептури не підтримується.'},405)
