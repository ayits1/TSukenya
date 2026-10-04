"""Explicit write-side price observation/history and stable reprint work; previews stay read-only."""
import hashlib
from django.utils import timezone
from .models import Document, PriceChange, PriceObservation, Store
from .promotion_prices import PriceResolver
from .services import audit


def contexts(user=None):
    own = user.profile.store_id if user else None
    if own is not None:
        return list(Store.objects.filter(pk=own))
    return [None, *Store.objects.filter(active=True).order_by('pk')]


def terms(value):
    return {key: value[key] for key in ('regularPrice', 'salePrice', 'effectivePromotion')}


def observation_key(document, store):
    return document.path + ':' + (str(store.pk) if store else 'network')


def observe_prices(user, documents, source, reason, *, seed=False, config=None, scoped=False, product_paths=None):
    """Caller holds ledger_lock. Seed captures the genuine pre-write state, not a fake history row."""
    count = 0
    for store in contexts(user if scoped else None):
        resolver = PriceResolver(config, store, product_paths=product_paths)
        for document in documents:
            value = terms(resolver.resolve(document))
            key = observation_key(document, store)
            observation = PriceObservation.objects.filter(pk=key).first()
            if observation is None:
                PriceObservation.objects.create(key=key, product_path=document.path, store=store, terms=value)
                continue
            if observation.terms == value:
                continue
            # A delayed scheduler must not mislabel the remembered price as this edit's immediate before state.
            change_source='observed_transition' if seed else source
            change_reason='Попередній перехід чинної ціни виявлено перед зміною: '+source if seed else reason
            previous = observation.terms
            change = PriceChange.objects.create(product_path=document.path, store=store,
                before=previous, after=value, author=user, source=change_source, reason=change_reason[:500])
            observation.terms = value
            observation.save(update_fields=['terms', 'observed_at'])
            task_path = 'tasks/reprint_' + hashlib.sha256(key.encode()).hexdigest()[:32]
            old_task = Document.objects.filter(pk=task_path).first()
            old = old_task.data if old_task else {}
            stamp = timezone.now()
            task = {**old, 'scope': 'operations', 'store': store.pk if store else None,
                'title': f"Передрукувати цінник: {document.data.get('name', '')} · {store.name if store else 'Мережа'} · {previous['salePrice']} → {value['salePrice']} грн",
                'status': 'todo', 'dueDate': resolver.day.isoformat(), '_priceTask': True,
                '_priceProduct': document.path.split('/', 1)[1], '_priceContext': store.pk if store else None,
                '_priceChange': change.pk, 'createdAt': old.get('createdAt') or stamp.isoformat(),
                'order': old.get('order') or int(stamp.timestamp() * 1000)}
            from .managed_alerts import clear_work
            clear_work(task);task['_alertCycle']=int(old.get('_alertCycle') or 0)+1
            task['_alertNote']='Ціну змінено: потрібен новий передрук';task['_alertNoteAt']=stamp.isoformat()
            Document.objects.update_or_create(pk=task_path, defaults={'data': task})
            audit(user, 'price_changed', document.path, {'store': store.pk if store else None,
                'before': previous, 'after': value, 'source': change_source, 'reason': change_reason[:500], 'change': change.pk})
            count += 1
    return count


def catalogue_price_change(user, before, after, source, reason, *, before_config=None, after_config=None):
    # No artificial old price for a genuinely new product.
    if before is not None:
        observe_prices(user, [before], source, reason, seed=True, config=before_config)
    return observe_prices(user, [after], source, reason, config=after_config)


def scan_prices(user, source='scheduler'):
    from .catalog import base_query
    documents = list(base_query().order_by('path'))
    return observe_prices(user, documents, source, 'Перехід періоду дії акцій або зміна чинної ціни', scoped=True)
