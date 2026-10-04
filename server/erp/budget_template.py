"""Versioned count for the catalogue budget; independent of ERP/label identities."""
import hashlib
import json
import re
from django.db import transaction
from .budget import budget_count, valid_count
from .financial_scope import require_network_owner
from .historical_reports import read_snapshot
from .models import Document
from .services import current_actor, ledger_lock, require, audit
from .business_audit import change as audit_change

RESOURCE = 'budget-template'


def revision(data):
    # Equivalent inferred/explicit counts describe the same editable value.
    return hashlib.sha256(json.dumps({'resource': RESOURCE, 'budgetStores': budget_count(data)}, sort_keys=True).encode()).hexdigest()


def dto(data):
    return {'resource': RESOURCE, 'budgetStores': budget_count(data), 'revision': revision(data),
            'source': 'explicit' if valid_count(data.get('budgetStores')) else 'legacy', 'canEdit': True}


def read(user):
    with read_snapshot():
        user = current_actor(user)
        require_network_owner(user)
        document = Document.objects.filter(pk='settings/main').first()
        return dto(document.data if document else {})


def check_revision(observed, data):
    from .views import response
    if observed is None or observed == '':
        return response({'error': 'Передайте початкову версію кількості магазинів.', 'code': 'revision_required'}, 428)
    require(isinstance(observed, str) and re.fullmatch(r'[a-f0-9]{64}', observed), 'Некоректна версія кількості магазинів.')
    if observed != revision(data):
        return response({'error': 'Кількість магазинів уже змінено. Чернетка збережена: узгодьте зміни.', 'code': 'revision_conflict'}, 409)


@transaction.atomic
def save(request, user):
    from .views import body, response
    ledger_lock()
    user = current_actor(user)
    require_network_owner(user)
    value = body(request)
    require(isinstance(value, dict) and 'budgetStores' in value and set(value) <= {'budgetStores', 'revision'}, 'Передайте кількість магазинів і її версію.')
    require(valid_count(value['budgetStores']), 'Кількість магазинів бюджету має бути цілим числом від 1 до 1000.')
    document = Document.objects.filter(pk='settings/main').first()
    old = dict(document.data) if document else {}
    error = check_revision(value.get('revision'), old)
    if error is not None:
        return error
    new = {**old, 'budgetStores': value['budgetStores']}
    # An unchanged confirmed value needs no additional audit/write.
    if new != old:
        Document.objects.update_or_create(pk='settings/main', defaults={'data': new})
        audit(user, 'budget_template_saved', 'settings/main', audit_change({'budgetStores': budget_count(old)}, {'budgetStores': budget_count(new)}, observed=value['revision']))
    return response(dto(new))


def guard_legacy(request, user, old, incoming=None):
    """No legacy PUT/PATCH/delete may silently change this independent count."""
    from .views import response
    require_network_owner(user)
    if incoming is None or 'budgetStores' in incoming:
        if incoming is not None:
            require(valid_count(incoming['budgetStores']), 'Кількість магазинів бюджету має бути цілим числом від 1 до 1000.')
        return check_revision(request.headers.get('X-Budget-Template-Revision'), old)
    # Label/ERP identity is independent. Preserve the observed budget count even
    # for replacing PUTs, including old documents with an inferred legacy count.
    incoming['budgetStores'] = budget_count(old)
