from django.db import migrations


def install(apps,schema_editor):
    from server.erp.migration_helpers import customer_report_0029_sql as sql
    (sql.install_pg if schema_editor.connection.vendor=='postgresql' else sql.install_sqlite)(schema_editor.connection)


def uninstall(apps,schema_editor):
    from server.erp.migration_helpers import customer_report_0029_sql as sql
    (sql.uninstall_pg if schema_editor.connection.vendor=='postgresql' else sql.uninstall_sqlite)(schema_editor.connection)


class Migration(migrations.Migration):
    dependencies=[('erp','0028_catalog_scalar_invalidation')]
    operations=[migrations.RunPython(install,uninstall)]
