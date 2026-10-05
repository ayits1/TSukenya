"""Restore derived-index isolation after TransactionTestCase's table flush."""
from server.erp.import_models import CatalogIndexDirty, CatalogNameIndex, CatalogRecipeIndex
from server.erp.models import Document


def clear_flushed_catalogue_tombstones():
    # SQLite flush may DELETE the dirty table before Document; its DELETE trigger
    # then re-enqueues old products. This is fixture cleanup, never a production
    # shortcut: real tombstones must be drained to remove their indexed names.
    if CatalogNameIndex.objects.exists() or CatalogRecipeIndex.objects.exists():
        raise AssertionError('Catalogue indexes were not flushed before fixture setup.')
    CatalogIndexDirty.objects.exclude(
        path__in=Document.objects.filter(path__startswith='products/').values('path')
    ).delete()
