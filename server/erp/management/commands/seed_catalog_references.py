"""Pin compatible product choices into persistent dictionaries without rewriting products."""
from django.core.management.base import BaseCommand
from django.db import transaction
from server.erp.catalog_references import reference_items
from server.erp.models import Document
from server.erp.services import ledger_lock


class Command(BaseCommand):
    help = 'Закріпити наявні значення довідників каталогу без зміни товарів.'

    @transaction.atomic
    def handle(self, *args, **options):
        ledger_lock()
        existing = set(Document.objects.filter(path__startswith='catalog_refs/').values_list('path', flat=True))
        missing = [Document(path='catalog_refs/' + item['id'], data={key: item[key] for key in ('field', 'value', 'parentType')})
                   for item in reference_items() if 'catalog_refs/' + item['id'] not in existing]
        Document.objects.bulk_create(missing)
        # Output only the count, never customer names or document contents.
        self.stdout.write(str(len(missing)))
