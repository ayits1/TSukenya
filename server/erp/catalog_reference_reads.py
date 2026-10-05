"""Paged editor/management options and selected-ID metadata in caller fresh RR."""
import re
from .catalog_references import FIELDS, identity, clean
from .catalog_reference_management import serialize
from .catalog_reference_index import ReferenceIndex
from .services import require, current_actor,Conflict
from .historical_reports import read_snapshot
from .catalog_budget import bounded,check

ID=re.compile('[A-Za-z0-9_-]{1,120}')


def parameters(params):
    allowed={'field','q','state','parentId','parentType','page'}
    require(not(set(params)-allowed) and all(len(params.getlist(key))==1 for key in params),'Некоректні параметри довідника.')
    field=params.get('field');state=params.get('state','active');q=params.get('q','')
    require(field in FIELDS and state in {'active','archived','merged'},'Невідомий довідник або стан.')
    require(len(q)<=250,'Пошук довідника задовгий.')
    parent_id=params.get('parentId');parent=params.get('parentType')
    require(not(parent_id is not None and parent is not None),'Вкажіть лише один контекст групи.')
    require(parent_id is None or ID.fullmatch(parent_id),'Некоректний ID групи.')
    require(parent is None or len(parent)<=160,'Некоректна назва групи.')
    require(field=='category' or parent_id is None and parent is None,'Група дозволена лише для категорії.')
    raw=params.get('page','1');require(re.fullmatch('[1-9][0-9]{0,9}',raw),'Некоректна сторінка.')
    return {'field':field,'q':q,'state':state,'parentId':parent_id,'parentType':parent},int(raw)


@bounded
def handle(request,user):
    from .views import response,body
    from .catalog import EDIT_ROLES
    with read_snapshot():
        user=current_actor(user)
        if request.method=='POST' and request.path.rstrip('/').endswith('/impact-page'):
            require(user.profile.role in EDIT_ROLES,'Недостатньо прав для керування довідниками.')
            from .catalog_reference_management import plan,request_value
            value=body(request)
            require(set(value)=={'request','snapshot','section','page'},'Некоректні поля сторінки впливу.')
            require(isinstance(value['snapshot'],str) and re.fullmatch('[0-9a-f]{64}',value['snapshot']),'Відсутній перевірений вплив.')
            require(isinstance(value['section'],str) and value['section'] in {'products','references','coalesced','blocked'} and type(value['page']) is int and 0<value['page']<=9999999999,'Некоректна сторінка впливу.')
            result,updated,changed,products,before=plan(request_value(value['request']))
            try:
                if result['snapshot']!=value['snapshot']:raise Conflict('Вплив змінився. Перегляньте його знову.','snapshot_conflict')
                items,total,number,pages=changed.page(value['section'],value['page'],before)
                check()
                return response({'contract':'catalog-reference-impact-page-v1','snapshot':result['snapshot'],'section':value['section'],'items':items,'total':total,'page':number,'pages':pages,'limit':30})
            finally:updated.close();before.close()
        with ReferenceIndex() as records:
            if request.method=='GET' and request.path.rstrip('/').endswith('/page'):
                query,number=parameters(request.GET)
                if query['parentId'] is not None:
                    group=records.get(query['parentId']);require(group is not None and group['field']=='type','Групу не знайдено. Перечитайте вибір.')
                items,total,number,pages=records.page(query['field'],query['state'],query['q'],query['parentId'],query['parentType'],number)
                return response({'contract':'catalog-reference-page-v1','items':[serialize(item) for item in items],
                    'total':total,'page':number,'pages':pages,'limit':30,'query':query,'canEdit':user.profile.role in EDIT_ROLES,'csrf':request.portal_session.csrf})
            if request.method=='POST' and request.path.rstrip('/').endswith('/details'):
                value=body(request);require(set(value)<={'items','product'} and isinstance(value.get('items'),list) and len(value['items'])<=20,'Надішліть не більше20 вибраних значень довідника.')
                if 'product' in value:require(isinstance(value['product'],str) and ID.fullmatch(value['product']),'Некоректний товар вибраних значень.')
                result=[];seen=set()
                for selected in value['items']:
                    require(isinstance(selected,dict) and set(selected)<={'field','id','value','parentType'} and selected.get('field') in FIELDS,'Некоректне вибране значення.')
                    field=selected['field'];text=selected.get('value','');parent=selected.get('parentType','');identifier=selected.get('id')
                    require(isinstance(text,str) and len(text)<=FIELDS[field] and isinstance(parent,str) and len(parent)<=160,'Некоректний підпис вибраного значення.')
                    require(identifier is None or isinstance(identifier,str) and ID.fullmatch(identifier),'Некоректний ID вибраного значення.')
                    require(field=='category' or not parent,'Група дозволена лише для категорії.')
                    key=(field,identifier,text,parent);require(key not in seen,'Вибрані значення повторюються.');seen.add(key)
                    item=records.get(identifier) if identifier else records.lookup(field,text,parent) if text else None
                    require(item is None or item['field']==field,'ID належить іншому довіднику.')
                    # A caller-owned missing ID is unresolved, never inferred archive
                    # or substituted with a matching text from another identity.
                    result.append({'selected':selected,'item':serialize(item) if item else None,'resolved':item is not None})
                return response({'contract':'catalog-reference-details-v1','items':result,'canEdit':user.profile.role in EDIT_ROLES})
    return response({'error':'Метод довідника не підтримується.','code':'unsupported_route'},405)
