import uuid
import django.db.models.deletion
from django.db import migrations, models


def backfill(apps, schema_editor):
    Line = apps.get_model('erp', 'VoucherLine')
    Entry = apps.get_model('erp', 'StockEntry')
    alias = schema_editor.connection.alias
    origins, pending = {}, []
    for line in Line.objects.using(alias).all().iterator():
        line.line_key = uuid.uuid4()
        key = (line.voucher_id, line.product_id)
        origins[key] = None if key in origins else line.pk
        pending.append(line)
        if len(pending) == 1000:
            Line.objects.using(alias).bulk_update(pending, ['line_key'], batch_size=1000)
            pending = []
    if pending:
        Line.objects.using(alias).bulk_update(pending, ['line_key'], batch_size=1000)
    pending = []
    # Production consumes recipe components, including possible self-SKU components, not output rows.
    for entry in Entry.objects.using(alias).select_related('lot', 'voucher').all().iterator():
        if entry.voucher.kind == 'production' and entry.quantity < 0:
            continue
        origin = origins.get((entry.voucher_id, entry.lot.product_id))
        if origin is not None:
            entry.line_id = origin
            pending.append(entry)
            if len(pending) == 1000:
                Entry.objects.using(alias).bulk_update(pending, ['line'], batch_size=1000)
                pending = []
    if pending:
        Entry.objects.using(alias).bulk_update(pending, ['line'], batch_size=1000)


class Migration(migrations.Migration):
    dependencies = [('erp', '0006_legacy_create_receipt')]
    operations = [
        migrations.AddField(model_name='voucherline', name='line_key', field=models.UUIDField(null=True, editable=False)),
        migrations.AddField(model_name='stockentry', name='line', field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='stock_entries', to='erp.voucherline')),
        migrations.RunPython(backfill, migrations.RunPython.noop),
        migrations.AlterField(model_name='voucherline', name='line_key', field=models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
    ]
