"""Freeze approved/legacy recipe terms and post actual manufacturing using existing stock rules."""
from datetime import timedelta
from decimal import Decimal
import uuid
from .models import Document, RecipeVersion, VoucherLine, ProductionInput
from .services import require, dec, day, QTY, ZERO, outgoing, incoming, audit
from .recipes_versions import terms, product_id


def quantity(value,label,minimum=QTY):
    result=dec(value,label,QTY,minimum=minimum)
    require(result<=999999999999999,f'{label}: значення завелике.')
    return result


def components_snapshot(rows,output):
    require(isinstance(rows,list) and 1<=len(rows)<=100,'Для готового товару задайте рецептуру.')
    normalized=[];seen=set()
    for row in rows:
        require(isinstance(row,dict) and set(row)=={'product','quantity'},'Некоректний інгредієнт рецептури.')
        path='products/'+product_id(row['product'])
        require(path!=output.product_id and path not in seen,'Інгредієнт не може повторюватись або збігатися з готовим товаром.');seen.add(path)
        ingredient=Document.objects.filter(pk=path).first();require(ingredient is not None,'Інгредієнт рецептури відсутній.')
        normalized.append({'product':row['product'],'name':str(ingredient.data.get('name') or '')[:250],'unit':str(ingredient.data.get('unit','шт'))[:30],'quantity':str(quantity(row['quantity'],'Кількість інгредієнта'))})
    return normalized


def freeze_production(user,v,payload,previous):
    require(dec(v.payload.get('additional_cost',0))==ZERO,'Додаткові виробничі витрати не підтримуються. Приберіть суму з чернетки; зарплату й накладні витрати обліковуйте окремо.')
    if dec(previous.get('additional_cost',0))!=ZERO:
        require(user.profile.role=='owner' and 'additional_cost' in payload and dec(payload['additional_cost'])==ZERO,'Власник має явно прибрати непідтримувані додаткові виробничі витрати з чернетки.')
    lines=list(v.lines.select_related('product'))
    require(len(lines)==1,'Виробництво оформлюється для одного готового товару.')
    output=lines[0]
    value=payload.get('production')
    if value is None:
        # An old draft keeps its original server snapshot even if the live recipe was edited.
        prior=previous.get('production',{})
        saved=prior.get('terms') if prior.get('source')=='legacy' and prior.get('terms',{}).get('product')==output.product_id.split('/',1)[1] else None
        recipe=saved or {'id':None,'product':output.product_id.split('/',1)[1],'version':None,'name':output.name,'unit':output.unit,'outputQuantity':'1.000','expiryPolicy':'unspecified','shelfLifeDays':None,'components':components_snapshot(payload.get('recipe') or output.product.data.get('recipe',[]),output)}
        planned=output.quantity
        value={'plannedOutput':str(planned),'varianceReason':'','expiryOverride':None}
        v.recipe_version=None
        source='legacy'
    else:
        require(isinstance(value,dict) and not(set(value)-{'recipeVersion','plannedOutput','actualComponents','varianceReason','expiryOverride'}),'Некоректні реквізити виробництва.')
        try:identifier=uuid.UUID(value.get('recipeVersion')) if isinstance(value.get('recipeVersion'),str) else None
        except ValueError:identifier=None
        require(identifier is not None,'Оберіть затверджену версію рецептури.')
        version=RecipeVersion.objects.select_related('approved_by').prefetch_related('components').filter(pk=identifier,product=output.product).first()
        require(version is not None,'Версія рецептури не належить готовому товару.')
        recipe=terms(version);v.recipe_version=version;source='version'
        planned=quantity(value.get('plannedOutput'),'Плановий вихід')
    require(output.unit==recipe['unit'],'Одиниця готового товару відрізняється від затвердженої рецептури.')
    expected=[]
    for row in recipe['components']:
        ingredient=Document.objects.filter(pk='products/'+row['product']).first()
        require(ingredient and str(ingredient.data.get('unit','шт'))==row['unit'],'Одиницю інгредієнта змінено. Потрібна нова затверджена версія.')
        scaled=Decimal(row['quantity'])*planned/Decimal(recipe['outputQuantity'])
        require(scaled<=Decimal('999999999999'),'Розрахована кількість інгредієнта завелика.')
        require(scaled==scaled.quantize(QTY) and scaled>=QTY,'Плановий вихід дає кількість інгредієнта менш ніж 0,001 або понад 3 знаки. Змініть розмір виробничої партії.')
        expected.append({**row,'expectedQuantity':str(scaled.quantize(QTY)),'quantity':str(scaled.quantize(QTY)),'lot':''})
    actual=value.get('actualComponents')
    if actual is not None:
        require(isinstance(actual,list) and len(actual)==len(expected),'Фактичні інгредієнти повинні відповідати затвердженому складу.')
        actual_by_id={}
        for row in actual:
            require(isinstance(row,dict) and {'product','quantity'}<=set(row) and not(set(row)-{'product','quantity','lot'}),'Некоректний фактичний інгредієнт.')
            identifier=product_id(row['product']);require(identifier not in actual_by_id,'Фактичний інгредієнт повторюється.')
            lot=row.get('lot','');require(isinstance(lot,str) and len(lot.strip())<=80,'Некоректний номер партії інгредієнта.')
            actual_by_id[identifier]={'quantity':str(quantity(row['quantity'],'Фактична кількість інгредієнта',ZERO)),'lot':lot.strip()}
        require(set(actual_by_id)=={r['product'] for r in expected},'Фактичний склад повинен відповідати рецептурі; заміна потребує нової версії.')
        expected=[{**r,**actual_by_id[r['product']]} for r in expected]
    require(any(Decimal(row['quantity'])>0 for row in expected),'Виробництво потребує фактичного списання інгредієнта.')
    reason=value.get('varianceReason','');require(isinstance(reason,str) and len(reason.strip())<=500,'Некоректне пояснення відхилення.')
    deviation=planned!=output.quantity or any(Decimal(r['quantity'])!=Decimal(r['expectedQuantity']) for r in expected)
    require(not deviation or reason.strip(),'Поясніть відхилення фактичного виходу або витрати інгредієнтів.')
    override=value.get('expiryOverride')
    if override is not None:
        require(user.profile.role=='owner','Ручну технологічну дату затверджує власник.')
        require(isinstance(override,dict) and set(override)=={'date','reason'},'Некоректна ручна технологічна дата.')
        require(isinstance(override['date'],str) and isinstance(override['reason'],str) and 0<len(override['reason'].strip())<=500,'Вкажіть ручну дату та технологічне обґрунтування.')
        expiry=day(override['date']);require(expiry>=v.date,'Придатність не може завершитися до виробництва.')
        override={'date':expiry.isoformat(),'reason':override['reason'].strip(),'approvedBy':user.username}
    # A raw output-row date is never mistaken for a calculated or approved technology policy.
    require(output.expiry is None or override is not None and output.expiry.isoformat()==override['date'],'Дату готового товару задавайте явно з технологічним обґрунтуванням.')
    v.production_inputs.all().delete()
    for row in expected:ProductionInput.objects.create(voucher=v,product_id='products/'+row['product'],name=row['name'],unit=row['unit'],expected_quantity=Decimal(row['expectedQuantity']),quantity=Decimal(row['quantity']),lot=row['lot'])
    v.payload['production']={'source':source,'terms':recipe,'plannedOutput':str(planned),'actualOutput':str(output.quantity),'components':expected,'varianceReason':reason.strip(),'expiryOverride':override}
    v.payload['recipe']=[{'product':r['product'],'quantity':r['quantity']} for r in recipe['components']]
    v.save(update_fields=['payload','recipe_version'])
    audit(user,'production_draft_saved',f'voucher/{v.pk}',{'before':audit_terms(previous.get('production')),'after':audit_terms(v.payload['production']),'reason':reason.strip() or 'Фіксація затверджених умов виробництва'})


def post_production(user,v,lines):
    require(len(lines)==1,'Виробництво оформлюється для одного готового товару.')
    output=lines[0]
    if not isinstance(v.payload.get('production'),dict):
        # Existing unposted documents acquire a server snapshot; posted history is never rewritten.
        freeze_production(user,v,v.payload,{})
    production=v.payload['production'];recipe=production['terms']
    before=audit_terms(production)
    require(output.unit==recipe['unit'],'Одиниця готового товару відрізняється від рецептури.')
    require(dec(v.payload.get('additional_cost',0))==ZERO,'Додаткові виробничі витрати не підтримуються. Власник має прибрати суму з чернетки перед проведенням.')
    cost=ZERO
    normalized=[];expiries=[];all_known=True
    for row in production['components']:
        qty=quantity(row['quantity'],'Фактична кількість інгредієнта',ZERO)
        if not qty:continue
        product=Document.objects.filter(pk='products/'+row['product']).first()
        require(product is not None,'Інгредієнт збереженої рецептури відсутній.')
        require(str(product.data.get('unit','шт'))==row['unit'],'Одиницю інгредієнта змінено після збереження виробництва.')
        proxy=VoucherLine(product=product,name=row['name'],unit=row['unit'],lot=row['lot'])
        value,consumed=outgoing(v,proxy,qty)
        cost+=value
        lots=[]
        for lot,take,amount in consumed:
            if lot.expiry is None:all_known=False
            else:expiries.append(lot.expiry)
            lots.append({'id':lot.pk,'code':lot.code,'quantity':str(take),'value':str(amount),'expiry':lot.expiry.isoformat() if lot.expiry else None})
        normalized.append({'product':row['product'],'quantity':str(qty),'cost':str(value),'lots':lots})
    policy=recipe['expiryPolicy'];override=production['expiryOverride'];computed=None;expiry=None
    if policy!='unspecified':
        require(all_known and expiries or override is not None,'Термін сировини невідомий. Власник має явно затвердити технологічну дату або потрібна інша затверджена політика.')
        if all_known and expiries:
            computed=min(expiries)
            if policy=='minimum_with_shelf_life':computed=min(computed,v.date+timedelta(days=recipe['shelfLifeDays']))
            expiry=computed
    if override:
        require(user.profile.role=='owner','Ручну технологічну дату має провести власник.')
        expiry=day(override['date']);boundary=computed or (min(expiries) if expiries else None)
        require(boundary is None or expiry<=boundary,'Ручна дата не може продовжувати відому межу придатності.')
    require(cost<=Decimal('9999999999999999.99'),'Собівартість випуску перевищує місткість облікового поля.')
    output.expiry=expiry
    output.cost=cost;output.save(update_fields=['cost','expiry'])
    lot=incoming(v,output,output.quantity,cost)
    planned=Decimal(production['plannedOutput']);actual=output.quantity
    production['result']={'actualOutput':str(actual),'plannedOutput':str(planned),'lossQuantity':str(max(planned-actual,ZERO)),'overrunQuantity':str(max(actual-planned,ZERO)),'materialCost':str(cost),'additionalCost':'0.00','totalCost':str(cost),'outputLot':lot.pk,'expiry':expiry.isoformat() if expiry else None,'expirySource':'owner_override' if override else 'calculated' if computed else 'unspecified','computedExpiry':computed.isoformat() if computed else None,'allComponentExpiriesKnown':all_known}
    v.payload['consumed']=normalized
    v.total=ZERO
    audit(user,'production_posted',f'voucher/{v.pk}',{'before':before,'after':audit_terms(production),'consumed':[{'product':r['product'],'quantity':r['quantity'],'cost':r['cost'],'lots':r['lots']} for r in normalized],'reason':production['varianceReason'] or 'Виробничий випуск за затвердженими умовами'})
    return cost


def audit_terms(value):
    """Only manufacturing fields enter the audit; imported arbitrary JSON is not copied."""
    from .business_audit import select
    if not isinstance(value,dict):return None
    result=select(value,('source','plannedOutput','actualOutput','varianceReason'))
    recipe=value.get('terms')
    if isinstance(recipe,dict):
        result['terms']=select(recipe,('id','product','version','name','unit','outputQuantity','expiryPolicy','shelfLifeDays','reason','approvedBy','approvedAt'))
        result['terms']['components']=[select(r,('product','name','unit','quantity')) for r in recipe.get('components',[]) if isinstance(r,dict)]
    result['components']=[select(r,('product','name','unit','quantity','expectedQuantity','lot')) for r in value.get('components',[]) if isinstance(r,dict)]
    if isinstance(value.get('expiryOverride'),dict):result['expiryOverride']=select(value['expiryOverride'],('date','reason','approvedBy'))
    if isinstance(value.get('result'),dict):result['result']=select(value['result'],('actualOutput','plannedOutput','lossQuantity','overrunQuantity','materialCost','additionalCost','totalCost','outputLot','expiry','expirySource','computedExpiry','allComponentExpiriesKnown'))
    return result
