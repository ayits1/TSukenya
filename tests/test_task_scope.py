import hashlib
import time

from django.contrib.auth.models import User
from django.test import TestCase

from server.erp.alerts import sync_alerts
from server.erp.legacy_settings import settings_for_role
from server.erp.labels import revision as label_revision
from server.erp.models import Document, LedgerLock, PortalSession, Profile, Store, Warehouse


class TaskScopeTests(TestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.a = Store.objects.create(name='Задачі A')
        self.b = Store.objects.create(name='Задачі B')
        self.user = User.objects.create(username='task-manager')
        Profile.objects.create(user=self.user, role='manager', store=self.a)
        token = 'isolated-task-scope-token'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),
            user=self.user, csrf='task-csrf', expires=int(time.time()) + 3600)
        self.client.cookies['ts_session'] = token
        self.headers = {'HTTP_ORIGIN': 'http://testserver', 'HTTP_X_CSRF_TOKEN': 'task-csrf'}
        self.task('mine', store=self.a.pk)
        self.task('other', store=self.b.pk)
        self.task('network')
        self.task('development', scope='development', store=self.a.pk)
        self.task('unknown', scope='mystery', store=self.a.pk)
        self.task('legacy', scope=None)

    def task(self, identifier, scope='operations', **extra):
        data = {'title': identifier, 'status': 'todo', **extra}
        if scope is not None:
            data['scope'] = scope
        return Document.objects.create(path='tasks/' + identifier, data=data)

    def role(self, role, store=None):
        self.user.profile.role = role
        self.user.profile.store = store
        self.user.profile.save(update_fields=['role', 'store'])

    def write(self, method, path, value=None):
        from server.erp.managed_alerts import task_revision
        doc=Document.objects.filter(pk=path.removeprefix('/api/docs/')).first() if path.startswith(('/api/docs/tasks/','/api/docs/ideas/','/api/docs/expenses/')) else None
        observed={'HTTP_IF_MATCH':task_revision(doc)} if doc else {}
        return getattr(self.client, method)(path, value, content_type='application/json', **(self.headers | observed))

    def items(self):
        return {item['id']: item for item in self.client.get('/api/state').json()['data']['tasks']}

    def test_debt_alerts_and_sync_costs_stay_with_finance_roles(self):
        self.task('auto_due', store=self.a.pk, _alertKey='due:7', _alertActive=True,
                  title='Перевірити оплату: Постачальник · документ № 000007 · 1500.00 грн')
        self.task('auto_low', store=self.a.pk, _alertKey='low:1:p', _alertActive=True, title='Поповнити')
        Document.objects.create(path='products/synced', data={
            'name': 'Цукерки', 'unit': 'кг', 'cost': 180, 'markup': 30, 'manualPrice': False,
            'gsBase': {'cost': '180', 'markup': '30', 'price': '234'}, 'gsRow': 4})
        for role, sees_debts in [('cashier', False), ('warehouse', False), ('manager', True), ('accountant', True)]:
            with self.subTest(role=role):
                self.role(role, self.a)
                state = self.client.get('/api/state').json()['data']
                tasks = {item['id'] for item in state['tasks']}
                self.assertIn('auto_low', tasks)
                self.assertEqual('auto_due' in tasks, sees_debts)
                product = next(p['data'] for p in state['products'] if p['id'] == 'synced')
                if role == 'cashier':
                    self.assertFalse({'cost', 'markup', 'gsBase', 'gsRow'} & set(product))
                    self.assertEqual(product['price'], product['regularPrice'])
                    self.assertEqual(product['name'], 'Цукерки')

    def test_scoped_read_and_authoritative_permissions_for_all_roles(self):
        for role in ['manager', 'cashier', 'warehouse', 'accountant']:
            with self.subTest(role=role):
                self.role(role, self.a)
                items = self.items()
                self.assertEqual(set(items), {'mine', 'network'})
                self.assertEqual(items['network']['permissions'], {'canEdit': False, 'canDelete': False})
                self.assertEqual(items['mine']['permissions'], {'canEdit': role == 'manager', 'canDelete': role == 'manager'})
                self.assertNotIn('permissions', items['mine']['data'])
        self.role('owner')
        self.assertEqual(set(self.items()), {'mine', 'other', 'network', 'development', 'unknown', 'legacy'})

    def test_manager_cannot_modify_or_delete_known_development_foreign_network_ids(self):
        for identifier in ['other', 'network', 'development', 'unknown', 'legacy']:
            document = Document.objects.get(pk='tasks/' + identifier)
            original = dict(document.data)
            for method, value in [('patch', {'status': 'done', 'scope': 'operations', 'store': self.a.pk}),
                                  ('put', {'title': 'Overwrite', 'scope': 'operations', 'store': self.a.pk}),
                                  ('delete', None)]:
                with self.subTest(identifier=identifier, method=method):
                    result = self.write(method, '/api/docs/' + document.pk, value)
                    self.assertEqual(result.status_code, 403, result.content)
                    self.assertEqual(Document.objects.get(pk=document.pk).data, original)

    def test_manager_may_edit_own_operations_but_cannot_escape_scope(self):
        path = '/api/docs/tasks/mine'
        result = self.write('patch', path, {'status': 'doing'})
        self.assertEqual(result.status_code, 200, result.content)
        for value in [{'scope': 'development'}, {'store': self.b.pk}, {'store': None}, {'store': True}]:
            result = self.write('patch', path, value)
            self.assertEqual(result.status_code, 403, result.content)
            self.assertEqual(Document.objects.get(pk='tasks/mine').data['status'], 'doing')
        self.assertEqual(self.write('delete', path).status_code, 200)

    def test_manager_creates_only_operations_with_inferred_store(self):
        result = self.write('post', '/api/tasks', {'title': 'Нова', 'scope': 'operations', 'status': 'todo'})
        self.assertEqual(result.status_code, 200, result.content)
        document = Document.objects.get(pk='tasks/' + result.json()['id'])
        self.assertEqual(document.data['store'], self.a.pk)
        for value in [{'title': 'Bad'}, {'scope': 'development'}, {'scope': 'unknown'}, {'scope': []},
                      {'scope': 'operations', 'store': self.b.pk}, {'scope': 'operations', 'store': str(self.a.pk)}]:
            before = Document.objects.count()
            result = self.write('post', '/api/tasks', value)
            self.assertIn(result.status_code, {400, 403}, result.content)
            self.assertEqual(Document.objects.count(), before)

    def test_unscoped_manager_can_manage_network_operations_only(self):
        self.role('manager')
        self.assertEqual(set(self.items()), {'mine', 'other', 'network'})
        self.assertTrue(self.items()['network']['permissions']['canEdit'])
        self.assertEqual(self.write('patch', '/api/docs/tasks/network', {'status': 'done'}).status_code, 200)
        self.assertEqual(self.write('patch', '/api/docs/tasks/other', {'status': 'doing'}).status_code, 200)
        self.assertEqual(self.write('delete', '/api/docs/tasks/development').status_code, 403)

    def test_owner_preserves_legacy_development_and_rejects_malformed_fields(self):
        self.role('owner')
        result = self.write('patch', '/api/docs/tasks/legacy', {'status': 'doing'})
        self.assertEqual(result.status_code, 200, result.content)
        self.assertNotIn('scope', Document.objects.get(pk='tasks/legacy').data)
        self.assertEqual(self.write('delete', '/api/docs/tasks/development').status_code, 200)
        for value in [{'scope': []}, {'scope': 'mystery'}, {'status': []}, {'status': 'invisible'},
                      {'store': True}, {'store': 9999999999999999999999}, {'store': 999999},
                      {'_canEdit': True}, {'_canDelete': True}, {'permissions': {'canEdit': True}}]:
            result = self.write('patch', '/api/docs/tasks/mine', value)
            self.assertEqual(result.status_code, 400, result.content)

    def test_generated_alert_metadata_is_server_owned_and_resolution_still_works(self):
        Warehouse.objects.create(store=self.a, name='Склад A')
        Warehouse.objects.create(store=self.b, name='Склад B')
        product = Document.objects.create(path='products/alert-test', data={'name': 'Поповнення', 'minStock': 2})
        result = sync_alerts(self.user)
        self.assertEqual(result['created'], 1)
        alert = Document.objects.get(path__startswith='tasks/auto_')
        original = dict(alert.data)
        item = self.items()[alert.pk.split('/')[1]]
        self.assertEqual(item['permissions'], {'canEdit': True, 'canDelete': False})
        for role in ['manager', 'owner']:
            self.role(role, self.a if role == 'manager' else None)
            self.assertEqual(self.write('patch', '/api/docs/' + alert.pk, {'status': 'doing'}).status_code, 200)
            for value in [{'title': 'Faked'}, {'dueDate': '2020-01-01'}, {'_alertActive': False},
                          {'_alertKey': 'faked'}, {'createdAt': 'faked'}, {'order': -1}, {'store': self.b.pk}]:
                result = self.write('patch', '/api/docs/' + alert.pk, value)
                self.assertIn(result.status_code, {400, 403}, result.content)
            self.assertEqual(self.write('delete', '/api/docs/' + alert.pk).status_code, 400)
            self.assertNotEqual(self.write('put', '/api/docs/' + alert.pk, {'status': 'done'}).status_code, 200)
        alert.refresh_from_db()
        from server.erp.managed_alerts import WORK_FIELDS
        excluded={'status',*WORK_FIELDS}
        self.assertEqual({k:v for k,v in alert.data.items() if k not in excluded},
                         {k:v for k,v in original.items() if k not in excluded})
        self.assertEqual(alert.data['_alertWorkState'],'accepted')
        self.assertEqual(alert.data['_alertAcceptedBy'],'task-manager')
        product.data['minStock'] = 0
        product.save(update_fields=['data'])
        self.assertEqual(sync_alerts(self.user)['resolved'], 1)
        alert.refresh_from_db()
        self.assertEqual(alert.data['status'], 'done')
        self.assertFalse(alert.data['_alertActive'])

    def test_manual_task_cannot_forge_alert_identity_and_readonly_roles_cannot_write(self):
        for role in ['manager', 'owner']:
            self.role(role, self.a if role == 'manager' else None)
            for value in [{'_alertActive': False}, {'_alertKey': 'forged'}, {'_alertFuture': 'forged'}]:
                self.assertEqual(self.write('patch', '/api/docs/tasks/mine', value).status_code, 400)
            self.assertEqual(self.write('put', '/api/docs/tasks/auto_forged', {
                'title': 'Fake', 'scope': 'operations', 'store': self.a.pk}).status_code, 400)
        for role in ['cashier', 'accountant', 'warehouse']:
            self.role(role, self.a)
            for method, value in [('patch', {'status': 'done'}), ('delete', None)]:
                self.assertEqual(self.write(method, '/api/docs/tasks/mine', value).status_code, 403)

    def test_settings_allowlist_and_development_privacy_without_read_mutation(self):
        original = {
            'tag': {'custom': 'Публічний напис', 'styles': {'price': {'size': 30}}},
            'chainName': 'Мережа', 'storeNames': ['A', 'B'], 'staleDays': 30,
            'defaultMarkup': 20, 'rounding': .5, 'stores': 7, 'budgetStores': 4,
            'gsId': 'synthetic-sheet-id', 'gsUrl': 'https://example.invalid/sheet',
            'gsTitle': 'Приватна таблиця', 'gsSheetName': 'Товари', 'gsFuture': 'private',
            'futurePrivate': {'note': 'Приватне налаштування'},
        }
        document = Document.objects.create(path='settings/main', data=original)
        project = Document.objects.create(path='project/state', data={'stage': 3, 'privatePlan': 'План власника'})
        public = {'tag', 'chainName', 'storeNames', 'staleDays'}
        for role in ['cashier', 'manager', 'warehouse', 'accountant']:
            with self.subTest(role=role):
                self.role(role, self.a)
                result = self.client.get('/api/state')
                self.assertEqual(result.status_code, 200)
                state = result.json()
                expected = public | ({'defaultMarkup', 'rounding'} if role != 'cashier' else set())
                self.assertEqual(set(state['data']['settings/main']), expected)
                self.assertEqual(state['data']['project/state'], {})
                self.assertEqual(state['labelRevision'], label_revision(original))
                workspace = self.client.get('/api/v1/labels/workspace').json()
                self.assertEqual(workspace['config'], original['tag'])
                self.assertFalse(workspace['canEdit'])
                self.assertEqual(workspace['revision'], state['labelRevision'])
                document.refresh_from_db()
                project.refresh_from_db()
                self.assertEqual(document.data, original)
                self.assertEqual(project.data, {'stage': 3, 'privatePlan': 'План власника'})
        # Mutating a returned DTO must never mutate its nested source settings.
        dto = settings_for_role(original, 'manager')
        dto['tag']['styles']['price']['size'] = 99
        dto['storeNames'].append('C')
        self.assertEqual(original['tag']['styles']['price']['size'], 30)
        self.assertEqual(original['storeNames'], ['A', 'B'])
        self.role('owner')
        state = self.client.get('/api/state').json()['data']
        self.assertEqual(state['settings/main'], original)
        self.assertEqual(state['project/state'], project.data)
        self.assertTrue(self.client.get('/api/v1/labels/workspace').json()['canEdit'])

    def test_cashier_public_regular_price_uses_private_server_defaults(self):
        Document.objects.create(path='settings/main', data={
            'defaultMarkup': 37, 'rounding': .5, 'budgetStores': 7, 'chainName': 'Мережа',
        })
        product = Document.objects.create(path='products/public-price', data={
            'name': 'Ціна без приватних defaults', 'cost': 10, 'manualPrice': False,
        })
        self.role('cashier', self.a)
        result = self.client.get('/api/state')
        self.assertEqual(result.status_code, 200)
        state = result.json()['data']
        self.assertEqual(state['settings/main'], {'chainName': 'Мережа'})
        row = next(row['data'] for row in state['products'] if row['id'] == 'public-price')
        self.assertEqual(row['regularPrice'], 14)
        self.assertEqual(row['price'], 14)
        self.assertTrue(row['manualPrice'])
        self.assertNotIn('cost', row)
        self.assertNotIn('markup', row)
        product.refresh_from_db()
        self.assertEqual(product.data, {'name': 'Ціна без приватних defaults', 'cost': 10, 'manualPrice': False})
