import json
from copy import deepcopy
from datetime import datetime, timedelta
from decimal import Decimal
from django.db.models import Sum, Q
from django.utils import timezone
from .models import *
from .services import money, require, ZERO, net_total, obligation, payroll_debt, cash_balance, day, dec, record_revision, discount_limit, percent_text

def number(value):
    return str(value or ZERO)

def voucher_json(v, detail=False, *, user):
    result = {'id':v.pk,'number':f'{v.pk:06d}','kind':v.kind,'status':v.status,'date':v.date.isoformat(),'store':v.store_id,'warehouse':v.warehouse_id,'target':v.target_id,'party':v.party_id,'employee':v.employee_id,'account':v.account_id,'shift':v.shift_id,'reference':v.reference_id,'total':str(v.total),'cost':str(v.cost),'note':v.note,'created_by':v.created_by.username,'created_at':v.created_at.isoformat(),'posted_at':v.posted_at.isoformat() if v.posted_at else None,'revision':v.revision}
    if v.kind in {'receipt','sale','debt_opening'} and v.status=='posted':
        result['outstanding'] = str(obligation(v))
    if detail:
        result['payload']=deepcopy(v.payload)
        if v.kind in {'customer_order','purchase_order'}:
            from .orders import order_json
            result['order']=order_json(v,user)
        if v.kind in {'payment','advance_allocation'}:
            result['allocations']=[{'source':r.source_id,'number':f'{r.source_id:06d}','amount':str(r.amount)} for r in v.allocation_entries.all()]
        if v.kind=='payment' and v.status=='posted':
            from .settlements import unused
            result['unallocated']=str(unused(v))
        result['lines']=[{'id':l.pk,'line_key':str(l.line_key),'reference_line':l.reference_line_id,'product':l.product_id.split('/',1)[1],'name':l.name,'unit':l.unit,'quantity':str(l.quantity),'price':str(l.price),'amount':str(l.amount),'cost':str(l.cost),'lot':l.lot,'expiry':l.expiry.isoformat() if l.expiry else ''} for l in v.lines.all()]
        for row in result['lines']:
            l = v.lines.get(pk=row['id'])
            if v.kind == 'receipt' and v.status == 'posted':
                from .services import receipt_source
                source = receipt_source(l, strict=False)
                row['origin_known'] = source is not None
                if source:
                    row['lot'] = source.lot.code
                    row['expiry'] = source.lot.expiry.isoformat() if source.lot.expiry else ''
            next_kind={'purchase_order':'receipt','customer_order':'sale','sale':'customer_return','receipt':'supplier_return'}.get(v.kind)
            if next_kind:
                used=VoucherLine.objects.filter(reference_line=l,voucher__kind=next_kind,voucher__status='posted').aggregate(n=Sum('quantity'))['n'] or ZERO
                row['remaining']=str(l.quantity-used)
                returned_amount=VoucherLine.objects.filter(reference_line=l,voucher__kind=next_kind,voucher__status='posted').aggregate(n=Sum('amount'))['n'] or ZERO
                row['remaining_amount']=str(money(l.amount-returned_amount))
        result['movements']=[{'warehouse':e.lot.warehouse_id,'product':e.lot.product_id.split('/',1)[1],'lot':e.lot.code,'line':e.line_id,'quantity':str(e.quantity),'value':str(e.value),'reversal':e.is_reversal} for e in v.stock_entries.select_related('lot')]
        result['cash_movements']=[{'account':e.account_id,'amount':str(e.amount),'reversal':e.is_reversal} for e in v.cash_entries.all()]
    if user.profile.role == 'cashier':
        result.pop('cost', None)
        for discount in result.get('payload', {}).get('discounts', []):
            discount.pop('below_cost', None)
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
    from .shift_browsing import cash_shift_json, CASH_SHIFT_ROLES, work_shift_json
    salary = user.profile.role in {'owner','accountant'}
    entities = {}
    for name,model,fields in [('stores',Store,['id','name','active']),('warehouses',Warehouse,['id','store_id','name']),('parties',Counterparty,['id','name','kind','phone','email','notes','active']),('accounts',CashAccount,['id','store_id','name','kind']),('employees',Employee,['id','name','store_id','active']+(['shift_rate','bonus_percent','bonus_basis'] if salary else []))]:
        qs = model.objects.all().order_by('pk')
        if name=='stores' and user.profile.store_id:
            qs=qs.filter(pk=user.profile.store_id)
        elif name in {'warehouses','accounts','employees'}:
            qs=scoped(qs,user)
        # Each row carries its content version; an edit form sends it back (B06).
        # Only roles that may edit a directory get its version (sent back by the edit form, B06).
        editable=user.profile.role in ({'owner','manager','accountant'} if name=='parties' else {'owner'})
        entities[name]=[{**{field:getattr(obj,field) for field in fields},**({'revision':record_revision(obj)} if editable else {})} for obj in qs]
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
        entities['work_shifts']=[work_shift_json(s) for s in work_shifts[:500]]
        entities['work_shifts_total']=work_shifts.count()
        entities['payroll_debts']=[{'employee':e.pk,'amount':str(payroll_debt(e))} for e in scoped(Employee.objects.all(),user)]
    lock=LedgerLock.objects.get(pk=1)
    entities['closed_through']=lock.closed_through
    from .financial_scope import network_owner
    entities['canViewAudit']=network_owner(user)
    entities['role']=user.profile.role
    entities['username']=user.username
    if user.profile.role in {'owner','manager'}:entities['alerts_status']=alert_status()
    entities['fiscal_required']=Setting.objects.filter(key='fiscal_required',value='true').exists()
    entities['max_discount']=percent_text(discount_limit())
    return entities

ALERT_OK_KEY,ALERT_ERROR_KEY='alerts_last_ok','alerts_last_error'
ALERT_STALE_MINUTES=90  # Cron runs every 30 minutes: three missed runs need attention.
ALERT_PUBLIC_ERROR='Не вдалося оновити контроль операцій. Повторіть перевірку; якщо помилка повториться, зверніться до адміністратора.'

def alert_status():
    now=timezone.now()
    def read(key):
        row=Setting.objects.filter(key=key).first()
        try:
            value=json.loads(row.value) if row else None
            if not isinstance(value,dict) or not isinstance(value.get('at'),str) or value.get('source') not in {'manual','scheduler'}:return None
            at=datetime.fromisoformat(value['at'])
            if timezone.is_naive(at) or at>now:return None
            public={'at':at.isoformat(),'source':value['source']}
            if key==ALERT_ERROR_KEY:
                # Sanitize old stored exceptions too: SQL and infrastructure details never reach the browser.
                public['message']=ALERT_PUBLIC_ERROR
                reference=value.get('reference')
                if isinstance(reference,str) and len(reference)==12 and all(c in '0123456789abcdef' for c in reference):public['reference']=reference
            else:
                for field in ('active','created','resolved','reopened'):
                    number=value.get(field)
                    if isinstance(number,int) and not isinstance(number,bool) and number>=0:public[field]=number
            return public,at
        except (ValueError,TypeError,OverflowError):return None
    ok,error=read(ALERT_OK_KEY),read(ALERT_ERROR_KEY)
    stale=not ok or now-ok[1]>=timedelta(minutes=ALERT_STALE_MINUTES)
    return {'ok':ok[0] if ok else None,'error':error[0] if error and (not ok or error[1]>ok[1]) else None,'stale':stale}

def assortment_rules(warehouses):
    """(warehouse, product path) -> (sold, minimum or None) for the assortment rows of these warehouses (B13)."""
    return {(a.warehouse_id,a.product_id):(a.sold,a.min_stock) for a in Assortment.objects.filter(warehouse__in=warehouses)}

def effective_assortment(rules,warehouse_id,product):
    """A row decides whether the product is sold here and its minimum (null -> catalogue minStock); no row: sold everywhere with minStock."""
    sold,minimum=rules.get((warehouse_id,product.pk),(True,None))
    return sold,(minimum if minimum is not None else dec(product.data.get('minStock',0),quantum=Decimal('.001')))

def stock(user):
    today=timezone.localdate()
    whs=scoped(Warehouse.objects.all(),user);rules=assortment_rules(whs)
    # Lots sold down to zero still count: a product with movement history stays in the totals of its warehouse.
    lots=scoped(StockLot.objects.select_related('product','warehouse'),user,'warehouse__store_id').order_by('warehouse_id','product_id','expiry','pk')
    result, grouped=[],{}
    from .reservations import held_quantities
    reserved=held_quantities(lots.values_list('pk',flat=True))
    def group(warehouse_id,p):
        sold,minimum=effective_assortment(rules,warehouse_id,p)
        return grouped.setdefault((warehouse_id,p.pk),{'warehouse':warehouse_id,'product':p.pk.split('/',1)[1],'name':p.data.get('name',''),'unit':p.data.get('unit','шт'),'quantity':ZERO,'value':ZERO,'available':ZERO,'reserved':ZERO,'minimum':minimum,'sold':sold})
    for l in lots:
        if l.quantity>0:result.append({'id':l.pk,'warehouse':l.warehouse_id,'product':l.product_id.split('/',1)[1],'name':l.product.data.get('name',''),'unit':l.product.data.get('unit','шт'),'lot':l.code,'expiry':l.expiry.isoformat() if l.expiry else None,'quantity':str(l.quantity),'value':str(l.value),'reserved':str(reserved.get(l.pk,ZERO)),'available':str(max(ZERO,l.quantity-reserved.get(l.pk,ZERO)) if not l.expiry or l.expiry>=today else ZERO),'expired':bool(l.expiry and l.expiry<today)})
        g=group(l.warehouse_id,l.product)
        g['quantity']+=l.quantity;g['value']+=l.value
        if not l.expiry or l.expiry>=today:g['available']+=max(ZERO,l.quantity-reserved.get(l.pk,ZERO));g['reserved']+=reserved.get(l.pk,ZERO)
    # Products without lots appear where they are sold with a positive minimum.
    products=list(Document.objects.filter(path__startswith='products/'))
    for w in whs:
        for p in products:
            if (w.pk,p.pk) in grouped:continue
            sold,minimum=effective_assortment(rules,w.pk,p)
            if sold and minimum>0:group(w.pk,p)
    totals=[]
    for g in grouped.values():
        # Only the assortment of a warehouse asks for replenishment.
        g['low']=g['sold'] and g['available']<g['minimum']
        totals.append({k:str(v) if isinstance(v,Decimal) else v for k,v in g.items()})
    return {'lots':result,'totals':totals}

def cashier_differences(user, start, end, store=None):
    """Closed till shifts of the period by cashier: counted minus expected cash, and sales per open hour."""
    from zoneinfo import ZoneInfo
    from django.db.models.functions import TruncDate
    shifts=scoped(CashShift.objects.select_related('employee','opened_by'),user).filter(closed_at__isnull=False).annotate(closed_day=TruncDate('closed_at',tzinfo=ZoneInfo('Europe/Kyiv'))).filter(closed_day__gte=start,closed_day__lte=end)
    if store:shifts=shifts.filter(store_id=store)
    rows={}
    # Sales minus returns posted on each shift, whatever the payment method.
    sold={}
    for shift_id,kind,total in Voucher.objects.filter(shift__in=shifts,status='posted',kind__in=['sale','customer_return']).values_list('shift_id','kind','total'):
        sold[shift_id]=sold.get(shift_id,ZERO)+(total if kind=='sale' else -total)
    for s in shifts.order_by('pk'):
        key=('employee',s.employee_id) if s.employee_id else ('user',s.opened_by_id)
        row=rows.setdefault(key,{'employee':s.employee_id,'name':s.employee.name if s.employee_id else s.opened_by.username,'shifts':0,'with_difference':0,'shortage':ZERO,'surplus':ZERO,'revenue':ZERO,'seconds':0})
        difference=s.counted_cash-s.expected_cash
        row['revenue']+=sold.get(s.pk,ZERO)
        row['seconds']+=max(0,int((s.closed_at-s.opened_at).total_seconds()))
        row['shifts']+=1
        if difference:row['with_difference']+=1
        if difference<0:row['shortage']-=difference
        else:row['surplus']+=difference
    late=late_return_bonus(user,start,end,store) if user.profile.role in {'owner','accountant'} else None
    for key,amount in (late or {}).items():
        row=rows.setdefault(key,{'employee':key[1] if key[0]=='employee' else None,'name':amount[1],'shifts':0,'with_difference':0,'shortage':ZERO,'surplus':ZERO,'revenue':ZERO,'seconds':0})
        row['late_return_bonus']=amount[0]
    result=[]
    for row in sorted(rows.values(),key=lambda r:(-r['shortage'],r['name'])):
        seconds=row.pop('seconds');late_bonus=row.pop('late_return_bonus',ZERO);hours=(Decimal(seconds)/3600).quantize(Decimal('.1'))
        # Shifts shorter than 6 minutes carry no meaningful hourly rate.
        per_hour=str(money(row['revenue']*3600/seconds)) if seconds>=360 else None
        result.append({**row,'shortage':str(money(row['shortage'])),'surplus':str(money(row['surplus'])),'net':str(money(row['surplus']-row['shortage'])),'revenue':str(money(row['revenue'])),'hours':str(hours),'revenue_per_hour':per_hour,**({'late_return_bonus':str(money(late_bonus))} if late is not None else {})})
    return result

def late_return_bonus(user, start, end, store=None):
    """Percent already accrued on sales that a customer return of the period took back after the payroll was posted (B05).
    The accrual stays final; this is information only. Salary percents are visible to owner/accountant, so only they get it.
    Each WorkShift can show at most the basis that was actually accrued (w.basis_amount): late returns consume what remains, oldest first."""
    eligible=WorkShift.objects.filter(payroll__status='posted',bonus_percent__gt=0,cash_shift__isnull=False)
    returns=scoped(Voucher.objects.filter(status='posted',kind='customer_return',date__lte=end,reference__shift__in=eligible.values('cash_shift')).select_related('reference__shift__employee','reference__shift__opened_by'),user).order_by('date','pk')
    if store:returns=returns.filter(store_id=store)
    returns=list(returns)
    by_shift={}
    for w in eligible.filter(cash_shift_id__in={r.reference.shift_id for r in returns}).select_related('payroll'):
        by_shift.setdefault(w.cash_shift_id,[]).append([w,w.basis_amount])
    result={}
    for r in returns:
        sale=r.reference;cash_shift=sale.shift
        total=None
        if start<=r.date:
            key=('employee',cash_shift.employee_id) if cash_shift.employee_id else ('user',cash_shift.opened_by_id)
            total=result.setdefault(key,[ZERO,cash_shift.employee.name if cash_shift.employee_id else cash_shift.opened_by.username])
        for item in by_shift.get(cash_shift.pk,[]):
            w,remaining=item
            if w.payroll.date>=r.date or (w.bonus_basis=='personal' and sale.employee_id!=w.employee_id):continue
            used=min(max(ZERO,r.total-r.cost if w.bonus_basis=='profit' else r.total),remaining);item[1]=remaining-used
            if total is not None:total[0]+=used*w.bonus_percent/Decimal(100)
    return result

def product_margins(qs):
    """Per product for the period: sold quantity, net revenue, cost of sales, gross profit, write-offs and inventory differences."""
    rows={}
    def row(path,name,unit):
        return rows.setdefault(path,{'product':path.split('/',1)[1],'name':name,'unit':unit,'quantity':ZERO,'revenue':ZERO,'cogs':ZERO,'writeoff_quantity':ZERO,'writeoff':ZERO,'inventory':ZERO})
    lines=VoucherLine.objects.filter(voucher__in=qs.filter(kind__in=['sale','customer_return','writeoff'])).values('product_id','voucher__kind').annotate(q=Sum('quantity'),a=Sum('amount'),c=Sum('cost'))
    names={d.pk:d.data for d in Document.objects.filter(pk__in={x['product_id'] for x in lines})}
    for x in lines:
        data=names.get(x['product_id'],{})
        r=row(x['product_id'],str(data.get('name','')),str(data.get('unit','шт')))
        sign=-1 if x['voucher__kind']=='customer_return' else 1
        if x['voucher__kind']=='writeoff':
            r['writeoff_quantity']+=x['q'] or ZERO;r['writeoff']+=x['c'] or ZERO
        else:
            r['quantity']+=sign*(x['q'] or ZERO);r['revenue']+=sign*(x['a'] or ZERO);r['cogs']+=sign*(x['c'] or ZERO)
    for v in qs.filter(kind='inventory').only('payload'):
        for d in v.payload.get('differences',[]):
            path='products/'+str(d.get('product','')).removeprefix('products/')
            data=names.get(path) or (Document.objects.filter(pk=path).values_list('data',flat=True).first() or {})
            row(path,str(data.get('name','')),str(data.get('unit','шт')))['inventory']+=Decimal(d.get('value','0'))
    result=[]
    for r in rows.values():
        gross=r['revenue']-r['cogs']
        margin=(gross*100/r['revenue']).quantize(Decimal('.1')) if r['revenue']>0 else None
        result.append({**r,'quantity':str(Decimal(r['quantity']).quantize(Decimal('.001'))),'writeoff_quantity':str(Decimal(r['writeoff_quantity']).quantize(Decimal('.001'))),'revenue':str(money(r['revenue'])),'cogs':str(money(r['cogs'])),'gross_profit':str(money(gross)),'margin':str(margin) if margin is not None else None,'writeoff':str(money(r['writeoff'])),'inventory':str(money(r['inventory'])),'result':str(money(gross-r['writeoff']+r['inventory']))})
    result.sort(key=lambda r:(-Decimal(r['result']),r['name']))
    return result

def report(user, params):
    from .historical_reports import report as historical_report
    return historical_report(user, params)
