"""Scalar mutations preserving unmodified historical JSON in the database.

Canonical revision hashing streams the original JSON through a private disk
sorter. No complete historical document is decoded or used as a new baseline.
The caller owns one RR snapshot or the ledger transaction throughout the read.
"""
import hashlib
import hmac
import json
import os
import sqlite3
import tempfile
from time import monotonic
from django.conf import settings
from django.db import connection
from .models import Document
from .services import require
from .catalog_budget import check

CHUNK = 16384
MAX_DISK = 256 * 1024 * 1024
MAX_SECONDS = 120
SCALAR_FIELDS = ('name', 'type', 'category', 'pack', 'size', 'unit', 'barcode', 'cost',
                 'markup', 'price', 'manualPrice', 'promotion', 'promotionPrice',
                 'priceAt', 'minStock', 'expiryAlertDays', 'hidden', 'referenceIds')


def pricing_settings(path='settings/main'):
    """Present pricing fields only; preserve missing versus explicit JSON null.

    Arbitrary unrelated historical settings never cross the driver boundary.
    The fixed keys are internal SQL literals, never request-controlled paths.
    """
    check()
    table=connection.ops.quote_name(Document._meta.db_table)
    if connection.vendor=='postgresql':
        expression="(SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(data) WHERE key IN ('defaultMarkup','rounding'))"
        size=f'octet_length(({expression})::text)'
        kind="jsonb_typeof(data)"
    else:
        expression="(SELECT coalesce(json_group_object(key,json(CASE WHEN type IN ('true','false','null') THEN type WHEN type IN ('object','array') THEN value ELSE json_quote(value) END)),'{}') FROM json_each(data) WHERE key IN ('defaultMarkup','rounding'))"
        size=f'length(CAST(({expression}) AS BLOB))'
        kind="json_type(data)"
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT CASE WHEN {kind}='object' THEN CASE WHEN {size}<=65536 THEN {expression} END END FROM {table} WHERE path=%s",[path])
        row=cursor.fetchone()
    if row is None:return {}
    require(row[0] is not None,'Некоректні параметри ціноутворення або поля перевищують ліміт 64 КіБ.')
    return json.loads(row[0]) if isinstance(row[0],str) else row[0]


def text_chunks(path):
    """Driver receives bounded strings; query never selects the full JSON value."""
    table = connection.ops.quote_name(Document._meta.db_table)
    if connection.vendor == 'postgresql':
        sql = f'''SELECT substring(source.text FROM part.position FOR %s)
          FROM (SELECT data::text AS text FROM {table} WHERE path=%s) source
          CROSS JOIN LATERAL generate_series(1,length(source.text),%s) part(position)
          ORDER BY part.position'''
        args = [CHUNK, path, CHUNK]
    else:
        sql = f'''WITH RECURSIVE source(text) AS (SELECT CAST(data AS TEXT) FROM {table} WHERE path=%s),
          parts(offset) AS (SELECT 1 UNION ALL SELECT offset+%s FROM parts,source WHERE offset+%s<=length(text))
          SELECT substr(text,offset,%s) FROM source,parts ORDER BY offset'''
        args = [path, CHUNK, CHUNK, CHUNK]
    with connection.chunked_cursor() as cursor:
        cursor.execute(sql, args)
        while rows := cursor.fetchmany(8):
            for row in rows: yield row[0]


class CanonicalStream:
    """JSON -> Python json.dumps(sort_keys=True,ensure_ascii=False) spelling.

    Arrays stream in order. Object members are sorted on disk, including nested
    unknown fields. Keys/scalar numbers retain the explicit 64KiB field guard;
    string values may be arbitrarily long without becoming a Python string.
    """
    def __init__(self, chunks, directory):
        self.chunks = iter(chunks)
        self.buffer = ''; self.offset = 0; self.started = monotonic(); self.ident = 0
        self.file = open(directory + '/canonical.bin', 'w+b')
        self.db = sqlite3.connect(directory + '/keys.sqlite3')
        self.db.execute('PRAGMA cache_size=-1024'); self.db.execute('PRAGMA temp_store=FILE')
        self.db.execute('PRAGMA journal_mode=OFF'); self.db.execute('PRAGMA synchronous=OFF')
        self.reserved_file=0
        self.db.create_collation('python', lambda a,b: (a>b)-(a<b))
        self.db.execute('CREATE TABLE members(parent INTEGER,key TEXT COLLATE python,start INTEGER,end INTEGER,PRIMARY KEY(parent,key))')
        self.directory = directory
        self.reserve(CHUNK)

    def close(self):
        self.db.close(); self.file.close()
        if hasattr(self.chunks, 'close'): self.chunks.close()

    def guard(self):
        check()
        require(monotonic()-self.started < MAX_SECONDS, 'Перевірка історичного запису перевищила ліміт часу.')
        require(self.file.seek(0, os.SEEK_END) + os.path.getsize(self.directory+'/keys.sqlite3') <= MAX_DISK,
                'Перевірка історичного запису перевищила ліміт тимчасового диска.')

    def peek(self):
        while self.offset >= len(self.buffer):
            self.buffer = next(self.chunks, ''); self.offset = 0
            if not self.buffer: return ''
            self.guard()
        return self.buffer[self.offset]

    def take(self):
        value = self.peek(); self.offset += bool(value); return value

    def whitespace(self):
        while self.peek() and self.peek().isspace(): self.take()

    def reserve(self, amount):
        check()
        end=self.file.seek(0,os.SEEK_END)
        reserved=((end+amount+CHUNK-1)//CHUNK)*CHUNK
        require(reserved<=MAX_DISK,'Перевірка історичного запису перевищила ліміт тимчасового диска.')
        if reserved>self.reserved_file:
            page_size=self.db.execute('PRAGMA page_size').fetchone()[0]
            pages=(MAX_DISK-reserved)//page_size
            require(self.db.execute('PRAGMA page_count').fetchone()[0]<=pages,'Перевірка історичного запису перевищила ліміт тимчасового диска.')
            self.db.execute('PRAGMA max_page_count='+str(pages));self.reserved_file=reserved

    def emit(self, value):
        encoded=value.encode('utf-8');self.reserve(len(encoded));self.file.write(encoded)

    def copy(self, start, end):
        while start < end:
            self.file.seek(start); value = self.file.read(min(CHUNK,end-start)); start += len(value)
            self.reserve(len(value));self.file.write(value)
            self.guard()

    def string(self, *, key=False):
        require(self.take()=='"', 'Некоректний JSON історичного запису.')
        self.emit('"'); key_text = [] if key else None; count = 0
        while True:
            char = self.take(); require(bool(char), 'Некоректний JSON історичного запису.')
            if char=='"': break
            if char=='\\':
                escaped = self.take()
                if escaped=='u':
                    code = ''.join(self.take() for _ in range(4))
                    try: char = chr(int(code,16))
                    except ValueError: require(False, 'Некоректний Unicode історичного запису.')
                    if 0xD800 <= ord(char) <= 0xDBFF:
                        require(self.take()=='\\' and self.take()=='u', 'Некоректний Unicode історичного запису.')
                        low = int(''.join(self.take() for _ in range(4)),16)
                        require(0xDC00<=low<=0xDFFF, 'Некоректний Unicode історичного запису.')
                        char = chr(0x10000+((ord(char)-0xD800)<<10)+low-0xDC00)
                else:
                    require(escaped in '"\\/bfnrt', 'Некоректний JSON історичного запису.')
                    char = {'b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'}.get(escaped,escaped)
            require(ord(char)>=32 or char in '\b\f\n\r\t', 'Некоректний JSON історичного запису.')
            self.emit(json.dumps(char,ensure_ascii=False)[1:-1])
            if key:
                count += len(char.encode()); require(count<=65536, 'Ключ історичного JSON перевищує 64 КіБ.')
                key_text.append(char)
        self.emit('"')
        return ''.join(key_text) if key else None

    def value(self, depth=0):
        require(depth < 1000, 'Історичний JSON має надмірну вкладеність.')
        self.whitespace(); char = self.peek(); start = self.file.seek(0,os.SEEK_END)
        if char=='"': self.string()
        elif char=='[':
            self.take(); self.whitespace(); self.ident += 1; parent=self.ident; index=0
            while self.peek()!=']':
                if index: require(self.take()==',', 'Некоректний JSON історичного запису.')
                child_start,child_end=self.value(depth+1)
                self.db.execute('INSERT INTO members VALUES (?,?,?,?)',(parent,str(index).zfill(20),child_start,child_end))
                self.whitespace(); index+=1
            self.take(); start=self.file.seek(0,os.SEEK_END); self.emit('['); first=True
            for child_start,child_end in self.db.execute('SELECT start,end FROM members WHERE parent=? ORDER BY key COLLATE python',(parent,)):
                if not first: self.emit(',')
                self.copy(child_start,child_end); first=False
            self.emit(']'); self.db.execute('DELETE FROM members WHERE parent=?',(parent,))
        elif char=='{':
            self.take(); self.whitespace(); self.ident += 1; parent=self.ident; first=True
            while self.peek()!='}':
                if not first: require(self.take()==',', 'Некоректний JSON історичного запису.'); self.whitespace()
                key=self.string(key=True); self.whitespace(); require(self.take()==':', 'Некоректний JSON історичного запису.')
                child_start,child_end=self.value(depth+1)
                self.db.execute('INSERT OR REPLACE INTO members VALUES (?,?,?,?)',(parent,key,child_start,child_end))
                self.whitespace(); first=False
            self.take(); start=self.file.seek(0,os.SEEK_END); self.emit('{'); first=True
            for key,child_start,child_end in self.db.execute('SELECT key,start,end FROM members WHERE parent=? ORDER BY key COLLATE python',(parent,)):
                if not first: self.emit(',')
                self.emit(json.dumps(key,ensure_ascii=False)+':'); self.copy(child_start,child_end); first=False
            self.emit('}'); self.db.execute('DELETE FROM members WHERE parent=?',(parent,))
        else:
            token=[]
            while self.peek() and self.peek() not in ',]} \t\r\n':
                token.append(self.take()); require(len(token)<=65536, 'Число історичного JSON перевищує 64 КіБ.')
            try: value=json.loads(''.join(token))
            except (ValueError,TypeError): require(False, 'Некоректний JSON історичного запису.')
            self.emit(json.dumps(value,ensure_ascii=False,separators=(',',':')))
        return start,self.file.seek(0,os.SEEK_END)

    def canonical(self):
        start,end=self.value(); self.whitespace(); require(not self.peek(), 'Некоректний JSON історичного запису.')
        self.guard(); self.file.seek(start)
        while start < end:
            value=self.file.read(min(CHUNK,end-start)); start+=len(value); yield value


def document_revision(path, config):
    from .catalog import plain
    from .services import require
    require(Document.objects.filter(pk=path).exists(), 'Товар не знайдено.')
    signer=hmac.new(settings.SECRET_KEY.encode(),digestmod=hashlib.sha256)
    with tempfile.TemporaryDirectory(prefix='tsukenya-revision-') as directory:
        stream=CanonicalStream(text_chunks(path),directory)
        try:
            signer.update(b'{"data":')
            for chunk in stream.canonical(): signer.update(chunk)
            signer.update((',"path":'+json.dumps(path,ensure_ascii=False)+',"pricing":'+json.dumps(
                {key:plain(value) for key,value in config.items()},ensure_ascii=False,sort_keys=True,separators=(',',':'))+'}').encode())
        finally: stream.close()
    return signer.hexdigest()


def merge_document(path, values):
    """Top-level replacement (including JSON null), never merge-patch deletion."""
    require(isinstance(values,dict), 'Некоректна зміна товару.')
    encoded=json.dumps(values,ensure_ascii=False,allow_nan=False,separators=(',',':'))
    check()
    table=connection.ops.quote_name(Document._meta.db_table)
    with connection.cursor() as cursor:
        if connection.vendor=='postgresql':
            cursor.execute(f'UPDATE {table} SET data=data || %s::jsonb WHERE path=%s',(encoded,path))
        else:
            # json_set replaces each top-level value exactly; json_patch would
            # erase nulls and recursively merge referenceIds, which is incorrect.
            clauses=[]; arguments=[]
            for key,value in values.items():
                clauses.append('%s,json(%s)'); arguments.extend(('$.'+json.dumps(key),json.dumps(value,ensure_ascii=False,allow_nan=False)))
            if clauses: cursor.execute(f'UPDATE {table} SET data=CAST(json_set(data,{",".join(clauses)}) AS TEXT) WHERE path=%s',[*arguments,path])


def projected_documents(paths):
    """One guarded scalar query for a caller-bounded path batch, no revision/hash."""
    require(isinstance(paths,list) and len(paths)<=200,'Пакет каталогу має містити не більше200 ID.')
    if not paths:return
    table=connection.ops.quote_name(Document._meta.db_table)
    fields=','.join("'"+key+"'" for key in SCALAR_FIELDS)
    if connection.vendor=='postgresql':
        expression=f"(SELECT coalesce(jsonb_object_agg(key,value),'{{}}'::jsonb) FROM jsonb_each(data) WHERE key IN ({fields}))"
        size=f'octet_length(({expression})::text)'
    else:
        expression=f"(SELECT coalesce(json_group_object(key,json(CASE WHEN type IN ('true','false','null') THEN type WHEN type IN ('object','array') THEN value ELSE json_quote(value) END)),'{{}}') FROM json_each(data) WHERE key IN ({fields}))"
        size=f'length(CAST(({expression}) AS BLOB))'
    placeholders=','.join(['%s']*len(paths))
    with connection.chunked_cursor() as cursor:
        cursor.execute(f'SELECT path,CASE WHEN {size}<=65536 THEN {expression} END FROM {table} WHERE path IN ({placeholders}) ORDER BY path',paths)
        while rows:=cursor.fetchmany(50):
            for path,value in rows:
                check();require(value is not None,'Каталожні поля перевищують ліміт64 КіБ.')
                document=Document(path=path,data=json.loads(value) if isinstance(value,str) else value)
                document._catalog_projection=True
                yield document


def projected_document(path, *, config=None, with_recipe=False):
    """Exact present allowed fields; unknown fields stay exclusively in SQL."""
    check()
    table=connection.ops.quote_name(Document._meta.db_table)
    fields=','.join("'"+key+"'" for key in SCALAR_FIELDS)
    if connection.vendor=='postgresql':
        expression=f"(SELECT coalesce(jsonb_object_agg(key,value),'{{}}'::jsonb) FROM jsonb_each(data) WHERE key IN ({fields}))"
        encoded=f'octet_length(({expression})::text)'
    else:
        expression=f"(SELECT coalesce(json_group_object(key,json(CASE WHEN type IN ('true','false','null') THEN type WHEN type IN ('object','array') THEN value ELSE json_quote(value) END)),'{{}}') FROM json_each(data) WHERE key IN ({fields}))"
        encoded=f'length(CAST(({expression}) AS BLOB))'
    with connection.cursor() as cursor:
        cursor.execute(f'SELECT CASE WHEN {encoded}<=65536 THEN {expression} ELSE NULL END FROM {table} WHERE path=%s',[path])
        row=cursor.fetchone()
    if row is None:return None
    require(row[0] is not None,'Каталожні поля перевищують ліміт 64 КіБ. Виправте запис перед зміною.')
    data=json.loads(row[0]) if isinstance(row[0],str) else row[0]
    if with_recipe:
        # Same <=100/type/ingredient/quantity validator as the original product
        # write. Per-row unknown fields never enter Python or the SQL patch.
        with connection.cursor() as cursor:
            if connection.vendor=='postgresql':
                cursor.execute(f'''SELECT data ? 'recipe',jsonb_typeof(data->'recipe'),
                  CASE WHEN jsonb_typeof(data->'recipe')='array' THEN jsonb_array_length(data->'recipe') END FROM {table} WHERE path=%s''',[path])
            else:
                cursor.execute(f'''SELECT json_type(data,'$.recipe') IS NOT NULL,json_type(data,'$.recipe'),
                  CASE WHEN json_type(data,'$.recipe')='array' THEN json_array_length(data,'$.recipe') END FROM {table} WHERE path=%s''',[path])
            present,kind,count=cursor.fetchone()
            if with_recipe=='index':
                if present and kind=='array' and count>100:
                    from .import_index import IndexLimit
                    raise IndexLimit(f'Історична рецептура {path} перевищує 100 рядків. Виправте її перед великим імпортом.')
                if present and kind!='array':data['recipe']=None;present=False
            require(not present or kind=='array' and count<=100,'Некоректна рецептура.')
            if present:
                if connection.vendor=='postgresql':
                    expression="jsonb_build_object('product',child->'product','quantity',child->'quantity')"
                    cursor.execute(f'''SELECT jsonb_typeof(child),CASE WHEN jsonb_typeof(child)='object' AND octet_length(({expression})::text)<=65536 THEN {expression} END
                      FROM {table} CROSS JOIN LATERAL jsonb_array_elements(data->'recipe') WITH ORDINALITY items(child,n)
                      WHERE path=%s ORDER BY n''',[path])
                else:
                    expression="""json_object(
                      'product',json(CASE WHEN json_type(child.value,'$.product') IN ('true','false','null') THEN json_type(child.value,'$.product') ELSE json_quote(json_extract(child.value,'$.product')) END),
                      'quantity',json(CASE WHEN json_type(child.value,'$.quantity') IN ('true','false','null') THEN json_type(child.value,'$.quantity') ELSE json_quote(json_extract(child.value,'$.quantity')) END))"""
                    cursor.execute(f'''SELECT child.type,CASE WHEN child.type='object' AND length(CAST(({expression}) AS BLOB))<=65536 THEN {expression} END
                      FROM {table},json_each(data,'$.recipe') child WHERE {table}.path=%s ORDER BY CAST(child.key AS INTEGER)''',[path])
                data['recipe']=[]
                for child_kind,value in cursor:
                    if with_recipe=='index' and child_kind!='object':continue
                    require(child_kind=='object','Некоректний інгредієнт.')
                    # Rows have two validator fields, never arbitrary recipe JSON.
                    require(value is not None,'Поле інгредієнта перевищує 64 КіБ.')
                    check()
                    data['recipe'].append(json.loads(value) if isinstance(value,str) else value)
    document=Document(path=path,data=data)
    document._catalog_projection=True
    if config is not None:document._catalog_revision=document_revision(path,config)
    return document


def save_projection(document, data, *, config=None):
    """Write only normalized editable terms; never write projected recipe rows."""
    values={key:value for key,value in data.items() if key in SCALAR_FIELDS}
    merge_document(document.path,values)
    document.data=data
    if hasattr(document,'_catalog_revision'):del document._catalog_revision
    if config is not None:document._catalog_revision=document_revision(document.path,config)
    return document


def recipe_usage(identifier, path):
    """Original list/dict/str(product) legacy ingredient predicate, scalar SQL."""
    check()
    table=connection.ops.quote_name(Document._meta.db_table)
    # str(None)/bool/numeric spellings are legacy Python semantics, not a JSON
    # string cast. Product IDs are ordinary strings; numeric IDs also match.
    if connection.vendor=='postgresql':
        sql=f'''SELECT 1 FROM {table} CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(data->'recipe')='array' THEN data->'recipe' ELSE '[]'::jsonb END) child
            WHERE path LIKE %s AND path<>%s AND jsonb_typeof(child)='object'
              AND CASE jsonb_typeof(child->'product') WHEN 'boolean' THEN CASE WHEN child->>'product'='true' THEN 'True' ELSE 'False' END WHEN 'null' THEN 'None' ELSE coalesce(child->>'product','None') END=%s LIMIT 1'''
    else:
        sql=f'''SELECT 1 FROM {table},json_each(CASE WHEN json_type(data,'$.recipe')='array' THEN json_extract(data,'$.recipe') ELSE '[]' END) child
            WHERE {table}.path LIKE %s AND {table}.path<>%s AND child.type='object'
              AND CASE json_type(child.value,'$.product') WHEN 'true' THEN 'True' WHEN 'false' THEN 'False' WHEN 'null' THEN 'None' ELSE coalesce(CAST(json_extract(child.value,'$.product') AS TEXT),'None') END=%s LIMIT 1'''
    with connection.cursor() as cursor:
        cursor.execute(sql,['products/%',path,identifier]);return cursor.fetchone() is not None


def recipe_truthy(path):
    check()
    table=connection.ops.quote_name(Document._meta.db_table)
    if connection.vendor=='postgresql':
        sql=f'''SELECT data->'recipe' IS NOT NULL AND data->'recipe' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb,'[]'::jsonb,'{{}}'::jsonb) FROM {table} WHERE path=%s'''
    else:
        sql=f'''SELECT CASE WHEN json_type(data,'$.recipe') IS NULL OR json_type(data,'$.recipe') IN ('null','false') THEN 0
          WHEN json_type(data,'$.recipe')='array' THEN json_array_length(data,'$.recipe')>0
          WHEN json_type(data,'$.recipe')='object' THEN EXISTS(SELECT 1 FROM json_each(data,'$.recipe'))
          ELSE json_extract(data,'$.recipe') NOT IN (0,'') END FROM {table} WHERE path=%s'''
    with connection.cursor() as cursor:cursor.execute(sql,[path]);return bool(cursor.fetchone()[0])


def save_reference(item, before):
    """Reference whitelist changes; old aliases/unknown metadata stay in SQL."""
    from .catalog_references import legacy_item
    path='catalog_refs/'+item['id']
    values={key:value for key,value in item.items() if key!='id' and key!='aliases'}
    if not Document.objects.filter(pk=path).exists():
        # A pinned legacy item has no arbitrary historical alias array.
        values['aliases']=list(item['aliases']);Document.objects.create(path=path,data=values);return
    merge_document(path,values)
    old_count=len(before['aliases']) if before else 0
    table=connection.ops.quote_name(Document._meta.db_table)
    aliases=item['aliases'].owner.db.execute('SELECT data FROM aliases WHERE id=? AND position>? ORDER BY position',(item['id'],old_count))
    for (encoded,) in aliases:
        check()
        with connection.cursor() as cursor:
            if connection.vendor=='postgresql':
                cursor.execute(f'''UPDATE {table} SET data=jsonb_set(data,'{{aliases}}',
                    CASE WHEN jsonb_typeof(data->'aliases')='array' THEN data->'aliases' ELSE '[]'::jsonb END || %s::jsonb) WHERE path=%s''',('['+encoded+']',path))
            else:
                cursor.execute(f'''UPDATE {table} SET data=json_insert(json_set(data,'$.aliases',json(
                    CASE WHEN json_type(data,'$.aliases')='array' THEN json_extract(data,'$.aliases') ELSE '[]' END)),'$.aliases[#]',json(%s)) WHERE path=%s''',(encoded,path))
