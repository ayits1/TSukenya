from django.apps import AppConfig
from django.db.backends.signals import connection_created


def sqlite_invalidation(sender, connection, **kwargs):
    if connection.vendor == 'sqlite':
        from .state_version_sqlite import register
        register(connection)
        from .trading_version_sql import register_sqlite
        register_sqlite(connection)


class ErpConfig(AppConfig):
    name = 'server.erp'
    default_auto_field = 'django.db.models.BigAutoField'

    def ready(self):
        connection_created.connect(sqlite_invalidation, dispatch_uid='erp-state-invalidation')
