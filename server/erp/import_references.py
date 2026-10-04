"""One bounded explicit dictionary read/materialization per locked worker step."""
from .models import Document
from .catalog_references import reference_records,FIELDS,keys,identity,legacy_item,clean,follow
from .catalog_import import canonical
from .services import BusinessError


class ReferenceLimit(BusinessError):pass


class ReferenceCache:
    def __init__(self):
        explicit=[];size=0
        for doc in Document.objects.filter(path__startswith='catalog_refs/').order_by('path').iterator(chunk_size=100):
            size+=len(canonical(doc.data).encode());explicit.append(doc)
            if len(explicit)>5000 or size>2097152:raise ReferenceLimit('Довідники перевищують ліміт великого імпорту.')
        self.records=reference_records(explicit_records=explicit,legacy_values=[])
        self.canonical={};self.aliases={};self.claimed=set();self.order={}
        for position,item in enumerate(self.records.values()):
            self.order[item['id']]=position
            self.canonical.setdefault(identity(item['field'],item['value'],item['parentType']),[]).append(item)
            for key in keys(item):self.aliases.setdefault(key,[]).append(item);self.claimed.add(key)
    def scope(self,old,values):return ReferenceScope(self,old,values)


class ReferenceScope:
    def __init__(self,cache,old,values):
        self.cache=cache;self.legacy={};added=set()
        for data in (old,{**old,**values}):
            parent=data.get('type','');parent=parent if isinstance(parent,str) else ''
            for field,maximum in FIELDS.items():
                text=data.get(field)
                if not isinstance(text,str) or not clean(text) or len(clean(text))>maximum:continue
                key=identity(field,text,parent)
                if key in cache.claimed or key in added:continue
                item=legacy_item(field,text,parent);self.legacy[item['id']]={**item,'state':'active','aliases':[]};added.add(key)
    def __contains__(self,key):return key in self.legacy or key in self.cache.records
    def get(self,key,default=None):return self.legacy.get(key,self.cache.records.get(key,default))
    def lookup(self,field,text,parent=''):
        key=identity(field,text,parent)
        exact=[item for item in self.cache.canonical.get(key,[]) if item['id'] not in self.legacy]
        exact.extend(item for item in self.legacy.values() if identity(item['field'],item['value'],item['parentType'])==key)
        matches=exact or [item for item in self.cache.aliases.get(key,[]) if item['id'] not in self.legacy]
        if not matches:return None
        match=min(matches,key=lambda item:(item['state']!='active',self.cache.order.get(item['id'],len(self.cache.order)+list(self.legacy).index(item['id']) if item['id'] in self.legacy else len(self.cache.order))))
        return follow(match,self) or match
