"""B25: read-only ledger reconciliation. Only SELECTs; reports exact IDs and never repairs data."""
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from django.db.models import Count, Sum
from .models import *
from .services import LINE_KINDS, STOCK_KINDS, ZERO, money

CHECKS = {'lot_balance': 'Партії: складські рухи = залишок партії', 'voucher_total': 'Документи: сума = рядки (+ додаткові витрати)', 'double_posting': 'Подвійне або неповне проведення', 'payroll': 'Зарплата: нарахування = змін і розрахунок', 'reversal': 'Скасовані документи: рухи в нуль'}
CASH_KINDS = {'sale', 'customer_return', 'supplier_return', 'payment', 'cash_transfer', 'cash_opening', 'expense', 'payroll_payment', 'cash_difference'}
VALUE_KINDS = {'inventory', 'production'}

def issue(check, subject, message, expected=None, actual=None):
    return {'check': check, 'subject': subject, 'message': message, 'expected': None if expected is None else str(expected), 'actual': None if actual is None else str(actual)}

def number(value):
    try: return Decimal(str(value))
    except (InvalidOperation, ValueError): return None

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
                extra = number(v.payload.get('additional_cost', 0))
                if extra is None: out.append(issue('voucher_total', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}): некоректні додаткові витрати «{v.payload.get("additional_cost")}».')); continue
                expected += extra
        if v.total != expected: out.append(issue('voucher_total', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}): сума {v.total} не дорівнює очікуваній {expected}.', expected, v.total))
    return out

def expected_cash(v):
    if v.kind not in CASH_KINDS: return ZERO
    if v.kind in {'sale', 'customer_return', 'supplier_return'}:
        total = ZERO
        for p in v.payload.get('payments') or []:
            amount = number(p.get('amount')) if isinstance(p, dict) else None
            if amount is None: return None
            total += amount
        return total
    return v.total * 2 if v.kind == 'cash_transfer' else v.total

def expected_stock(v, lines):
    """Expected non-reversal stock movement of a posted voucher as {(product path, 'in'|'out'): quantity}."""
    want = defaultdict(lambda: ZERO)
    if v.kind in {'receipt', 'opening', 'customer_return'}:
        for p, q in lines: want[(p, 'in')] += q
    elif v.kind in {'sale', 'writeoff', 'supplier_return'}:
        for p, q in lines: want[(p, 'out')] += q
    elif v.kind == 'transfer':
        for p, q in lines: want[(p, 'out')] += q; want[(p, 'in')] += q
    elif v.kind == 'production':
        for p, q in lines: want[(p, 'in')] += q
        for c in v.payload.get('consumed') or []:
            q = number(c.get('quantity')) if isinstance(c, dict) else None
            if q is None or not c.get('product'): return None
            want[('products/' + str(c['product']), 'out')] += q
    elif v.kind == 'inventory':
        for d in v.payload.get('differences') or []:
            q = number(d.get('difference')) if isinstance(d, dict) else None
            product = d.get('product') if isinstance(d, dict) else None
            if q is None or not product: return None
            if q: want[(product, 'in' if q > 0 else 'out')] += abs(q)
    return {k: x for k, x in want.items() if x}

def check_stock_quantities():
    out = []
    ids = list(Voucher.objects.filter(status__in=['posted', 'reversed'], kind__in=STOCK_KINDS).values_list('pk', flat=True))
    lines, actual = defaultdict(list), defaultdict(lambda: ZERO)
    for l in VoucherLine.objects.filter(voucher__in=ids).values('voucher', 'product', 'quantity'): lines[l['voucher']].append((l['product'], l['quantity']))
    for e in StockEntry.objects.filter(voucher__in=ids, is_reversal=False).values('voucher', 'lot__product', 'quantity'): actual[(e['voucher'], e['lot__product'], 'in' if e['quantity'] > 0 else 'out')] += abs(e['quantity'])
    by_voucher = defaultdict(dict)
    for (voucher, product, way), q in actual.items(): by_voucher[voucher][(product, way)] = q
    for v in Voucher.objects.filter(pk__in=ids).order_by('pk'):
        want = expected_stock(v, lines.get(v.pk, []))
        if want is None: out.append(issue('double_posting', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}): некоректні дані для звірки складських рухів.')); continue
        got = by_voucher.get(v.pk, {})
        for k in sorted(set(want) | set(got), key=str):
            if want.get(k, ZERO) != got.get(k, ZERO): out.append(issue('double_posting', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}): по товару {k[0]} складський рух ({"прихід" if k[1] == "in" else "витрата"}) {got.get(k, ZERO)} замість очікуваних {want.get(k, ZERO)}.', want.get(k, ZERO), got.get(k, ZERO)))
    return out

def check_double_posting():
    out = check_stock_quantities()
    for r in StockEntry.objects.values('voucher', 'lot', 'is_reversal').annotate(n=Count('pk')).filter(n__gt=1).order_by('voucher', 'lot'):
        out.append(issue('double_posting', f'voucher/{r["voucher"]}', f'Документ № {r["voucher"]:06d}: {r["n"]} {"сторнувальних" if r["is_reversal"] else "основних"} складських рухів по партії № {r["lot"]} замість одного.', 1, r['n']))
    stock = {(r['voucher'], r['is_reversal']): r['n'] for r in StockEntry.objects.values('voucher', 'is_reversal').annotate(n=Count('pk'))}
    cash = defaultdict(lambda: ZERO)
    for e in CashEntry.objects.filter(is_reversal=False).values('voucher', 'amount'): cash[e['voucher']] += abs(e['amount'])
    cash_rows = {r['voucher']: r['n'] for r in CashEntry.objects.values('voucher').annotate(n=Count('pk'))}
    for v in Voucher.objects.order_by('pk'):
        has_stock = (v.pk, False) in stock or (v.pk, True) in stock
        if v.status == 'draft' and (has_stock or v.pk in cash_rows): out.append(issue('double_posting', f'voucher/{v.pk}', f'Чернетка № {v.pk:06d} ({v.kind}) має складські або грошові рухи.'))
        if v.status == 'posted' and (v.pk, True) in stock: out.append(issue('double_posting', f'voucher/{v.pk}', f'Проведений документ № {v.pk:06d} ({v.kind}) має сторнувальні складські рухи.'))
        if v.status == 'posted' and has_stock and v.kind not in STOCK_KINDS: out.append(issue('double_posting', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}) не має змінювати склад, але має складські рухи.'))
        if v.status == 'posted' and v.kind in STOCK_KINDS and v.kind != 'inventory' and not (v.pk, False) in stock: out.append(issue('double_posting', f'voucher/{v.pk}', f'Проведений документ № {v.pk:06d} ({v.kind}) не має складських рухів.'))
        if v.status in {'posted', 'reversed'}:
            expected = expected_cash(v)
            if expected is None: out.append(issue('double_posting', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}): некоректні оплати в документі.')); continue
            if v.kind == 'cash_difference' and not cash_rows.get(v.pk): continue
            if cash[v.pk] != expected: out.append(issue('double_posting', f'voucher/{v.pk}', f'Документ № {v.pk:06d} ({v.kind}): грошові рухи {cash[v.pk]} замість очікуваних {expected}.', expected, cash[v.pk]))
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
        calc = v.payload.get('calculation')
        if not isinstance(calc, list) or {c.get('id') for c in calc if isinstance(c, dict)} != {s.pk for s in mine} or len(calc) != len(mine):
            out.append(issue('payroll', f'voucher/{v.pk}', f'Нарахування № {v.pk:06d}: розрахунок у документі не збігається зі змінами {sorted(s.pk for s in mine)}.')); continue
        by_id = {s.pk: s for s in mine}
        for c in calc:
            s = by_id[c['id']]
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

RUNNERS = {'lot_balance': check_lots, 'voucher_total': check_totals, 'double_posting': check_double_posting, 'payroll': check_payroll, 'reversal': check_reversals}

def reconcile():
    """Runs every check; returns {'checks': {name: {'title', 'issues'}}, 'issues': n}."""
    result = {name: {'title': CHECKS[name], 'issues': run()} for name, run in RUNNERS.items()}
    return {'checks': result, 'issues': sum(len(c['issues']) for c in result.values()), 'counts': {'lots': StockLot.objects.count(), 'vouchers': Voucher.objects.count(), 'stock_entries': StockEntry.objects.count(), 'cash_entries': CashEntry.objects.count()}}
