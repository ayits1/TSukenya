import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

class Migration(migrations.Migration):
    dependencies = [('erp', '0026_setting_action_receipts'), migrations.swappable_dependency(settings.AUTH_USER_MODEL)]
    operations = [migrations.CreateModel(name='VoucherActionReceipt', fields=[
        ('key', models.UUIDField(editable=False, primary_key=True, serialize=False)),
        ('target_id', models.PositiveBigIntegerField()),
        ('store_id_snapshot', models.PositiveBigIntegerField()),
        ('kind', models.CharField(max_length=24)),
        ('action', models.CharField(max_length=8)),
        ('expense_scope', models.CharField(max_length=8)),
        ('fingerprint', models.CharField(max_length=64)),
        ('request', models.JSONField()),
        ('outcome', models.CharField(max_length=8)),
        ('created_at', models.DateTimeField(auto_now_add=True)),
        ('author', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
    ])]
