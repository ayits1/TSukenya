"""Warehouse assortment (B13): whether a product is sold in a warehouse and its minimum there. Rows are edited one at a time, revision-protected."""
from decimal import Decimal
from django.db import transaction
from .models import Assortment, Document, Warehouse
from .services import Conflict, STALE_FORM, audit, dec, get, ledger_lock, record_revision, require, require_revision, scope

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
    w = warehouse_for(user, query.get('warehouse'))
    rows = {a.product_id: a for a in Assortment.objects.filter(warehouse=w)}
    products = sorted(Document.objects.filter(path__startswith='products/'), key=lambda p: (str(p.data.get('name', '')).casefold(), p.pk))
    return {'warehouse': w.pk, 'rows': [row_json(p, rows.get(p.pk)) for p in products]}

@transaction.atomic
def save_assortment(user, value):
    ledger_lock()
    w = warehouse_for(user, value.get('warehouse')); p = get(Document, 'products/' + str(value.get('product', '')), 'Товар')
    row = Assortment.objects.filter(warehouse=w, product=p).first()
    # The first save of a product here is a create and must not carry a version; later saves must carry the current one.
    if row: require_revision(row, value.get('revision'))
    elif value.get('revision'): raise Conflict(STALE_FORM, 'revision_conflict')
    else: row = Assortment(warehouse=w, product=p)
    require(isinstance(value.get('sold'), bool), 'Вкажіть, чи продається товар на цьому складі.')
    raw = value.get('min_stock'); old = (row.sold, row.min_stock) if row.pk else None
    row.sold = value['sold']; row.min_stock = None if raw is None or str(raw).strip() == '' else dec(raw, 'Мінімальний залишок', QTY)
    row.save(); row.refresh_from_db()
    audit(user, 'assortment_saved', f'assortment/{row.pk}', {'warehouse': w.pk, 'product': p.pk, 'sold': row.sold, 'min_stock': None if row.min_stock is None else str(row.min_stock),
                                                              **({'old': {'sold': old[0], 'min_stock': None if old[1] is None else str(old[1])}} if old else {})})
    return row_json(p, row)
