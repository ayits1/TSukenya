"""Owner-only, bounded catalogue price plans and atomic retry-safe changes."""
from .catalog_access import revalidate_actor
from . import catalog_price_results as price_results
from .business_audit import snapshot as audit_snapshot, change as audit_change
import hashlib
import hmac
import re
from decimal import Decimal
from django.core.exceptions import RequestDataTooBig
from django.db import transaction
from .catalog import defaults, normalise_product, plain, revision, serialize
from .catalog_import import MAX_ENTRIES, UUID_PATTERN, canonical, snapshot
from .models import Document
from .services import BusinessError, audit, dec, ledger_lock, require

ROUNDING = {'0.01', '0.1', '0.5', '1'}


def pricing_body(request):
    from .views import body
    try:
        return body(request)
    except RequestDataTooBig:
        raise BusinessError('Запит зміни цін завеликий. Дозволено до 1000 товарів і 1 МіБ JSON.')


def validate_payload(payload, *, committing=False):
    kind = payload.get('kind')
    require(isinstance(kind, str) and kind in {'markup', 'rounding'}, 'Невідомий вид зміни цін.')
    fields = {'kind', 'ids', 'markup', 'resetManualPrices', 'updateDefault'} if kind == 'markup' else {'kind', 'rounding'}
    if kind=='markup' and 'selection' in payload:
        fields=(fields-{'ids'})|{'selection'}
    if 'priceContext' in payload:
        price_results.validate_context(payload['priceContext']); fields.add('priceContext')
    if committing:
        fields |= {'snapshot', 'idempotencyKey'}
    require(set(payload) == fields, 'Запит містить невідомі поля або не всі параметри зміни цін.')
    if kind == 'markup':
        require(isinstance(payload['markup'], str) and re.fullmatch(r'[0-9]+(?:\.[0-9]{1,4})?', payload['markup']), 'Націнка має бути невід’ємним десятковим рядком до 4 знаків після коми.')
        markup = dec(payload['markup'], 'Націнка', Decimal('.0001'))
        require(markup <= Decimal('99999999.99'), 'Націнка завелика.')
        require(type(payload['resetManualPrices']) is bool and type(payload['updateDefault']) is bool, 'Очікуються логічні параметри зміни цін.')
        selection=payload.get('selection')
        if 'selection' in payload:
            require(isinstance(selection,dict) and set(selection)=={'q','type','category','pack','promotion','store'},'Некоректний вибір за фільтром.')
            require(all(isinstance(selection[k],str) and len(selection[k]) <= (250 if k=='q' else 160) for k in selection),'Некоректні умови фільтра.')
            require(selection['promotion'] in {'','yes','no'},'Некоректний фільтр акції.')
        ids = payload.get('ids')
        require(ids is None or isinstance(ids, list) and 0 < len(ids) <= MAX_ENTRIES, 'Виберіть від 1 до 1000 товарів або всі активні товари.')
        if ids is not None:
            require(all(isinstance(identifier, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,120}', identifier) for identifier in ids), 'Некоректний ID товару.')
            require(len(set(ids)) == len(ids), 'Список товарів містить повторені ID.')
        require(not payload['updateDefault'] or ids is None and 'selection' not in payload, 'Змінити націнку за замовчуванням можна лише для всіх активних товарів.')
    else:
        require(isinstance(payload['rounding'], str) and payload['rounding'] in ROUNDING, 'Виберіть округлення: 0.01, 0.1, 0.5 або 1.')
    if committing:
        require(isinstance(payload['snapshot'], str) and re.fullmatch(r'[0-9a-f]{64}', payload['snapshot']), 'Відсутній перевірений знімок зміни цін.')
        require(isinstance(payload['idempotencyKey'], str) and re.fullmatch(UUID_PATTERN, payload['idempotencyKey']), 'Ключ повтору має бути UUID у нижньому регістрі.')


def price_pair(document, user, config, resolver=None):
    product = serialize(document, user, config, resolver=resolver)
    return {'regularPrice': product['regularPrice'], 'salePrice': product['salePrice']}


def settings_pair(config):
    return {'defaultMarkup': plain(config['markup']), 'rounding': plain(config['rounding'])}


def plan(payload, user):
    validate_payload(payload)
    before_config = defaults()
    after_config = dict(before_config)
    from .catalog_references import reference_records
    references = reference_records()
    documents = list(Document.objects.filter(path__startswith='products/').order_by('path'))
    active = {document.path.split('/', 1)[1]: document for document in documents if document.data.get('hidden') is not True}
    kind = payload['kind']
    if kind == 'markup':
        ids = payload.get('ids')
        if 'selection' in payload:
            from .catalog import filtered_products
            query,*_=filtered_products(user,payload['selection'])
            ids=[path.split('/',1)[1] for path in query.values_list('path',flat=True)]
            require(ids,'За вибраними фільтрами товарів немає.')
            require(len(ids)<=MAX_ENTRIES,'Вибір за фільтром охоплює понад 1000 товарів. Зменшіть вибір.')
        if ids is not None:
            require(all(identifier in active for identifier in ids), 'Вибраний товар не існує або прихований. Оновіть каталог.')
        selected = set(active) if ids is None else set(ids)
        if payload['updateDefault']:
            after_config['markup'] = dec(payload['markup'], 'Націнка', Decimal('.0001'))
        # Pin the previous fallback for every excluded product, including hidden
        # products and skipped manual prices, before changing a future default.
        candidates = [document for document in documents if document.path.split('/', 1)[1] in selected
                      or payload['updateDefault'] and 'markup' not in document.data]
    else:
        selected = set()
        after_config['rounding'] = Decimal(payload['rounding'])
        candidates = documents
    require(len(candidates) <= MAX_ENTRIES, 'Зміна цін охоплює понад 1000 товарів. Зменшіть вибір; глобальне округлення потребує меншого каталогу.')
    from .promotion_prices import PriceResolver,context_store,kyiv_day
    price_store=price_results.resolve_context(user,payload,selection_store=payload.get('selection',{}).get('store'))
    price_day=kyiv_day();paths=[d.path for d in candidates]
    before_resolver=PriceResolver(before_config,price_store,price_day,product_paths=paths)
    after_resolver=PriceResolver(after_config,price_store,price_day,product_paths=paths)
    entries = []
    prepared = []
    changed_prices = changed_records = skipped_manual = errors = 0
    for document in candidates:
        identifier = document.path.split('/', 1)[1]
        old = document.data
        before = price_pair(document, user, before_config,before_resolver)
        entry = {'id': identifier, 'name': str(old.get('name') or ''), 'hidden': bool(old.get('hidden')),
                 'action': 'unchanged', 'before': before, 'after': dict(before)}
        try:
            values = {}
            skipping = kind == 'markup' and identifier in selected and bool(old.get('manualPrice')) and not payload['resetManualPrices']
            if kind == 'markup':
                if identifier in selected and not skipping:
                    values.update(markup=payload['markup'])
                    if payload['resetManualPrices']:
                        values.update(manualPrice=False, price=None)
                elif payload['updateDefault'] and 'markup' not in old:
                    values['markup'] = format(before_config['markup'], 'f')
            entry['after'] = price_pair(Document(path=document.path, data={**old, **values}), user, after_config,after_resolver)
            data = normalise_product(values, old, document.path, validate_references=False, config=after_config,old_config=before_config, references=references)
            entry['after'] = price_pair(Document(path=document.path, data=data), user, after_config,after_resolver)
            # Only stored changes are written and audited; equal numbers compare alike (30 == 30.0).
            entry['priceComparison'] = price_results.compare_terms(
                price_results.terms(document,before_config,before_resolver),
                price_results.terms(Document(path=document.path,data=data),after_config,after_resolver))
            record_changed = data != old
            price_changed = before != entry['after']
            changed_records += record_changed
            changed_prices += price_changed
            entry['action'] = 'skip' if skipping else 'update' if record_changed else 'unchanged'
            skipped_manual += skipping
            prepared.append((document, data, entry, record_changed))
        except BusinessError as exc:
            errors += 1
            entry.update(action='error', error=str(exc))
        entries.append(entry)
    settings = {'before': settings_pair(before_config), 'after': settings_pair(after_config)}
    summary = {'candidates': len(entries), 'changedPrices': changed_prices, 'changedRecords': changed_records,
               'skippedManual': skipped_manual, 'errors': errors}
    scope={'kind':'filter' if 'selection' in payload else 'all' if kind=='rounding' or payload.get('ids') is None else 'ids','count':len(selected) if kind=='markup' else len(candidates)}
    if 'selection' in payload:
        from .promotion_prices import context_store
        store=context_store(user,payload['selection']['store'])
        scope.update(filters=payload['selection'],storeName=store.name if store else None)
    review=snapshot(documents,before_config,day=price_day)
    if 'selection' in payload:
        from django.conf import settings as django_settings
        material={'catalogue':review,'selection':payload['selection'],'selected':sorted(selected),'prices':[[e['id'],e['before']] for e in entries],'day':price_day.isoformat()}
        review=hmac.new(django_settings.SECRET_KEY.encode(),canonical(material).encode(),hashlib.sha256).hexdigest()
    # Explicit context must be part of the reviewed intent, including unfiltered plans.
    if 'priceContext' in payload:
        from .labels import sign
        review=sign({'catalogue':review,'priceContext':payload['priceContext']})
    return {'valid': errors == 0, 'kind': kind, 'scope':scope, 'snapshot':review,
            'priceContext':price_results.capture_context(price_store),'effectiveDay':price_day.isoformat(),
            'entries': entries, 'summary': summary, 'settings': settings}, prepared, after_config


def preview_pricing(request, user):
    from .views import response
    from .historical_reports import read_snapshot
    from .services import current_actor
    payload = pricing_body(request)
    with read_snapshot():
        user = current_actor(user)
        require(user.profile.role in {'owner'}, 'Недостатньо прав. Зміна цін доступна лише власнику.')
        result, *_ = plan(payload, user)
        return response(result)


@transaction.atomic
def commit_pricing(request, user):
    from .views import response
    require(user.profile.role == 'owner', 'Недостатньо прав. Зміна цін доступна лише власнику.')
    payload = pricing_body(request)
    validate_payload(payload, committing=True)
    digest = hashlib.sha256(canonical(payload).encode()).hexdigest()
    path = 'pricing_runs/' + payload['idempotencyKey']
    ledger_lock()
    revalidate_actor(user, {'owner'}, 'Недостатньо прав. Зміна цін доступна лише власнику.')
    previous = Document.objects.filter(pk=path).first()
    if previous:
        if previous.data.get('owner') != user.pk or previous.data.get('payloadHash') != digest:
            return response({'error': 'Ключ повтору вже використано для іншої зміни цін.', 'code': 'idempotency_conflict'}, 409)
        if previous.data.get('priceContext') is not None:
            price_results.scope_context(user,previous.data['priceContext'])
        return response(previous.data['result'])
    original_payload = {key: value for key, value in payload.items() if key not in {'snapshot', 'idempotencyKey'}}
    result, prepared, config = plan(original_payload, user)
    if not hmac.compare_digest(payload['snapshot'], result['snapshot']):
        return response({'error': 'Каталог або налаштування цін уже змінено. Оновіть попередній перегляд.', 'code': 'revision_conflict'}, 409)
    if not result['valid']:
        return response({**result, 'error': 'Зміна цін містить помилки. Жодного товару чи налаштування не збережено.', 'code': 'invalid_pricing'}, 400)
    from .promotion_history import observe_prices
    observed = [document for document, *_ in prepared]
    observe_prices(user,observed,'pricing','Масова зміна цін',seed=True,config=defaults())
    settings = result['settings']
    if config != defaults():  # Decimal values: '30' and 30 are the same setting.
        document, _ = Document.objects.get_or_create(pk='settings/main', defaults={'data': {}})
        before = audit_snapshot('settings', document.data)
        document.data = {**document.data, 'defaultMarkup': float(config['markup']), 'rounding': float(config['rounding'])}
        document.save()
        audit(user, 'pricing_settings_changed', document.path, {'run': payload['idempotencyKey'], **settings, **audit_change(before, audit_snapshot('settings', document.data), observed=payload['snapshot'], reason='Масова зміна цін')})
    from .promotion_prices import PriceResolver
    price_store=price_results.resolve_context(user,original_payload,selection_store=payload.get('selection',{}).get('store'))
    from datetime import date
    resolver=PriceResolver(config,price_store,date.fromisoformat(result['effectiveDay']),product_paths=[d.path for d,*_ in prepared])
    from django.utils import timezone
    committed_at=timezone.now()
    committed_entries = []
    for document, data, entry, record_changed in prepared:
        if record_changed:
            before = audit_snapshot('product', document.data)
            document.data = data
            document.save()
            audit(user, 'catalog_changed', document.path, {'method': 'PRICING', 'contract': 'v1', 'run': payload['idempotencyKey'], **audit_change(before, audit_snapshot('product', data), observed=payload['snapshot'], reason='Масова зміна цін')})
        compared=price_results.compare_terms(entry['priceComparison']['before'],price_results.terms(document,config,resolver))
        price_result=price_results.result(entry['id'],{'skip':'skipped','unchanged':'unchanged','update':'updated'}[entry['action']],compared,resolver,ordinal=len(committed_entries)+1,committed_at=committed_at)
        committed_entries.append({'id': entry['id'], 'action': entry['action'], 'revision': revision(document, config),'priceResult':price_result})
    observe_prices(user,observed,'pricing','Масова зміна цін',config=config)
    committed = {'ok': True, 'priceContext':result['priceContext'], 'idempotencyKey': payload['idempotencyKey'], 'kind': result['kind'],
                 'summary': result['summary'], 'settings': settings, 'entries': committed_entries}
    Document.objects.create(path=path, data={'owner': user.pk, 'payloadHash': digest, 'priceContext':result['priceContext'], 'result': committed})
    audit(user, 'catalog_pricing_changed', path, result['summary'])
    return response(committed)
