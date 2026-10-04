from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('erp', '0022_planning_create_receipts')]
    operations = [
        migrations.AddField(model_name='catalogimportrun', name='price_context', field=models.JSONField(null=True)),
        migrations.AddField(model_name='catalogimportrow', name='price_result', field=models.JSONField(null=True)),
    ]
