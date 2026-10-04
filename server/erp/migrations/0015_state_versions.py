from django.db import migrations, models


def install(apps, schema_editor):
    from server.erp.state_version_sql import pg_install
    from server.erp.state_version_sqlite import install as sqlite_install
    connection = schema_editor.connection
    if connection.vendor == 'postgresql':pg_install(connection)
    elif connection.vendor == 'sqlite':sqlite_install(connection)


def uninstall(apps, schema_editor):
    from server.erp.state_version_sql import pg_uninstall
    from server.erp.state_version_sqlite import uninstall as sqlite_uninstall
    connection = schema_editor.connection
    if connection.vendor == 'postgresql':pg_uninstall(connection)
    elif connection.vendor == 'sqlite':sqlite_uninstall(connection)


class Migration(migrations.Migration):
    dependencies = [('erp', '0014_managed_alerts')]
    operations = [migrations.CreateModel(name='StateVersion', fields=[
        ('key', models.CharField(max_length=160, primary_key=True, serialize=False)),
        ('revision', models.PositiveBigIntegerField(default=1)),
    ]), migrations.RunPython(install, uninstall)]
