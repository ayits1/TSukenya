"""Warehouse assortment (B13): whether a product is sold in a warehouse and its minimum there. Rows are edited one at a time, revision-protected."""
from decimal import Decimal
from django.db import transaction
from django.db.models.functions import Lower
from django.db.models.fields.json import KeyTextTransform
from .browsing import PAGE_SIZE, page_number, page_bounds
from .historical_reports import read_snapshot
from .models import Assortment, Document, Warehouse
from .services import Conflict, STALE_FORM, audit, dec, get, ledger_lock, record_revision, require, require_revision, scope, current_actor

ROLES = {'owner', 'manager', 'warehouse'}
QTY = Decimal('.001')

def warehouse_for(user, value):
    require(user.profile.role in ROLES, 'Недостатньо прав для асортименту складу.')
    w = get(Warehouse, value, 'Склад'); scope(user, w.store); return w

def row_json(p, row):
    default = dec(p.data.get('minStock', 0), quantum=QTY)
    return {'product': p.pk.split('/', 1)[1], 'name': p.data.get('name', ''), 'unit': p.data.get('unit', 'шт'), 'default_min': str(default),
            'sold': row.sold if row else True, 'min_stock': None if not row or row.min_stock is None else str(row.min_stock),
            'minimum': str(row.min_stock if row and row.min_stock is not None else default), 'revision': record_revision(row) if row else None}

def assortment(user, query):
    search = query.get('q', '').strip()
    require(len(search) <= 250, 'Пошуковий запит задовгий.')
    require(not query.get('sort') or query['sort'] == 'name', 'Невідоме сортування асортименту.')
    selected = query.get('product', '')
    require(isinstance(selected, str) and len(selected) <= 120 and '/' not in selected, 'Некоректний ID товару.')
    requested = page_number(query)
    with read_snapshot():
        user = current_actor(user)
        w = warehouse_for(user, query.get('warehouse'))
        products = Document.objects.filter(path__startswith='products/')
        if search: products = products.filter(data__name__icontains=search)
        if selected: products = products.filter(pk='products/' + selected)
        total = products.count(); page, pages, offset = page_bounds(total, requested)
        products = list(products.annotate(sort_name=Lower(KeyTextTransform('name', 'data'))).order_by('sort_name', 'pk')[offset:offset + PAGE_SIZE])
        rows = {a.product_id: a for a in Assortment.objects.filter(warehouse=w, product_id__in=[p.pk for p in products])}
        return {'warehouse': w.pk, 'rows': [row_json(p, rows.get(p.pk)) for p in products],
                'total': total, 'page': page, 'pages': pages, 'limit': PAGE_SIZE}

@transaction.atomic
def save_assortment(user, value):
    ledger_lock()
    user = current_actor(user)
    w = warehouse_for(user, value.get('warehouse')); p = get(Document, 'products/' + str(value.get('product', '')), 'Товар')
    return apply(user, value, w, p)


def apply(user, value, w, p):
    """Caller holds the ledger and already checked actor/warehouse/product access."""
    row = Assortment.objects.filter(warehouse=w, product_id=p.pk).first()
    # The first save of a product here is a create and must not carry a version; later saves must carry the current one.
    if row: require_revision(row, value.get('revision'))
    elif value.get('revision'): raise Conflict(STALE_FORM, 'revision_conflict')
    else: row = Assortment(warehouse=w, product_id=p.pk)
    require(isinstance(value.get('sold'), bool), 'Вкажіть, чи продається товар на цьому складі.')
    raw = value.get('min_stock'); old = (row.sold, row.min_stock) if row.pk else None
    row.sold = value['sold']; row.min_stock = None if raw is None or str(raw).strip() == '' else dec(raw, 'Мінімальний залишок', QTY)
    row.save(); row.refresh_from_db()
    audit(user, 'assortment_saved', f'assortment/{row.pk}', {'warehouse': w.pk, 'product': p.pk, 'sold': row.sold, 'min_stock': None if row.min_stock is None else str(row.min_stock),
                                                              **({'old': {'sold': old[0], 'min_stock': None if old[1] is None else str(old[1])}} if old else {})})
    return row_json(p, row)
