"""Disk-backed whole B30 impact; scalar product patches retain unknown JSON."""
import json
from .catalog_references import FIELDS,find_reference
from .catalog_reference_index import ReferenceIndex
from .catalog_selection import scalar_rows,BATCH
from .models import Document
from .services import require


class Changes:
    def __init__(self,records):
        self.records=records;self.db=records.db
        self.db.execute('CREATE TABLE changes(path TEXT PRIMARY KEY,before TEXT,patch TEXT,name TEXT)')
        self.db.execute('CREATE TABLE usage(path TEXT PRIMARY KEY)')
        self.db.execute('CREATE TABLE blocked(path TEXT PRIMARY KEY,message TEXT)')
        self.db.execute('CREATE TABLE changed(id TEXT PRIMARY KEY)')
        self.db.execute('CREATE TABLE redirects(source TEXT PRIMARY KEY,target TEXT)')
        self.db.execute('CREATE TABLE coalesced(source TEXT PRIMARY KEY,data TEXT)')
    def add(self,identifier):self.db.execute('INSERT OR IGNORE INTO changed VALUES (?)',(identifier,))
    def __contains__(self,identifier):return self.db.execute('SELECT 1 FROM changed WHERE id=?',(identifier,)).fetchone() is not None
    def __iter__(self):
        for row in self.db.execute('SELECT id FROM changed ORDER BY id'):yield row[0]
    def __len__(self):return self.db.execute('SELECT COUNT(*) FROM changed').fetchone()[0]
    def redirect(self,source,target):self.db.execute('INSERT OR REPLACE INTO redirects VALUES (?,?)',(source,target))
    def destination(self,source):
        row=self.db.execute('SELECT target FROM redirects WHERE source=?',(source,)).fetchone();return row[0] if row else source
    def coalesce(self,source,target,value):self.db.execute('INSERT INTO coalesced VALUES (?,?)',(source,json.dumps({'sourceId':source,'targetId':target,'value':value},ensure_ascii=False)))
    def count(self,table):
        require(table in {'changes','usage','blocked','coalesced'},'Невідомий вплив довідника.')
        return self.db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]
    def products(self):
        for path,before,patch in self.db.execute('SELECT path,before,patch FROM changes ORDER BY path'):
            yield Document(path=path,data=json.loads(before)),json.loads(patch)
    def examples(self):return [{'id':path.split('/',1)[1],'name':name} for path,name in self.db.execute('SELECT path,name FROM changes ORDER BY path LIMIT 10')]
    def blocked_examples(self):return [row[0] for row in self.db.execute('SELECT message FROM blocked ORDER BY path LIMIT 10')]
    def coalesced_examples(self):return [json.loads(row[0]) for row in self.db.execute('SELECT data FROM coalesced ORDER BY source LIMIT 10')]
    def page(self,section,number,before):
        table={'products':'changes','references':'changed','coalesced':'coalesced','blocked':'blocked'}.get(section)
        require(table is not None,'Невідомий розділ впливу.')
        total=self.db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]
        pages=max(1,(total+29)//30);number=min(number,pages);offset=(number-1)*30
        if section=='products':
            items=[{'id':path.split('/',1)[1],'name':name} for path,name in self.db.execute('SELECT path,name FROM changes ORDER BY path LIMIT 30 OFFSET ?',(offset,))]
        elif section=='references':
            from .catalog_reference_management import serialize
            items=[{'before':serialize(before[id]),'after':serialize(self.records[id])} for (id,) in self.db.execute('SELECT id FROM changed ORDER BY id LIMIT 30 OFFSET ?',(offset,))]
        elif section=='coalesced':items=[json.loads(row[0]) for row in self.db.execute('SELECT data FROM coalesced ORDER BY source LIMIT 30 OFFSET ?',(offset,))]
        else:items=[{'id':path.split('/',1)[1],'reason':message} for path,message in self.db.execute('SELECT path,message FROM blocked ORDER BY path LIMIT 30 OFFSET ?',(offset,))]
        return items,total,number,pages

    def scan(self,source,operation,before):
        from .catalog_projection import recipe_usage,recipe_truthy
        from .catalog import unit_in_use
        rows=scalar_rows(Document.objects.filter(path__startswith='products/'),('name',*FIELDS,'referenceIds')).iterator(chunk_size=BATCH)
        try:
            for path,old in rows:
                self.records.guard();require(old is not None,'Довідникові поля товару перевищують 64 КіБ.')
                matched={}
                for field in FIELDS:
                    text=old.get(field) or ('шт' if field=='unit' else '')
                    if not isinstance(text,str) or not text:continue
                    parent=old.get('type','') if field=='category' else '';parent=parent if isinstance(parent,str) else ''
                    stored=old.get('referenceIds');item=before.get(stored.get(field)) if isinstance(stored,dict) else None
                    if not item or item['field']!=field:item=find_reference(before,field,text,parent)
                    if item and item['id'] in self:matched[field]=item['id']
                if not matched:continue
                if source['id'] in matched.values():self.db.execute('INSERT INTO usage VALUES (?)',(path,))
                if operation not in {'rename','merge'}:continue
                bindings=dict(old['referenceIds']) if isinstance(old.get('referenceIds'),dict) else {};patch={}
                for field,identifier in matched.items():
                    item=self.records[self.destination(identifier)];patch[field]=item['value'];bindings[field]=item['id']
                patch['referenceIds']=bindings
                if source['field']=='unit' and source['id'] in matched.values():
                    data={**old,'recipe':recipe_truthy(path)}
                    reason=unit_in_use(path,data,legacy_recipe_lookup=recipe_usage)
                    if reason:self.db.execute('INSERT INTO blocked VALUES (?,?)',(path,f'{old.get("name",path)}: {reason}. Для іншої одиниці створіть окремий товар.'))
                if any(old.get(key)!=value for key,value in patch.items()):
                    self.db.execute('INSERT INTO changes VALUES (?,?,?,?)',(path,json.dumps(old,ensure_ascii=False),json.dumps(patch,ensure_ascii=False),str(old.get('name') or '')))
        finally:rows.close()
        self.db.commit();self.records.guard()
