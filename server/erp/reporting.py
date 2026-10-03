from datetime import timedelta
from decimal import Decimal
from django.db.models import Sum, Q
from django.utils import timezone
from .models import *
from .services import money, require, ZERO, net_total, obligation, payroll_debt, cash_balance, day, dec

def number(value):
    return str(value or ZERO)

def voucher_json(v, detail=False, *, user):
    result = {'id':v.pk,'number':f'{v.pk:06d}','kind':v.kind,'status':v.status,'date':v.date.isoformat(),'store':v.store_id,'warehouse':v.warehouse_id,'target':v.target_id,'party':v.party_id,'employee':v.employee_id,'account':v.account_id,'shift':v.shift_id,'reference':v.reference_id,'total':str(v.total),'cost':str(v.cost),'note':v.note,'created_by':v.created_by.username,'created_at':v.created_at.isoformat(),'posted_at':v.posted_at.isoformat() if v.posted_at else None}
    if v.kind in {'receipt','sale','debt_opening'} and v.status=='posted':
        result['outstanding'] = str(obligation(v))
    if detail:
        result['payload']=v.payload
        result['lines']=[{'id':l.pk,'product':l.product_id.split('/',1)[1],'name':l.name,'unit':l.unit,'quantity':str(l.quantity),'price':str(l.price),'amount':str(l.amount),'cost':str(l.cost),'lot':l.lot,'expiry':l.expiry.isoformat() if l.expiry else ''} for l in v.lines.all()]
        for row in result['lines']:
            l = v.lines.get(pk=row['id'])
            next_kind={'purchase_order':'receipt','customer_order':'sale','sale':'customer_return','receipt':'supplier_return'}.get(v.kind)
            if next_kind:
                used=VoucherLine.objects.filter(reference_line=l,voucher__kind=next_kind,voucher__status='posted').aggregate(n=Sum('quantity'))['n'] or ZERO
                row['remaining']=str(l.quantity-used)
                returned_amount=VoucherLine.objects.filter(reference_line=l,voucher__kind=next_kind,voucher__status='posted').aggregate(n=Sum('amount'))['n'] or ZERO
                row['remaining_amount']=str(money(l.amount-returned_amount))
        result['movements']=[{'warehouse':e.lot.warehouse_id,'product':e.lot.product_id.split('/',1)[1],'lot':e.lot.code,'quantity':str(e.quantity),'value':str(e.value),'reversal':e.is_reversal} for e in v.stock_entries.select_related('lot')]
        result['cash_movements']=[{'account':e.account_id,'amount':str(e.amount),'reversal':e.is_reversal} for e in v.cash_entries.all()]
    if user.profile.role == 'cashier':
        result.pop('cost', None)
        for line in result.get('lines', []):
            line.pop('cost', None)
        for movement in result.get('movements', []):
            movement.pop('value', None)
    return result

def scoped(qs, user, field='store_id'):
    if user.profile.store_id:
        return qs.filter(**{field:user.profile.store_id})
    return qs

def state(user):
    from .shift_browsing import cash_shift_json, CASH_SHIFT_ROLES, WORK_FIELDS
    salary = user.profile.role in {'owner','accountant'}
    entities = {}
    for name,model,fields in [('stores',Store,['id','name','active']),('warehouses',Warehouse,['id','store_id','name']),('parties',Counterparty,['id','name','kind','phone','email','notes','active']),('accounts',CashAccount,['id','store_id','name','kind']),('employees',Employee,['id','name','store_id','active']+(['shift_rate','bonus_percent','bonus_basis'] if salary else []))]:
        qs = model.objects.all().order_by('pk')
        if name=='stores' and user.profile.store_id:
            qs=qs.filter(pk=user.profile.store_id)
        elif name in {'warehouses','accounts','employees'}:
            qs=scoped(qs,user)
        entities[name]=list(qs.values(*fields))
    if user.profile.role in {'owner','manager','accountant'}:
        for a in entities['accounts']:
            a['balance']=str(cash_balance(CashAccount(pk=a['id'])))
    shifts=scoped(CashShift.objects.select_related('opened_by'),user).order_by('-pk')
    if user.profile.role not in CASH_SHIFT_ROLES:
        shifts=shifts.none()
    entities['shifts']=[cash_shift_json(s) for s in shifts[:100]]
    entities['shifts_total']=shifts.count()
    entities['active_shifts']=[cash_shift_json(s) for s in shifts.filter(closed_at__isnull=True)]
    if salary:
        work_shifts=scoped(WorkShift.objects.all(),user).order_by('-date','-pk')
        entities['work_shifts']=list(work_shifts[:500].values(*WORK_FIELDS))
        entities['work_shifts_total']=work_shifts.count()
        entities['payroll_debts']=[{'employee':e.pk,'amount':str(payroll_debt(e))} for e in scoped(Employee.objects.all(),user)]
    lock=LedgerLock.objects.get(pk=1)
    entities['closed_through']=lock.closed_through
    entities['role']=user.profile.role
    entities['username']=user.username
    entities['fiscal_required']=Setting.objects.filter(key='fiscal_required',value='true').exists()
    return entities

def stock(user):
    today=timezone.localdate()
    lots=scoped(StockLot.objects.select_related('product','warehouse').filter(quantity__gt=0),user,'warehouse__store_id').order_by('warehouse_id','product_id','expiry','pk')
    result, grouped=[],{}
    for l in lots:
        result.append({'id':l.pk,'warehouse':l.warehouse_id,'product':l.product_id.split('/',1)[1],'name':l.product.data.get('name',''),'unit':l.product.data.get('unit','шт'),'lot':l.code,'expiry':l.expiry.isoformat() if l.expiry else None,'quantity':str(l.quantity),'value':str(l.value),'expired':bool(l.expiry and l.expiry<today)})
        key=(l.warehouse_id,l.product_id)
        g=grouped.setdefault(key,{'warehouse':l.warehouse_id,'product':l.product_id.split('/',1)[1],'name':l.product.data.get('name',''),'unit':l.product.data.get('unit','шт'),'quantity':ZERO,'value':ZERO,'available':ZERO,'minimum':dec(l.product.data.get('minStock',0),quantum=Decimal('.001'))})
        g['quantity']+=l.quantity;g['value']+=l.value
        if not l.expiry or l.expiry>=today:g['available']+=l.quantity
    # Include stocked-out products that have movements or a configured minimum.
    whs=scoped(Warehouse.objects.all(),user)
    products=Document.objects.filter(path__startswith='products/')
    for w in whs:
        for p in products:
            minimum=dec(p.data.get('minStock',0),quantum=Decimal('.001'))
            if minimum>0:
                grouped.setdefault((w.pk,p.pk),{'warehouse':w.pk,'product':p.pk.split('/',1)[1],'name':p.data.get('name',''),'unit':p.data.get('unit','шт'),'quantity':ZERO,'value':ZERO,'available':ZERO,'minimum':minimum})
    totals=[]
    for g in grouped.values():
        g['low']=g['available']<g['minimum']
        totals.append({k:str(v) if isinstance(v,Decimal) else v for k,v in g.items()})
    return {'lots':result,'totals':totals}

def report(user, params):
    from .browsing import positive_integer
    today=timezone.localdate()
    start=day(params.get('from',today.replace(day=1).isoformat()))
    end=day(params.get('to',today.isoformat()))
    require(start <= end, 'Початкова дата пізніша за кінцеву.')
    qs=scoped(Voucher.objects.filter(status='posted',date__gte=start,date__lte=end),user)
    selected_store=positive_integer(params['store'],'ID магазину') if params.get('store') else None
    if selected_store:qs=qs.filter(store_id=selected_store)
    sales=qs.filter(kind='sale'); returns=qs.filter(kind='customer_return')
    revenue=net_total(sales)-net_total(returns)
    cogs=(sales.aggregate(n=Sum('cost'))['n'] or ZERO)-(returns.aggregate(n=Sum('cost'))['n'] or ZERO)
    expenses=net_total(qs.filter(kind='expense'))
    wages=net_total(qs.filter(kind='payroll'))
    writeoff=qs.filter(kind='writeoff').aggregate(n=Sum('cost'))['n'] or ZERO
    supplier_returns=qs.filter(kind='supplier_return')
    supplier_variance=net_total(supplier_returns)-(supplier_returns.aggregate(n=Sum('cost'))['n'] or ZERO)
    inventory=ZERO
    for v in qs.filter(kind='inventory'):
        inventory+=sum((Decimal(x['value']) for x in v.payload.get('differences',[])),ZERO)
    from .financial_browsing import current_debts
    debts,debt_totals=current_debts(user,{'store':params['store']} if params.get('store') else {})
    flow=CashEntry.objects.filter(voucher__date__gte=start,voucher__date__lte=end).exclude(voucher__kind='cash_opening')
    flow=scoped(flow,user,'account__store_id')
    if params.get('store'):flow=flow.filter(account__store_id=params['store'])
    by_store=[]
    for s in scoped(Store.objects.all(),user,'pk'):
        ss=sales.filter(store=s);rr=returns.filter(store=s)
        rev=net_total(ss)-net_total(rr);cost=(ss.aggregate(n=Sum('cost'))['n'] or ZERO)-(rr.aggregate(n=Sum('cost'))['n'] or ZERO)
        by_store.append({'store':s.pk,'name':s.name,'revenue':str(rev),'gross_profit':str(rev-cost)})
    return {'from':start.isoformat(),'to':end.isoformat(),'revenue':str(money(revenue)),'cogs':str(money(cogs)),'gross_profit':str(money(revenue-cogs)),'expenses':str(money(expenses)),'payroll':str(money(wages)),'writeoffs':str(money(writeoff)),'inventory_adjustment':str(money(inventory)),'supplier_return_variance':str(money(supplier_variance)),'profit':str(money(revenue-cogs-expenses-wages-writeoff+inventory+supplier_variance)),'cash_net':str(money(flow.aggregate(n=Sum('amount'))['n'] or ZERO)),'debts':debts,'debt_count':len(debts),'debt_totals':debt_totals,'by_store':by_store}
