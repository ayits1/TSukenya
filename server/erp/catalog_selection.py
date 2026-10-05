"""Current catalogue selection with bounded scalar inputs and private derived disk.

The caller owns one read snapshot (or LedgerLock transaction). This is not a
persisted catalogue, cache, write baseline or permission grant. PostgreSQL owns
search/order; Python's existing Decimal resolver owns effective promotion.
"""
import json
import os
import sqlite3
import tempfile
from django.conf import settings
from itertools import islice
from time import monotonic
from django.db import connection
from django.db.models import BinaryField, BooleanField, Case, Func, IntegerField, JSONField, Q, Value, When, Subquery, OuterRef
from django.db.models.expressions import RawSQL
from django.db.models.fields.json import KeyTransform
from django.db.models.functions import Cast, JSONObject, Length
from django.db.models import TextField
from .services import require

BATCH = 200
MAX_DISK = 256 * 1024 * 1024
MAX_SECONDS = 120
MAX_SCALAR_BYTES = 64 * 1024
FIELDS = ('name', 'type', 'category', 'pack', 'cost', 'markup', 'price',
          'manualPrice', 'promotion', 'promotionPrice')
FACETS = ('type', 'category', 'pack')


def scalar_rows(query, fields, *, present=None, ordering=('path',), extra=()):
    """Decode at most BATCH guarded scalar rows; never decode full product JSON."""
    scalar = JSONObject(**{key: KeyTransform(key, 'data') for key in fields})
    if connection.vendor == 'sqlite':
        arguments, expressions = [], []
        for key in fields:
            path = '$."' + key + '"'
            expressions.append('%s,json(CASE WHEN json_type(data,%s) IN (\'true\',\'false\',\'null\') THEN json_type(data,%s) ELSE json_quote(json_extract(data,%s)) END)')
            arguments.extend((key, path, path, path))
        scalar = RawSQL('json_object(' + ','.join(expressions) + ')', arguments, output_field=JSONField())
    encoded_bytes = Func(Cast(scalar, TextField()), function='octet_length', output_field=IntegerField()) if connection.vendor == 'postgresql' else Length(Cast(Cast(scalar, TextField()), BinaryField()))
    projected = query.annotate(scalar_bytes=encoded_bytes).annotate(scalar=Case(When(scalar_bytes__lte=MAX_SCALAR_BYTES, then=scalar), default=Value(None), output_field=JSONField()))
    presence = (present,) if isinstance(present, str) else tuple(present or ())
    names = []
    for index, field in enumerate(presence):
        name = 'present' if isinstance(present, str) else 'present_' + str(index)
        names.append(name)
        projected = projected.annotate(**{name: Case(When(**{'data__has_key': field}, then=Value(True)), default=Value(False), output_field=BooleanField())})
    return projected.order_by(*ordering).values_list('path', 'scalar', *names, *extra)



def source(user, params, visibility='active'):
    from .catalog import base_query, defaults
    from .models import Document
    from .promotion_prices import context_store
    require(visibility in {'active', 'hidden'}, 'Некоректний стан товарів.')
    query = base_query() if visibility == 'active' else Document.objects.filter(path__startswith='products/', data__hidden=True)
    for word in params.get('q', '').strip()[:250].split():
        query = query.filter(Q(data__name__icontains=word) | Q(data__barcode__icontains=word))
    require(params.get('promotion', '') in {'', 'yes', 'no'}, 'Некоректний фільтр акції.')
    for key in FACETS:
        require(isinstance(params.get(key, ''), str) and len(params.get(key, '')) <= 160, 'Значення фільтра задовге.')
    return query, defaults(), context_store(user, params.get('store'))


def narrowed(query, params, fields=FACETS):
    for field in fields:
        if params.get(field): query = query.filter(**{'data__' + field: params[field]})
    return query


class Selection:
    def __init__(self, user, params, visibility='active', *, effective_day=None, read_cache=False):
        # Physical POST bypass: pricing always supplies effective_day and never
        # enables read_cache. There is no implicit cache in the shared selector.
        require(not read_cache or effective_day is None, 'Read cache не є baseline зміни ціни.')
        self.user, self.visibility = user, visibility
        # Persistent derived files are a PostgreSQL deployment capability.
        # SQLite can opt in with an explicitly isolated trusted cache directory.
        self.read_cache = read_cache and getattr(settings, 'CATALOGUE_READ_CACHE', connection.vendor == 'postgresql')
        self.params = params
        self.query, self.config, self.store = source(user, params, visibility)
        self.directory = None
        from .promotion_prices import kyiv_day
        self.day = effective_day or kyiv_day()

    def __enter__(self):
        # Plain pages need no scan/spool. Facets and promotion create it lazily.
        return self

    def __exit__(self, *args):
        try:
            if hasattr(self, 'db'): self.db.close()
        finally:
            if hasattr(self, '_cache_handle'): self._cache_handle.close()
            if self.directory: self.directory.cleanup()

    def build(self):
        if hasattr(self, 'db'): return
        if self.read_cache:
            from .catalog_read_cache import load
            load(self, self._build_private)
            self.db.create_collation('fold', lambda a, b: (a.casefold() > b.casefold()) - (a.casefold() < b.casefold()))
            return
        self._build_private()

    def _build_private(self, cache_directory=None):
        from .models import Document
        from .promotion_prices import PriceResolver
        self.directory = tempfile.TemporaryDirectory(prefix='.build-' if cache_directory else 'tsukenya-catalogue-', dir=cache_directory)
        path = self.directory.name + '/selection.sqlite3'
        self.db = sqlite3.connect(path)
        os.chmod(path, 0o600)
        self.db.execute('PRAGMA cache_size=-2048')
        self.db.execute('PRAGMA temp_store=MEMORY' if self.read_cache else 'PRAGMA temp_store=FILE')
        if self.read_cache:
            # Only disposable derived data: partial builds are discarded, never
            # published. B-tree insertion replaces sorter/journal scratch files.
            self.db.execute('PRAGMA journal_mode=OFF')
            page_size = self.db.execute('PRAGMA page_size').fetchone()[0]
            self.db.execute('PRAGMA max_page_count=' + str(MAX_DISK // page_size))
        self.db.create_collation('fold', lambda a, b: (a.casefold() > b.casefold()) - (a.casefold() < b.casefold()))
        self.db.execute('CREATE TABLE items (position INTEGER PRIMARY KEY,path TEXT UNIQUE,type TEXT,category TEXT,pack TEXT,type_label TEXT,category_label TEXT,pack_label TEXT,promoted INTEGER)')
        if self.read_cache:
            self.db.execute('CREATE TABLE facets(field TEXT,parent1 TEXT,parent2 TEXT,promoted INTEGER,folded TEXT,value TEXT,PRIMARY KEY(field,parent1,parent2,promoted,folded,value)) WITHOUT ROWID')
            self.db.execute('CREATE INDEX promotion_lookup ON items(promoted,type,category,pack)')
        query, extra = self.query, ()
        if self.read_cache and self.params.get('promotion'):
            from .promotion_prices import current_prices
            query = query.annotate(campaign_min=Subquery(current_prices(self.store, self.day).filter(
                product_id=OuterRef('path'), price__gt=0).order_by('price', 'campaign_id').values('price')[:1]))
            extra = ('campaign_min',)
        projected = scalar_rows(query, FIELDS, present='markup', ordering=('data__type', 'data__category', 'data__name', 'path'), extra=extra)
        started = monotonic()
        if self.read_cache:
            self.db.set_progress_handler(lambda: int(monotonic() - started >= MAX_SECONDS), 10000)
        iterator = projected.iterator(chunk_size=BATCH)
        position = 0
        try:
            while batch := list(islice(iterator, BATCH)):
                require(monotonic() - started < MAX_SECONDS, 'Перегляд каталогу перевищив ліміт часу. Зменшіть вибір і повторіть читання.')
                resolver = PriceResolver(self.config, self.store, self.day, product_paths=[row[0] for row in batch]) if self.params.get('promotion') and not self.read_cache else None
                facet_terms = set()  # at most seven terms per scalar batch row
                for row in batch:
                    identifier, data, present = row[:3]
                    require(data is not None, 'Каталожні поля перевищують ліміт 64 КіБ. Виправте запис перед переглядом.')
                    if not present: data.pop('markup', None)
                    if self.read_cache and self.params.get('promotion'):
                        from .promotion_prices import has_promotion
                        promoted = has_promotion(data, self.config, row[3])
                    else: promoted = bool(resolver and resolver.resolve(Document(path=identifier, data=data))['effectivePromotion'])
                    if not self.read_cache and resolver and promoted != (self.params['promotion'] == 'yes'): continue
                    position += 1
                    raw = [json.dumps(data[key], ensure_ascii=False, separators=(',', ':')) for key in FACETS]
                    labels = [str(data[key]) if data[key] else None for key in FACETS]
                    self.db.execute('INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?)', [position, identifier, *raw, *labels, int(promoted)])
                    if self.read_cache:
                        # Every allowed parent combination has its own unique
                        # terms. Hit queries need neither DISTINCT nor a sorter.
                        for field, value, parents in (
                            ('type', labels[0], [('', '')]),
                            ('category', labels[1], [('', ''), (raw[0], '')]),
                            ('pack', labels[2], [('', ''), (raw[0], ''), ('', raw[1]), (raw[0], raw[1])])):
                            if value is not None:
                                folded = value.casefold()
                                for parent1, parent2 in parents:
                                    facet_terms.add((field,parent1,parent2,int(promoted),folded,value))
                if self.read_cache:
                    self.db.executemany('INSERT OR IGNORE INTO facets VALUES (?,?,?,?,?,?)',facet_terms)
                self.db.commit()
                pages = self.db.execute('PRAGMA page_count').fetchone()[0]
                size = self.db.execute('PRAGMA page_size').fetchone()[0]
                require(pages * size <= MAX_DISK, 'Перегляд каталогу перевищив ліміт тимчасового диска. Зменшіть вибір.')
        finally:
            iterator.close()

    def where(self, fields=FACETS):
        args, clauses = [], []
        for field in fields:
            if self.params.get(field):
                clauses.append(field + '=?')
                args.append(json.dumps(self.params[field], ensure_ascii=False, separators=(',', ':')))
        if self.params.get('promotion'):
            clauses.append('promoted=?'); args.append(int(self.params['promotion'] == 'yes'))
        return (' AND '.join(clauses) or '1'), args

    def ids(self, limit, offset=0):
        if not self.params.get('promotion'):
            return list(narrowed(self.query, self.params).order_by('data__type', 'data__category', 'data__name', 'path').values_list('path', flat=True)[offset:offset + limit])
        self.build()
        where, args = self.where()
        return [row[0] for row in self.db.execute('SELECT path FROM items NOT INDEXED WHERE ' + where + ' ORDER BY position LIMIT ? OFFSET ?', [*args, limit, offset])]

    def iter_ids(self):
        """Full filtered source, bounded cursor; no pagination offset omission."""
        if not self.params.get('promotion'):
            rows=narrowed(self.query,self.params).order_by('data__type','data__category','data__name','path').values_list('path',flat=True).iterator(chunk_size=BATCH)
            try:yield from rows
            finally:rows.close()
        else:
            self.build();where,args=self.where()
            for row in self.db.execute('SELECT path FROM items NOT INDEXED WHERE '+where+' ORDER BY position',args):yield row[0]

    def count(self):
        if not self.params.get('promotion'): return narrowed(self.query, self.params).count()
        self.build()
        where, args = self.where()
        return self.db.execute('SELECT COUNT(*) FROM items WHERE ' + where, args).fetchone()[0]

    def facet(self, field, q, page):
        require(field in FACETS, 'Невідомий фільтр каталогу.')
        self.build()
        if self.read_cache: return self._cached_facet(field, q, page)
        where, args = self.where(FACETS[:FACETS.index(field)])
        # A facet is constrained by parents only; its own committed filter stays independent.
        column = 'value' if self.read_cache else field + '_label'
        self.db.create_function('contains', 2, lambda value, needle: needle.casefold() in (value or '').casefold())
        # MATERIALIZED performs Unicode search once per distinct facet value,
        # not once per product. Temporary sort storage remains on disk.
        table = 'facets' if self.read_cache else 'items'
        if self.read_cache:
            where = 'field=? AND ' + where; args.insert(0, field)
        query = 'WITH facet AS MATERIALIZED (SELECT DISTINCT ' + column + ' AS value FROM ' + table + ' WHERE ' + where + ' AND ' + column + ' IS NOT NULL) SELECT value FROM facet WHERE contains(value,?)'
        arguments = [*args, q]
        total = self.db.execute('SELECT COUNT(*) FROM (' + query + ')', arguments).fetchone()[0]
        pages = max(1, (total + 29) // 30)
        page = min(page, pages)
        items = [row[0] for row in self.db.execute(query + ' ORDER BY value COLLATE fold,value LIMIT 30 OFFSET ?', [*arguments, (page - 1) * 30])]
        return {'contract': 'catalog-facets-v1', 'field': field, 'q': q, 'items': items, 'total': total, 'page': page, 'pages': pages, 'limit': 30}

    def _cached_facet(self, field, q, page):
        self.db.create_function('contains', 2, lambda value, needle: needle.casefold() in value.casefold())
        parents = [json.dumps(self.params[key],ensure_ascii=False,separators=(',', ':')) if self.params.get(key) else '' for key in FACETS[:FACETS.index(field)]]
        parent1,parent2 = (parents + ['', ''])[:2]
        args = [field,parent1,parent2,int(self.params.get('promotion') == 'yes'),q]
        where = 'field=? AND parent1=? AND parent2=? AND promoted=? AND contains(value,?)'
        total = self.db.execute('SELECT COUNT(*) FROM facets WHERE ' + where,args).fetchone()[0]
        pages=max(1,(total+29)//30);page=min(page,pages)
        items=[r[0] for r in self.db.execute('SELECT value FROM facets WHERE ' + where + ' ORDER BY folded,value LIMIT 30 OFFSET ?', [*args,(page-1)*30])]
        return {'contract':'catalog-facets-v1','field':field,'q':q,'items':items,'total':total,'page':page,'pages':pages,'limit':30}


def page(request, user):
    from .catalog import EDIT_ROLES, plain, serialize
    from .models import Document
    from .promotion_prices import PriceResolver
    from .views import response
    from .browsing import page_number
    params = request.GET
    number = page_number(params)
    require(params.get('limit', '20') in {'10', '20', '50'}, 'Некоректний розмір списку.')
    limit = int(params.get('limit', '20'))
    visibility = params.get('visibility', 'active')
    require(visibility != 'hidden' or user.profile.role == 'owner', 'Приховані товари доступні лише власнику.')
    with Selection(user, params, visibility, read_cache=True) as selection:
        total = selection.count()
        pages = max(1, (total + limit - 1) // limit)
        number = min(number, pages)
        paths = selection.ids(limit, (number - 1) * limit)
        from .catalog_snapshot import bounded_documents
        documents = {doc.path: doc for doc in bounded_documents(Document.objects.filter(pk__in=paths))}
        resolver = PriceResolver(selection.config, selection.store, selection.day, product_paths=paths)
        return response({'contract': 'catalog-page-v2', 'items': [serialize(documents[path], user, selection.config, resolver=resolver) for path in paths],
            'total': total, 'page': number, 'pages': pages, 'limit': limit, 'visibility': visibility,
            'canEdit': user.profile.role in EDIT_ROLES, 'defaultMarkup': plain(selection.config['markup']), 'facetMode': 'paged', 'facets': None})


def handle(request, user):
    from .catalog_read_cache import CacheUnavailable
    from .views import response
    try: return _handle(request, user)
    except (CacheUnavailable, OSError, sqlite3.DatabaseError):
        result = response({'error': 'Перегляд каталогу тимчасово недоступний. Повторіть читання.', 'code': 'catalog_read_pending'}, 503)
        result['Retry-After'] = '2'
        return result


def _handle(request, user):
    from .historical_reports import read_snapshot
    from .services import current_actor
    from .views import response
    from .browsing import page_number
    with read_snapshot():
        user = current_actor(user)
        if request.path.rstrip('/').endswith('/page'): return page(request, user)
        params = request.GET
        visibility = params.get('visibility', 'active')
        require(visibility != 'hidden' or user.profile.role == 'owner', 'Приховані товари доступні лише власнику.')
        q = params.get('facetQ', '')
        require(len(q) <= 250, 'Пошук фільтра задовгий.')
        with Selection(user, params, visibility, read_cache=True) as selection:
            return response(selection.facet(params.get('field', ''), q, page_number(params)))
