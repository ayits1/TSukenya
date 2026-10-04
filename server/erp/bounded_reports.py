"""Bounded report transport with exact disk-backed aggregation, not business snapshots.
Every request owns a current READ ONLY / REPEATABLE READ accounting-date read.
The private spool is removed after a page, export completion, error or cancellation.
"""
import csv
import io
import json
import os
import sqlite3
import tempfile
from contextlib import contextmanager
from decimal import Decimal
from datetime import timezone as utc
from itertools import islice
from django.contrib.auth.models import User
from django.http import StreamingHttpResponse
from django.utils import timezone
from .models import CashAccount, CashEntry, CashShift, Employee, StockEntry, Voucher, WorkShift
from .services import ZERO, day, money, obligation, require
from .browsing import PAGE_SIZE, page_number, page_bounds
from .historical_reports import (KYIV, ROLES, read_snapshot, stores_for, metrics, totals,
    period_documents, period_sign, effective_entries, require_reversal_dates, active_at)
from .report_contributions import voucher_contributions
from .settlements import context, advance_balances
from .csv_format import guarded

CONTRACT = 'trading-reports-v1'
NOTICE = 'Кожне читання має окремий поточний узгоджений знімок. Нове проведення може змінити підсумки, наступну сторінку або CSV порівняно з раніше відкритим звітом.'
SECTIONS = {'period': ('products', 'by_store', 'expenses_by_category', 'cashiers'),
            'balances': ('stock', 'cash', 'debts', 'advances', 'payroll_debts')}


def actor(user):
    current = User.objects.select_related('profile').filter(pk=user.pk, is_active=True).first()
    require(current is not None and hasattr(current, 'profile') and current.profile.role in ROLES,
            'Недостатньо прав для фінансових звітів.')
    return current


def batches(query, size=200):
    iterator = query.iterator(chunk_size=size)
    try:
        while batch := list(islice(iterator, size)):yield batch
    finally:iterator.close()


class Spool:
    """JSON records on private temporary disk; one decoded aggregate in Python at a time."""
    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory(prefix='tsukenya-report-')
        try:
            path=self.directory.name + '/rows.sqlite3'
            self.db = sqlite3.connect(path)
            os.chmod(path, 0o600)
            self.db.execute('PRAGMA cache_size=-2048')
            self.db.execute('PRAGMA temp_store=FILE')
            self.db.execute('CREATE TABLE rows (section TEXT, key TEXT, value TEXT, PRIMARY KEY(section,key))')
            self.db.create_collation('decimal', lambda a,b: (Decimal(a)>Decimal(b))-(Decimal(a)<Decimal(b)))
            self.db.create_function('fold', 1, lambda s: str(s or '').casefold())
        except BaseException:
            if hasattr(self,'db'):self.db.close()
            self.directory.cleanup()
            raise
        return self

    def __exit__(self, *args):
        try:self.db.close()
        finally:self.directory.cleanup()

    def get(self, section, key):
        record = self.db.execute('SELECT value FROM rows WHERE section=? AND key=?', (section,str(key))).fetchone()
        return json.loads(record[0]) if record else None

    def put(self, section, key, value):
        value = json.dumps(value, ensure_ascii=False, default=str, separators=(',',':'))
        self.db.execute('INSERT INTO rows VALUES (?,?,?) ON CONFLICT(section,key) DO UPDATE SET value=excluded.value', (section,str(key),value))

    def add(self, section, key, initial, changes):
        value = self.get(section,key) or initial
        for field, amount in changes.items(): value[field] = str(Decimal(str(value.get(field,0))) + amount)
        self.put(section,key,value)

    def query(self, section, q=''):
        # Search only user-facing row captions/numbers; parameterized, with literal wildcard escaping.
        return ('section=?', [section]) if not q else (
            "section=? AND (fold(COALESCE(json_extract(value,'$.name'),'')) LIKE ? ESCAPE '\\' OR fold(COALESCE(json_extract(value,'$.party'),'')) LIKE ? ESCAPE '\\' OR fold(COALESCE(json_extract(value,'$.number'),'')) LIKE ? ESCAPE '\\' OR fold(COALESCE(json_extract(value,'$.category'),'')) LIKE ? ESCAPE '\\' OR fold(COALESCE(json_extract(value,'$.code'),'')) LIKE ? ESCAPE '\\')",
            [section] + ['%' + q.casefold().replace('\\','\\\\').replace('%','\\%').replace('_','\\_') + '%'] * 5)

    def count(self, section, q=''):
        where,args = self.query(section,q)
        return self.db.execute('SELECT COUNT(*) FROM rows WHERE '+where,args).fetchone()[0]

    def rows(self, section, q='', limit=None, offset=0):
        where,args = self.query(section,q)
        order = "json_extract(value,'$.result') COLLATE decimal DESC," if section=='products' else "json_extract(value,'$.shortage') COLLATE decimal DESC," if section=='cashiers' else ''
        order += "COALESCE(json_extract(value,'$.name'),json_extract(value,'$.party'),json_extract(value,'$.category'),''),key"
        sql = 'SELECT key,value FROM rows WHERE '+where+' ORDER BY '+order
        if limit is not None: sql += ' LIMIT ? OFFSET ?'; args += [limit,offset]
        cursor = self.db.execute(sql,args)
        while records := cursor.fetchmany(100):
            for key,value in records: yield key,json.loads(value)


def product_finish(row):
    gross = Decimal(row['revenue']) - Decimal(row['cogs']); revenue=Decimal(row['revenue'])
    for key in ('quantity','writeoff_quantity'): row[key]=str(Decimal(row[key]).quantize(Decimal('.001')))
    for key in ('revenue','cogs','writeoff','inventory'): row[key]=str(money(Decimal(row[key])))
    row.update(gross_profit=str(money(gross)), margin=str((gross*100/revenue).quantize(Decimal('.1'))) if revenue>0 else None,
               result=str(money(gross-Decimal(row['writeoff'])+Decimal(row['inventory']))))
    return row


def period(user, params, spool, stores, scoped):
    ids={s.pk for s in stores}; today=timezone.localdate()
    start=day(params.get('from') or today.replace(day=1).isoformat()); end=day(params.get('to') or today.isoformat())
    require(start<=end<=today,'Період має закінчуватись не раніше початку й не пізніше сьогодні.')
    require_reversal_dates(ids,end); whole=metrics(); unallocated=ZERO
    for store in stores: spool.put('by_store',store.pk,{'store':store.pk,'name':store.name,**{key:'0' for key in whole}})
    for batch in batches(period_documents(ids,start,end,include_lines=True).order_by('pk')):
        for voucher in batch:
            sign=period_sign(voucher,start,end)
            if not sign: continue
            changes=voucher_contributions(voucher,sign,scoped=scoped)
            for key,value in changes.items():
                if key=='unallocated_expenses': unallocated+=value
                else: whole[key]+=value
            spool.add('by_store',voucher.store_id,{}, {k:v for k,v in changes.items() if k!='unallocated_expenses'})
            if voucher.kind=='expense':
                network=voucher.payload.get('expense_scope','store')=='network'
                if not network or not scoped:
                    category=voucher.payload.get('category','Інше'); store=None if network else voucher.store_id
                    spool.add('expenses_by_category',json.dumps([store,category]),{'store':store,'scope':'network' if network else 'store','store_name':None if network else spool.get('by_store',store)['name'],'category':category,'amount':'0'}, {'amount':sign*voucher.total})
            if voucher.kind not in {'sale','customer_return','writeoff','inventory'}: continue
            for line in voucher.lines.all():
                initial={'product':line.product_id.split('/',1)[1],'name':line.name,'unit':line.unit,**{k:'0' for k in ('quantity','revenue','cogs','writeoff_quantity','writeoff','inventory')}}
                if voucher.kind=='writeoff': changes={'writeoff_quantity':sign*line.quantity,'writeoff':sign*line.cost}
                elif voucher.kind=='inventory': changes={'inventory':sign*sum((Decimal(item['value']) for item in voucher.payload.get('differences',[]) if str(item.get('product','')).removeprefix('products/')==initial['product']),ZERO)}
                else:
                    direction=sign*(-1 if voucher.kind=='customer_return' else 1)
                    changes={'quantity':direction*line.quantity,'revenue':direction*line.amount,'cogs':direction*line.cost}
                spool.add('products',line.product_id,initial,changes)
    for entry in effective_entries(CashEntry,end,start).filter(account__store_id__in=ids).exclude(voucher__kind='cash_opening').select_related('account').iterator(chunk_size=200):
        whole['cash_net']+=entry.amount; spool.add('by_store',entry.account.store_id,{}, {'cash_net':entry.amount})
    for key,row in spool.rows('products'): spool.put('products',key,product_finish(row))
    for key,row in spool.rows('by_store'): spool.put('by_store',key,{**row,**totals({k:Decimal(row[k]) for k in whole})})
    for key,row in spool.rows('expenses_by_category'): spool.put('expenses_by_category',key,{**row,'amount':str(money(Decimal(row['amount'])))})
    cashier_rows(user,ids,start,end,spool)
    whole['expenses']+=unallocated
    return {'mode':'period','from':start.isoformat(),'to':end.isoformat(),**totals(whole),'unallocated_expenses':str(money(unallocated)),
            'cashiers_basis':'current_posted_closed_shifts','debts_basis':'current'}


def cashier_rows(user,ids,start,end,spool):
    from django.db.models.functions import TruncDate
    from .payroll_chronology import is_late_return, return_order
    shifts=CashShift.objects.filter(store_id__in=ids,closed_at__isnull=False).annotate(closed_day=TruncDate('closed_at',tzinfo=KYIV)).filter(closed_day__range=(start,end)).select_related('employee','opened_by').order_by('pk')
    def initial(employee,name):
        return {'employee':employee,'name':name,**{k:'0' for k in ('shifts','with_difference','shortage','surplus','revenue','seconds')}}
    def identity(shift): return ('employee:'+str(shift.employee_id),shift.employee_id,shift.employee.name) if shift.employee_id else ('user:'+str(shift.opened_by_id),None,shift.opened_by.username)
    for batch in batches(shifts):
        sold={}
        for shift,kind,total in Voucher.objects.filter(shift_id__in=[s.pk for s in batch],status='posted',kind__in=['sale','customer_return']).values_list('shift_id','kind','total').iterator(chunk_size=200): sold[shift]=sold.get(shift,ZERO)+(total if kind=='sale' else -total)
        for shift in batch:
            key,employee,name=identity(shift); difference=shift.counted_cash-shift.expected_cash
            spool.add('cashiers',key,initial(employee,name),{'revenue':sold.get(shift.pk,ZERO),'seconds':Decimal(max(0,int((shift.closed_at-shift.opened_at).total_seconds()))),'shifts':Decimal(1),'with_difference':Decimal(bool(difference)),'shortage':max(ZERO,-difference),'surplus':max(ZERO,difference)})
    if user.profile.role in {'owner','accountant'}:
        eligible=WorkShift.objects.filter(payroll__status='posted',bonus_percent__gt=0,cash_shift__isnull=False)
        returns=Voucher.objects.filter(store_id__in=ids,status='posted',kind='customer_return',date__lte=end,reference__shift_id__in=eligible.values('cash_shift_id')).select_related('reference__shift__employee','reference__shift__opened_by').order_by('pk')
        # return_order combines posted_at with a legacy date fallback; disk sorting preserves exact chronology.
        for returned in returns.iterator(chunk_size=200):
            instant,pk=return_order(returned);spool.put('_returns',f'{instant.astimezone(utc.utc).isoformat()}:{pk:020d}',{'id':pk})
        cursor=spool.db.execute("SELECT value FROM rows WHERE section='_returns' ORDER BY key")
        while raw := cursor.fetchmany(200):
            lookup={r.pk:r for r in Voucher.objects.filter(pk__in=[json.loads(x[0])['id'] for x in raw]).select_related('reference__shift__employee','reference__shift__opened_by')}
            shift_ids={r.reference.shift_id for r in lookup.values()}
            workers={}
            for worker in eligible.filter(cash_shift_id__in=shift_ids).select_related('payroll').iterator(chunk_size=200): workers.setdefault(worker.cash_shift_id,[]).append(worker)
            for item in raw:
                returned=lookup[json.loads(item[0])['id']];sale=returned.reference;shift=sale.shift;key,employee,name=identity(shift)
                if start<=returned.date and spool.get('cashiers',key) is None: spool.put('cashiers',key,initial(employee,name))
                for worker in workers.get(shift.pk,[]):
                    if not is_late_return(returned,worker.payroll) or (worker.bonus_basis=='personal' and sale.employee_id!=worker.employee_id): continue
                    remaining=spool.get('_basis',worker.pk); remaining=Decimal(remaining['amount']) if remaining else worker.basis_amount
                    used=min(max(ZERO,returned.total-returned.cost if worker.bonus_basis=='profit' else returned.total),remaining)
                    spool.put('_basis',worker.pk,{'amount':str(remaining-used)})
                    if start<=returned.date: spool.add('cashiers',key,initial(employee,name),{'late_return_bonus':used*worker.bonus_percent/Decimal(100)})
    for key,row in spool.rows('cashiers'):
        seconds=int(Decimal(row.pop('seconds')));revenue=Decimal(row['revenue']);shortage=Decimal(row['shortage']);surplus=Decimal(row['surplus'])
        row.update(shifts=int(Decimal(row['shifts'])),with_difference=int(Decimal(row['with_difference'])),hours=str((Decimal(seconds)/3600).quantize(Decimal('.1'))),revenue_per_hour=str(money(revenue*3600/seconds)) if seconds>=360 else None,net=str(money(surplus-shortage)))
        for field in ('shortage','surplus','revenue'): row[field]=str(money(Decimal(row[field])))
        if user.profile.role in {'owner','accountant'}: row['late_return_bonus']=str(money(Decimal(row.get('late_return_bonus','0'))))
        spool.put('cashiers',key,row)


def balances(user,params,spool,stores):
    ids={s.pk for s in stores};cutoff=day(params.get('as_of') or timezone.localdate().isoformat())
    require(cutoff<=timezone.localdate(),'Дата залишків не може бути в майбутньому.');require_reversal_dates(ids,cutoff)
    stock_value=cash_total=owed_to_us=owed_by_us=ZERO;advance_totals={'customer':ZERO,'supplier':ZERO}
    for entry in effective_entries(StockEntry,cutoff).filter(lot__warehouse__store_id__in=ids).select_related('lot__product','lot__warehouse').order_by('pk').iterator(chunk_size=200):
        lot=entry.lot
        spool.add('stock',lot.pk,{'lot':lot.pk,'code':lot.code,'warehouse':lot.warehouse_id,'warehouse_name':lot.warehouse.name,'store':lot.warehouse.store_id,'product':lot.product_id.split('/',1)[1],'name':lot.product.data.get('name',''),'unit':lot.product.data.get('unit','шт'),'expiry':lot.expiry.isoformat() if lot.expiry else None,'quantity':'0','value':'0'}, {'quantity':entry.quantity,'value':entry.value})
    for key,row in spool.rows('stock'):
        quantity,value=Decimal(row['quantity']),Decimal(row['value'])
        if not quantity and not value: spool.db.execute('DELETE FROM rows WHERE section=? AND key=?',('stock',key));continue
        stock_value+=value;row.update(quantity=str(quantity.quantize(Decimal('.001'))),value=str(money(value)),expired=bool(row['expiry'] and row['expiry']<cutoff.isoformat()));spool.put('stock',key,row)
    for account in CashAccount.objects.filter(store_id__in=ids).order_by('pk').iterator(chunk_size=200): spool.put('cash',account.pk,{'account':account.pk,'name':account.name,'store':account.store_id,'kind':account.kind,'amount':'0'})
    for entry in effective_entries(CashEntry,cutoff).filter(account__store_id__in=ids).iterator(chunk_size=200): cash_total+=entry.amount;spool.add('cash',entry.account_id,{}, {'amount':entry.amount})
    for key,row in spool.rows('cash'): spool.put('cash',key,{**row,'amount':str(money(Decimal(row['amount'])))})
    sources=Voucher.objects.filter(store_id__in=ids,date__lte=cutoff,status__in=['posted','reversed'],kind__in=['sale','receipt','debt_opening']).select_related('party').order_by('pk')
    for batch in batches(sources):
        related,allocated=context(batch,cutoff)
        for source in batch:
            if not active_at(source,cutoff) or not source.party_id: continue
            amount=obligation(source,settlements=related[source.pk],allocations=allocated[source.pk])
            if not amount:continue
            supplier=source.kind=='receipt' or source.kind=='debt_opening' and source.party.kind=='supplier'
            if supplier:owed_by_us+=amount
            else:owed_to_us+=amount
            deadline=source.payload.get('due_date','')
            spool.put('debts',source.pk,{'voucher':source.pk,'number':f'{source.pk:06d}','kind':'receipt' if supplier else 'sale','original_kind':source.kind,'store':source.store_id,'date':source.date.isoformat(),'party':source.party.name,'party_id':source.party_id,'total':str(source.total),'amount':str(money(amount)),'due_date':deadline,'overdue':bool(deadline and deadline<cutoff.isoformat())})
    if user.profile.role in {'owner','accountant'}:
        for voucher in Voucher.objects.filter(store_id__in=ids,date__lte=cutoff,status__in=['posted','reversed'],kind__in=['payroll','payroll_payment']).iterator(chunk_size=200):
            if active_at(voucher,cutoff):spool.add('_payroll',voucher.employee_id,{'amount':'0'}, {'amount':voucher.total*(1 if voucher.kind=='payroll' else -1)})
        cursor=spool.db.execute("SELECT key,value FROM rows WHERE section='_payroll' ORDER BY key")
        while records := cursor.fetchmany(200):
            amounts={int(key):Decimal(json.loads(value)['amount']) for key,value in records if key!='None'}
            for employee in Employee.objects.filter(pk__in=amounts).iterator(chunk_size=200):
                if amounts[employee.pk]:spool.put('payroll_debts',employee.pk,{'employee':employee.pk,'name':employee.name,'store':employee.store_id,'amount':str(money(amounts[employee.pk]))})
    payments=Voucher.objects.filter(store_id__in=ids,kind='payment',status__in=['posted','reversed'],date__lte=cutoff).select_related('party','reference__party').order_by('pk')
    for batch in batches(payments):
        remaining=advance_balances(batch,cutoff)
        for payment in batch:
            if not payment.party_id or not remaining[payment.pk]:continue
            value=remaining[payment.pk];advance_totals[payment.party.kind]+=value
            spool.put('advances',payment.pk,{'payment':payment.pk,'number':f'{payment.pk:06d}','store':payment.store_id,'party_id':payment.party_id,'party':payment.party.name,'direction':payment.party.kind,'date':payment.date.isoformat(),'amount':str(value)})
    return {'mode':'balances','as_of':cutoff.isoformat(),'stock_value':str(money(stock_value)),'cash_total':str(money(cash_total)), 'debt_totals':{'owed_to_us':str(money(owed_to_us)),'owed_by_us':str(money(owed_by_us))},'advance_totals':{key:str(money(value)) for key,value in advance_totals.items()}}


@contextmanager
def built(user,params):
    with read_snapshot(), Spool() as spool:
        current=actor(user); mode=params.get('mode','period');require(mode in SECTIONS,'Некоректний режим звіту.')
        stores,scoped=stores_for(current,params)
        data=balances(current,params,spool,stores) if mode=='balances' else period(current,params,spool,stores,scoped)
        sections=[s for s in SECTIONS[mode] if s!='payroll_debts' or current.profile.role in {'owner','accountant'}]
        data.update(contract=CONTRACT,store=int(params['store']) if params.get('store') else current.profile.store_id,
                    scope_name=stores[0].name if scoped and stores else 'Усі доступні магазини' if not scoped else 'Магазин поза доступним контекстом',
                    generated_at=timezone.now().isoformat(),basis='accounting_dates',reversal_policy='kyiv_reversed_at',snapshot='current',snapshot_notice=NOTICE,
                    counts={s:spool.count(s) for s in sections},can_view_payroll=current.profile.role in {'owner','accountant'})
        yield spool,data


def summary(user,params):
    with built(user,params) as (_,data):return data


def rows(user,params):
    requested=page_number(params);q=params.get('q','').strip();require(len(q)<=250,'Пошуковий запит задовгий.')
    with built(user,params) as (spool,data):
        section=params.get('section','');require(section in SECTIONS[data['mode']],'Невідома секція звіту.')
        require(section in data['counts'],'Недостатньо прав для зарплатної секції.')
        total=spool.count(section,q);page,pages,offset=page_bounds(total,requested)
        return {'contract':CONTRACT,'section':section,'items':[r for _,r in spool.rows(section,q,PAGE_SIZE,offset)],'total':total,'page':page,'pages':pages,'limit':PAGE_SIZE,'q':q,'summary':data}


CSV_FIELDS={
 'products': [('name','Товар'),('unit','Од.'),('quantity','Продано мінус повернення'),('revenue','Виторг'),('cogs','Собівартість'),('gross_profit','Валовий прибуток'),('margin','Маржа, %'),('writeoff_quantity','Списано'),('writeoff','Вартість списань'),('inventory','Інвентаризаційне коригування'),('result','Результат')],
 'by_store': [('name','Магазин')]+[(k,k) for k in (*metrics(),'gross_profit','profit')],
 'expenses_by_category':[('category','Стаття'),('scope','Належність'),('store','Магазин ID'),('amount','Сума')],
 'cashiers':[('name','Касир'),('shifts','Змін'),('hours','Годин'),('revenue','Виторг'),('revenue_per_hour','Виторг на годину'),('with_difference','З розходженням'),('shortage','Нестача'),('surplus','Надлишок'),('net','Разом'),('late_return_bonus','Бонус із повернених після нарахування продажів')],
 'stock':[('name','Товар'),('warehouse_name','Склад'),('code','Партія'),('quantity','Кількість'),('unit','Од.'),('value','Вартість'),('expiry','Термін')],
 'cash':[('name','Рахунок'),('kind','Тип'),('amount','Залишок')],
 'debts':[('number','Документ'),('kind','Напрям'),('party','Контрагент'),('date','Дата'),('total','Сума документа'),('amount','Борг'),('due_date','Строк оплати')],
 'advances':[('number','Платіж'),('direction','Напрям'),('party','Контрагент'),('date','Дата'),('amount','Аванс')],
 'payroll_debts':[('name','Працівник'),('amount','Борг із зарплати')],
}
TEXT_FIELDS={'name','unit','scope','kind','category','party','code','warehouse_name','direction'}


def export_csv(user,params):
    current=actor(user); section=params.get('section','summary')
    q=params.get('q','').strip();require(len(q)<=250,'Пошуковий запит задовгий.')
    require(section=='summary' or section=='all' and params.get('mode')=='balances' or section in SECTIONS.get(params.get('mode','period'),()),'Невідома секція CSV.')
    require(section!='payroll_debts' or current.profile.role in {'owner','accountant'},'Недостатньо прав для зарплатного CSV.')
    def generate():
        with built(user,params) as (spool,data):
            require(section in {'summary','all'} or section in data['counts'],'Секція CSV недоступна.')
            buffer=io.StringIO(newline='');writer=csv.writer(buffer,delimiter=';',quoting=csv.QUOTE_ALL,lineterminator='\r\n')
            def record(values):
                buffer.seek(0);buffer.truncate(0);writer.writerow(values);return buffer.getvalue()
            yield '\ufeff'+record(['Звіт',data['mode'],'Контекст','\t'+data['scope_name'] if guarded(data['scope_name']) else data['scope_name'],'Знімок',data['generated_at']])
            if section=='all':
                yield record(['Розділ','Назва','Кількість','Сума, грн'])
                labels={'stock':'Товар','cash':'Кошти','debts':'Борг','advances':'Аванс','payroll_debts':'Зарплата'}
                for kind in data['counts']:
                    for _,row in spool.rows(kind,q):
                        name=row.get('name',row.get('party',''));name='\t'+name if guarded(name) else name
                        label=labels[kind]+(' '+row.get('kind',row.get('direction','')) if kind in {'debts','advances'} else '')
                        yield record([label,name,row.get('quantity',''),row.get('value',row.get('amount',''))])
            elif section=='summary':
                yield record(['Показник','Значення'])
                for key,value in data.items():
                    if isinstance(value,str) and key not in {'contract','mode','scope_name','snapshot_notice'}:yield record([key,'\t'+value if key not in {*metrics(),'gross_profit','profit','stock_value','cash_total','unallocated_expenses'} and guarded(value) else value])
                for key in ('debt_totals','advance_totals'):
                    for field,value in data.get(key,{}).items():yield record([field,value])
            else:
                fields=[p for p in CSV_FIELDS[section] if p[0]!='late_return_bonus' or data['can_view_payroll']]
                yield record([label for _,label in fields])
                for _,row in spool.rows(section,q):
                    yield record(['\t'+str(row.get(key,'')) if key in TEXT_FIELDS and guarded(str(row.get(key,'') or '')) else '' if row.get(key) is None else row.get(key,'') for key,_ in fields])
    result=StreamingHttpResponse(generate(),content_type='text/csv; charset=utf-8')
    result['Content-Disposition']=f'attachment; filename="report-{section}.csv"';result['Cache-Control']='private, no-store'
    return result
