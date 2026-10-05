from django.db import migrations


def upgrade(apps,schema_editor):
    from server.erp.catalog_scalar_sqlite import install
    install(schema_editor.connection)


def downgrade(apps,schema_editor):
    from server.erp.catalog_scalar_sqlite import restore
    restore(schema_editor.connection)


class Migration(migrations.Migration):
    dependencies=[('erp','0027_voucher_action_receipts')]
    operations=[migrations.RunPython(upgrade,downgrade)]
