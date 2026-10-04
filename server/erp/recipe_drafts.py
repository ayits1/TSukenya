"""Read-only recipe draft policy and creator-bound approved request identity."""
import hashlib
import json
import uuid

from .historical_reports import read_snapshot
from .models import Document, RecipeVersion
from .recipes_versions import product_id, terms
from .services import Conflict, current_actor, require

REQUEST_FIELDS = {'idempotencyKey', 'product', 'expectedVersion', 'catalogRevision',
                  'outputQuantity', 'components', 'expiryPolicy', 'shelfLifeDays', 'reason'}


def authorize(user, mode):
    require(mode in {'legacy', 'version'}, 'Некоректний редактор рецептури.')
    roles = {'owner', 'manager', 'warehouse'} if mode == 'legacy' else {'owner', 'manager'}
    require(user.profile.role in roles, 'Недостатньо прав для редактора рецептури.')


def recovery_context(user, params):
    require(not (set(params) - {'mode', 'product'}), 'Некоректні параметри чернетки рецептури.')
    with read_snapshot():
        user = current_actor(user)
        mode = params.get('mode')
        authorize(user, mode)
        identifier = params.get('product', '')
        require(isinstance(identifier, str), 'Некоректний товар рецептури.')
        product = None
        if identifier:
            product = Document.objects.filter(pk='products/' + product_id(identifier)).first()
        return {'mode': mode, 'product': identifier, 'role': user.profile.role,
                'storeId': user.profile.store_id,
                'networkOwner': user.profile.role == 'owner' and user.profile.store_id is None,
                'exists': product is not None if identifier else None,
                'canWrite': bool(not identifier or product is not None and
                                 (mode == 'legacy' or not product.data.get('hidden')))}


def identity(user, value):
    with read_snapshot():
        user = current_actor(user)
        authorize(user, 'version')
        require(isinstance(value, dict) and set(value) == {'request'}, 'Некоректний початковий запит рецептури.')
        request = value['request']
        require(isinstance(request, dict) and set(request) == REQUEST_FIELDS, 'Некоректні реквізити версії рецептури.')
        key = request['idempotencyKey']
        try:
            identifier = uuid.UUID(key) if isinstance(key, str) else None
        except ValueError:
            identifier = None
        require(identifier is not None, 'Некоректний ключ створення рецептури.')
        product = product_id(request['product'])
        # Match the existing create_version receipt byte semantics, including raw
        # decimals and observed versions. Do not normalize against today's catalogue.
        try:
            fingerprint = hashlib.sha256(json.dumps(
                {field: item for field, item in request.items() if field != 'idempotencyKey'},
                sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
        except (ValueError, TypeError):
            require(False, 'Некоректні реквізити рецептури.')
        recipe = RecipeVersion.objects.select_related('approved_by').prefetch_related('components').filter(pk=identifier).first()
        result = {'confirmed': recipe is not None, 'key': str(identifier), 'product': product}
        if recipe is not None:
            if recipe.approved_by_id != user.pk or recipe.request_fingerprint != fingerprint or recipe.product_id != 'products/' + product:
                raise Conflict('Ключ уже використано для іншого створення рецептури.', 'idempotency_conflict')
            result['original'] = terms(recipe)
        return result
