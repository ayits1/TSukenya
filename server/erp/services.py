"""Document posting. Decimal arithmetic and one atomic transaction per voucher."""
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from datetime import date
import uuid
from django.db import transaction
from django.db.models import Sum, F
from django.utils import timezone
from .models import *

ZERO = Decimal('0')
CENT = Decimal('.01')
QTY = Decimal('.001')
KINDS = dict(Voucher.KIND)
STOCK_KINDS = {'receipt','opening','sale','customer_return','supplier_return','transfer','writeoff','inventory','production'}
LINE_KINDS = STOCK_KINDS | {'purchase_order','customer_order'}
ROLE_KINDS = {
    'owner': set(KINDS), 'manager': set(KINDS)-{'payroll','payroll_payment','cash_opening','debt_opening'},
    'cashier': {'sale','customer_return','customer_order'},
    'warehouse': {'purchase_order','receipt','opening','supplier_return','transfer','writeoff','inventory','production'},
    'accountant': {'payment','expense','cash_opening','payroll','payroll_payment','debt_opening','cash_transfer'},
}
class BusinessError(ValueError):
    pass

def require(condition, message):
    if not condition:
        raise BusinessError(message)

def dec(value, label='Сума', quantum=CENT, minimum=ZERO):
    try:
        n = Decimal(str(value).replace(',', '.'))
        require(n.is_finite() and abs(n) <= Decimal('999999999999'), f'{label}: некоректне число.')
        require(n >= minimum, f'{label}: значення не може бути меншим за {minimum}.')
        rounded = n.quantize(quantum, rounding=ROUND_HALF_UP)
        require(n == rounded, f'{label}: забагато знаків після коми.')
        return rounded
    except (InvalidOperation, TypeError):
        raise BusinessError(f'{label}: некоректне число.')

def money(value):
    return value.quantize(CENT, rounding=ROUND_HALF_UP)

def day(value):
    try:
        return date.fromisoformat(str(value))
    except (ValueError, TypeError):
        raise BusinessError('Вкажіть дату у форматі РРРР-ММ-ДД.')

def get(model, key, label):
    try:
        return model.objects.get(pk=key)
    except (model.DoesNotExist, ValueError, TypeError):
        raise BusinessError(f'{label}: запис не знайдено.')

def audit(user, action, subject, detail=None):
    AuditEvent.objects.create(user=user, action=action, subject=str(subject), detail=detail or {})

def scope(user, store):
    p = user.profile
    require(p.store_id is None or p.store_id == store.pk, 'Немає доступу до цього магазину.')

def permission(user, kind):
    require(kind in ROLE_KINDS.get(user.profile.role, set()), 'Ваша роль не дозволяє цю операцію.')

def ledger_lock():
    return LedgerLock.objects.select_for_update().get(pk=1)

def cash_balance(account):
    return money(CashEntry.objects.filter(account=account).aggregate(n=Sum('amount'))['n'] or ZERO)

def movement(v, lot, qty, value):
    lot.quantity += qty
    lot.value += value
    require(lot.quantity <= Decimal('999999999999999') and lot.value <= Decimal('9999999999999999.99'), 'Перевищено максимальний обсяг облікового залишку.')
    require(lot.quantity >= 0 and lot.value >= 0, 'Недостатньо товару для цієї операції.')
    require(lot.quantity != 0 or lot.value == 0, 'Неузгоджений залишок партії.')
    lot.save(update_fields=['quantity','value'])
    StockEntry.objects.create(voucher=v, lot=lot, quantity=qty, value=value)

def incoming(v, line, quantity, value, warehouse=None, code=None, expiry=None):
    wh = warehouse or v.warehouse
    code = code or line.lot or f'D{v.pk}-L{line.pk}'
    expiry = expiry if expiry is not None else line.expiry
    lot, _ = StockLot.objects.get_or_create(warehouse=wh, product=line.product, code=code, defaults={'expiry': expiry})
    require(lot.expiry == expiry, 'Термін придатності цієї партії вже відрізняється. Вкажіть інший номер партії.')
    movement(v, lot, quantity, value)
    return lot

def outgoing(v, line, quantity, *, allow_expired=False):
    lots = StockLot.objects.filter(warehouse=v.warehouse, product=line.product, quantity__gt=0)
    if line.lot:
        lots = lots.filter(code=line.lot)
    lots = lots.order_by(F('expiry').asc(nulls_last=True), 'pk')
    remaining, total, consumed = quantity, ZERO, []
    for lot in lots:
        if not allow_expired and lot.expiry and lot.expiry < v.date:
            continue
        take = min(remaining, lot.quantity)
        value = lot.value if take == lot.quantity else money(lot.value * take / lot.quantity)
        movement(v, lot, -take, -value)
        total += value
        consumed.append((lot, take, value))
        remaining -= take
        if not remaining:
            break
    require(remaining == 0, f'{line.name}: недостатньо придатного залишку (не вистачає {remaining} {line.unit}).')
    return total, consumed

def cash(v, account, amount, cross_store=False):
    require(cross_store or account.store_id == v.store_id, 'Грошовий рахунок належить іншому магазину.')
    require(not CashEntry.objects.filter(account=account,voucher__date__gt=v.date).exists(), 'На рахунку вже є пізніші операції. Оберіть поточну дату.')
    require(cash_balance(account) + amount >= 0, f'На рахунку «{account.name}» недостатньо коштів.')
    CashEntry.objects.create(voucher=v, account=account, amount=amount)

def net_total(qs):
    return money(qs.aggregate(n=Sum('total'))['n'] or ZERO)

def obligation(reference, *, settlements=None):
    # A read-only browser can preload settlements for many sources. Posting uses
    # the original database path under its ledger lock; the calculation is shared.
    if settlements is None:
        returns = Voucher.objects.filter(reference=reference, status='posted', kind__in=['customer_return','supplier_return'])
        paid = Voucher.objects.filter(reference=reference, status='posted', kind='payment')
        returned_total = net_total(returns)
        paid_total = net_total(paid)
    else:
        returns = [v for v in settlements if v.status == 'posted' and v.kind in {'customer_return', 'supplier_return'}]
        paid = [v for v in settlements if v.status == 'posted' and v.kind == 'payment']
        returned_total = money(sum((v.total for v in returns), ZERO))
        paid_total = money(sum((v.total for v in paid), ZERO))
    embedded = sum((dec(x['amount']) for x in reference.payload.get('payments', [])), ZERO) if reference.kind == 'sale' else ZERO
    refunded = sum((sum((dec(p['amount']) for p in r.payload.get('payments', [])), ZERO) for r in returns), ZERO)
    return reference.total - returned_total - paid_total - embedded + refunded

def payroll_debt(employee):
    qs = Voucher.objects.filter(employee=employee, status='posted')
    return net_total(qs.filter(kind='payroll')) - net_total(qs.filter(kind='payroll_payment'))

@transaction.atomic
def save_voucher(user, body, pk=None):
    lock = ledger_lock()
    kind = body.get('kind')
    permission(user, kind)
    store = get(Store, body.get('store'), 'Магазин')
    scope(user, store)
    require(store.active, 'Магазин вимкнений.')
    posting_day = day(body.get('date'))
    require(not lock.closed_through or posting_day > lock.closed_through, 'Цей обліковий період закритий.')
    require(posting_day <= timezone.localdate(), 'Документ не може бути датований майбутнім днем.')
    key = str(body.get('idempotency_key') or uuid.uuid4())
    require(len(key) <= 80, 'Некоректний ключ запиту.')
    if pk:
        v = get(Voucher, pk, 'Документ')
        scope(user, v.store)
        require(v.status == 'draft', 'Проведений документ редагувати не можна.')
        require(v.kind == kind, 'Тип документа змінити не можна.')
    else:
        previous = Voucher.objects.filter(idempotency_key=key).first()
        if previous:
            scope(user, previous.store)
            permission(user, previous.kind)
            require(previous.kind == kind, 'Ключ запиту вже використано для іншого документа.')
            return previous
        v = Voucher(kind=kind, created_by=user, idempotency_key=key)
    v.date, v.store = posting_day, store
    for field, model, label in [('warehouse',Warehouse,'Склад'),('target',Warehouse,'Склад призначення'),('party',Counterparty,'Контрагент'),('employee',Employee,'Працівник'),('account',CashAccount,'Рахунок'),('shift',CashShift,'Касова зміна'),('reference',Voucher,'Пов’язаний документ')]:
        setattr(v, field, get(model, body[field], label) if body.get(field) else None)
    require(not v.warehouse or v.warehouse.store_id == store.pk, 'Склад належить іншому магазину.')
    require(not v.account or v.account.store_id == store.pk, 'Рахунок належить іншому магазину.')
    if v.target:
        scope(user, v.target.store)
    if kind in LINE_KINDS:
        require(v.warehouse is not None, 'Виберіть склад.')
    if kind == 'transfer':
        require(v.target and v.target != v.warehouse, 'Виберіть інший склад призначення.')
    if kind in {'receipt','purchase_order','supplier_return'}:
        require(v.party and v.party.kind == 'supplier' and v.party.active, 'Виберіть постачальника.')
    if kind in {'sale','customer_return','customer_order'} and v.party:
        require(v.party.kind == 'customer' and v.party.active, 'Виберіть покупця.')
    if kind == 'customer_order':
        require(v.party is not None, 'Виберіть покупця для замовлення.')
    if v.reference:
        require(v.reference.pk != v.pk and v.reference.store_id == store.pk, 'Пов’язаний документ належить іншому магазину.')
        require(v.reference.status == 'posted', 'Пов’язаний документ ще не проведений.')
    ref_types = {'customer_return':'sale','supplier_return':'receipt','receipt':'purchase_order','sale':'customer_order'}
    if v.reference and kind in ref_types:
        require(v.reference.kind == ref_types[kind], 'Невідповідний тип пов’язаного документа.')
        require(v.reference.party_id == v.party_id, 'Контрагент має збігатись із вихідним документом.')
        require(v.reference.warehouse_id == v.warehouse_id, 'Склад має збігатись із вихідним документом.')
    if kind in {'customer_return','supplier_return'}:
        require(v.reference is not None, 'Повернення повинно бути пов’язане з вихідним документом.')
    if kind == 'payment':
        require(v.reference and v.reference.kind in {'receipt','sale','debt_opening'}, 'Виберіть надходження або продаж для оплати.')
        v.party = v.reference.party
    if kind == 'debt_opening':
        require(v.party is not None, 'Виберіть контрагента початкового боргу.')
    if kind in {'payroll','payroll_payment'}:
        require(v.employee and v.employee.store_id == store.pk , 'Виберіть працівника цього магазину.')
    if kind in {'payment','expense','cash_opening','payroll_payment','cash_transfer'}:
        require(v.account is not None, 'Виберіть рахунок.')
    v.note = str(body.get('note',''))[:4000]
    payload = body.get('payload', {})
    require(isinstance(payload, dict), 'Некоректні реквізити документа.')
    # Store only supported fields; amounts and computed payroll never come from the client.
    v.payload = {'payments': payload.get('payments', []), 'fiscal_ref': str(payload.get('fiscal_ref',''))[:160], 'category': str(payload.get('category','Інше'))[:100], 'shift_ids': payload.get('shift_ids', []), 'due_date': str(payload.get('due_date','')), 'additional_cost': str(dec(payload.get('additional_cost', 0))), 'recipe': payload.get('recipe', []), 'target_account': payload.get('target_account')}
    if v.payload['due_date']:
        day(v.payload['due_date'])
    require(isinstance(v.payload['payments'], list) and len(v.payload['payments']) <= 10, 'Некоректні способи оплати.')
    normalized_payments = []
    for payment in v.payload['payments']:
        require(isinstance(payment, dict), 'Некоректний платіж.')
        account = get(CashAccount, payment.get('account'), 'Рахунок оплати')
        require(account.store_id == store.pk, 'Рахунок оплати належить іншому магазину.')
        amount = dec(payment.get('amount'), 'Оплата', minimum=CENT)
        normalized_payments.append({'account': account.pk, 'amount': str(amount)})
    v.payload['payments'] = normalized_payments
    v.total, v.cost = ZERO, ZERO
    if kind not in LINE_KINDS:
        v.total = dec(body.get('amount',0), minimum=ZERO if kind=='payroll' else CENT)
    v.save()
    v.lines.all().delete()
    rows = body.get('lines', [])
    if kind in LINE_KINDS:
        require(isinstance(rows,list) and 1 <= len(rows) <= 200, 'Додайте від 1 до 200 товарних рядків.')
        require(len({str(x.get('product')) for x in rows}) == len(rows), 'Один товар має бути в одному рядку документа. Різні партії оформлюйте окремими документами.')
        for row in rows:
            product = get(Document, 'products/'+str(row.get('product')), 'Товар')
            quantity = dec(row.get('quantity'), 'Кількість', QTY, minimum=ZERO if kind=='inventory' else QTY)
            price = dec(row.get('price',0), 'Ціна', Decimal('.0001'))
            expiry = day(row['expiry']) if row.get('expiry') else None
            require(kind not in {'sale','customer_order'} or price > 0, 'Вкажіть ненульову ціну продажу.')
            require(kind != 'inventory' or not row.get('lot'), 'Інвентаризація рахує повний залишок товару, без вибору окремої партії.')
            amount = money(quantity * price)
            ref_line = None
            if v.reference and kind in ref_types:
                ref_line = v.reference.lines.filter(product=product).first()
                require(ref_line is not None, 'Товар відсутній у вихідному документі.')
                if kind in {'customer_return','supplier_return'}:
                    price = ref_line.price
                    amount = money(quantity * price)
            require(amount <= Decimal('99999999999999.99'), 'Сума рядка перевищує допустиме значення.')
            line = VoucherLine.objects.create(voucher=v, product=product, name=str(product.data.get('name',''))[:250], unit=str(product.data.get('unit','шт'))[:30], quantity=quantity, price=price, amount=amount, lot=str(row.get('lot',''))[:80], expiry=expiry, reference_line=ref_line)
            v.total += line.amount
        if kind == 'receipt':
            v.total += dec(v.payload['additional_cost'])
        require(v.total <= Decimal('99999999999999.99'), 'Сума документа перевищує допустиме значення.')
        v.save(update_fields=['total'])
    audit(user, 'draft_saved', f'voucher/{v.pk}', {'kind':kind})
    return v

def validate_reference_quantities(v):
    if not v.reference:
        return
    for line in v.lines.all():
        if not line.reference_line:
            continue
        previous = VoucherLine.objects.filter(reference_line=line.reference_line, voucher__kind=v.kind, voucher__status='posted').exclude(voucher=v).aggregate(n=Sum('quantity'))['n'] or ZERO
        require(previous + line.quantity <= line.reference_line.quantity, f'{line.name}: перевищено кількість вихідного документа.')

def payroll_amount(v):
    ids = v.payload.get('shift_ids', [])
    require(isinstance(ids,list) and ids, 'Виберіть відпрацьовані зміни.')
    shifts = list(WorkShift.objects.filter(pk__in=ids, employee=v.employee, store=v.store, payroll__isnull=True))
    require(len(shifts) == len(set(ids)), 'Зміну вже оплачено або вона належить іншому працівнику.')
    total = ZERO
    for s in shifts:
        require(s.date <= v.date, 'Дата нарахування передує відпрацьованій зміні.')
        if s.cash_shift:
            require(s.cash_shift.closed_at is not None, 'Касову зміну потрібно закрити перед нарахуванням.')
        sales = Voucher.objects.filter(status='posted', kind='sale', store=s.store, date=s.date)
        returns = Voucher.objects.filter(status='posted', kind='customer_return', store=s.store, date=s.date)
        if s.cash_shift:
            sales = Voucher.objects.filter(status='posted',kind='sale',store=s.store,shift=s.cash_shift)
            returns = Voucher.objects.filter(status='posted',kind='customer_return',store=s.store,reference__shift=s.cash_shift,date__lte=v.date)
        if s.bonus_basis == 'personal':
            sales = sales.filter(employee=s.employee)
            returns = returns.filter(reference__employee=s.employee)
        basis = net_total(sales) - net_total(returns)
        if s.bonus_basis == 'profit':
            basis -= (sales.aggregate(n=Sum('cost'))['n'] or ZERO) - (returns.aggregate(n=Sum('cost'))['n'] or ZERO)
        s.basis_amount = max(ZERO, basis)
        s.accrued = money(s.units * s.shift_rate + s.basis_amount * s.bonus_percent / Decimal(100))
        s.payroll = v
        s.save(update_fields=['basis_amount','accrued','payroll'])
        total += s.accrued
    v.payload['calculation'] = [{'id':s.pk,'date':s.date.isoformat(),'units':str(s.units),'rate':str(s.shift_rate),'percent':str(s.bonus_percent),'basis':s.bonus_basis,'basis_amount':str(s.basis_amount),'accrued':str(s.accrued)} for s in shifts]
    return total

@transaction.atomic
def post_voucher(user, pk):
    lock = ledger_lock()
    v = get(Voucher, pk, 'Документ')
    scope(user,v.store)
    permission(user,v.kind)
    if v.status == 'posted':
        return v
    require(v.status == 'draft', 'Скасований документ повторно провести не можна.')
    require(not lock.closed_through or v.date > lock.closed_through, 'Обліковий період закритий.')
    require(v.store.active, 'Магазин вимкнений.')
    require(not v.reference or v.reference.status == 'posted', 'Вихідний документ скасований.')
    validate_reference_quantities(v)
    if v.kind in {'customer_return','supplier_return'}:
        v.total = ZERO
        for line in v.lines.select_related('reference_line'):
            original = line.reference_line
            prior = VoucherLine.objects.filter(reference_line=original,voucher__kind=v.kind,voucher__status='posted').aggregate(q=Sum('quantity'),a=Sum('amount'))
            line.amount = original.amount-(prior['a'] or ZERO) if (prior['q'] or ZERO)+line.quantity == original.quantity else money(line.quantity*original.price)
            line.save(update_fields=['amount'])
            v.total += line.amount
    # Backdating changes valuations and closed wage periods. Block it explicitly.
    if v.kind in STOCK_KINDS:
        warehouse_ids = [v.warehouse_id] + ([v.target_id] if v.target_id else [])
        require(not StockEntry.objects.filter(lot__warehouse_id__in=warehouse_ids, voucher__date__gt=v.date).exists(), 'Після цієї дати є складські операції. Оберіть поточну дату.')
    if v.kind in {'sale','customer_return'}:
        require(not WorkShift.objects.filter(store=v.store, date__gte=v.date, payroll__status='posted').exists(), 'Зарплату за цей день уже нараховано. Спочатку скасуйте нарахування.')
    lines = list(v.lines.select_related('product','reference_line'))
    costs = ZERO
    if v.kind in {'receipt','opening'}:
        extra = dec(v.payload['additional_cost']) if v.kind=='receipt' else ZERO
        base = sum((l.amount for l in lines), ZERO)
        require(not extra or base > 0, 'Додаткові витрати неможливо розподілити на товари з нульовою вартістю.')
        remaining_extra = extra
        for i,l in enumerate(lines):
            allocation = remaining_extra if i==len(lines)-1 else money(extra*l.amount/base) if base else ZERO
            remaining_extra -= allocation
            l.cost = l.amount + allocation
            incoming(v,l,l.quantity,l.cost)
            costs += l.cost
            l.save(update_fields=['cost'])
    elif v.kind in {'sale','writeoff','supplier_return','transfer'}:
        for l in lines:
            if v.kind == 'supplier_return':
                source=v.reference.stock_entries.filter(lot__product=l.product,quantity__gt=0,is_reversal=False).select_related('lot').first()
                require(source is not None, 'Партію вихідного надходження не знайдено.')
                require(not l.lot or l.lot==source.lot.code,'Повернення має стосуватись партії вихідного надходження.')
                l.lot=source.lot.code
            l.cost, consumed = outgoing(v,l,l.quantity,allow_expired=v.kind in {'writeoff','supplier_return','transfer'})
            if v.kind == 'transfer':
                for lot,qty,value in consumed:
                    # Prefix includes the source warehouse: lot codes cannot collide across warehouses.
                    incoming(v,l,qty,value,warehouse=v.target,code=f'W{v.warehouse_id}:{lot.pk}',expiry=lot.expiry)
            costs += l.cost
            l.save(update_fields=['cost'])
    elif v.kind == 'customer_return':
        for l in lines:
            ref = l.reference_line
            returned = VoucherLine.objects.filter(reference_line=ref,voucher__kind='customer_return',voucher__status='posted').aggregate(n=Sum('cost'))['n'] or ZERO
            returned_qty = VoucherLine.objects.filter(reference_line=ref,voucher__kind='customer_return',voucher__status='posted').aggregate(n=Sum('quantity'))['n'] or ZERO
            l.cost = ref.cost-returned if returned_qty+l.quantity == ref.quantity else money(ref.cost*l.quantity/ref.quantity)
            source_expiries = list(v.reference.stock_entries.filter(lot__product=l.product, quantity__lt=0, lot__expiry__isnull=False).values_list('lot__expiry', flat=True))
            earliest = min(source_expiries) if source_expiries else None
            require(not earliest or not l.expiry or l.expiry <= earliest, 'Повернення не може подовжувати термін придатності товару.')
            incoming(v,l,l.quantity,l.cost,code=f'RETURN-{v.pk}-{l.pk}',expiry=l.expiry or earliest)
            costs += l.cost
            l.save(update_fields=['cost'])
    elif v.kind == 'inventory':
        # Count is for the entire product in the warehouse. Positive discrepancies need an explicit unit cost.
        for l in lines:
            existing = StockLot.objects.filter(warehouse=v.warehouse,product=l.product).aggregate(q=Sum('quantity'))['q'] or ZERO
            difference = l.quantity-existing
            if difference > 0:
                require(l.price > 0, f'{l.name}: для надлишку вкажіть собівартість.')
                l.cost = money(difference*l.price)
                incoming(v,l,difference,l.cost)
            elif difference < 0:
                l.cost,_ = outgoing(v,l,-difference,allow_expired=True)
            v.payload.setdefault('differences',[]).append({'product':l.product_id,'expected':str(existing),'counted':str(l.quantity),'difference':str(difference),'value':str(l.cost if difference>=0 else -l.cost)})
            costs += l.cost
            l.save(update_fields=['cost'])
        v.total = ZERO
    elif v.kind == 'production':
        require(len(lines) == 1, 'Виробництво оформлюється для одного готового товару.')
        output = lines[0]
        recipe = v.payload.get('recipe') or output.product.data.get('recipe',[])
        require(isinstance(recipe,list) and recipe, 'Для готового товару задайте рецептуру.')
        normalized = []
        require(len({str(x.get('product')) for x in recipe}) == len(recipe), 'Інгредієнт не може повторюватись.')
        for component in recipe:
            product = get(Document,'products/'+str(component.get('product')),'Інгредієнт')
            require(product != output.product, 'Готовий товар не може бути власним інгредієнтом.')
            per_unit = dec(component.get('quantity'),'Кількість інгредієнта',QTY,minimum=QTY)
            quantity = per_unit*output.quantity
            require(quantity == quantity.quantize(QTY), 'Кількість інгредієнта повинна мати не більше трьох знаків після коми.')
            proxy = VoucherLine(product=product,name=product.data.get('name',''),unit=product.data.get('unit','шт'),lot='')
            value,_ = outgoing(v,proxy,quantity)
            costs += value
            normalized.append({'product':component['product'],'quantity':str(quantity),'cost':str(value)})
        output.cost = costs
        output.save(update_fields=['cost'])
        incoming(v,output,output.quantity,costs)
        v.payload['consumed'] = normalized
        v.total = ZERO
    if v.kind == 'sale':
        if v.shift:
            require(v.shift.store_id == v.store_id and not v.shift.closed_at, 'Касова зміна закрита або належить іншому магазину.')
            require(user.profile.role != 'cashier' or v.shift.opened_by_id == user.pk, 'Касова зміна відкрита іншим касиром.')
        require(v.employee is None or v.employee.store_id == v.store_id, 'Працівник належить іншому магазину.')
        fiscal = Setting.objects.filter(key='fiscal_required').first()
        require(not fiscal or fiscal.value != 'true' or v.payload['fiscal_ref'], 'Потрібен номер фіскального чека із вашого ПРРО.')
        paid = sum((dec(p['amount']) for p in v.payload['payments']),ZERO)
        require(paid <= v.total, 'Сума оплат перевищує суму продажу.')
        require(v.party or paid == v.total, 'Продаж у борг потребує вибору покупця.')
        for p in v.payload['payments']:
            account = get(CashAccount,p['account'],'Рахунок')
            if account.kind == 'cash':
                require(v.shift and v.shift.account_id == account.pk, 'Для готівкової оплати відкрийте касову зміну цього рахунку.')
            cash(v,account,dec(p['amount']))
    elif v.kind == 'customer_return':
        # Refund only the already-paid part. The remainder reduces the customer's debt.
        refund = sum((dec(p['amount']) for p in v.payload['payments']),ZERO)
        previously_refunded = sum((sum((dec(p['amount']) for p in r.payload['payments']),ZERO) for r in Voucher.objects.filter(reference=v.reference,kind='customer_return',status='posted')),ZERO)
        original_paid = sum((dec(p['amount']) for p in v.reference.payload['payments']),ZERO)+net_total(Voucher.objects.filter(reference=v.reference,kind='payment',status='posted'))
        prior_return_total = net_total(Voucher.objects.filter(reference=v.reference,kind='customer_return',status='posted'))
        unpaid = max(ZERO,v.reference.total-original_paid-prior_return_total+previously_refunded)
        required_refund = max(ZERO,v.total-unpaid)
        require(refund == required_refund, f'Сума повернення коштів має бути {required_refund} грн; решта зменшує борг.')
        for p in v.payload['payments']:
            cash(v,get(CashAccount,p['account'],'Рахунок'),-dec(p['amount']))
    elif v.kind == 'supplier_return':
        refund = sum((dec(p['amount']) for p in v.payload['payments']), ZERO)
        required_refund = max(ZERO, v.total-obligation(v.reference))
        require(refund == required_refund, f'Повернення коштів від постачальника має бути {required_refund} грн; решта зменшує борг.')
        for p in v.payload['payments']:
            cash(v,get(CashAccount,p['account'],'Рахунок'),dec(p['amount']))
    elif v.kind == 'payment':
        require(v.total <= obligation(v.reference), 'Оплата перевищує залишок боргу.')
        cash(v,v.account,v.total if (v.reference.kind=='sale' or v.reference.kind=='debt_opening' and v.reference.party.kind=='customer') else -v.total)
    elif v.kind == 'cash_transfer':
        target=get(CashAccount,v.payload.get('target_account'),'Рахунок призначення')
        scope(user,target.store)
        require(target.pk != v.account_id, 'Виберіть інший рахунок призначення.')
        cash(v,v.account,-v.total)
        cash(v,target,v.total,cross_store=True)
    elif v.kind == 'cash_opening':
        require(not CashEntry.objects.filter(account=v.account).exists(), 'Початковий залишок цього рахунку вже введено або є грошові операції.')
        cash(v,v.account,v.total)
    elif v.kind in {'expense','payroll_payment'}:
        cash(v,v.account,-v.total)
    elif v.kind == 'payroll':
        v.total = payroll_amount(v)
        require(v.total > 0, 'Нарахування дорівнює нулю. Перевірте ставку та відсоток.')
    v.cost = costs
    v.status, v.posted_at = 'posted', timezone.now()
    v.save()
    audit(user,'posted',f'voucher/{v.pk}',{'total':str(v.total),'cost':str(v.cost),'kind':v.kind})
    return v

@transaction.atomic
def reverse_voucher(user, pk, reason):
    lock = ledger_lock()
    v = get(Voucher,pk,'Документ')
    scope(user,v.store)
    require(user.profile.role in {'owner','manager','accountant'}, 'Скасування доступне керівнику або бухгалтеру.')
    permission(user,v.kind)
    require(str(reason).strip(), 'Вкажіть причину скасування.')
    if v.status == 'reversed':
        return v
    require(v.status=='posted','Документ ще не проведено.')
    require(not lock.closed_through or v.date>lock.closed_through,'Обліковий період закритий.')
    require(not Voucher.objects.filter(reference=v,status='posted').exists(),'Спочатку скасуйте пов’язані оплати, надходження або повернення.')
    require(not v.shift or not v.shift.closed_at,'Касову зміну вже закрито. Документ цієї зміни скасовувати не можна.')
    if v.kind in {'sale','customer_return'}:
        require(not WorkShift.objects.filter(store=v.store,date__gte=v.date,payroll__status='posted').exists(),'Спочатку скасуйте нарахування зарплати за цей день.')
    entries = list(v.stock_entries.filter(is_reversal=False).select_related('lot').order_by('-pk'))
    if entries:
        last = max(e.pk for e in entries)
        pairs = {(e.lot.warehouse_id,e.lot.product_id) for e in entries}
        for wh,product in pairs:
            require(not StockEntry.objects.filter(lot__warehouse_id=wh,lot__product_id=product,pk__gt=last,voucher__status='posted').exists(),'Є наступні операції з цим товаром. Скасовуйте їх у зворотному порядку.')
        for e in entries:
            lot = get(StockLot,e.lot_id,'Партія')
            require(lot.quantity-e.quantity>=0 and lot.value-e.value>=0,'Скасування призведе до від’ємного залишку.')
            lot.quantity -= e.quantity
            lot.value -= e.value
            lot.save(update_fields=['quantity','value'])
            StockEntry.objects.create(voucher=v,lot=lot,quantity=-e.quantity,value=-e.value,is_reversal=True)
    for entry in v.cash_entries.filter(is_reversal=False).select_related('account'):
        scope(user,entry.account.store)
        require(cash_balance(entry.account)-entry.amount>=0,'Скасування призведе до від’ємного залишку коштів.')
        CashEntry.objects.create(voucher=v,account=entry.account,amount=-entry.amount,is_reversal=True)
    if v.kind=='payroll':
        WorkShift.objects.filter(payroll=v).update(payroll=None,accrued=0,basis_amount=0)
    v.status,v.reversed_at='reversed',timezone.now()
    v.save(update_fields=['status','reversed_at'])
    audit(user,'reversed',f'voucher/{v.pk}',{'reason':str(reason)[:4000]})
    return v
