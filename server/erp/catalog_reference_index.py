"""Private request disk index for complete dictionary identity semantics.

Only page/detail maps enter memory. Explicit aliases and legacy product values
are streamed; Python clean/casefold, path order, tombstones and parent linkage
remain the original oracle. No cache grants, persisted snapshots or GET writes.
"""
import copy
import json
import os
import sqlite3
import tempfile
from time import monotonic
from collections.abc import Mapping
from django.db import connection
from .catalog_references import FIELDS, clean, identity, legacy_item, follow
from .catalog_selection import scalar_rows, BATCH, MAX_SECONDS, MAX_DISK
from .models import Document
from .services import BusinessError
from .catalog_budget import check

REFERENCE_FIELDS=('field','value','parentType','parentId','state','mergedInto')


class ReferenceIndexLimit(BusinessError):
    """A declared reference resource guard, distinct from unexpected failures."""


def require_resource(condition, message):
    if not condition:raise ReferenceIndexLimit(message)


class Aliases(list):
    def __init__(self, owner, identifier):self.owner=owner;self.identifier=identifier
    def __iter__(self):
        for value in self.owner.db.execute('SELECT data FROM aliases WHERE id=? ORDER BY position',(self.identifier,)):
            check();yield json.loads(value[0])
    def __len__(self):return self.owner.db.execute('SELECT COUNT(*) FROM aliases WHERE id=?',(self.identifier,)).fetchone()[0]
    def __contains__(self,value):return any(alias==value for alias in self)
    def append(self,value):self.owner.add_alias(self.identifier,value)
    def __deepcopy__(self,memo):return Aliases(self.owner,self.identifier)


class ReferenceIndex(Mapping):
    def __init__(self, *, legacy=True):
        self.directory=tempfile.TemporaryDirectory(prefix='tsukenya-references-')
        self.path=self.directory.name+'/index.sqlite3'
        self.db=sqlite3.connect(self.path);os.chmod(self.path,0o600)
        self.db.execute('PRAGMA cache_size=-2048');self.db.execute('PRAGMA temp_store=FILE')
        self.db.execute('PRAGMA journal_mode=OFF');self.db.execute('PRAGMA synchronous=OFF')
        self.db.execute('PRAGMA max_page_count='+str(MAX_DISK//self.db.execute('PRAGMA page_size').fetchone()[0]))
        self.db.create_collation('fold',lambda a,b:(a.casefold()>b.casefold())-(a.casefold()<b.casefold()))
        self.db.create_function('contains',2,lambda value,q:q.casefold() in value.casefold())
        self.db.execute('CREATE TABLE items(id TEXT PRIMARY KEY,position INTEGER UNIQUE,field TEXT,value TEXT,parent TEXT,parentId TEXT,state TEXT,data TEXT)')
        self.db.execute('CREATE TABLE aliases(id TEXT,position INTEGER,data TEXT,PRIMARY KEY(id,position))')
        self.db.execute('CREATE TABLE keys(id TEXT,field TEXT,value TEXT,parent TEXT,canonical INTEGER,UNIQUE(id,field,value,parent,canonical))')
        self.db.execute('CREATE INDEX identity_lookup ON keys(field,value,parent,canonical)')
        self.db.execute('CREATE INDEX item_page ON items(field,state,value COLLATE fold,value,id)')
        self.db.execute('CREATE INDEX item_parent_id_page ON items(field,state,parentId,value COLLATE fold,value,id)')
        self.db.execute('CREATE INDEX item_parent_page ON items(field,state,parent,value COLLATE fold,value,id)')
        self.started=monotonic();self.position=0
        try:self.build(legacy=legacy)
        except BaseException:self.close();raise

    def __enter__(self):return self
    def __exit__(self,*args):self.close()
    def close(self):
        if getattr(self,'db',None):self.db.close();self.db=None
        if getattr(self,'directory',None):self.directory.cleanup();self.directory=None
    def __del__(self):self.close()
    def guard(self):
        check()
        require_resource(monotonic()-self.started<MAX_SECONDS,'Перевірка довідників перевищила ліміт часу. Повторіть читання.')
        pages=self.db.execute('PRAGMA page_count').fetchone()[0];size=self.db.execute('PRAGMA page_size').fetchone()[0]
        require_resource(pages*size<=MAX_DISK,'Довідники перевищили ліміт тимчасового диска. Виправте джерело й повторіть читання.')
    def __len__(self):return self.db.execute('SELECT COUNT(*) FROM items').fetchone()[0]
    def __iter__(self):
        check()
        cursor=self.db.execute('SELECT id FROM items ORDER BY position')
        try:
            while True:
                check()
                row=cursor.fetchone()
                if row is None:return
                yield row[0]
        finally:cursor.close()
    def __getitem__(self,identifier):
        check()
        row=self.db.execute('SELECT data FROM items WHERE id=?',(identifier,)).fetchone()
        if row is None:raise KeyError(identifier)
        item=json.loads(row[0]);item['aliases']=Aliases(self,identifier);return item
    def __contains__(self,identifier):return isinstance(identifier,str) and self.db.execute('SELECT 1 FROM items WHERE id=?',(identifier,)).fetchone() is not None
    def values(self):
        for identifier in self:yield self[identifier]
    def put(self,item):
        check()
        identifier=item['id'];position=self.db.execute('SELECT position FROM items WHERE id=?',(identifier,)).fetchone()
        if position is None:self.position+=1;position=(self.position,)
        encoded=json.dumps({key:value for key,value in item.items() if key!='aliases'},ensure_ascii=False,separators=(',',':'))
        require_resource(len(encoded.encode())<=65536,'Довідникові поля перевищують 64 КіБ.')
        self.db.execute('INSERT OR REPLACE INTO items VALUES (?,?,?,?,?,?,?,?)',(identifier,position[0],item['field'],item['value'],item['parentType'],item.get('parentId'),item['state'],encoded))
        self.db.execute('DELETE FROM keys WHERE id=? AND canonical=1',(identifier,))
        self.key(identifier,identity(item['field'],item['value'],item['parentType']),True)
    def key(self,identifier,value,canonical=False):
        self.db.execute('INSERT OR IGNORE INTO keys VALUES (?,?,?,?,?)',(identifier,*value,int(canonical)))
    def add_alias(self,identifier,value,*,deduplicate=True):
        encoded=json.dumps(value,ensure_ascii=False,separators=(',',':'))
        require_resource(len(encoded.encode())<=65536,'Попередня назва довідника перевищує 64 КіБ.')
        if deduplicate and self.db.execute('SELECT 1 FROM aliases WHERE id=? AND data=?',(identifier,encoded)).fetchone():return
        position=self.db.execute('SELECT coalesce(max(position),0)+1 FROM aliases WHERE id=?',(identifier,)).fetchone()[0]
        self.db.execute('INSERT INTO aliases VALUES (?,?,?)',(identifier,position,encoded))
        if isinstance(value,dict) and isinstance(value.get('value'),str) and isinstance(value.get('parentType',''),str):
            item=self[identifier];self.key(identifier,identity(item['field'],value['value'],value.get('parentType','')))
    def lookup(self,field,text,parent=''):
        key=identity(field,text,parent)
        row=self.db.execute('''SELECT items.id FROM keys JOIN items USING(id) WHERE keys.field=? AND keys.value=? AND keys.parent=?
          ORDER BY canonical DESC,(state!='active'),position LIMIT 1''',key).fetchone()
        if row is None:return None
        item=self[row[0]];return follow(item,self) or item
    def claimed(self,key):return self.db.execute('SELECT 1 FROM keys WHERE field=? AND value=? AND parent=? LIMIT 1',key).fetchone() is not None
    def group(self,text,*,aliases=True):
        if aliases:
            row=self.db.execute("SELECT items.id FROM keys JOIN items USING(id) WHERE keys.field='type' AND keys.value=? ORDER BY position DESC LIMIT 1",(clean(text).casefold(),)).fetchone()
        else:
            row=self.db.execute("SELECT items.id FROM keys JOIN items USING(id) WHERE keys.field='type' AND keys.value=? AND canonical=1 ORDER BY position DESC LIMIT 1",(clean(text).casefold(),)).fetchone()
        return self[row[0]] if row else None
    def collisions(self,item,*,active=True):
        args=[item['id'],item['id']]
        where=" AND other.state='active'" if active else ''
        row=self.db.execute('''SELECT other.id FROM keys source JOIN keys collision
          ON source.field=collision.field AND source.value=collision.value AND source.parent=collision.parent
          JOIN items other ON other.id=collision.id WHERE source.id=? AND other.id!=?'''+where+' ORDER BY other.position LIMIT 1',args).fetchone()
        return self[row[0]] if row else None
    def add_legacy(self,field,text,parent=''):
        if not isinstance(text,str) or not clean(text) or len(clean(text))>FIELDS[field]:return
        key=identity(field,text,parent)
        if self.claimed(key):return
        self.put({**legacy_item(field,text,parent),'state':'active'})
    def build(self,*,legacy):
        rows=scalar_rows(Document.objects.filter(path__startswith='catalog_refs/'),REFERENCE_FIELDS,present=('state','parentType','parentId','mergedInto')).iterator(chunk_size=BATCH)
        try:
            for path,data,present,parent_present,parent_id_present,merged_present in rows:
                self.guard();require_resource(data is not None,'Довідникові поля перевищують 64 КіБ.')
                field,text,parent=data.get('field'),data.get('value'),data.get('parentType')
                # Missing parentType has the old empty default; explicit null is
                # invalid just as reference_records, so preserve presence below.
                if not parent_present:parent=''
                if not isinstance(field,str) or field not in FIELDS or not isinstance(text,str) or not clean(text) or not isinstance(parent,str):continue
                state=data['state'] if present else 'active'
                if state not in {'active','archived','merged'}:continue
                item={'id':path.split('/',1)[1],'field':field,'value':text,'parentType':parent if field=='category' else '', 'state':state}
                # Preserve absence for the old supported-item revision spelling.
                for key,exists in (('parentId',parent_id_present),('mergedInto',merged_present)):
                    if exists:item[key]=data[key]
                self.put(item)
        finally:rows.close()
        self.load_aliases()
        for identifier in self:
            item=self[identifier]
            if item['field']!='category':continue
            parent=self.get(item.get('parentId')) or self.group(item['parentType'])
            if parent and parent['field']=='type':
                item['parentId']=parent['id']
                if item['parentType']!=parent['value']:self.add_alias(identifier,{'value':item['value'],'parentType':item['parentType']})
                item['parentType']=parent['value'];self.put(item)
        if legacy:
            rows=scalar_rows(Document.objects.filter(path__startswith='products/'),tuple(FIELDS)).iterator(chunk_size=BATCH)
            try:
                for path,data in rows:
                    self.guard();require_resource(data is not None,'Довідникові поля товару перевищують 64 КіБ.')
                    parent=data.get('type','');parent=parent if isinstance(parent,str) else ''
                    for field in FIELDS:self.add_legacy(field,data.get(field),parent)
            finally:rows.close()
        self.add_legacy('unit','шт')
        for identifier in self:
            item=self[identifier]
            if item['field']=='category' and not item.get('parentId'):
                parent=self.group(item['parentType'],aliases=False)
                if parent:item['parentId']=parent['id'];self.put(item)
        self.db.commit();self.guard()
    def load_aliases(self):
        table=connection.ops.quote_name(Document._meta.db_table)
        if connection.vendor=='postgresql':
            scalar="""CASE WHEN jsonb_typeof(alias)='object' THEN
                (SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(alias) WHERE key IN ('value','parentType'))
                WHEN octet_length(alias::text)<=65536 THEN alias ELSE 'null'::jsonb END"""
            sql=f'''SELECT {table}.path,CASE WHEN octet_length(({scalar})::text)<=65536 THEN {scalar} ELSE NULL END,
              octet_length(({scalar})::text)>65536
              FROM {table} CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(data->'aliases')='array' THEN data->'aliases' ELSE '[]'::jsonb END) WITH ORDINALITY children(alias,n)
              WHERE {table}.path LIKE %s ORDER BY {table}.path,n'''
        else:
            atom="CASE WHEN alias.type IN ('true','false','null') THEN alias.type WHEN alias.type IN ('object','array') THEN alias.value ELSE json_quote(alias.value) END"
            fields="(SELECT coalesce(json_group_object(key,json(CASE WHEN type IN ('true','false','null') THEN type WHEN type IN ('object','array') THEN value ELSE json_quote(value) END)),'{}') FROM json_each(alias.value) WHERE key IN ('value','parentType'))"
            scalar=f"CASE WHEN alias.type='object' THEN {fields} WHEN length(CAST(({atom}) AS BLOB))<=65536 THEN {atom} ELSE 'null' END"
            sql=f'''SELECT {table}.path,CASE WHEN length(CAST(({scalar}) AS BLOB))<=65536 THEN {scalar} ELSE NULL END,
              length(CAST(({scalar}) AS BLOB))>65536
              FROM {table},json_each(CASE WHEN json_type(data,'$.aliases')='array' THEN json_extract(data,'$.aliases') ELSE '[]' END) alias
              WHERE {table}.path LIKE %s ORDER BY {table}.path,CAST(alias.key AS INTEGER)'''
        with connection.chunked_cursor() as cursor:
            cursor.execute(sql,['catalog_refs/%'])
            while rows:=cursor.fetchmany(BATCH):
                for path,value,oversized in rows:
                    self.guard();identifier=path.split('/',1)[1]
                    if identifier not in self:continue
                    require_resource(not oversized,'Попередня назва довідника перевищує 64 КіБ.')
                    require_resource((len(value.encode()) if isinstance(value,str) else len(json.dumps(value).encode()))<=65536,'Попередня назва довідника перевищує 64 КіБ.')
                    alias=json.loads(value) if isinstance(value,str) else value
                    self.add_alias(identifier,alias,deduplicate=False)
    def page(self,field,state,q,parentId,parentType,number):
        args=[field,state,q];where='field=? AND state=? AND contains(value,?)'
        if field=='category':
            if parentId is not None:where+=' AND parentId=?';args.append(parentId)
            elif parentType is not None:where+=' AND parent=?';args.append(parentType)
        total=self.db.execute('SELECT COUNT(*) FROM items WHERE '+where,args).fetchone()[0];pages=max(1,(total+29)//30);number=min(number,pages)
        items=[self[row[0]] for row in self.db.execute('SELECT id FROM items WHERE '+where+' ORDER BY value COLLATE fold,value,id LIMIT 30 OFFSET ?',[*args,(number-1)*30])]
        return items,total,number,pages

    def clone(self):
        result=object.__new__(ReferenceIndex)
        result.directory=tempfile.TemporaryDirectory(prefix='tsukenya-reference-plan-');result.path=result.directory.name+'/index.sqlite3'
        result.db=sqlite3.connect(result.path);os.chmod(result.path,0o600)
        result.db.create_collation('fold',lambda a,b:(a.casefold()>b.casefold())-(a.casefold()<b.casefold()))
        result.db.create_function('contains',2,lambda value,q:q.casefold() in value.casefold())
        result.db.execute('PRAGMA journal_mode=OFF');result.db.execute('PRAGMA synchronous=OFF')
        result.db.execute('PRAGMA cache_size=-2048');result.db.execute('PRAGMA temp_store=FILE')
        self.db.commit();self.db.backup(result.db,pages=200)
        result.db.execute('PRAGMA max_page_count='+str(MAX_DISK//result.db.execute('PRAGMA page_size').fetchone()[0]))
        result.started=self.started;result.position=self.position;return result
