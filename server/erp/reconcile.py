"""B25: read-only ledger reconciliation. Only SELECTs; reports exact IDs and never repairs data."""
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from django.db.models import Count, Sum
from .models import *
from .services import LINE_KINDS, STOCK_KINDS, ZERO, money

CHECKS = {'allocations':'Розподіли платежів, аванси й борги', 'lot_balance': 'Партії: складські рухи = залишок партії', 'voucher_total': 'Документи: сума = рядки (+ додаткові витрати)', 'double_posting': 'Подвійне або неповне проведення', 'payroll': 'Зарплата: нарахування = змін і розрахунок', 'reversal': 'Скасовані документи: рухи в нуль'}
CASH_KINDS = {'sale', 'customer_return', 'supplier_return', 'payment', 'payment_refund', 'cash_transfer', 'cash_opening', 'expense', 'payroll_payment', 'cash_difference'}
VALUE_KINDS = {'inventory', 'production'}

def issue(check, subject, message, expected=None, actual=None):
    return {'check': check, 'subject': subject, 'message': message, 'expected': None if expected is None else str(expected), 'actual': None if actual is None else str(actual)}

def number(value):
    try:
        result = Decimal(str(value))
        return result if result.is_finite() and result.copy_abs() <= Decimal('999999999999999999999999') else None
    except (InvalidOperation, ValueError, TypeError): return None

def identifier(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)): return None
    text = str(value)
    return int(text) if len(text) <= 19 and text.isascii() and text.isdigit() and 0 < int(text) <= 9223372036854775807 else None

def check_lots():
    sums = {r['lot']: r for r in StockEntry.objects.values('lot').annotate(q=Sum('quantity'), v=Sum('value'))}
    out = []
    for lot in StockLot.objects.order_by('pk'):
        row = sums.get(lot.pk, {}); q, v = row.get('q') or ZERO, row.get('v') or ZERO
        if q != lot.quantity: out.append(issue('lot_balance', f'stocklot/{lot.pk}', f'Партія № {lot.pk} (склад {lot.warehouse_id}, товар {lot.product_id}, код {lot.code}): кількість рухів {q} не дорівнює залишку {lot.quantity}.', q, lot.quantity))
        if v != lot.value: out.append(issue('lot_balance', f'stocklot/{lot.pk}', f'Партія № {lot.pk} (склад {lot.warehouse_id}, товар {lot.product_id}, код {lot.code}): вартість рухів {v} не дорівнює вартості залишку {lot.value}.', v, lot.value))
    return out

def check_totals():
    sums = {r['voucher']: r['a'] or ZERO for r in VoucherLine.objects.values('voucher').annotate(a=Sum('amount'))}
    out = []
    for v in Voucher.objects.filter(status__in=['posted', 'reversed'], kind__in=LINE_KINDS).order_by('pk'):
        if v.kind in VALUE_KINDS: expected = ZERO
        else:
            expected = sums.get(v.pk, ZERO)
            if v.kind == 'receipt':
                extra = number(v.payload.get('additional_cost', 0)) if isinstance(v.payload, dict) else None
                if extra is None: out.append(issue('voucher_total', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}): некоректні додаткові витрати «{v.payload.get("additional_cost") if isinstance(v.payload, dict) else v.payload}».')); continue
                expected += extra
        if v.total != expected: out.append(issue('voucher_total', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}): сума {v.total} не дорівнює очікуваній {expected}.', expected, v.total))
    return out

def expected_cash(v):
    """Signed original amounts by account/direction, so opposite extra entries cannot cancel."""
    if v.kind not in CASH_KINDS: return {}
    if not isinstance(v.payload, dict): return None
    want = defaultdict(lambda: ZERO)
    def add(account, amount):
        account = identifier(account)
        if account is None or amount is None: return False
        if amount: want[(account, 'in' if amount > 0 else 'out')] += amount
        return True
    if v.kind in {'sale', 'customer_return', 'supplier_return'}:
        payments = v.payload.get('payments', [])
        if not isinstance(payments, list): return None
        for p in payments:
            amount = number(p.get('amount')) if isinstance(p, dict) else None
            if amount is None or amount < 0: return None
            if not add(p.get('account'), -amount if v.kind == 'customer_return' else amount): return None
    elif v.kind == 'cash_transfer':
        if not add(v.account_id, -v.total) or not add(v.payload.get('target_account'), v.total): return None
    elif v.kind in {'payment','payment_refund'}:
        from .settlements import direction
        if not v.party and not (v.reference and v.reference.party): return None
        if not add(v.account_id, v.total*direction(v)*(-1 if v.kind=='payment_refund' else 1)): return None
    elif v.kind=='advance_allocation':
        pass
    elif v.kind == 'cash_difference':
        difference = number(v.payload.get('difference'))
        if difference is None or abs(difference) != v.total: return None
        if not add(v.account_id, difference): return None
    else:
        amount = -v.total if v.kind in {'expense', 'payroll_payment'} else v.total
        if not add(v.account_id, amount): return None
    return dict(want)

def expected_stock(v, lines):
    """Expected original quantities by product, warehouse and direction."""
    if not isinstance(v.payload, dict): return None
    want = defaultdict(lambda: ZERO)
    if v.kind in {'receipt', 'opening', 'customer_return'}:
        for p, q in lines: want[(p, v.warehouse_id, 'in')] += q
    elif v.kind in {'sale', 'writeoff', 'supplier_return'}:
        for p, q in lines: want[(p, v.warehouse_id, 'out')] += q
    elif v.kind == 'transfer':
        for p, q in lines:
            want[(p, v.warehouse_id, 'out')] += q
            want[(p, v.target_id, 'in')] += q
    elif v.kind == 'production':
        for p, q in lines: want[(p, v.warehouse_id, 'in')] += q
        consumed = v.payload.get('consumed', [])
        if not isinstance(consumed, list): return None
        for c in consumed:
            q = number(c.get('quantity')) if isinstance(c, dict) else None
            product = c.get('product') if isinstance(c, dict) else None
            if q is None or q <= 0 or not isinstance(product, str) or not product: return None
            want[('products/' + product, v.warehouse_id, 'out')] += q
    elif v.kind == 'inventory':
        differences = v.payload.get('differences', [])
        if not isinstance(differences, list): return None
        for d in differences:
            q = number(d.get('difference')) if isinstance(d, dict) else None
            product = d.get('product') if isinstance(d, dict) else None
            if q is None or not isinstance(product, str) or not product: return None
            if q: want[(product, v.warehouse_id, 'in' if q > 0 else 'out')] += abs(q)
    return {k: x for k, x in want.items() if x}

def check_stock_quantities():
    out = []
    ids = list(Voucher.objects.filter(status__in=['posted', 'reversed'], kind__in=STOCK_KINDS).values_list('pk', flat=True))
    lines, actual = defaultdict(list), defaultdict(lambda: ZERO)
    for l in VoucherLine.objects.filter(voucher__in=ids).values('voucher', 'product', 'quantity'): lines[l['voucher']].append((l['product'], l['quantity']))
    for e in StockEntry.objects.filter(voucher__in=ids, is_reversal=False).values('voucher', 'lot__product', 'lot__warehouse', 'quantity'): actual[(e['voucher'], e['lot__product'], e['lot__warehouse'], 'in' if e['quantity'] > 0 else 'out')] += abs(e['quantity'])
    by_voucher = defaultdict(dict)
    for (voucher, product, warehouse, way), q in actual.items(): by_voucher[voucher][(product, warehouse, way)] = q
    for v in Voucher.objects.filter(pk__in=ids).order_by('pk'):
        want = expected_stock(v, lines.get(v.pk, []))
        if want is None: out.append(issue('double_posting', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}): некоректні дані для звірки складських рухів.')); continue
        got = by_voucher.get(v.pk, {})
        for k in sorted(set(want) | set(got), key=str):
            if want.get(k, ZERO) != got.get(k, ZERO): out.append(issue('double_posting', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}): по товару {k[0]} на складі № {k[1]} складський рух ({"прихід" if k[2] == "in" else "витрата"}) {got.get(k, ZERO)} замість очікуваних {want.get(k, ZERO)}.', want.get(k, ZERO), got.get(k, ZERO)))
    return out

def check_double_posting():
    out = check_stock_quantities()
    for r in StockEntry.objects.values('voucher', 'lot', 'is_reversal').annotate(n=Count('pk')).filter(n__gt=1).order_by('voucher', 'lot'):
        out.append(issue('double_posting', f'voucher/{r["voucher"]}', f'Документ № {r["voucher"]:06d}: {r["n"]} {"сторнувальних" if r["is_reversal"] else "основних"} складських рухів по партії № {r["lot"]} замість одного.', 1, r['n']))
    stock = {(r['voucher'], r['is_reversal']): r['n'] for r in StockEntry.objects.values('voucher', 'is_reversal').annotate(n=Count('pk'))}
    cash = defaultdict(lambda: defaultdict(lambda: ZERO))
    for e in CashEntry.objects.filter(is_reversal=False).values('voucher', 'account', 'amount'):
        if e['amount']: cash[e['voucher']][(e['account'], 'in' if e['amount'] > 0 else 'out')] += e['amount']
    cash_reversals = set(CashEntry.objects.filter(is_reversal=True).values_list('voucher', flat=True))
    cash_rows = {r['voucher']: r['n'] for r in CashEntry.objects.values('voucher').annotate(n=Count('pk'))}
    for v in Voucher.objects.select_related('reference__party').order_by('pk'):
        has_stock = (v.pk, False) in stock or (v.pk, True) in stock
        if v.status == 'draft' and (has_stock or v.pk in cash_rows): out.append(issue('double_posting', f'voucher/{v.pk}', f'Чернетка № {v.pk:06d} ({v.kind}) має складські або грошові рухи.'))
        if v.status == 'posted' and (v.pk, True) in stock: out.append(issue('double_posting', f'voucher/{v.pk}', f'Проведений документ № {v.pk:06d} ({v.kind}) має сторнувальні складські рухи.'))
        if v.status == 'posted' and v.pk in cash_reversals: out.append(issue('double_posting', f'voucher/{v.pk}', f'Проведений документ № {v.pk:06d} ({v.kind}) має сторнувальні грошові рухи.'))
        if v.status == 'posted' and has_stock and v.kind not in STOCK_KINDS: out.append(issue('double_posting', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}) не має змінювати склад, але має складські рухи.'))
        if v.status == 'posted' and v.kind in STOCK_KINDS and v.kind != 'inventory' and not (v.pk, False) in stock: out.append(issue('double_posting', f'voucher/{v.pk}', f'Проведений документ № {v.pk:06d} ({v.kind}) не має складських рухів.'))
        if v.status in {'posted', 'reversed'}:
            expected = expected_cash(v) if isinstance(v.payload, dict) else None
            if expected is None: out.append(issue('double_posting', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}): некоректні оплати в документі.')); continue
            got = cash[v.pk]
            for account, direction in sorted(set(expected) | set(got)):
                key = (account, direction)
                if got.get(key, ZERO) != expected.get(key, ZERO):
                    out.append(issue('double_posting', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}): по рахунку № {account} ({"прихід" if direction == "in" else "витрата"}) грошові рухи {got.get(key, ZERO)} замість очікуваних {expected.get(key, ZERO)}.', expected.get(key, ZERO), got.get(key, ZERO)))
    return out

def check_payroll():
    out = []
    shifts = defaultdict(list)
    for s in WorkShift.objects.filter(payroll__isnull=False).order_by('pk'): shifts[s.payroll_id].append(s)
    for v in Voucher.objects.filter(kind='payroll').order_by('pk'):
        mine = shifts.get(v.pk, [])
        if v.status != 'posted':
            if mine: out.append(issue('payroll', f'voucher/{v.pk}', f'Нарахування № {v.pk:06d} має статус «{v.status}», але до нього прив’язані зміни {sorted(s.pk for s in mine)}.'))
            continue
        accrued = sum((s.accrued for s in mine), ZERO)
        if v.total != accrued: out.append(issue('payroll', f'voucher/{v.pk}', f'Нарахування № {v.pk:06d}: сума {v.total} не дорівнює сумі змін {accrued}.', accrued, v.total))
        calc = v.payload.get('calculation') if isinstance(v.payload, dict) else None
        if not isinstance(calc, list) or any(not isinstance(c, dict) or identifier(c.get('id')) is None for c in calc) or {identifier(c['id']) for c in calc} != {s.pk for s in mine} or len(calc) != len(mine):
            out.append(issue('payroll', f'voucher/{v.pk}', f'Нарахування № {v.pk:06d}: розрахунок у документі не збігається зі змінами {sorted(s.pk for s in mine)}.')); continue
        by_id = {s.pk: s for s in mine}
        for c in calc:
            s = by_id[identifier(c['id'])]
            if number(c.get('accrued')) != s.accrued or number(c.get('basis_amount')) != s.basis_amount: out.append(issue('payroll', f'voucher/{v.pk}', f'Нарахування № {v.pk:06d}, зміна № {s.pk}: розрахунок {c.get("accrued")} не збігається з нарахованим {s.accrued}.', c.get('accrued'), s.accrued))
        for s in mine:
            formula = money(s.units * s.shift_rate + s.basis_amount * s.bonus_percent / Decimal(100))
            if formula != s.accrued: out.append(issue('payroll', f'workshift/{s.pk}', f'Зміна № {s.pk} (нарахування № {v.pk:06d}): ставка і відсоток дають {formula}, нараховано {s.accrued}.', formula, s.accrued))
    for s in WorkShift.objects.filter(payroll__isnull=True).exclude(accrued=0, basis_amount=0).order_by('pk'): out.append(issue('payroll', f'workshift/{s.pk}', f'Зміна № {s.pk} не оплачена, але має нараховану суму {s.accrued} або базу {s.basis_amount}.', 0, s.accrued))
    return out

def check_reversals():
    out = []
    ids = list(Voucher.objects.filter(status='reversed').values_list('pk', flat=True))
    stock = defaultdict(lambda: [ZERO, ZERO, 0, 0])
    for e in StockEntry.objects.filter(voucher__in=ids).values('voucher', 'lot', 'quantity', 'value', 'is_reversal'):
        row = stock[(e['voucher'], e['lot'])]; row[0] += e['quantity']; row[1] += e['value']; row[2 if e['is_reversal'] else 3] += 1
    for (voucher, lot), (q, value, rev, main) in sorted(stock.items()):
        if q or value or rev != main: out.append(issue('reversal', f'voucher/{voucher}', f'Скасований документ № {voucher:06d}: по партії № {lot} складські рухи не обнуляються (кількість {q}, вартість {value}, основних {main}, сторнувальних {rev}).', 0, f'{q} / {value}'))
    cash = defaultdict(lambda: [ZERO, 0, 0])
    for e in CashEntry.objects.filter(voucher__in=ids).values('voucher', 'account', 'amount', 'is_reversal'):
        row = cash[(e['voucher'], e['account'])]; row[0] += e['amount']; row[1 if e['is_reversal'] else 2] += 1
    for (voucher, account), (amount, rev, main) in sorted(cash.items()):
        if amount or rev != main: out.append(issue('reversal', f'voucher/{voucher}', f'Скасований документ № {voucher:06d}: по рахунку № {account} грошові рухи не обнуляються (сума {amount}, основних {main}, сторнувальних {rev}).', 0, amount))
    return out

def check_allocations():
    from .settlements import SOURCE_KINDS, allocation_active, advance_balances
    from .services import obligation, BusinessError
    out=[];by_event=defaultdict(lambda:ZERO)
    rows=list(PaymentAllocation.objects.select_related('settlement','payment','source','source__party'))
    for row in rows:
        event,payment,source=row.settlement,row.payment,row.source
        by_event[event.pk]+=row.amount
        valid=(event.kind in {'payment','advance_allocation'} and payment.kind=='payment' and source.kind in SOURCE_KINDS and row.amount>0
               and event.party_id==payment.party_id==source.party_id and event.store_id==payment.store_id==source.store_id
               and source.date<=event.date and payment.date<=event.date
               and (source.kind=='debt_opening' or source.party is not None and source.kind==('sale' if source.party.kind=='customer' else 'receipt'))
               and (event.pk==payment.pk if event.kind=='payment' else event.reference_id==payment.pk))
        if not valid:out.append(issue('allocations',f'allocation/{row.pk}','Некоректні джерело, напрям, дата або сума розподілу.'))
        if event.status=='posted' and not allocation_active(row):out.append(issue('allocations',f'allocation/{row.pk}','Активний розподіл посилається на непроведений платіж або джерело.'))
    payments=list(Voucher.objects.filter(kind='payment',status='posted').select_related('party','reference__party'))
    remaining=advance_balances(payments)
    for v in payments:
        if by_event[v.pk]>v.total or remaining[v.pk]<0:out.append(issue('allocations',f'voucher/{v.pk}','Розподіли та повернення перевищують платіж.',v.total,by_event[v.pk]))
        if v.reference_id and v.reference.kind in SOURCE_KINDS and by_event[v.pk] and by_event[v.pk]!=v.total:out.append(issue('allocations',f'voucher/{v.pk}','Legacy оплата має неповний розподіл.'))
    for v in Voucher.objects.filter(kind__in=['advance_allocation','payment_refund'],status='posted').select_related('reference'):
        if not v.reference or v.reference.kind!='payment' or v.reference.status!='posted' or v.reference.store_id!=v.store_id or v.reference.party_id!=v.party_id or v.reference.date>v.date or v.total<=0:
            out.append(issue('allocations',f'voucher/{v.pk}','Некоректні вихідний аванс, магазин, контрагент, дата або сума операції.'))
        if v.kind=='advance_allocation' and by_event[v.pk]!=v.total:out.append(issue('allocations',f'voucher/{v.pk}','Сума використання авансу не дорівнює розподілам.',v.total,by_event[v.pk]))
    from .browsing import with_settlements
    for source in with_settlements(Voucher.objects.filter(kind__in=SOURCE_KINDS,status='posted')):
        try:
            amount=obligation(source,settlements=source.browse_settlements,allocations=source.browse_allocations)
        except (BusinessError, KeyError, TypeError, AttributeError, InvalidOperation):
            out.append(issue('allocations',f'voucher/{source.pk}','Некоректні реквізити боргу або повернень: залишок неможливо обчислити.'))
            continue
        if amount<0:out.append(issue('allocations',f'voucher/{source.pk}','Розподіли перевищують борг документа.',0,amount))
    return out

RUNNERS = {'lot_balance': check_lots, 'voucher_total': check_totals, 'double_posting': check_double_posting, 'payroll': check_payroll, 'reversal': check_reversals, 'allocations':check_allocations}

def reconcile():
    """Runs every check; returns {'checks': {name: {'title', 'issues'}}, 'issues': n}."""
    result = {name: {'title': CHECKS[name], 'issues': run()} for name, run in RUNNERS.items()}
    from .reconcile_periods import check_periods
    found, coverage = check_periods()
    result['closed_period'] = {'title': 'Закриті періоди та відомий порядок проведень', 'issues': found}
    return {'coverage': coverage, 'checks': result, 'issues': sum(len(c['issues']) for c in result.values()), 'counts': {'lots': StockLot.objects.count(), 'vouchers': Voucher.objects.count(), 'stock_entries': StockEntry.objects.count(), 'cash_entries': CashEntry.objects.count()}}
