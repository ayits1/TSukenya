"""B17 accounting-date reports. Original date is voucher.date; reversal date is Kyiv reversed_at.
Network expenses stay unallocated. These are implementation defaults, not owner decisions.
"""
from collections import defaultdict
from contextlib import contextmanager
from copy import copy
from decimal import Decimal
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo
from django.db import connection, transaction
from django.db.models import Q
from django.db.models.functions import TruncDate
from django.utils import timezone
from .models import CashAccount, CashEntry, Employee, StockEntry, Store, Voucher
from .services import ZERO, day, money, obligation, require
from .browsing import positive_integer

KYIV = ZoneInfo('Europe/Kyiv')
ROLES = {'owner', 'manager', 'accountant'}
METRICS = ('revenue', 'cogs', 'expenses', 'payroll', 'writeoffs', 'inventory_adjustment', 'supplier_return_variance', 'cash_difference', 'cash_net')


@contextmanager
def read_snapshot(strict=True):
    outer = not connection.in_atomic_block
    if not outer and connection.vendor == 'postgresql' and strict:
        with connection.cursor() as cursor:
            cursor.execute('SHOW transaction_isolation'); isolation = cursor.fetchone()[0]
            cursor.execute('SHOW transaction_read_only'); readonly = cursor.fetchone()[0]
        require(isolation in {'repeatable read', 'serializable'} and readonly == 'on',
                'Звіт усередині транзакції потребує REPEATABLE READ та READ ONLY.')
    with transaction.atomic():
        if outer and connection.vendor == 'postgresql':
            with connection.cursor() as cursor:
                cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        yield


def stores_for(user, params):
    require(user.profile.role in ROLES, 'Недостатньо прав для фінансових звітів.')
    selected = positive_integer(params['store'], 'ID магазину') if params.get('store') else user.profile.store_id
    stores = Store.objects.all().order_by('pk')
    if user.profile.store_id:
        stores = stores.filter(pk=user.profile.store_id)
    # Intersect the requested filter with role scope; never disclose a foreign store.
    # Keep the existing report contract: an inaccessible filter yields empty totals.
    if selected:
        return list(stores.filter(pk=selected)), True
    return list(stores), False


def reversal_day(voucher):
    return timezone.localtime(voucher.reversed_at, KYIV).date() if voucher.reversed_at else None


def active_at(voucher, cutoff):
    cancelled = reversal_day(voucher)
    return voucher.date <= cutoff and voucher.status in {'posted', 'reversed'} and (cancelled is None or cancelled > cutoff)


def effective_entries(model, end, start=None):
    query = model.objects.filter(voucher__status__in=['posted', 'reversed']).annotate(
        reversal_day=TruncDate('voucher__reversed_at', tzinfo=KYIV))
    original = Q(is_reversal=False, voucher__date__lte=end)
    reversed_part = Q(is_reversal=True, reversal_day__lte=end)
    if start:
        original &= Q(voucher__date__gte=start)
        reversed_part &= Q(reversal_day__gte=start)
    return query.filter(original | reversed_part)


def require_reversal_dates(ids, cutoff):
    # A missing date cannot safely be assigned to the original period or to today.
    ambiguous = Voucher.objects.filter(status='reversed', reversed_at__isnull=True, date__lte=cutoff).filter(
        Q(store_id__in=ids) | Q(cash_entries__account__store_id__in=ids) | Q(stock_entries__lot__warehouse__store_id__in=ids))
    require(not ambiguous.exists(), 'Є скасований документ без дати скасування. Історичний звіт неможливо визначити достовірно; зверніться до адміністратора для перевірки регістрів.')


def metrics():
    return dict.fromkeys(METRICS, ZERO)


def totals(row):
    gross = row['revenue'] - row['cogs']
    profit = gross - row['expenses'] - row['payroll'] - row['writeoffs'] + row['inventory_adjustment'] + row['supplier_return_variance'] + row['cash_difference']
    return {**{key: str(money(value)) for key, value in row.items()}, 'gross_profit': str(money(gross)), 'profit': str(money(profit))}


def period_documents(ids, start, end, *, kinds=None, include_lines=False):
    # Bound originals and Kyiv cancellations in SQL without loading cancelled history.
    reversal_start = datetime.combine(start, time.min, tzinfo=KYIV)
    reversal_end = datetime.combine(end + timedelta(days=1), time.min, tzinfo=KYIV)
    query = Voucher.objects.filter(store_id__in=ids, status__in=['posted', 'reversed']).filter(
        Q(date__range=(start, end)) | Q(reversed_at__gte=reversal_start, reversed_at__lt=reversal_end))
    if kinds is not None:
        query = query.filter(kind__in=kinds)
    return query.prefetch_related('lines') if include_lines else query


def period_sign(voucher, start, end):
    # The reversal offsets its own Kyiv date, never the original accounting month.
    cancelled = reversal_day(voucher)
    return int(start <= voucher.date <= end) - int(cancelled is not None and start <= cancelled <= end)


def period(user, params):
    from .reporting import cashier_differences
    stores, scoped = stores_for(user, params); ids = {store.pk for store in stores}
    today = timezone.localdate()
    start = day(params.get('from') or today.replace(day=1).isoformat()); end = day(params.get('to') or today.isoformat())
    require(start <= end <= today, 'Період має закінчуватись не раніше початку й не пізніше сьогодні.')
    require_reversal_dates(ids, end)
    documents = period_documents(ids, start, end, include_lines=True)
    rows = {store.pk: metrics() for store in stores}; products = {}; unallocated = ZERO
    expenses_by_category = defaultdict(lambda: ZERO)
    for voucher in documents:
        sign = period_sign(voucher, start, end)
        if not sign: continue
        row = rows[voucher.store_id]; total, cost = sign * voucher.total, sign * voucher.cost
        if voucher.kind == 'sale': row['revenue'] += total; row['cogs'] += cost
        elif voucher.kind == 'customer_return': row['revenue'] -= total; row['cogs'] -= cost
        elif voucher.kind == 'expense':
            network = voucher.payload.get('expense_scope', 'store') == 'network'
            if network:
                if not scoped: unallocated += total
            else: row['expenses'] += total
            if not network or not scoped:
                expenses_by_category[(None if network else voucher.store_id, voucher.payload.get('category', 'Інше'))] += total
        elif voucher.kind == 'payroll': row['payroll'] += total
        elif voucher.kind == 'writeoff': row['writeoffs'] += cost
        elif voucher.kind == 'supplier_return': row['supplier_return_variance'] += total - cost
        elif voucher.kind == 'inventory': row['inventory_adjustment'] += sign * sum((Decimal(item['value']) for item in voucher.payload.get('differences', [])), ZERO)
        elif voucher.kind == 'cash_difference': row['cash_difference'] += sign * Decimal(voucher.payload.get('difference', '0'))
        for line in voucher.lines.all():
            if voucher.kind not in {'sale', 'customer_return', 'writeoff', 'inventory'}: continue
            product = products.setdefault(line.product_id, {'product': line.product_id.split('/', 1)[1], 'name': line.name, 'unit': line.unit,
                'quantity': ZERO, 'revenue': ZERO, 'cogs': ZERO, 'writeoff_quantity': ZERO, 'writeoff': ZERO, 'inventory': ZERO})
            if voucher.kind == 'writeoff': product['writeoff_quantity'] += sign * line.quantity; product['writeoff'] += sign * line.cost
            elif voucher.kind == 'inventory':
                product['inventory'] += sign * sum((Decimal(item['value']) for item in voucher.payload.get('differences', []) if str(item.get('product', '')).removeprefix('products/') == product['product']), ZERO)
            else:
                direction = sign * (-1 if voucher.kind == 'customer_return' else 1)
                product['quantity'] += direction * line.quantity; product['revenue'] += direction * line.amount; product['cogs'] += direction * line.cost
    for entry in effective_entries(CashEntry, end, start).filter(account__store_id__in=ids).exclude(voucher__kind='cash_opening').select_related('account'):
        rows[entry.account.store_id]['cash_net'] += entry.amount
    all_metrics = {key: sum((row[key] for row in rows.values()), ZERO) for key in METRICS}
    all_metrics['expenses'] += unallocated
    product_rows = []
    for product in products.values():
        gross = product['revenue'] - product['cogs']
        product_rows.append({**{key: str(value.quantize(Decimal('.001'))) if key in {'quantity', 'writeoff_quantity'} else str(money(value)) if isinstance(value, Decimal) else value for key, value in product.items()},
            'gross_profit': str(money(gross)), 'margin': str((gross * 100 / product['revenue']).quantize(Decimal('.1'))) if product['revenue'] > 0 else None,
            'result': str(money(gross - product['writeoff'] + product['inventory']))})
    from .financial_browsing import current_debts
    debts, debt_totals = current_debts(user, {'store': params['store']} if params.get('store') else {})
    return {'mode': 'period', 'from': start.isoformat(), 'to': end.isoformat(), **totals(all_metrics),
        'unallocated_expenses': str(money(unallocated)),
        'by_store': [{'store': store.pk, 'name': store.name, **totals(rows[store.pk])} for store in stores],
        'expenses_by_category': [{'store': store, 'scope': 'network' if store is None else 'store', 'category': category, 'amount': str(money(value))} for (store, category), value in expenses_by_category.items()],
        'cashiers': cashier_differences(user, start, end, stores[0].pk if scoped else None) if stores else [],
        'cashiers_basis': 'current_posted_closed_shifts', 'products': sorted(product_rows, key=lambda row: (-Decimal(row['result']), row['name'])),
        'debts': debts, 'debt_count': len(debts), 'debt_totals': debt_totals, 'debts_basis': 'current',
        'basis': 'accounting_dates', 'reversal_policy': 'kyiv_reversed_at'}


def balances(user, params):
    stores, _ = stores_for(user, params); ids = {store.pk for store in stores}
    cutoff = day(params.get('as_of') or timezone.localdate().isoformat())
    require(cutoff <= timezone.localdate(), 'Дата залишків не може бути в майбутньому.')
    require_reversal_dates(ids, cutoff)
    lots = {}
    for entry in effective_entries(StockEntry, cutoff).filter(lot__warehouse__store_id__in=ids).select_related('lot__product', 'lot__warehouse'):
        lot = entry.lot
        row = lots.setdefault(lot.pk, {'lot': lot.pk, 'code': lot.code, 'warehouse': lot.warehouse_id,
            'store': lot.warehouse.store_id, 'product': lot.product_id.split('/', 1)[1], 'name': lot.product.data.get('name', ''),
            'unit': lot.product.data.get('unit', 'шт'), 'expiry': lot.expiry.isoformat() if lot.expiry else None, 'quantity': ZERO, 'value': ZERO})
        row['quantity'] += entry.quantity; row['value'] += entry.value
    stock = [{**row, 'quantity': str(row['quantity'].quantize(Decimal('.001'))), 'value': str(money(row['value'])),
              'expired': bool(row['expiry'] and row['expiry'] < cutoff.isoformat())} for row in lots.values() if row['quantity'] or row['value']]
    account_amounts = defaultdict(lambda: ZERO)
    for entry in effective_entries(CashEntry, cutoff).filter(account__store_id__in=ids): account_amounts[entry.account_id] += entry.amount
    cash = [{'account': account.pk, 'name': account.name, 'store': account.store_id, 'kind': account.kind,
             'amount': str(money(account_amounts[account.pk]))} for account in CashAccount.objects.filter(store_id__in=ids).order_by('store_id', 'pk')]
    sources = list(Voucher.objects.filter(store_id__in=ids, date__lte=cutoff, status__in=['posted', 'reversed'], kind__in=['sale', 'receipt', 'debt_opening']).select_related('party'))
    related = defaultdict(list)
    for settlement in Voucher.objects.filter(reference_id__in=[source.pk for source in sources], date__lte=cutoff, status__in=['posted', 'reversed']):
        if active_at(settlement, cutoff):
            snapshot = copy(settlement); snapshot.status = 'posted'; related[settlement.reference_id].append(snapshot)
    debts = []; owed_to_us = owed_by_us = ZERO
    for source in sources:
        if not active_at(source, cutoff) or not source.party_id: continue
        amount = obligation(source, settlements=related[source.pk])
        if not amount: continue
        supplier = source.kind == 'receipt' or source.kind == 'debt_opening' and source.party.kind == 'supplier'
        if supplier: owed_by_us += amount
        else: owed_to_us += amount
        debts.append({'voucher': source.pk, 'number': f'{source.pk:06d}', 'kind': 'receipt' if supplier else 'sale', 'original_kind': source.kind,
            'store': source.store_id, 'date': source.date.isoformat(), 'party': source.party.name, 'party_id': source.party_id,
            'total': str(source.total), 'amount': str(money(amount)), 'due_date': source.payload.get('due_date', ''),
            'overdue': bool(source.payload.get('due_date') and source.payload['due_date'] < cutoff.isoformat())})
    payroll = []
    if user.profile.role in {'owner', 'accountant'}:
        accrued = defaultdict(lambda: ZERO)
        for voucher in Voucher.objects.filter(store_id__in=ids, date__lte=cutoff, status__in=['posted', 'reversed'], kind__in=['payroll', 'payroll_payment']):
            if active_at(voucher, cutoff): accrued[voucher.employee_id] += voucher.total * (1 if voucher.kind == 'payroll' else -1)
        payroll = [{'employee': employee.pk, 'name': employee.name, 'store': employee.store_id, 'amount': str(money(accrued[employee.pk]))}
                   for employee in Employee.objects.filter(pk__in=accrued) if accrued[employee.pk]]
    return {'mode': 'balances', 'as_of': cutoff.isoformat(), 'basis': 'accounting_dates', 'reversal_policy': 'kyiv_reversed_at',
        'stock': stock, 'stock_value': str(money(sum((Decimal(row['value']) for row in stock), ZERO))),
        'cash': cash, 'cash_total': str(money(sum(account_amounts.values(), ZERO))), 'debts': debts,
        'debt_totals': {'owed_to_us': str(money(owed_to_us)), 'owed_by_us': str(money(owed_by_us))},
        **({'payroll_debts': payroll} if user.profile.role in {'owner', 'accountant'} else {})}


def report(user, params):
    mode = params.get('mode', 'period')
    require(mode in {'period', 'balances'}, 'Некоректний режим звіту.')
    # Legacy programmatic callers may own their transaction. Explicit modes require a stable snapshot.
    with read_snapshot(strict='mode' in params):
        return balances(user, params) if mode == 'balances' else period(user, params)
