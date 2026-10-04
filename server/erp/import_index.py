"""Exact Python keys; durable SQL dirty queue covers ORM bulk writes too."""
import hashlib
from .models import Document
from .import_models import CatalogNameIndex,CatalogRecipeIndex,CatalogIndexDirty
from .catalog import name_key
from .services import require

MAX_INDEX_RECORD_BYTES=1048576
MAX_INDEX_RECIPE_ROWS=100


class IndexLimit(ValueError):pass


def indexed_duplicate(data,old,path):
    key=name_key(data.get('name'))
    if not key or old.get('name') and key==name_key(old.get('name')):return False
    hashed=hashlib.sha256(key.encode()).hexdigest()
    # Exact final equality preserves semantics even in the theoretical hash collision case.
    return any(x==key for x in CatalogNameIndex.objects.filter(name_hash=hashed).exclude(product_id=path).values_list('normalized_name',flat=True).iterator(chunk_size=200))


def legacy_recipe_lookup(identifier,path):
    return CatalogRecipeIndex.objects.filter(component=identifier).exclude(product_id=path).exists()


def drain(limit=200):
    """Caller owns LedgerLock. Technical writes are rolled back with the current step."""
    from .catalog_import import canonical
    paths=list(CatalogIndexDirty.objects.order_by('path').values_list('path','revision')[:limit])
    for path,observed in paths:
        document=Document.objects.select_for_update().filter(pk=path).first()
        if document is None:
            CatalogNameIndex.objects.filter(product_id=path).delete();CatalogRecipeIndex.objects.filter(product_id=path).delete()
        else:
            data=document.data if isinstance(document.data,dict) else {}
            if len(canonical(data).encode())>MAX_INDEX_RECORD_BYTES:raise IndexLimit(f'Каталожний запис {path} перевищує 1 МіБ. Виправте його перед великим імпортом.')
            recipe=data.get('recipe',[])
            if isinstance(recipe,list) and len(recipe)>MAX_INDEX_RECIPE_ROWS:raise IndexLimit(f'Історична рецептура {path} перевищує 100 рядків. Виправте її перед великим імпортом.')
            key=name_key(data.get('name'));hashed=hashlib.sha256(key.encode()).hexdigest() if key else ''
            CatalogNameIndex.objects.update_or_create(product_id=path,defaults={'name_hash':hashed,'normalized_name':key})
            CatalogRecipeIndex.objects.filter(product_id=path).delete()
            components={str(x.get('product')) for x in recipe if isinstance(x,dict)} if isinstance(recipe,list) else set()
            # A longer component can never equal a Document's identifier (160 minus 'products/').
            CatalogRecipeIndex.objects.bulk_create([CatalogRecipeIndex(product_id=path,component=x) for x in components if len(x)<=151],batch_size=100)
        CatalogIndexDirty.objects.filter(pk=path,revision=observed).delete()
    return len(paths),CatalogIndexDirty.objects.exists()
