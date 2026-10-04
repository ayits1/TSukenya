import hashlib
import time
from io import StringIO
from django.core.management import call_command
from django.contrib.auth.models import User
from django.test import TransactionTestCase
from server.erp.models import Document, Profile, PortalSession, LedgerLock, AuditEvent


class CatalogReferenceTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create(username='reference-owner')
        Profile.objects.create(user=self.user, role='owner')
        LedgerLock.objects.create(pk=1)
        token = 'isolated-reference-token'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), user=self.user, csrf='references-csrf', expires=int(time.time()) + 3600)
        self.client.cookies['ts_session'] = token
        self.headers = {'HTTP_ORIGIN': 'http://testserver', 'HTTP_X_CSRF_TOKEN': 'references-csrf'}
        Document.objects.create(path='products/coffee', data={'name': 'Кава', 'type': 'Напої', 'category': 'Кава', 'pack': 'Пакет', 'size': '250 г', 'unit': 'шт'})
        Document.objects.create(path='products/orphan', data={'name': 'Історичний', 'category': 'Без групи'})

    def references(self):
        return self.client.get('/api/v1/catalog/references').json()['items']

    def create(self, field, value, **kwargs):
        return self.client.post('/api/v1/catalog/references', {'field': field, 'value': value, **kwargs}, content_type='application/json', **self.headers)

    def patch(self, identifier, **kwargs):
        detail = self.client.get('/api/v1/catalog/products/' + identifier).json()
        return self.client.patch('/api/v1/catalog/products/' + identifier, {'revision': detail['revision'], **kwargs}, content_type='application/json', **self.headers)

    def test_existing_product_choices_and_default_unit_have_stable_ids(self):
        first = self.references()
        self.assertEqual(first, self.references())
        for field, value in [('type', 'Напої'), ('category', 'Кава'), ('pack', 'Пакет'), ('size', '250 г'), ('unit', 'шт')]:
            item = next(item for item in first if item['field'] == field and item['value'] == value)
            self.assertEqual(item['parentType'], 'Напої' if field == 'category' else '')
        orphan = next(item for item in first if item['value'] == 'Без групи')
        self.assertEqual(orphan['parentType'], '')
        self.assertFalse(Document.objects.filter(path__startswith='catalog_refs/').exists())
        Document.objects.filter(path__startswith='products/').delete()
        self.assertEqual([(item['field'], item['value']) for item in self.references()], [('unit', 'шт')])

    def test_new_choice_normalizes_and_retries_are_idempotent(self):
        first = self.create('pack', '  Скляна   банка  ')
        self.assertEqual(first.status_code, 201)
        self.assertEqual(first.json()['value'], 'Скляна банка')
        second = self.create('pack', 'скляна БАНКА')
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json(), second.json())
        self.assertEqual(Document.objects.filter(path__startswith='catalog_refs/').count(), 1)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_reference_created').count(), 1)
        Document.objects.filter(path__startswith='products/').delete()
        self.assertIn(first.json(), self.references())

    def test_post_existing_product_value_pins_choice_after_product_deletion(self):
        source = next(item for item in self.references() if item['field'] == 'pack')
        created = self.create('pack', '  ПАКЕТ ')
        self.assertEqual(created.status_code, 200)
        self.assertEqual(created.json(), source)
        Document.objects.filter(path__startswith='products/').delete()
        self.assertIn(source, self.references())

    def test_categories_require_group_and_same_name_can_exist_in_other_group(self):
        self.assertEqual(self.create('category', 'Чай').status_code, 400)
        self.assertEqual(self.create('category', 'Чай', parentType='Вигадана').status_code, 400)
        first = self.create('category', 'Чай', parentType=' напої ')
        self.assertEqual(first.status_code, 201)
        self.assertEqual(first.json()['parentType'], 'Напої')
        self.assertEqual(self.create('category', ' чай ', parentType='НАПОЇ').json()['id'], first.json()['id'])
        self.assertEqual(self.create('type', 'Подарунки').status_code, 201)
        second = self.create('category', 'Чай', parentType='Подарунки')
        self.assertEqual(second.status_code, 201)
        self.assertNotEqual(first.json()['id'], second.json()['id'])
        self.assertEqual(self.create('pack', 'Банка', parentType='Напої').status_code, 400)

    def test_added_category_keeps_legacy_parent_after_last_source_product_is_deleted(self):
        category = self.create('category', 'Чай', parentType='Напої').json()
        Document.objects.filter(path__startswith='products/').delete()
        choices = self.references()
        self.assertIn(category, choices)
        self.assertIn('Напої', [item['value'] for item in choices if item['field'] == 'type'])
        self.assertEqual(self.create('category', 'ЧАЙ', parentType='напої').json(), category)

    def test_malformed_choices_do_not_write_or_audit(self):
        for field, value, kwargs in [('unknown', 'x', {}), ([], 'x', {}), ('type', '', {}), ('type', ' '*3, {}), ('unit', 'x'*31, {}), ('type', 'x'*161, {}), ('pack', 123, {}), ('category', 'x', {'parentType': []}), ('pack', 'x', {'extra': True})]:
            self.assertEqual(self.create(field, value, **kwargs).status_code, 400)
        self.assertEqual(Document.objects.filter(path__startswith='catalog_refs/').count(), 0)
        self.assertEqual(AuditEvent.objects.count(), 0)

    def test_roles_csrf_and_auth_are_enforced(self):
        for role in ['owner', 'manager', 'warehouse']:
            self.user.profile.role = role; self.user.profile.save()
            self.assertTrue(self.client.get('/api/v1/catalog/references').json()['canEdit'])
            self.assertEqual(self.create('size', role).status_code, 201)
        self.user.profile.role = 'cashier'; self.user.profile.save()
        self.assertFalse(self.client.get('/api/v1/catalog/references').json()['canEdit'])
        self.assertEqual(self.create('size', 'secret').status_code, 403)
        self.user.profile.role = 'owner'; self.user.profile.save()
        self.assertEqual(self.client.post('/api/v1/catalog/references', {'field': 'size', 'value': 'x'}, content_type='application/json').status_code, 403)
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/v1/catalog/references').status_code, 401)

    def test_v1_saves_require_choices_and_preserve_unchanged_orphan(self):
        self.assertEqual(self.patch('coffee', pack='Unknown').status_code, 400)
        self.assertEqual(self.patch('coffee', category='Без групи').status_code, 400)
        self.assertEqual(self.patch('coffee', type='').status_code, 400)
        self.assertEqual(self.patch('orphan', name='Оновлена назва', category='Без групи', type='').status_code, 200)
        self.assertEqual(self.create('type', 'Подарунки').status_code, 201)
        self.assertEqual(self.patch('coffee', type='Подарунки').status_code, 400)
        self.assertEqual(self.patch('coffee', type='подарунки', category='').status_code, 200)
        self.assertEqual(Document.objects.get(pk='products/coffee').data['type'], 'Подарунки')
        self.create('category', 'Новий набір', parentType='Подарунки')
        saved = self.patch('coffee', category='новий   набір')
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()['category'], 'Новий набір')

    def test_product_create_uses_standalone_choices_and_legacy_import_stays_compatible(self):
        self.create('type', 'Нові товари')
        self.create('category', 'Нова категорія', parentType='Нові товари')
        self.create('unit', 'кг')
        valid = self.client.post('/api/v1/catalog/products', {'name': 'Товар', 'type': 'Нові товари', 'category': 'Нова категорія', 'unit': 'кг'}, content_type='application/json', **self.headers)
        self.assertEqual(valid.status_code, 201)
        invalid = self.client.post('/api/v1/catalog/products', {'name': 'Товар', 'size': 'Ручне значення'}, content_type='application/json', **self.headers)
        self.assertEqual(invalid.status_code, 400)
        version = self.client.get('/api/v1/catalog/products/coffee').json()['revision']
        legacy = self.client.patch('/api/docs/products/coffee', {'pack': 'Імпортоване пакування', 'size': '500 г'}, content_type='application/json', HTTP_IF_MATCH=version, **self.headers)
        self.assertEqual(legacy.status_code, 200)
        self.assertIn('Імпортоване пакування', [item['value'] for item in self.references()])

    def test_deleting_product_does_not_delete_added_dictionary_entries(self):
        choice = self.create('type', 'Напої').json()
        detail = self.client.get('/api/v1/catalog/products/coffee').json()
        deleted = self.client.delete('/api/v1/catalog/products/coffee', {'revision': detail['revision']}, content_type='application/json', **self.headers)
        self.assertEqual(deleted.status_code, 200)
        self.assertIn(choice, self.references())

    def test_seed_command_pins_all_existing_values_is_idempotent_and_preserves_products(self):
        products = list(Document.objects.filter(path__startswith='products/').order_by('path').values('path', 'data'))
        before = self.references()
        first_output = StringIO()
        call_command('seed_catalog_references', stdout=first_output)
        self.assertEqual(first_output.getvalue(), str(len(before)) + '\n')
        self.assertEqual(self.references(), before)
        self.assertEqual(list(Document.objects.filter(path__startswith='products/').order_by('path').values('path', 'data')), products)
        second_output = StringIO()
        call_command('seed_catalog_references', stdout=second_output)
        self.assertEqual(second_output.getvalue(), '0\n')
        self.assertEqual(Document.objects.filter(path__startswith='catalog_refs/').count(), len(before))
        Document.objects.filter(path__startswith='products/').delete()
        self.assertEqual(self.references(), before)

    def test_seed_command_retains_existing_canonical_entries_and_pins_later_imports(self):
        canonical = self.create('pack', 'пакет').json()
        original = Document.objects.get(pk='catalog_refs/' + canonical['id']).data.copy()
        call_command('seed_catalog_references', stdout=StringIO())
        self.assertEqual(Document.objects.get(pk='catalog_refs/' + canonical['id']).data, original)
        Document.objects.create(path='products/import', data={'name': 'Імпорт', 'pack': 'Нове пакування'})
        output = StringIO()
        call_command('seed_catalog_references', stdout=output)
        self.assertEqual(output.getvalue(), '1\n')
        Document.objects.filter(path__startswith='products/').delete()
        self.assertIn('Нове пакування', [item['value'] for item in self.references() if item['field'] == 'pack'])
