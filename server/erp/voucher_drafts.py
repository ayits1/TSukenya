"""Read-only authorization for an unsent native draft. No receipts or postings here."""
from datetime import date
from django.utils import timezone
from .historical_reports import read_snapshot
from .services import current_actor, get, permission, scope, require
from .models import Store, LedgerLock
from .browsing import positive_integer


def recovery_context(user, params):
    with read_snapshot():
        user = current_actor(user)
        kind = params.get('kind')
        require(isinstance(kind, str) and kind != 'cash_difference', 'Некоректний тип чернетки.')
        permission(user, kind)
        store = get(Store, positive_integer(params.get('store'), 'ID магазину'), 'Магазин')
        scope(user, store)
        expense_scope = params.get('expense_scope', 'store')
        require(expense_scope in {'store', 'network'}, 'Некоректна належність витрати.')
        require(kind != 'expense' or expense_scope != 'network' or user.profile.role in {'owner', 'accountant'}, 'Мережеві витрати недоступні цій ролі.')
        closed = LedgerLock.objects.filter(pk=1).values_list('closed_through', flat=True).first()
        try:
            observed_date = date.fromisoformat(params.get('date', ''))
            valid_date = observed_date.isoformat() == params.get('date')
        except (TypeError, ValueError):
            observed_date, valid_date = None, False
        return {'kind': kind, 'store': store.pk, 'editing': {
            'role': user.profile.role, 'storeId': user.profile.store_id,
            'closedThrough': closed.isoformat() if closed else None,
            'storeActive': store.active,
            'canEdit': bool(store.active and valid_date and observed_date <= timezone.localdate() and (closed is None or observed_date > closed)),
        }}
