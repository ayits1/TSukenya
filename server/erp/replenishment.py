"""Purchase order suggestions for products below their minimum stock. Read-only; the draft is saved by the user."""
from decimal import Decimal

from django.db.models import Sum

from .models import VoucherLine, Warehouse
from .reporting import stock
from .services import ZERO, money, permission

QTY = Decimal('.001')


def on_order(warehouse_id, product_path):
    """Posted purchase order quantity not yet received by posted receipts."""
    ordered = VoucherLine.objects.filter(product_id=product_path, voucher__kind='purchase_order', voucher__status='posted', voucher__warehouse_id=warehouse_id,voucher__order_control__closed_at__isnull=True)
    total = ordered.aggregate(n=Sum('quantity'))['n'] or ZERO
    received = VoucherLine.objects.filter(reference_line__in=ordered, voucher__kind='receipt', voucher__status='posted').aggregate(n=Sum('quantity'))['n'] or ZERO
    return max(ZERO, total - received)


def last_purchase(warehouse, product_path):
    """Supplier and price of the latest posted receipt of this product, preferring the same warehouse."""
    lines = VoucherLine.objects.filter(product_id=product_path, voucher__kind='receipt', voucher__status='posted').select_related('voucher__party').order_by('-voucher__date', '-voucher_id')
    return lines.filter(voucher__warehouse=warehouse).first() or lines.filter(voucher__store_id=warehouse.store_id).first()


def replenishment(user):
    permission(user, 'purchase_order')
    warehouses = {w.pk: w for w in Warehouse.objects.all()}
    groups, covered = {}, 0
    for row in stock(user)['totals']:
        if not row['low']:
            continue
        warehouse, path = warehouses[row['warehouse']], 'products/' + row['product']
        available, minimum = Decimal(row['available']), Decimal(row['minimum'])
        ordered = on_order(warehouse.pk, path)
        need = (minimum - available - ordered).quantize(QTY)
        if need <= 0:
            covered += 1
            continue
        source = last_purchase(warehouse, path)
        party = source.voucher.party if source and source.voucher.party and source.voucher.party.active else None
        price = source.price if source else ZERO
        key = (warehouse.pk, party.pk if party else None)
        group = groups.setdefault(key, {'warehouse': warehouse.pk, 'store': warehouse.store_id, 'party': party.pk if party else None,
                                        'party_name': party.name if party else '', 'lines': [], 'total': ZERO})
        group['lines'].append({'product': row['product'], 'name': row['name'], 'unit': row['unit'], 'quantity': str(need),
                               'price': str(price), 'available': str(available), 'minimum': str(minimum), 'on_order': str(ordered)})
        group['total'] += money(need * price)
    result = sorted(groups.values(), key=lambda g: (g['party'] is None, g['party_name'], g['warehouse']))
    for group in result:
        group['lines'].sort(key=lambda line: line['name'])
        group['total'] = str(money(group['total']))
    return {'groups': result, 'covered': covered}
