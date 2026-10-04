"""Finance workspace projections; posting and settlement formulas remain authoritative."""
import re
from zoneinfo import ZoneInfo
from django.db.models import Q, Case, When, F, DateField, Value, TextField
from django.db.models.functions import TruncDate, Coalesce, Length
from django.db.models.fields.json import KeyTextTransform
from . import directories, settlement_reads
from .browsing import PAGE_SIZE, page_bounds, page_number, positive_integer
from .financial_browsing import financial_access, date_filter
from .historical_reports import read_snapshot
from .models import CashEntry, Store, Voucher
from .reporting import scoped
from .services import current_actor, day, ROLE_KINDS, SYSTEM_KINDS, require

KINDS = ('payment','advance_allocation','payment_refund','expense','cash_opening','debt_opening','cash_transfer','cash_difference')
RESOURCES = {'accounts','debts','advances','ledger','documents'}
FIELDS = {'accounts': {'q','store'}, 'debts': {'q','store','party','from','to','due_from','due_to','status'},
          'advances': {'q','store','party'}, 'ledger': {'q','store','account','from','to'},
          'documents': {'store','status'}}


def policy(user):
    financial_access(user)
    allowed = [kind for kind in KINDS if kind in ROLE_KINDS[user.profile.role]]
    return {'role':user.profile.role,'store':user.profile.store_id,'documentKinds':allowed,
            'createKinds':[kind for kind in allowed if kind not in SYSTEM_KINDS], 'canManageAccounts':user.profile.role=='owner'}


def options(resource, params):
    require(resource in RESOURCES and not set(params)-FIELDS[resource]-{'page'}, 'Невідомий параметр фінансів.')
    require(all(isinstance(v,str) for v in params.values()), 'Некоректні параметри фінансів.')
    if hasattr(params,'getlist'):require(all(len(params.getlist(k))==1 for k in params),'Параметр повторюється.')
    result = {key:None if key in {'store','party','account'} else '' for key in sorted(FIELDS[resource])}
    for key in result:
        value=params.get(key,'')
        if key in {'store','party','account'}:result[key]=positive_integer(value,'ID довідника') if value else None
        elif key in {'from','to','due_from','due_to'}:
            require(not value or day(value).isoformat()==value,'Дата має формат РРРР-ММ-ДД.');result[key]=value
        else:result[key]=value.strip() if key=='q' else value
    require(len(result.get('q',''))<=250,'Пошуковий запит задовгий.')
    for a,b in [('from','to'),('due_from','due_to')]:require(not result.get(a) or not result.get(b) or result[a]<=result[b],'Початкова дата пізніша за кінцеву.')
    if 'status' in result:require(result['status'] in ({'','overdue','not_overdue'} if resource=='debts' else {'','draft','posted','reversed'}),'Невідомий стан.')
    page_number(params)
    return result


def query_params(query, params):
    return {**{k:str(v) for k,v in query.items() if v is not None and v!=''},'page':str(page_number(params))}


def captions(ids):
    return dict(Store.objects.filter(pk__in=set(ids)).values_list('pk','name'))


def page(query, params):
    total=query.count(); selected,pages,offset=page_bounds(total,page_number(params))
    return {'total':total,'page':selected,'pages':pages,'limit':PAGE_SIZE},offset


def accounts(user, params, selected):
    raw=directories.page(user,'accounts',{**params,'purpose':'finance'})
    names=captions(x['store_id'] for x in raw['items'])
    return {k:raw[k] for k in ('total','page','pages','limit')} | {'items':[{'id':int(x['id']),'name':x['name'],
        'store':x['store_id'],'storeName':names[x['store_id']],'kind':x['kind'],'balance':x['balance'],'revision':x.get('revision')} for x in raw['items']]}


def debts(user, params, selected):
    raw=settlement_reads.debts(user,params); names=captions(x['store'] for x in raw['items'])
    return {k:raw[k] for k in ('total','page','pages')} | {'limit':PAGE_SIZE,
        'totals':{'owedToUs':raw['debt_totals']['owed_to_us'],'owedByUs':raw['debt_totals']['owed_by_us']},
        'items':[{'id':x['voucher'],'number':x['number'],'kind':x['kind'],'originalKind':x['original_kind'],
                  'store':x['store'],'storeName':names[x['store']],'date':x['date'],'party':x['party_id'],'partyName':x['party'],
                  'total':x['total'],'amount':x['amount'],'dueDate':x['due_date'] if isinstance(x['due_date'],str) else '',
                  'overdue':x['overdue']} for x in raw['items']]}


def advances(user, params, selected):
    raw=settlement_reads.advances(user,params);names=captions(x['store'] for x in raw['items'])
    return {k:raw[k] for k in ('total','page','pages')} | {'limit':PAGE_SIZE,'totals':raw['totals'],
        'items':[{'id':x['payment'],'number':x['number'],'store':x['store'],'storeName':names[x['store']],
                  'date':x['date'],'party':x['party'],'partyName':x['party_name'],'direction':x['direction'],
                  'unallocated':x['unallocated']} for x in raw['items']]}


def ledger(user, params, selected):
    query=scoped(CashEntry.objects.all(),user,'account__store_id').annotate(entry_day=Case(
        When(is_reversal=True,then=TruncDate('voucher__reversed_at',tzinfo=ZoneInfo('Europe/Kyiv'))),
        default=F('voucher__date'),output_field=DateField()))
    if user.profile.role=='manager':query=query.exclude(voucher__kind__in=['payroll','payroll_payment'])
    for key,field in [('store','account__store_id'),('account','account_id')]:
        if selected[key]:query=query.filter(**{field:selected[key]})
    query=date_filter(query,params,'entry_day');search=selected['q'];number=search.lstrip('№').strip()
    if re.fullmatch(r'[0-9]+',number or ''):
        require(len(number)<=12,'Номер документа задовгий.');query=query.filter(voucher_id=int(number))
    elif search:query=query.filter(Q(account__name__icontains=search)|Q(voucher__party__name__icontains=search)|Q(voucher__note__icontains=search))
    bounds,offset=page(query,params)
    values=query.annotate(note_length=Length('voucher__note'), selected_note=Case(
        When(note_length__lte=4000,then=F('voucher__note')),default=Value(None),output_field=TextField()
    )).order_by('-pk').values('id','voucher_id','entry_day','account_id','account__name','account__store_id',
        'account__store__name','voucher__kind','amount','selected_note','is_reversal')[offset:offset+PAGE_SIZE]
    rows=[]
    for x in values:
        require(isinstance(x['selected_note'],str),'Історична примітка перевищує межу 4000 символів.')
        rows.append({'id':x['id'],'voucher':x['voucher_id'],'number':f"{x['voucher_id']:06d}",
            'date':x['entry_day'].isoformat() if x['entry_day'] else '', 'account':x['account_id'],'accountName':x['account__name'],
            'store':x['account__store_id'],'storeName':x['account__store__name'],'kind':x['voucher__kind'],
            'amount':format(x['amount'],'.2f'),'note':x['selected_note'],'reversal':x['is_reversal']})
    return {**bounds,'items':rows}


def documents(user, params, selected):
    query=scoped(Voucher.objects.filter(kind__in=[k for k in KINDS if k in ROLE_KINDS[user.profile.role]]),user)
    if user.profile.role not in {'owner','accountant'}:query=query.alias(expense_scope=Coalesce(KeyTextTransform('expense_scope','payload'),Value('store'),output_field=TextField())).exclude(kind='expense',expense_scope='network')
    if selected['store']:query=query.filter(store_id=selected['store'])
    if selected['status']:query=query.filter(status=selected['status'])
    bounds,offset=page(query,params)
    values=query.order_by('-pk').values('id','kind','status','date','store_id','store__name','party_id','party__name','total','revision')[offset:offset+PAGE_SIZE]
    return {**bounds,'items':[{'id':x['id'],'number':f"{x['id']:06d}",'kind':x['kind'],'status':x['status'],'date':x['date'].isoformat(),
        'store':x['store_id'],'storeName':x['store__name'],'party':x['party_id'],'partyName':x['party__name'] or '',
        'total':format(x['total'],'.2f'),'revision':x['revision']} for x in values]}


READERS={'accounts':accounts,'debts':debts,'advances':advances,'ledger':ledger,'documents':documents}

def read(user, resource, params):
    selected=options(resource,params)
    with read_snapshot():
        user=current_actor(user); auth=policy(user)
        result=READERS[resource](user,query_params(selected,params),selected)
        return {**result,'query':selected,'policy':auth}
