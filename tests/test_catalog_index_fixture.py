from django.test import TransactionTestCase
from server.erp.import_models import CatalogIndexDirty, CatalogNameIndex, CatalogRecipeIndex
from server.erp.models import Document
from tests.catalog_index_fixture import clear_flushed_catalogue_tombstones


class CatalogueFlushIsolationTests(TransactionTestCase):
    def test_deleted_flush_tombstones_removed_but_current_dirty_records_retained(self):
        self.assertFalse(CatalogNameIndex.objects.exists())
        self.assertFalse(CatalogRecipeIndex.objects.exists())
        Document.objects.bulk_create([
            Document(path=f'products/old-fixture-{i}', data={'name': str(i)}) for i in range(205)
        ])
        # Reproduce SQLite's possible table-delete order explicitly.
        CatalogIndexDirty.objects.all().delete()
        Document.objects.all().delete()
        self.assertEqual(CatalogIndexDirty.objects.count(), 205)
        Document.objects.create(path='products/current-fixture', data={'name': 'Поточний'})
        clear_flushed_catalogue_tombstones()
        self.assertEqual(list(CatalogIndexDirty.objects.values_list('path', flat=True)),
                         ['products/current-fixture'])
