"""Worker-scoped complete references with disk-backed aliases and identities."""
from .catalog_reference_index import ReferenceIndex
from .catalog_references import FIELDS, identity, legacy_item, clean, follow
from .services import BusinessError

class ReferenceLimit(BusinessError):pass

class ReferenceCache:
    def __init__(self):
        self.records=ReferenceIndex(legacy=False)
    def scope(self,old,values):return ReferenceScope(self,old,values)
    def close(self):self.records.close()
    def __del__(self):
        if hasattr(self,'records'):self.records.close()

class ReferenceScope:
    def __init__(self,cache,old,values):
        self.cache=cache;self.legacy={};added=set()
        for data in (old,{**old,**values}):
            parent=data.get('type','');parent=parent if isinstance(parent,str) else ''
            for field,maximum in FIELDS.items():
                text=data.get(field)
                if not isinstance(text,str) or not clean(text) or len(clean(text))>maximum:continue
                key=identity(field,text,parent)
                if cache.records.claimed(key) or key in added:continue
                item=legacy_item(field,text,parent);self.legacy[item['id']]={**item,'state':'active','aliases':[]};added.add(key)
    def __contains__(self,key):return key in self.legacy or key in self.cache.records
    def get(self,key,default=None):return self.legacy.get(key,self.cache.records.get(key,default))
    def lookup(self,field,text,parent=''):
        item=self.cache.records.lookup(field,text,parent)
        if item:return item
        key=identity(field,text,parent)
        return next((item for item in self.legacy.values() if identity(item['field'],item['value'],item['parentType'])==key),None)
