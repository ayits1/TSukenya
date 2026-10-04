from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class StateVersionsMigrationTests(TransactionTestCase):
    def test_forward_reverse_reinstall_and_preexisting_documents(self):
        executor=MigrationExecutor(connection)
        leaves=executor.loader.graph.leaf_nodes('erp')
        try:
            executor.migrate([('erp','0014_managed_alerts')])
            state=executor.loader.project_state([('erp','0014_managed_alerts')]).apps
            doc=state.get_model('erp','Document')
            doc.objects.create(path='products/old',data={'name':'Old','cost':3})
            executor=MigrationExecutor(connection);executor.migrate([('erp','0015_state_versions')])
            state=executor.loader.project_state([('erp','0015_state_versions')]).apps
            version=state.get_model('erp','StateVersion');self.assertEqual(version.objects.count(),0,'GET need not initialize old records')
            doc.objects.filter(pk='products/old').update(data={'name':'Edited','cost':3})
            self.assertEqual(version.objects.get(pk='catalog').revision,1)
            executor=MigrationExecutor(connection);executor.migrate([('erp','0014_managed_alerts')])
            doc.objects.filter(pk='products/old').update(data={'name':'After rollback','cost':3})
            executor=MigrationExecutor(connection);executor.migrate([('erp','0015_state_versions')])
            doc.objects.filter(pk='products/old').delete()
            self.assertEqual(version.objects.get(pk='catalog').revision,1)
        finally:
            MigrationExecutor(connection).migrate(leaves)
