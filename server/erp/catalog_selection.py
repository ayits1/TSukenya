"""Current catalogue selection with bounded scalar inputs and private derived disk.

The caller owns one read snapshot (or LedgerLock transaction). This is not a
persisted catalogue, cache, write baseline or permission grant. PostgreSQL owns
search/order; Python's existing Decimal resolver owns effective promotion.
"""
import json
import os
import sqlite3
import tempfile
from itertools import islice
from time import monotonic
from django.db import connection
from django.db.models import BinaryField, BooleanField, Case, Func, IntegerField, JSONField, Q, Value, When
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


def scalar_rows(query, fields, *, present=None, ordering=('path',)):
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
    if present:
        projected = projected.annotate(present=Case(When(**{'data__has_key': present}, then=Value(True)), default=Value(False), output_field=BooleanField()))
    return projected.order_by(*ordering).values_list('path', 'scalar', *(['present'] if present else []))


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
    def __init__(self, user, params, visibility='active', *, effective_day=None):
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
            if self.directory: self.directory.cleanup()

    def build(self):
        if hasattr(self, 'db'): return
        from .models import Document
        from .promotion_prices import PriceResolver
        self.directory = tempfile.TemporaryDirectory(prefix='tsukenya-catalogue-')
        path = self.directory.name + '/selection.sqlite3'
        self.db = sqlite3.connect(path)
        os.chmod(path, 0o600)
        self.db.execute('PRAGMA cache_size=-2048')
        self.db.execute('PRAGMA temp_store=FILE')
        self.db.create_collation('fold', lambda a, b: (a.casefold() > b.casefold()) - (a.casefold() < b.casefold()))
        self.db.execute('CREATE TABLE items (position INTEGER PRIMARY KEY,path TEXT UNIQUE,type TEXT,category TEXT,pack TEXT,type_label TEXT,category_label TEXT,pack_label TEXT)')
        projected = scalar_rows(self.query, FIELDS, present='markup', ordering=('data__type', 'data__category', 'data__name', 'path'))
        started = monotonic()
        iterator = projected.iterator(chunk_size=BATCH)
        position = 0
        try:
            while batch := list(islice(iterator, BATCH)):
                require(monotonic() - started < MAX_SECONDS, 'Перегляд каталогу перевищив ліміт часу. Зменшіть вибір і повторіть читання.')
                resolver = PriceResolver(self.config, self.store, self.day, product_paths=[row[0] for row in batch]) if self.params.get('promotion') else None
                for identifier, data, present in batch:
                    require(data is not None, 'Каталожні поля перевищують ліміт 64 КіБ. Виправте запис перед переглядом.')
                    if not present: data.pop('markup', None)
                    if resolver and bool(resolver.resolve(Document(path=identifier, data=data))['effectivePromotion']) != (self.params['promotion'] == 'yes'): continue
                    position += 1
                    raw = [json.dumps(data[key], ensure_ascii=False, separators=(',', ':')) for key in FACETS]
                    labels = [str(data[key]) if data[key] else None for key in FACETS]
                    self.db.execute('INSERT INTO items VALUES (?,?,?,?,?,?,?,?)', [position, identifier, *raw, *labels])
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
        return (' AND '.join(clauses) or '1'), args

    def ids(self, limit, offset=0):
        if not self.params.get('promotion'):
            return list(narrowed(self.query, self.params).order_by('data__type', 'data__category', 'data__name', 'path').values_list('path', flat=True)[offset:offset + limit])
        self.build()
        where, args = self.where()
        return [row[0] for row in self.db.execute('SELECT path FROM items WHERE ' + where + ' ORDER BY position LIMIT ? OFFSET ?', [*args, limit, offset])]

    def count(self):
        if not self.params.get('promotion'): return narrowed(self.query, self.params).count()
        self.build()
        where, args = self.where()
        return self.db.execute('SELECT COUNT(*) FROM items WHERE ' + where, args).fetchone()[0]

    def facet(self, field, q, page):
        require(field in FACETS, 'Невідомий фільтр каталогу.')
        self.build()
        where, args = self.where(FACETS[:FACETS.index(field)])
        # A facet is constrained by parents only; its own committed filter stays independent.
        column = field + '_label'
        self.db.create_function('contains', 2, lambda value, needle: needle.casefold() in (value or '').casefold())
        query = 'SELECT DISTINCT ' + column + ' AS value FROM items WHERE ' + where + ' AND ' + column + ' IS NOT NULL AND contains(' + column + ',?)'
        arguments = [*args, q]
        total = self.db.execute('SELECT COUNT(*) FROM (' + query + ')', arguments).fetchone()[0]
        pages = max(1, (total + 29) // 30)
        page = min(page, pages)
        items = [row[0] for row in self.db.execute(query + ' ORDER BY value COLLATE fold,value LIMIT 30 OFFSET ?', [*arguments, (page - 1) * 30])]
        return {'contract': 'catalog-facets-v1', 'field': field, 'q': q, 'items': items, 'total': total, 'page': page, 'pages': pages, 'limit': 30}


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
    with Selection(user, params, visibility) as selection:
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
        with Selection(user, params, visibility) as selection:
            return response(selection.facet(params.get('field', ''), q, page_number(params)))
