"""Paginated source explanations in one current RR snapshot, with salary privacy."""
from django.utils import timezone
from .models import CashEntry, StockEntry, StockLot, CashAccount
from .services import ROLE_KINDS, ZERO, day, money, require
from .browsing import PAGE_SIZE, page_bounds, page_number, positive_integer
from .historical_reports import (METRICS, read_snapshot, stores_for, require_reversal_dates,
                                period_documents, period_sign, reversal_day, effective_entries)
from .report_contributions import PROFIT_WEIGHTS, GROSS_WEIGHTS, voucher_contributions

LABELS = {'revenue':'Виторг', 'cogs':'Собівартість', 'expenses':'Витрати', 'payroll':'Зарплата', 'writeoffs':'Списання',
          'inventory_adjustment':'Інвентаризація', 'supplier_return_variance':'Різниця повернень постачальнику',
          'cash_difference':'Касове розходження', 'cash_net':'Чистий рух коштів', 'gross_profit':'Валовий прибуток',
          'profit':'Операційний результат', 'unallocated_expenses':'Мережеві нерозподілені витрати', 'stock':'Товар на дату', 'cash':'Кошти на дату'}
FORMULAS = {'gross_profit':'Виторг − собівартість', 'profit':'Виторг − собівартість − витрати − зарплата − списання + інвентаризація + різниця повернень постачальнику + касове розходження',
            'cash_net':'Сума рухів коштів за період без початкових залишків', 'expenses':'Магазинні витрати + мережеві нерозподілені витрати (лише для мережі)',
            'stock':'Сума первинних і зворотних складських рухів до кінця вибраного дня', 'cash':'Сума первинних і зворотних грошових рухів до кінця вибраного дня'}


def source(user, voucher, metric, contribution, date, sign, *, entry=None, visible_store=None):
    readable = (voucher.kind in ROLE_KINDS[user.profile.role]
                and (not user.profile.store_id or user.profile.store_id == voucher.store_id)
                and not (voucher.kind == 'expense' and voucher.payload.get('expense_scope') == 'network' and user.profile.role == 'manager'))
    return {'type':'voucher', 'metric':metric, 'amount':str(money(contribution)), 'sign':sign, 'date':date.isoformat(),
            'voucher_date':voucher.date.isoformat(), 'reversal':sign < 0, 'store':visible_store if visible_store is not None else voucher.store_id,
            'kind':voucher.kind, 'voucher':voucher.pk if readable else None, 'number':f'{voucher.pk:06d}' if readable else None,
            'canOpen':readable, **({'entry':entry} if entry is not None else {})}


class PageRows:
    """Keep only the requested page and last page, even for a lifetime ledger."""
    def __init__(self, params):
        self.requested = page_number(params)
        self.offset = (self.requested - 1) * PAGE_SIZE
        self.total, self.items, self.last = 0, [], []

    def append(self, row):
        if self.total % PAGE_SIZE == 0: self.last = []
        self.last.append(row)
        if self.offset <= self.total < self.offset + PAGE_SIZE: self.items.append(row)
        self.total += 1


def paginate(rows, params, result):
    page, pages, _ = page_bounds(rows.total, rows.requested)
    items = rows.last if page != rows.requested else rows.items
    return {**result, 'items':items, 'total':rows.total, 'page':page, 'pages':pages,
            'snapshot':'current', 'basis':'accounting_dates', 'reversal_policy':'kyiv_reversed_at',
            'snapshot_notice':'Розшифровку й суму обчислено за поточним знімком. Пізніше проведення може змінити раніше відкритий звіт.'}


def private_aggregate(rows, amount, metric):
    rows.append({'type':'aggregate', 'metric':metric, 'amount':str(money(amount)), 'label':'Зарплата — сукупна сума без персональних документів', 'canOpen':False})


def period_sources(user, params, ids, scoped):
    metric = params.get('metric', '')
    require(metric in {*METRICS, 'profit', 'gross_profit', 'unallocated_expenses'}, 'Невідомий показник звіту.')
    today = timezone.localdate(); start = day(params.get('from') or today.replace(day=1).isoformat()); end = day(params.get('to') or today.isoformat())
    require(start <= end <= today, 'Період має закінчуватись не раніше початку й не пізніше сьогодні.')
    require_reversal_dates(ids, end)
    rows, amount, salary, has_salary = PageRows(params), ZERO, ZERO, False
    weights = PROFIT_WEIGHTS if metric == 'profit' else GROSS_WEIGHTS if metric == 'gross_profit' else {metric:1}
    if metric in {'profit','expenses'} and not scoped: weights = {**weights,'unallocated_expenses':-1 if metric=='profit' else 1}
    if metric == 'cash_net':
        for entry in effective_entries(CashEntry, end, start).filter(account__store_id__in=ids).exclude(voucher__kind='cash_opening').select_related('voucher','account').order_by('pk').iterator(chunk_size=200):
            amount += entry.amount
            if user.profile.role == 'manager' and entry.voucher.kind in {'payroll','payroll_payment'}:
                salary += entry.amount; has_salary = True; continue
            sign = -1 if entry.is_reversal else 1
            rows.append(source(user,entry.voucher,metric,entry.amount,reversal_day(entry.voucher) if entry.is_reversal else entry.voucher.date,sign,entry=entry.pk,visible_store=entry.account.store_id))
    else:
        for voucher in period_documents(ids,start,end).order_by('date','pk').iterator(chunk_size=200):
            sign = period_sign(voucher,start,end)
            if not sign: continue
            for component,value in voucher_contributions(voucher,sign,scoped=scoped).items():
                if component not in weights: continue
                contribution = value * weights[component]; amount += contribution
                if user.profile.role == 'manager' and voucher.kind == 'payroll':
                    salary += contribution; has_salary = True; continue
                rows.append(source(user,voucher,component,contribution,reversal_day(voucher) if sign<0 else voucher.date,sign))
    if has_salary: private_aggregate(rows,salary,'payroll' if metric!='cash_net' else 'cash_net')
    return paginate(rows,params,{'mode':'period','metric':metric,'title':LABELS[metric],'formula':FORMULAS.get(metric,'Сума підписаних внесків джерельних документів'),
                                'from':start.isoformat(),'to':end.isoformat(),'amount':str(money(amount))})


def balance_sources(user,params,ids):
    metric = params.get('metric'); require(metric in {'stock','cash'},'Невідомий показник залишків.')
    cutoff = day(params.get('as_of') or timezone.localdate().isoformat()); require(cutoff<=timezone.localdate(),'Дата залишків не може бути в майбутньому.')
    require_reversal_dates(ids,cutoff)
    identifier = positive_integer(params.get('source',''),'ID джерела залишку')
    rows, amount, salary, has_salary = PageRows(params), ZERO, ZERO, False
    if metric == 'stock':
        exists = StockLot.objects.filter(pk=identifier,warehouse__store_id__in=ids).exists()
        entries = effective_entries(StockEntry,cutoff).filter(lot_id=identifier,lot__warehouse__store_id__in=ids).select_related('voucher','lot__warehouse').order_by('pk').iterator(chunk_size=200) if exists else []
    else:
        exists = CashAccount.objects.filter(pk=identifier,store_id__in=ids).exists()
        entries = effective_entries(CashEntry,cutoff).filter(account_id=identifier,account__store_id__in=ids).select_related('voucher','account').order_by('pk').iterator(chunk_size=200) if exists else []
    for entry in entries:
        value = entry.value if metric=='stock' else entry.amount; amount += value
        if user.profile.role=='manager' and entry.voucher.kind in {'payroll','payroll_payment'}:
            salary += value;has_salary=True;continue
        sign = -1 if entry.is_reversal else 1
        row = source(user,entry.voucher,metric,value,reversal_day(entry.voucher) if entry.is_reversal else entry.voucher.date,sign,entry=entry.pk,visible_store=entry.lot.warehouse.store_id if metric=='stock' else entry.account.store_id)
        if metric=='stock':row['quantity']=str(entry.quantity)
        rows.append(row)
    if has_salary:private_aggregate(rows,salary,metric)
    return paginate(rows,params,{'mode':'balances','metric':metric,'title':LABELS[metric],'formula':FORMULAS[metric],
                                'as_of':cutoff.isoformat(),'source':identifier,'amount':str(money(amount))})


def drilldown(user,params):
    with read_snapshot():
        stores,scoped=stores_for(user,params);ids={store.pk for store in stores}
        mode=params.get('mode','period');require(mode in {'period','balances'},'Некоректний режим розшифровки.')
        return balance_sources(user,params,ids) if mode=='balances' else period_sources(user,params,ids,scoped)
