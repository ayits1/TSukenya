"""Read-only bounded current review of immutable operation outcomes. Never a print proof."""
import hmac
import re
from .catalog import EDIT_ROLES,defaults,serialize
from .catalog_price_results import capture_context,scope_context,stored_store,terms,compare_terms
from .historical_reports import read_snapshot
from .labels import sign
from .models import Document
from .import_models import CatalogImportRun
from .promotion_prices import PriceResolver
from .services import current_actor,require


def preview(request,user,kind,identifier):
    from .views import body,response
    value=body(request)
    require(isinstance(value,dict) and set(value)<={'ordinals','page','snapshot'} and 'ordinals' in value,'Некоректний пакет перегляду цінників.')
    ordinals=value['ordinals'];page=value.get('page',1);expected=value.get('snapshot')
    require(isinstance(ordinals,list) and 0<len(ordinals)<=1000 and all(type(n) is int and 0<n<=100000 for n in ordinals) and len(set(ordinals))==len(ordinals),'Виберіть до 1000 різних підтверджених рядків.')
    require(type(page) is int and 0<page<=100000,'Некоректна сторінка перегляду.')
    require(expected is None or isinstance(expected,str) and re.fullmatch('[0-9a-f]{64}',expected),'Некоректний знімок перегляду.')
    ordinals=sorted(ordinals)
    with read_snapshot():
        user=current_actor(user)
        require(user.profile.role in ({'owner'} if kind=='pricing' else EDIT_ROLES),'Недостатньо прав для результату зміни цін.')
        if kind=='pricing':
            receipt=Document.objects.filter(pk='pricing_runs/'+identifier,data__owner=user.pk).first()
            if receipt is None:return response({'error':'Результат не знайдено.','code':'not_found'},404)
            context=receipt.data.get('priceContext')
            original=[entry['priceResult'] for entry in receipt.data['result']['entries'] if entry.get('priceResult') and entry['priceResult']['ordinal'] in ordinals]
        else:
            run=CatalogImportRun.objects.filter(pk=identifier,owner=user).first()
            if run is None:return response({'error':'Результат не знайдено.','code':'not_found'},404)
            context=run.price_context
            original=list(run.rows.filter(ordinal__in=ordinals,status__in=['created','updated','skipped'],price_result__isnull=False).order_by('ordinal').values_list('price_result',flat=True))
        require(context is not None,'Для цієї старої операції немає збереженої ціни до зміни.')
        scope_context(user,context)
        require(len(original)==len(ordinals),'Деякі рядки ще не підтверджені або відсутні в цій операції.')
        original.sort(key=lambda row:row['ordinal'])
        paths=['products/'+row['id'] for row in original]
        documents={doc.path:doc for doc in Document.objects.filter(pk__in=paths)}
        store=stored_store(user,context);config=defaults();resolver=PriceResolver(config,store,product_paths=paths)
        current_context=capture_context(store);items=[];selection=[]
        counts={'selected':len(original),'available':0,'hidden':0,'missing':0,'changedAfterOperation':0}
        for row in original:
            document=documents.get('products/'+row['id'])
            state='missing' if document is None else 'hidden' if document.data.get('hidden') is True else 'available'
            current=terms(document,config,resolver) if document else None
            compared=compare_terms(row['after'],current) if current else None
            changed=current is not None and (current['productRevision']!=row['after']['productRevision'] or current['effectivePriceRevision']!=row['after']['effectivePriceRevision'])
            counts[state]+=1;counts['changedAfterOperation']+=bool(changed)
            selection.append({'ordinal':row['ordinal'],'id':row['id']})
            items.append({'operationResult':row,'state':state,'current':serialize(document,user,config,resolver=resolver) if document else None,'currentTerms':current,
                'amountChanged':bool(compared and compared['retailChanged']),'displayChanged':bool(compared and compared['displayChanged']),
                'revisionChanged':bool(changed)})
        material={'operation':[kind,identifier],'context':current_context,'day':resolver.day.isoformat(),'rows':[
            [r['operationResult']['ordinal'],r['operationResult']['id'],r['operationResult']['after']['productRevision'],r['operationResult']['after']['effectivePriceRevision'],r['state'],r['currentTerms']] for r in items]}
        snapshot=sign(material)
        if expected is not None and not hmac.compare_digest(expected,snapshot):
            return response({'error':'Поточні ціни або доступність товарів уже змінилися. Прочитайте перегляд і підтвердьте вибір повторно.','code':'revision_conflict'},409)
        pages=max(1,(len(items)+99)//100);page=min(page,pages)
        return response({'operation':{'kind':kind,'id':identifier},'priceContext':current_context,'effectiveDay':resolver.day.isoformat(),'ordinals':ordinals,'selection':selection,
            'counts':counts,'canApply':counts['hidden']==0 and counts['missing']==0,'snapshot':snapshot,'total':len(items),'page':page,'pages':pages,'limit':100,'items':items[(page-1)*100:page*100]})
