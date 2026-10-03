import copy
import hashlib
import time

from django.contrib.auth.models import User
from django.test import TestCase

from server.erp.budget import budget_count, freeze_budget
from server.erp.labels import revision
from server.erp.models import Document, LedgerLock, PortalSession, Profile, Store
from tests.test_labels import config


class BudgetTests(TestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.user = User.objects.create(username='budget-owner')
        Profile.objects.create(user=self.user, role='owner')
        token = 'isolated-budget-token'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),
            user=self.user, csrf='budget-csrf', expires=int(time.time()) + 3600)
        self.client.cookies['ts_session'] = token
        self.headers = {'HTTP_ORIGIN': 'http://testserver', 'HTTP_X_CSRF_TOKEN': 'budget-csrf'}

    def write(self, method, path, value):
        return getattr(self.client, method)(path, value, content_type='application/json', **self.headers)

    def settings(self, **patch):
        data = {'stores': 7, 'storeNames': ['Цінник A'], 'chainName': 'Мережа',
                'staleDays': 30, 'tag': config(), 'defaultMarkup': 30, **patch}
        return Document.objects.create(path='settings/main', data=data)

    def test_count_precedence_bounds_and_no_read_migration(self):
        cases = [({}, 1), ({'budgetStores': 4, 'stores': 7, 'storeNames': ['A']}, 4),
                 ({'budgetStores': True, 'stores': 7}, 7), ({'stores': ['A', 'B']}, 2),
                 ({'stores': [], 'storeNames': ['A', 'B', 'C']}, 3),
                 ({'stores': 0, 'storeNames': ['A']}, 1), ({'stores': 2.0, 'storeNames': ['A']}, 1),
                 ({'budgetStores': 1001, 'stores': 1000}, 1000),
                 ({'stores': ['A'] * 1001, 'storeNames': ['A', 'B']}, 2)]
        for data, expected in cases:
            with self.subTest(data=data if len(str(data)) < 100 else 'large-list'):
                original = copy.deepcopy(data)
                self.assertEqual(budget_count(data), expected)
                self.assertEqual(data, original)
                self.assertEqual(freeze_budget(data)['budgetStores'], expected)
        document = self.settings()
        self.client.get('/api/state')
        self.client.get('/api/v1/labels/workspace')
        document.refresh_from_db()
        self.assertNotIn('budgetStores', document.data)

    def test_expense_validation_merged_patch_and_owner_access(self):
        created = self.write('post', '/api/expenses', {'name': ' Оренда ', 'group': 'fixed', 'amount': 10.07})
        self.assertEqual(created.status_code, 200, created.content)
        identifier = created.json()['id']
        path = 'expenses/' + identifier
        self.assertEqual(Document.objects.get(pk=path).data['name'], 'Оренда')
        patched = self.write('patch', '/api/docs/' + path, {'amount': 12.09})
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(Document.objects.get(pk=path).data, {'name': 'Оренда', 'group': 'fixed', 'amount': 12.09})
        original = Document.objects.get(pk=path).data
        for value in [{'amount': -1}, {'amount': .001}, {'amount': 1.234}, {'amount': True}, {'amount': '12.09'},
                      {'amount': float('inf')}, {'amount': float('nan')}, {'amount': 100000000},
                      {'name': ' '}, {'name': 'x' * 251}, {'group': 'other'}, {'group': []}]:
            with self.subTest(value=value):
                result = self.write('patch', '/api/docs/' + path, value)
                self.assertEqual(result.status_code, 400, result.content)
                self.assertEqual(Document.objects.get(pk=path).data, original)
        for role in ['manager', 'accountant', 'cashier', 'warehouse']:
            self.user.profile.role = role
            self.user.profile.save(update_fields=['role'])
            self.assertEqual(self.write('patch', '/api/docs/' + path, {'amount': 20}).status_code, 403)

    def test_budget_patch_strict_integer_preserves_erp_and_label_identity(self):
        store = Store.objects.create(name='ERP A')
        document = self.settings()
        old_revision = revision(document.data)
        result = self.write('patch', '/api/docs/settings/main', {'budgetStores': 3})
        self.assertEqual(result.status_code, 200, result.content)
        document.refresh_from_db()
        self.assertEqual(document.data['budgetStores'], 3)
        self.assertEqual(document.data['stores'], 7)
        self.assertEqual(document.data['storeNames'], ['Цінник A'])
        self.assertEqual(revision(document.data), old_revision)
        self.assertEqual(Store.objects.get(pk=store.pk).name, 'ERP A')
        for value in [True, 0, -1, 1.5, '3', 1001]:
            self.assertEqual(self.write('patch', '/api/docs/settings/main', {'budgetStores': value}).status_code, 400)
            document.refresh_from_db()
            self.assertEqual(document.data['budgetStores'], 3)
        self.user.profile.role = 'manager'
        self.user.profile.save(update_fields=['role'])
        self.assertEqual(self.write('patch', '/api/docs/settings/main', {'budgetStores': 2}).status_code, 403)

    def test_expense_maximum_exact_cent_boundary(self):
        created = self.write('post', '/api/expenses', {
            'name': 'Максимальна сума', 'group': 'fixed', 'amount': 99999999.99,
        })
        self.assertEqual(created.status_code, 200, created.content)
        path = 'expenses/' + created.json()['id']
        self.assertEqual(Document.objects.get(pk=path).data['amount'], 99999999.99)
        rejected = self.write('patch', '/api/docs/' + path, {'amount': 100000000})
        self.assertEqual(rejected.status_code, 400, rejected.content)
        self.assertEqual(Document.objects.get(pk=path).data['amount'], 99999999.99)

    def test_label_save_freezes_old_budget_and_never_overwrites_legacy_stores(self):
        for legacy in [7, ['ERP A', 'ERP B']]:
            with self.subTest(legacy=legacy):
                Document.objects.filter(pk='settings/main').delete()
                document = self.settings(stores=legacy)
                expected = budget_count(document.data)
                payload = {'revision': revision(document.data), 'config': config(), 'settings': {
                    'chainName': 'Нова мережа', 'storeNames': ['Новий A', 'Новий B', 'Новий C'], 'staleDays': 30,
                }}
                result = self.write('patch', '/api/v1/labels/workspace', payload)
                self.assertEqual(result.status_code, 200, result.content)
                document.refresh_from_db()
                self.assertEqual(document.data['stores'], legacy)
                self.assertEqual(document.data['budgetStores'], expected)
                self.assertEqual(document.data['storeNames'], payload['settings']['storeNames'])
        document.data['budgetStores'] = 9
        document.save(update_fields=['data'])
        payload['revision'] = revision(document.data)
        payload['settings']['storeNames'] = ['Один']
        self.assertEqual(self.write('patch', '/api/v1/labels/workspace', payload).status_code, 200)
        self.assertEqual(Document.objects.get(pk='settings/main').data['budgetStores'], 9)

    def test_erp_store_changes_preserve_budget_type_and_label_revision(self):
        existing = Store.objects.create(name='ERP A')
        for legacy in [7, ['ERP A']]:
            with self.subTest(legacy=legacy):
                Store.objects.exclude(pk=existing.pk).delete()
                existing.active = True
                existing.save(update_fields=['active'])
                Document.objects.filter(pk='settings/main').delete()
                document = self.settings(stores=legacy)
                old_revision = revision(document.data)
                old_count = budget_count(document.data)
                created = self.write('post', '/api/erp/entities/stores', {'name': 'ERP B', 'active': True})
                self.assertEqual(created.status_code, 200, created.content)
                document.refresh_from_db()
                self.assertEqual(document.data['budgetStores'], old_count)
                self.assertEqual(revision(document.data), old_revision)
                self.assertEqual(document.data['storeNames'], ['Цінник A'])
                self.assertEqual(document.data['stores'], ['ERP A', 'ERP B'] if isinstance(legacy, list) else 7)
                deactivated = self.write('post', '/api/erp/entities/stores', {'id': existing.pk, 'name': 'ERP A', 'active': False})
                self.assertEqual(deactivated.status_code, 200, deactivated.content)
                document.refresh_from_db()
                self.assertEqual(document.data['budgetStores'], old_count)
                self.assertEqual(document.data['stores'], ['ERP B'] if isinstance(legacy, list) else 7)
                self.assertEqual(revision(document.data), old_revision)

    def test_erp_store_creation_does_not_create_missing_settings(self):
        self.assertEqual(self.write('post', '/api/erp/entities/stores', {'name': 'ERP A'}).status_code, 200)
        self.assertFalse(Document.objects.filter(pk='settings/main').exists())

    def test_legacy_label_identity_patch_freezes_before_replacing_names(self):
        document = self.settings()
        document.data.pop('stores')
        document.data['storeNames'] = ['Старий A', 'Старий B']
        document.save(update_fields=['data'])
        result = self.write('patch', '/api/docs/settings/main', {'storeNames': ['Новий A']})
        self.assertEqual(result.status_code, 200, result.content)
        document.refresh_from_db()
        self.assertEqual(document.data['budgetStores'], 2)
        self.assertEqual(document.data['storeNames'], ['Новий A'])
        self.assertNotIn('stores', document.data)
