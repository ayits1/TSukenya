from django.db import migrations, models


def install(apps, schema_editor):
    from server.erp.migration_helpers import trading_versions_0024_sql as sql
    (sql.install_pg if schema_editor.connection.vendor == 'postgresql' else sql.install_sqlite)(schema_editor.connection)


def uninstall(apps, schema_editor):
    from server.erp.migration_helpers import trading_versions_0024_sql as sql
    (sql.uninstall_pg if schema_editor.connection.vendor == 'postgresql' else sql.uninstall_sqlite)(schema_editor.connection)


class Migration(migrations.Migration):
    dependencies = [('erp', '0023_operation_price_results')]
    operations = [migrations.CreateModel(name='TradingVersion', fields=[
        ('key', models.CharField(max_length=160, primary_key=True, serialize=False)),
        ('revision', models.PositiveBigIntegerField(default=1))]), migrations.RunPython(install,uninstall)]
