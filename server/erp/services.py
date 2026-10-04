"""Document posting. Decimal arithmetic and one atomic transaction per voucher."""
from .business_audit import snapshot as audit_snapshot, change as audit_change
from decimal import Decimal, InvalidOperation, ROUND_DOWN, ROUND_HALF_UP
from datetime import date
import hashlib
import hmac
import json
import uuid
from django.conf import settings
from django.db import transaction
from django.db.models import Sum, F, Q
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
    'accountant': {'payment','advance_allocation','payment_refund','expense','cash_opening','payroll','payroll_payment','debt_opening','cash_transfer','cash_difference'},
}
# Posted only by the system when a till shift is closed; never entered through the document form.
SYSTEM_KINDS = {'cash_difference'}
class BusinessError(ValueError):
    pass

class Conflict(BusinessError):
    """HTTP 409: the record changed elsewhere or a create key was reused with another request."""
    def __init__(self, message, code, **extra):
        super().__init__(message)
        self.code, self.extra = code, extra

_UNOBSERVED_REVISION = object()

STALE_FORM = 'Запис уже змінено на іншому пристрої. Ваші зміни не збережено: скопіюйте потрібне, закрийте форму й відкрийте запис знову.'

def record_revision(obj):
    """Content version of a directory record or timesheet row; any stored field change gives a new one."""
    # Keyed like catalogue revisions: hidden fields such as an employee's rate cannot be guessed from it.
    values = {f.attname: str(getattr(obj, f.attname)) for f in obj._meta.concrete_fields}
    material = json.dumps([obj._meta.label, values], sort_keys=True, ensure_ascii=False).encode()
    return hmac.new(settings.SECRET_KEY.encode(), material, hashlib.sha256).hexdigest()[:32]

def require_revision(obj, sent):
    if not isinstance(sent, str) or sent != record_revision(obj):
        raise Conflict(STALE_FORM, 'revision_conflict')

def require_voucher_revision(voucher, sent):
    """An observed draft version must still be current under the ledger lock."""
    if type(sent) is not int or sent != voucher.revision:
        raise Conflict(STALE_FORM, 'revision_conflict', id=voucher.pk, revision=voucher.revision)


def request_fingerprint(user, body):
    """Normalised create request: the same retry matches, a changed form under the same key does not."""
    material = {key: value for key, value in body.items() if key not in {'idempotency_key', 'revision'}}
    return hashlib.sha256(json.dumps([user.pk, material], sort_keys=True, ensure_ascii=False, separators=(',', ':'), default=str).encode()).hexdigest()

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
    from .business_audit import context
    AuditEvent.objects.create(user=user, action=action, subject=str(subject), detail=context(detail))

def scope(user, store):
    p = user.profile
    require(p.store_id is None or p.store_id == store.pk, 'Немає доступу до цього магазину.')

def permission(user, kind):
    require(kind in ROLE_KINDS.get(user.profile.role, set()), 'Ваша роль не дозволяє цю операцію.')

def current_actor(user):
    """Reload authentication after the posting lock, before permissions or retry ACKs."""
    actor = User.objects.select_related('profile').filter(pk=user.pk, is_active=True, profile__isnull=False).first()
    require(actor is not None, 'Обліковий запис вимкнено або доступ відкликано.')
    # The HTTP caller may serialize the result with this same object. Keep its
    # permission cache current too, so a newly restricted role cannot see costs.
    user.is_active = actor.is_active
    user.profile = actor.profile
    return user


def ledger_lock():
    return LedgerLock.objects.select_for_update().get(pk=1)

def cash_balance(account):
    return money(CashEntry.objects.filter(account=account).aggregate(n=Sum('amount'))['n'] or ZERO)

def movement(v, lot, qty, value, line=None):
    if qty < 0:
        from .reservations import guard_movement
        guard_movement(lot,lot.quantity+qty)
    lot.quantity += qty
    lot.value += value
    require(lot.quantity <= Decimal('999999999999999') and lot.value <= Decimal('9999999999999999.99'), 'Перевищено максимальний обсяг облікового залишку.')
    require(lot.quantity >= 0 and lot.value >= 0, 'Недостатньо товару для цієї операції.')
    require(lot.quantity != 0 or lot.value == 0, 'Неузгоджений залишок партії.')
    lot.save(update_fields=['quantity','value'])
    StockEntry.objects.create(voucher=v, lot=lot, quantity=qty, value=value, line=line if line and line.pk else None)

def receipt_source(line, *, strict=True):
    """Exact received line; old unannotated movements are accepted only when unambiguous."""
    entries = line.voucher.stock_entries.filter(quantity__gt=0, is_reversal=False).select_related('lot')
    annotated = list(entries.filter(line=line))
    if annotated:
        if len(annotated) != 1:
            require(not strict, 'Рядок надходження має неоднозначне походження партії.')
            return None
        return annotated[0]
    if line.voucher.lines.filter(product=line.product).count() != 1:
        require(not strict, 'Історична партія не має однозначного рядка походження.')
        return None
    legacy = list(entries.filter(line__isnull=True, lot__product=line.product))
    if len(legacy) > 1:
        require(not strict, 'Історична партія не має однозначного руху походження.')
        return None
    return legacy[0] if legacy else None

def incoming(v, line, quantity, value, warehouse=None, code=None, expiry=None):
    wh = warehouse or v.warehouse
    code = code or line.lot or f'D{v.pk}-L{line.pk}'
    expiry = expiry if expiry is not None else line.expiry
    lot, _ = StockLot.objects.get_or_create(warehouse=wh, product=line.product, code=code, defaults={'expiry': expiry})
    require(lot.expiry == expiry, 'Термін придатності цієї партії вже відрізняється. Вкажіть інший номер партії.')
    movement(v, lot, quantity, value, line)
    return lot

def outgoing(v, line, quantity, *, allow_expired=False):
    lots = StockLot.objects.filter(warehouse=v.warehouse, product=line.product, quantity__gt=0)
    if line.lot:
        lots = lots.filter(code=line.lot)
    lots = lots.order_by(F('expiry').asc(nulls_last=True), 'pk')
    from .reservations import outgoing_plan,consume
    eligible=[lot for lot in lots if allow_expired or not lot.expiry or lot.expiry>=v.date]
    plan=outgoing_plan(v,line,quantity,eligible)
    combined={}
    for lot,take,reservation in plan:
        consume(reservation,line,take)
        if lot.pk not in combined:combined[lot.pk]=[lot,ZERO]
        combined[lot.pk][1]+=take
    total,consumed=ZERO,[]
    for lot,take in combined.values():
        value = lot.value if take == lot.quantity else money(lot.value * take / lot.quantity)
        movement(v, lot, -take, -value, line)
        total += value
        consumed.append((lot, take, value))
    return total, consumed

def cash(v, account, amount, cross_store=False):
    require(cross_store or account.store_id == v.store_id, 'Грошовий рахунок належить іншому магазину.')
    require(not CashEntry.objects.filter(account=account,voucher__date__gt=v.date).exists(), 'На рахунку вже є пізніші операції. Оберіть поточну дату.')
    require(cash_balance(account) + amount >= 0, f'На рахунку «{account.name}» недостатньо коштів.')
    CashEntry.objects.create(voucher=v, account=account, amount=amount)

def post_cash_difference(user, shift, note=''):
    """Post counted minus expected cash of a closed till so the next shift starts from the counted amount."""
    difference = shift.counted_cash - shift.expected_cash
    if not difference:
        return None
    lock = LedgerLock.objects.get(pk=1)
    today = timezone.localdate()
    require(not lock.closed_through or today > lock.closed_through, 'Обліковий період закритий. Розходження каси провести не можна.')
    shortage = difference < 0
    reason = f'{"Нестача" if shortage else "Надлишок"} каси за зміною № {shift.pk}: очікувано {shift.expected_cash} грн, пораховано {shift.counted_cash} грн.'
    v = Voucher.objects.create(
        kind='cash_difference', date=today, store=shift.store, account=shift.account, shift=shift, employee=shift.employee,
        total=abs(difference), created_by=user, idempotency_key=f'cash-difference/{shift.pk}', note=(reason + (' ' + note if note else ''))[:4000],
        payload={'category': 'Нестача каси' if shortage else 'Надлишок каси', 'direction': 'shortage' if shortage else 'surplus',
                 'difference': str(difference), 'expected': str(shift.expected_cash), 'counted': str(shift.counted_cash), 'reason': reason})
    cash(v, shift.account, difference)
    v.status, v.posted_at = 'posted', timezone.now()
    v.save(update_fields=['status','posted_at'])
    audit(user,'posted',f'voucher/{v.pk}',{**audit_change(None, audit_snapshot('voucher', v), reason=note or reason), 'total':str(v.total),'kind':v.kind,'difference':str(difference)})
    return v

def net_total(qs):
    return money(qs.aggregate(n=Sum('total'))['n'] or ZERO)

def obligation(reference, *, settlements=None, allocations=None):
    from .settlements import allocated_amount, current_allocations
    if settlements is None:
        settlements = list(Voucher.objects.filter(reference=reference, status='posted', kind__in=['customer_return','supplier_return','payment']))
    if allocations is None:
        allocations = list(current_allocations(reference))
    returns = [v for v in settlements if v.status=='posted' and v.kind in {'customer_return','supplier_return'}]
    returned_total = money(sum((v.total for v in returns), ZERO))
    paid_total = allocated_amount(reference, settlements=settlements, allocations=allocations)
    embedded = sum((dec(x['amount']) for x in reference.payload.get('payments', [])), ZERO) if reference.kind == 'sale' else ZERO
    refunded = sum((sum((dec(p['amount']) for p in r.payload.get('payments', [])), ZERO) for r in returns), ZERO)
    return reference.total - returned_total - paid_total - embedded + refunded

def payroll_debt(employee):
    qs = Voucher.objects.filter(employee=employee, status='posted')
    return net_total(qs.filter(kind='payroll')) - net_total(qs.filter(kind='payroll_payment'))

# B09: new commitments need active participants; returns, debt payments and payroll for worked shifts stay open to inactive ones.
ACTIVE_PARTY_KINDS = {'sale','customer_order','purchase_order','receipt'}
ACTIVE_EMPLOYEE_KINDS = {'sale'}
def require_active(obj, what):
    require(obj is None or obj.active, f'{what} «{getattr(obj, "name", "")}» неактивний: нові операції з ним заборонені. Оберіть іншого або активуйте запис.')

def require_active_participants(v):
    if v.kind in ACTIVE_PARTY_KINDS and v.party:
        require_active(v.party, 'Постачальник' if v.party.kind == 'supplier' else 'Покупець')
    if v.kind in ACTIVE_EMPLOYEE_KINDS:
        require_active(v.employee, 'Працівник')
        if v.shift:
            require_active(v.shift.employee, 'Працівник касової зміни')

def expense_permission(user, voucher):
    require(voucher.kind != 'expense' or voucher.payload.get('expense_scope', 'store') != 'network' or user.profile.role in {'owner', 'accountant'}, 'Мережеві витрати доступні лише власнику або бухгалтеру.')

DISCOUNT_KEY, DISCOUNT_DEFAULT = 'max_cashier_discount', Decimal(10)

def percent_text(value):
    return format(value.normalize(), 'f')

def discount_limit():
    row = Setting.objects.filter(key=DISCOUNT_KEY).first()
    try:
        value = Decimal(row.value) if row else DISCOUNT_DEFAULT
        return value if value.is_finite() and ZERO <= value <= 100 else DISCOUNT_DEFAULT
    except InvalidOperation:
        return DISCOUNT_DEFAULT

def approved_order_price(line):
    """Only posting creates this proof; legacy orders and draft snapshots are not approvals."""
    if not line.reference_line:
        return False
    source = line.reference_line.voucher
    if source.kind != 'customer_order' or source.status != 'posted':
        return False
    return any(a.get('line') == line.reference_line_id and a.get('price') == str(line.reference_line.price)
               and a.get('role') in {'owner', 'manager', 'cashier'}
               for a in source.payload.get('price_approvals', []) if isinstance(a, dict)) and line.price >= line.reference_line.price

def apply_discounts(user, v, *, actual_cost=False):
    """Validate price at posting. Sales use consumed stock value, independently of discounts or orders."""
    from .catalog import defaults, regular_price, decimal
    config, limit, role, snapshots = defaults(), discount_limit(), user.profile.role, []
    from .promotion_prices import PriceResolver
    lines = list(v.lines.select_related('product', 'reference_line__voucher'))
    resolver = PriceResolver(config, v.store, product_paths=[line.product_id for line in lines])
    versions = []
    for l in lines:
        data = l.product.data
        resolved = resolver.resolve(l.product)
        effective = Decimal(resolved['salePrice'])
        versions.append({'product': l.product_id.split('/', 1)[1], 'effective_price': str(effective), 'effective_day': resolved['effectiveDay'], 'price_revision': resolved['effectivePriceRevision']})
        approved = v.kind == 'sale' and approved_order_price(l)
        discounted = effective > 0 and l.price < effective and not approved
        below_cost = l.amount < l.cost if actual_cost else decimal(data.get('cost')) > l.price
        # A catalogue promotion or an approved order never authorizes a cashier's loss-making sale.
        require(role in {'owner', 'manager'} or not below_cost, f'{l.name}: ціна нижче собівартості. Такий продаж може провести лише менеджер або власник.')
        if not discounted and not below_cost:
            continue
        deep = discounted and (effective - l.price) * 100 > limit * effective
        require(role in {'owner', 'manager'} or not deep, f'{l.name}: знижка перевищує ліміт касира {percent_text(limit)}%. Більшу знижку може провести лише менеджер або власник.')
        reason = str(v.payload.get('discount_reason', '')).strip()
        require(reason, 'Вкажіть причину знижки.')
        percent = max(ZERO, (effective - l.price) * 100 / effective) if effective > 0 else ZERO
        snapshots.append({'product': l.product_id.split('/', 1)[1], 'name': l.name, 'catalogue_price': str(regular_price(data, config)), 'effective_price': str(effective), 'price': str(l.price), 'discount_percent': str(percent.quantize(CENT, rounding=ROUND_HALF_UP)), 'below_cost': below_cost, 'author': user.username, 'reason': reason})
    v.payload['price_context'] = {'store': v.store_id, 'effective_day': resolver.day.isoformat()}
    v.payload['price_versions'] = versions
    v.payload.pop('discounts', None)
    if snapshots:
        v.payload['discounts'] = snapshots
    v.save(update_fields=['payload'])

@transaction.atomic
def save_voucher(user, body, pk=None):
    lock = ledger_lock()
    user = current_actor(user)
    kind = body.get('kind')
    require(isinstance(kind, str), 'Некоректний тип документа.')
    require(kind not in SYSTEM_KINDS, 'Касове розходження проводиться автоматично під час закриття касової зміни.')
    permission(user, kind)
    store = get(Store, body.get('store'), 'Магазин')
    scope(user, store)
    require(store.active, 'Магазин вимкнений.')
    posting_day = day(body.get('date'))
    require(not lock.closed_through or posting_day > lock.closed_through, 'Цей обліковий період закритий.')
    require(posting_day <= timezone.localdate(), 'Документ не може бути датований майбутнім днем.')
    key = str(body.get('idempotency_key') or uuid.uuid4())
    require(len(key) <= 80, 'Некоректний ключ запиту.')
    before = None
    if pk:
        v = get(Voucher, pk, 'Документ')
        scope(user, v.store)
        require(v.status == 'draft', 'Проведений документ редагувати не можна.')
        require(v.kind == kind, 'Тип документа змінити не можна.')
        expense_permission(user, v)
        # B06: a draft form saves only over the version it was opened from.
        require_voucher_revision(v, body.get('revision'))
        before = audit_snapshot('voucher', v)
        v.revision += 1
    else:
        fingerprint = request_fingerprint(user, body)
        previous = Voucher.objects.filter(idempotency_key=key).first()
        if previous:
            scope(user, previous.store)
            permission(user, previous.kind)
            expense_permission(user, previous)
            require(previous.kind == kind, 'Ключ запиту вже використано для іншого документа.')
            # Documents saved before fingerprints keep the earlier kind-only retry rule.
            if previous.request_fingerprint and (previous.request_fingerprint != fingerprint or previous.revision != 1):
                raise Conflict(f'Документ № {previous.pk:06d} уже створено попереднім запитом, але з іншим змістом. Відкрийте його та внесіть зміни там.', 'idempotency_conflict', id=previous.pk, revision=previous.revision, status=previous.status, original_request_confirmed=previous.request_fingerprint == fingerprint)
            return previous
        v = Voucher(kind=kind, created_by=user, idempotency_key=key, request_fingerprint=fingerprint)
    v.date, v.store = posting_day, store
    for field, model, label in [('warehouse',Warehouse,'Склад'),('target',Warehouse,'Склад призначення'),('party',Counterparty,'Контрагент'),('employee',Employee,'Працівник'),('account',CashAccount,'Рахунок'),('shift',CashShift,'Касова зміна'),('reference',Voucher,'Пов’язаний документ')]:
        setattr(v, field, get(model, body[field], label) if body.get(field) else None)
    require(not v.warehouse or v.warehouse.store_id == store.pk, 'Склад належить іншому магазину.')
    require(not v.account or v.account.store_id == store.pk, 'Рахунок належить іншому магазину.')
    require(not v.shift or v.shift.store_id == store.pk, 'Касова зміна належить іншому магазину.')
    if v.target:
        scope(user, v.target.store)
    if kind in LINE_KINDS:
        require(v.warehouse is not None, 'Виберіть склад.')
    if kind == 'transfer':
        require(v.target and v.target != v.warehouse, 'Виберіть інший склад призначення.')
    if kind in {'receipt','purchase_order','supplier_return'}:
        require(v.party and v.party.kind == 'supplier', 'Виберіть постачальника.')
    if kind in {'sale','customer_return','customer_order'} and v.party:
        require(v.party.kind == 'customer', 'Виберіть покупця.')
    if kind == 'customer_order':
        require(v.party is not None, 'Виберіть покупця для замовлення.')
    require_active_participants(v)
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
        if v.reference:
            require(v.reference.kind in {'receipt','sale','debt_opening'}, 'Виберіть надходження або продаж для оплати.')
            v.party = v.reference.party
        require(v.party is not None, 'Виберіть контрагента платежу.')
    if kind in {'advance_allocation','payment_refund'}:
        require(v.reference and v.reference.kind=='payment', 'Виберіть вихідний платіж з авансом.')
        require(not v.party or v.party.pk==v.reference.party_id, 'Контрагент має збігатись із вихідним платежем.')
        v.party = v.reference.party
        require(v.party is not None, 'Вихідний платіж не має контрагента.')
        require(v.reference.date<=v.date, 'Документ не може передувати вихідному платежу.')
    if kind == 'debt_opening':
        require(v.party is not None, 'Виберіть контрагента початкового боргу.')
    if kind in {'payroll','payroll_payment'}:
        require(v.employee and v.employee.store_id == store.pk , 'Виберіть працівника цього магазину.')
    if kind in {'payment','payment_refund','expense','cash_opening','payroll_payment','cash_transfer'}:
        require(v.account is not None, 'Виберіть рахунок.')
    v.note = str(body.get('note',''))[:4000]
    payload = body.get('payload', {})
    require(isinstance(payload, dict), 'Некоректні реквізити документа.')
    # Store only supported fields; amounts and computed payroll never come from the client.
    previous_payload = dict(v.payload)
    old_expense_scope = v.payload.get('expense_scope', 'store') if v.pk else None
    expense_scope = payload.get('expense_scope', old_expense_scope or 'store')
    require(expense_scope in {'store', 'network'}, 'Некоректна належність витрати.')
    require(expense_scope == 'store' or kind == 'expense' and user.profile.role in {'owner', 'accountant'}, 'Мережеві витрати доступні лише власнику або бухгалтеру.')
    v.payload = {'payments': payload.get('payments', []), 'fiscal_ref': str(payload.get('fiscal_ref',''))[:160], 'category': str(payload.get('category','Інше'))[:100], 'shift_ids': payload.get('shift_ids', []), 'due_date': str(payload.get('due_date','')), 'additional_cost': str(dec(payload.get('additional_cost', 0))), 'recipe': payload.get('recipe', []), 'target_account': payload.get('target_account'), 'discount_reason': str(payload.get('discount_reason','')).strip()[:300], **({'expense_scope': expense_scope} if kind == 'expense' else {})}
    if kind=='expense':
        from .monthly_budgets import bind_expense
        v.payload.update(bind_expense(payload,previous_payload))
    from .orders import normalise_terms,validate_source
    v.payload.update(normalise_terms(v,payload));validate_source(v)
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
    existing_lines = {str(line.line_key): line for line in v.lines.all()}
    retained_lines = set()
    rows = body.get('lines', [])
    if kind in LINE_KINDS:
        require(isinstance(rows,list) and 1 <= len(rows) <= 200, 'Додайте від 1 до 200 товарних рядків.')
        require(all(isinstance(x, dict) for x in rows), 'Некоректний товарний рядок.')
        if kind not in {'receipt', 'opening', 'supplier_return'}:
            require(len({str(x.get('product')) for x in rows}) == len(rows), 'Один товар має бути в одному рядку цього документа.')
        require(all(row.get('expiry') is None or isinstance(row.get('expiry'), str) for row in rows), 'Некоректний термін придатності рядка.')
        if kind in {'receipt', 'opening'}:
            identities = [(str(row.get('product')), str(row.get('lot') or '').strip(), (row.get('expiry') or '') if not str(row.get('lot') or '').strip() else '') for row in rows]
            require(len(set(identities)) == len(rows), 'Рядки одного товару повинні мати різні партії або терміни придатності.')
        for row in rows:
            product = get(Document, 'products/'+str(row.get('product')), 'Товар')
            quantity = dec(row.get('quantity'), 'Кількість', QTY, minimum=ZERO if kind=='inventory' else QTY)
            price = dec(row.get('price',0), 'Ціна', Decimal('.0001'))
            lot_code = str(row.get('lot') or '').strip()
            require(len(lot_code) <= 80, 'Номер партії має містити не більше 80 символів.')
            source_id = row.get('reference_line')
            if source_id == '':
                source_id = None  # Empty hidden input is an absent source in legacy form serialization.
            if source_id is not None:
                text = str(source_id)
                require(type(source_id) in {int, str} and text.isascii() and text.isdigit() and len(text) <= 19,
                        'Некоректний рядок вихідного документа.')
                source_id = int(text)
                require(0 < source_id <= 9223372036854775807, 'Некоректний рядок вихідного документа.')
                require(v.reference and kind in ref_types, 'Рядок походження потребує відповідного вихідного документа.')
            expiry = day(row['expiry']) if row.get('expiry') else None
            require(kind not in {'sale','customer_order'} or price > 0, 'Вкажіть ненульову ціну продажу.')
            require(kind != 'inventory' or not row.get('lot'), 'Інвентаризація рахує повний залишок товару, без вибору окремої партії.')
            amount = money(quantity * price)
            ref_line = None
            if v.reference and kind in ref_types:
                candidates = v.reference.lines.filter(product=product)
                if source_id is not None:
                    ref_line = candidates.filter(pk=source_id).first()
                else:
                    require(candidates.count() <= 1, 'Товар має кілька партій у вихідному документі. Виберіть конкретний рядок.')
                    ref_line = candidates.first()
                require(ref_line is not None, 'Товар або рядок відсутній у вихідному документі.')
                if kind in {'customer_return','supplier_return'}:
                    price = ref_line.price
                    amount = money(quantity * price)
            require(amount <= Decimal('99999999999999.99'), 'Сума рядка перевищує допустиме значення.')
            sent_key = row.get('line_key')
            if not sent_key:
                matches = [l for l in existing_lines.values() if l.product_id == product.pk and str(l.line_key) not in retained_lines]
                if len(matches) == 1 and sum(str(r.get('product')) == str(row.get('product')) for r in rows) == 1:
                    sent_key = str(matches[0].line_key)
            try:
                line_key = uuid.UUID(str(sent_key)) if sent_key else uuid.uuid4()
            except (ValueError, TypeError, AttributeError):
                raise BusinessError('Некоректний ідентифікатор товарного рядка.')
            require(str(line_key) not in retained_lines, 'Ідентифікатор товарного рядка повторюється.')
            line = existing_lines.get(str(line_key))
            require(line is not None or not VoucherLine.objects.filter(line_key=line_key).exists(), 'Товарний рядок належить іншому документу.')
            if line is None:
                line = VoucherLine(voucher=v, line_key=line_key)
            line.product, line.name, line.unit = product, str(product.data.get('name',''))[:250], str(product.data.get('unit','шт'))[:30]
            line.quantity, line.price, line.amount = quantity, price, amount
            line.lot, line.expiry, line.reference_line = lot_code, expiry, ref_line
            if kind == 'supplier_return':
                source = receipt_source(ref_line)
                require(source is not None, 'Партію вихідного надходження не знайдено.')
                require(not line.lot or line.lot == source.lot.code, 'Повернення має стосуватись партії вихідного рядка.')
                line.lot, line.expiry = source.lot.code, source.lot.expiry
            line.save()
            retained_lines.add(str(line_key))
            v.total += line.amount
        v.lines.exclude(line_key__in=retained_lines).delete()
        if kind == 'supplier_return':
            refs = list(v.lines.values_list('reference_line_id', flat=True))
            require(len(set(refs)) == len(refs), 'Кожну отриману партію додавайте одним рядком повернення.')
        if kind == 'customer_order':
            apply_discounts(user, v)
        if kind == 'receipt':
            v.total += dec(v.payload['additional_cost'])
        require(v.total <= Decimal('99999999999999.99'), 'Сума документа перевищує допустиме значення.')
        v.save(update_fields=['total'])
    v.lines.exclude(line_key__in=retained_lines).delete()
    if kind == 'production':
        from .production import freeze_production
        freeze_production(user,v,payload,previous_payload)
    from .settlements import save_allocations
    save_allocations(v, body)
    audit(user, 'draft_saved', f'voucher/{v.pk}', {**audit_change(before, audit_snapshot('voucher', v), observed=body.get('revision'), reason=body.get('reason')), 'kind':kind, **({'allocations': [{'source':r.source_id,'amount':str(r.amount)} for r in v.allocation_entries.all()]} if kind in {'payment','advance_allocation'} else {}), **({'expense_scope': expense_scope, 'old_expense_scope': old_expense_scope} if kind == 'expense' else {})})
    return v

def validate_reference_quantities(v):
    if not v.reference:
        return
    requested = v.lines.exclude(reference_line=None).values('reference_line').annotate(quantity=Sum('quantity'))
    for row in requested:
        original = v.reference.lines.get(pk=row['reference_line'])
        previous = VoucherLine.objects.filter(reference_line=original, voucher__kind=v.kind, voucher__status='posted').exclude(voucher=v).aggregate(n=Sum('quantity'))['n'] or ZERO
        require(previous + row['quantity'] <= original.quantity, f'{original.name}: перевищено кількість вихідного документа.')


def bonus_duplicates(shift, ids=()):
    # One cash-shift turnover may carry one employee's percent only once; another day keeps the rate only.
    return WorkShift.objects.filter(employee_id=shift.employee_id, cash_shift_id=shift.cash_shift_id, bonus_percent__gt=0).exclude(pk=shift.pk).filter(Q(pk__in=list(ids)) | Q(payroll__status='posted'))

def payroll_locked(v):
    """Whether this sale/return changes a posted payroll basis; mirrors payroll_amount."""
    accrued = WorkShift.objects.filter(store=v.store, payroll__status='posted', bonus_percent__gt=0)
    # Without a cash shift a legacy percent reads every store sale/return of that day; later days also
    # block backdating. A rate-only day does not depend on sales and never freezes trading.
    if accrued.filter(cash_shift__isnull=True, bonus_percent__gt=0, date__gte=v.date).exists():
        return True
    if v.kind == 'sale':
        return bool(v.shift_id) and accrued.filter(cash_shift_id=v.shift_id).exists()
    source_shift = v.reference.shift_id if v.reference else None
    if not source_shift:
        return False
    from .payroll_chronology import posted_after
    attempt_at = timezone.now() if v.status == 'draft' else None
    for work in accrued.filter(cash_shift_id=source_shift, payroll__date__gte=v.date).select_related('payroll'):
        # Preserve the backdating boundary. Same-day returns after an actual
        # modern accrual do not rewrite its frozen basis or final bonus.
        if v.date == work.payroll.date and posted_after(v, work.payroll, attempt_at=attempt_at) is True:
            continue
        return True
    return False

def payroll_amount(v):
    ids = v.payload.get('shift_ids', [])
    require(isinstance(ids,list) and ids, 'Виберіть відпрацьовані зміни.')
    require(len(ids) <= 1000 and all(type(x) is int and x > 0 for x in ids), 'Некоректний перелік відпрацьованих змін.')
    shifts = list(WorkShift.objects.filter(pk__in=ids, employee=v.employee, store=v.store, payroll__isnull=True))
    require(len(shifts) == len(set(ids)), 'Зміну вже оплачено або вона належить іншому працівнику.')
    total = ZERO
    for s in shifts:
        require(s.date <= v.date, 'Дата нарахування передує відпрацьованій зміні.')
        if s.cash_shift:
            require(s.cash_shift.closed_at is not None, 'Касову зміну потрібно закрити перед нарахуванням.')
            require(not s.bonus_percent or not bonus_duplicates(s, ids).exists(), f'Зміна {s.date.isoformat()}: відсоток від виторгу касової зміни № {s.cash_shift_id} уже враховано в іншому дні цього працівника. Для повторного дня залиште лише ставку (відсоток 0).')
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
    v.payload['calculation'] = [{'id':s.pk,'date':s.date.isoformat(),'cash_shift':s.cash_shift_id,'units':str(s.units),'rate':str(s.shift_rate),'percent':str(s.bonus_percent),'basis':s.bonus_basis,'basis_amount':str(s.basis_amount),'accrued':str(s.accrued)} for s in shifts]
    return total

@transaction.atomic
def post_voucher(user, pk, *, expected_revision=_UNOBSERVED_REVISION):
    lock = ledger_lock()
    user = current_actor(user)
    v = get(Voucher, pk, 'Документ')
    scope(user,v.store)
    permission(user,v.kind)
    expense_permission(user, v)
    if v.status == 'posted':
        return v
    require(v.status == 'draft', 'Скасований документ повторно провести не можна.')
    # Omitted revision keeps the explicit API 'post current' contract; browser sends its observed version.
    if expected_revision is not _UNOBSERVED_REVISION:
        require_voucher_revision(v, expected_revision)
    before = audit_snapshot('voucher', v)
    require(not lock.closed_through or v.date > lock.closed_through, 'Обліковий період закритий.')
    require(v.store.active, 'Магазин вимкнений.')
    require_active_participants(v)
    require(not v.reference or v.reference.status == 'posted', 'Вихідний документ скасований.')
    validate_reference_quantities(v)
    from .orders import validate_source,approve
    validate_source(v);approve(v)
    from .settlements import validate_post
    validate_post(v)
    if v.kind == 'customer_order':
        apply_discounts(user, v)
        v.payload['price_approvals'] = [{'line': l.pk, 'price': str(l.price), 'author': user.username, 'role': user.profile.role} for l in v.lines.all()]
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
        require(not payroll_locked(v), 'Зарплату за цей день уже нараховано. Спочатку скасуйте нарахування.')
    lines = list(v.lines.select_related('product','reference_line'))
    costs = ZERO
    if v.kind in {'receipt','opening'}:
        extra = dec(v.payload['additional_cost']) if v.kind=='receipt' else ZERO
        base = sum((l.amount for l in lines), ZERO)
        require(not extra or base > 0, 'Додаткові витрати неможливо розподілити на товари з нульовою вартістю.')
        # Proportional shares rounded down; the non-negative cent remainder goes to the largest line.
        shares = [(extra*l.amount/base).quantize(CENT, rounding=ROUND_DOWN) if extra else ZERO for l in lines]
        if extra:
            largest = max(range(len(lines)), key=lambda i: lines[i].amount)
            shares[largest] += extra - sum(shares, ZERO)
        for l,allocation in zip(lines,shares):
            l.cost = l.amount + allocation
            incoming(v,l,l.quantity,l.cost)
            costs += l.cost
            l.save(update_fields=['cost'])
    elif v.kind in {'sale','writeoff','supplier_return','transfer'}:
        for l in lines:
            if v.kind == 'supplier_return':
                source = receipt_source(l.reference_line)
                require(source is not None, 'Партію вихідного надходження не знайдено.')
                require(not l.lot or l.lot==source.lot.code,'Повернення має стосуватись партії вихідного надходження.')
                l.lot=source.lot.code
                l.expiry=source.lot.expiry
            l.cost, consumed = outgoing(v,l,l.quantity,allow_expired=v.kind in {'writeoff','supplier_return','transfer'})
            if v.kind == 'transfer':
                for lot,qty,value in consumed:
                    # Prefix includes the source warehouse: lot codes cannot collide across warehouses.
                    incoming(v,l,qty,value,warehouse=v.target,code=f'W{v.warehouse_id}:{lot.pk}',expiry=lot.expiry)
            costs += l.cost
            l.save(update_fields=['cost','lot','expiry'])
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
        from .production import post_production
        costs = post_production(user,v,lines)
    if v.kind in {'sale','customer_return'} and v.shift:
        require(v.shift.store_id == v.store_id and not v.shift.closed_at, 'Касова зміна закрита або належить іншому магазину.')
        require(user.profile.role != 'cashier' or v.shift.opened_by_id == user.pk, 'Касова зміна відкрита іншим касиром.')
    if v.kind == 'sale':
        apply_discounts(user, v, actual_cost=True)
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
        unpaid = max(ZERO, obligation(v.reference))
        required_refund = max(ZERO,v.total-unpaid)
        require(refund == required_refund, f'Сума повернення коштів має бути {required_refund} грн; решта зменшує борг.')
        for p in v.payload['payments']:
            account = get(CashAccount,p['account'],'Рахунок')
            if account.kind == 'cash':
                require(v.shift and v.shift.account_id == account.pk, 'Для повернення готівки виберіть відкриту касову зміну цього рахунку.')
            cash(v,account,-dec(p['amount']))
    elif v.kind == 'supplier_return':
        refund = sum((dec(p['amount']) for p in v.payload['payments']), ZERO)
        required_refund = max(ZERO, v.total-obligation(v.reference))
        require(refund == required_refund, f'Повернення коштів від постачальника має бути {required_refund} грн; решта зменшує борг.')
        for p in v.payload['payments']:
            cash(v,get(CashAccount,p['account'],'Рахунок'),dec(p['amount']))
    elif v.kind in {'payment','payment_refund'}:
        from .settlements import direction
        cash(v,v.account,v.total*direction(v)*(-1 if v.kind=='payment_refund' else 1))
    elif v.kind == 'advance_allocation':
        pass  # Reclassifies the existing advance; never repeats its cash movement.
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
    from .orders import changed_source
    changed_source(v)
    audit(user,'posted',f'voucher/{v.pk}',{**audit_change(before, audit_snapshot('voucher', v), observed=expected_revision), 'total':str(v.total),'cost':str(v.cost),'kind':v.kind})
    return v

@transaction.atomic
def reverse_voucher(user, pk, reason):
    lock = ledger_lock()
    user = current_actor(user)
    v = get(Voucher,pk,'Документ')
    scope(user,v.store)
    require(user.profile.role in {'owner','manager','accountant'}, 'Скасування доступне керівнику або бухгалтеру.')
    permission(user,v.kind)
    expense_permission(user, v)
    require(str(reason).strip(), 'Вкажіть причину скасування.')
    if v.status == 'reversed':
        return v
    require(v.status=='posted','Документ ще не проведено.')
    before = audit_snapshot('voucher', v)
    require(not lock.closed_through or v.date>lock.closed_through,'Обліковий період закритий.')
    require(not PaymentAllocation.objects.filter(source=v,settlement__status='posted',payment__status='posted').exists(), 'Спочатку скасуйте розподіли платежів на цей документ.')
    require(not Voucher.objects.filter(reference=v,status='posted').exists(),'Спочатку скасуйте пов’язані оплати, надходження або повернення.')
    require(not v.shift or not v.shift.closed_at,'Касову зміну вже закрито. Документ цієї зміни скасовувати не можна.')
    if v.kind in {'sale','customer_return'}:
        require(not payroll_locked(v),'Спочатку скасуйте нарахування зарплати за цей день.')
    entries = list(v.stock_entries.filter(is_reversal=False).select_related('lot').order_by('-pk'))
    if entries:
        last = max(e.pk for e in entries)
        pairs = {(e.lot.warehouse_id,e.lot.product_id) for e in entries}
        for wh,product in pairs:
            require(not StockEntry.objects.filter(lot__warehouse_id=wh,lot__product_id=product,pk__gt=last,voucher__status='posted').exists(),'Є наступні операції з цим товаром. Скасовуйте їх у зворотному порядку.')
        for e in entries:
            lot = get(StockLot,e.lot_id,'Партія')
            require(lot.quantity-e.quantity>=0 and lot.value-e.value>=0,'Скасування призведе до від’ємного залишку.')
            if e.quantity > 0:
                from .reservations import guard_movement
                guard_movement(lot,lot.quantity-e.quantity)
            lot.quantity -= e.quantity
            lot.value -= e.value
            lot.save(update_fields=['quantity','value'])
            StockEntry.objects.create(voucher=v,lot=lot,quantity=-e.quantity,value=-e.value,is_reversal=True,line_id=e.line_id)
    for entry in v.cash_entries.filter(is_reversal=False).select_related('account'):
        scope(user,entry.account.store)
        require(cash_balance(entry.account)-entry.amount>=0,'Скасування призведе до від’ємного залишку коштів.')
        CashEntry.objects.create(voucher=v,account=entry.account,amount=-entry.amount,is_reversal=True)
    if v.kind=='payroll':
        WorkShift.objects.filter(payroll=v).update(payroll=None,accrued=0,basis_amount=0)
    v.status,v.reversed_at='reversed',timezone.now()
    v.save(update_fields=['status','reversed_at'])
    from .reservations import reverse_uses
    from .orders import changed_source,cancel_order
    reverse_uses(v);changed_source(v);cancel_order(v)
    audit(user,'reversed',f'voucher/{v.pk}',audit_change(before, audit_snapshot('voucher', v), reason=reason))
    return v
