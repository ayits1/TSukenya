"""B26: paged contacts and current customer facts; never creates money or loyalty points."""
import re
from datetime import date
from decimal import Decimal

from django.db.models import BooleanField, Case, Count, Max, Min, Q, Sum, Value, When
from django.utils import timezone

from .browsing import PAGE_SIZE, page_bounds, page_number, positive_integer
from .historical_reports import read_snapshot
from .models import Counterparty, Store, Voucher
from .reporting import scoped
from .services import BusinessError, ZERO, current_actor, money, require
from .settlements import current_source_obligations

READ_ROLES = {'owner', 'manager', 'cashier', 'accountant'}
FINANCE_ROLES = {'owner', 'manager', 'accountant'}


def access(user, params):
    require(user.profile.role in READ_ROLES, 'Недостатньо прав для клієнтської бази.')
    store = positive_integer(params['store'], 'ID магазину') if params.get('store') else user.profile.store_id
    if store:
        require(user.profile.store_id is None or user.profile.store_id == store, 'Магазин недоступний.')
        require(Store.objects.filter(pk=store).exists(), 'Магазин не знайдено.')
    return store


def contact(row):
    return {'id': row.pk, 'name': row.name, 'phone': row.phone, 'email': row.email,
            'notes': row.notes, 'active': row.active}


def list_customers(user, params):
    """Contacts are a shared directory, as in the existing ERP; metrics are store-scoped."""
    with read_snapshot():
        user = current_actor(user)
        access(user, params)
        query = Counterparty.objects.filter(kind='customer')
        search = params.get('q', '').strip()
        require(len(search) <= 250, 'Пошуковий запит задовгий.')
        if search:
            query = query.filter(Q(name__icontains=search) | Q(phone__icontains=search) | Q(email__icontains=search))
        active = params.get('active', '')
        require(active in {'', 'yes', 'no'}, 'Некоректний стан клієнта.')
        if active:
            query = query.filter(active=active == 'yes')
        total = query.count()
        page, pages, offset = page_bounds(total, page_number(params))
        return {'items': [contact(row) for row in query.order_by('name', 'pk')[offset:offset + PAGE_SIZE]],
                'total': total, 'page': page, 'pages': pages,
                'canEdit': user.profile.role != 'cashier'}


def profile(user, identifier, params):
    with read_snapshot():
        user = current_actor(user)
        store = access(user, params)
        customer = Counterparty.objects.filter(pk=identifier, kind='customer').first()
        require(customer is not None, 'Клієнта не знайдено.')
        today = timezone.localdate()
        sources = scoped(Voucher.objects.filter(party=customer, status='posted', date__lte=today), user)
        if store:
            sources = sources.filter(store_id=store)
        sales = sources.filter(kind='sale')
        totals = sales.aggregate(count=Count('pk'), gross=Sum('total'), first=Min('date'), last=Max('date'))
        count, gross = totals['count'], totals['gross'] or ZERO
        # A return may have no party of its own. Its source sale decides customer and store.
        returns = scoped(Voucher.objects.filter(kind='customer_return', status='posted', date__lte=today,
                                               reference_id__in=sales.values('pk')), user)
        if store:
            returns = returns.filter(store_id=store)
        returned = returns.aggregate(total=Sum('total'))['total'] or ZERO
        segment = 'repeat' if count >= 2 else 'single' if count else 'none'
        debt = None
        if user.profile.role in FINANCE_ROLES:
            outstanding, overdue, debt_count, overdue_count, invalid_due = ZERO, ZERO, 0, 0, 0
            invoices = sources.filter(kind__in=['sale', 'debt_opening']).annotate(
                # Preserve the old truthiness rule without decoding a structured due date.
                crm_due_empty=Case(When(Q(payload__due_date={}) | Q(payload__due_date=[]),
                                       then=Value(True)), default=Value(False), output_field=BooleanField()))
            for invoice, amount in current_source_obligations(invoices.order_by('pk')):
                if amount <= ZERO:
                    continue
                outstanding += amount
                debt_count += 1
                require(not invoice.report_payload_bad,
                        f'Документ {invoice.pk} має некоректні реквізити показника; перевірте регістри.')
                if invoice.report_due_bad:
                    invalid_due += int(not invoice.crm_due_empty)
                    continue
                kind = invoice.report_due_kind
                raw = (kind == 'true' if kind in {'true', 'false'} else invoice.report_due) if invoice.report_due_present else ''
                if raw:
                    try:
                        require(isinstance(raw, str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', raw), 'Некоректна дата.')
                        deadline = date.fromisoformat(raw)
                    except (ValueError, TypeError, BusinessError):
                        # Historic malformed dates must not silently become overdue or break contacts.
                        invalid_due += 1
                        continue
                    if deadline < today:
                        overdue += amount
                        overdue_count += 1
            debt = {'outstanding': str(money(outstanding)), 'overdue': str(money(overdue)),
                    'documents': debt_count, 'overdueDocuments': overdue_count, 'unknownDueDocuments': invalid_due}
        return {'customer': contact(customer), 'scope': {'store': store, 'today': today.isoformat(), 'basis': 'current'},
                'purchases': {'checks': count, 'gross': str(money(gross)), 'returned': str(money(returned)),
                              'net': str(money(gross - returned)),
                              'averageCheck': str(money(gross / Decimal(count))) if count else None,
                              'first': totals['first'].isoformat() if totals['first'] else None,
                              'last': totals['last'].isoformat() if totals['last'] else None, 'segment': segment},
                'debt': debt, 'canEdit': user.profile.role != 'cashier'}


def handle_customers(request, user):
    from .views import response
    if request.method != 'GET':
        return response({'error': 'Метод недоступний.', 'code': 'method_not_allowed'}, 405)
    if request.path == '/api/v1/crm/customers':
        return response(list_customers(user, request.GET))
    match = re.fullmatch(r'/api/v1/crm/customers/([0-9]{1,12})', request.path)
    if match:
        return response(profile(user, positive_integer(match[1], 'ID клієнта'), request.GET))
    return response({'error': 'Сторінку не знайдено.'}, 404)
