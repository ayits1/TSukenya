import hashlib
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier
from unittest.mock import patch

from django.contrib.auth.models import User
from django.db import close_old_connections, connection, connections
from django.test import Client, TransactionTestCase

from server.erp.catalog import revision
from server.erp.models import AuditEvent, Document, LedgerLock, PortalSession, Profile
from server.erp.services import BusinessError


class RecipeEndpointTests(TransactionTestCase):
    endpoint = '/api/erp/recipes'

    def setUp(self):
        LedgerLock.objects.create(pk=1)
        Document.objects.create(path='settings/main', data={'defaultMarkup': 30, 'rounding': .5})
        self.ingredient = Document.objects.create(path='products/flour', data={'name': 'Борошно', 'unit': 'кг'})
        self.other = Document.objects.create(path='products/milk', data={'name': 'Молоко', 'unit': 'л'})
        self.product = Document.objects.create(path='products/cake', data={
            'name': 'Кекс', 'unit': 'шт', 'cost': 10, 'markup': 30,
            'barcode': 'recipe-test-cake', 'minStock': 2,
            'recipe': [{'product': 'flour', 'quantity': '0.250'}],
        })
        self.original = deepcopy(self.product.data)
        self.user, self.client, self.headers = self.editor('recipe-owner', 'owner')

    def editor(self, username, role):
        user = User.objects.create(username=username)
        Profile.objects.create(user=user, role=role)
        token, csrf = username + '-session', username + '-csrf'
        PortalSession.objects.create(user=user, token_hash=hashlib.sha256(token.encode()).hexdigest(),
                                     csrf=csrf, expires=int(time.time()) + 3600)
        client = Client()
        client.cookies['ts_session'] = token
        headers = {'HTTP_ORIGIN': 'http://testserver', 'HTTP_X_CSRF_TOKEN': csrf}
        return user, client, headers

    def read(self, client=None, product='cake'):
        return (client or self.client).get(self.endpoint, {'product': product})

    def save_recipe(self, recipe, version=None, client=None, headers=None, product='cake'):
        return (client or self.client).post(self.endpoint, {
            'product': product, 'recipe': recipe,
            'revision': version if version is not None else self.read().json()['revision'],
        }, content_type='application/json', **(headers if headers is not None else self.headers))

    def assert_unchanged(self):
        self.product.refresh_from_db()
        self.assertEqual(self.product.data, self.original)
        self.assertFalse(AuditEvent.objects.exists())

    def test_get_returns_current_recipe_metadata_and_catalogue_revision(self):
        response = self.read()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            'product': {'id': 'cake', 'name': 'Кекс', 'unit': 'шт'},
            'recipe': self.original['recipe'], 'revision': revision(self.product), 'canEdit': True,
        })
        catalogue = self.client.get('/api/state').json()['data']['products']
        self.assertEqual(next(row['revision'] for row in catalogue if row['id'] == 'cake'), response.json()['revision'])
        self.product.data.update(name='Новий кекс', unit='порція', recipe=[{'product': 'milk', 'quantity': '0.125'}])
        self.product.save(update_fields=['data'])
        refreshed = self.read().json()
        self.assertEqual(refreshed['product'], {'id': 'cake', 'name': 'Новий кекс', 'unit': 'порція'})
        self.assertEqual(refreshed['recipe'], self.product.data['recipe'])
        self.assertNotEqual(refreshed['revision'], response.json()['revision'])
        self.assertFalse(AuditEvent.objects.exists())

    def test_get_missing_product_is_explicit_404(self):
        for product in ('missing', ''):
            with self.subTest(product=product):
                response = self.read(product=product)
                self.assertEqual(response.status_code, 404)
                self.assertIn('Готовий товар', response.json()['error'])
        self.assertEqual(self.client.get(self.endpoint).status_code, 404)
        self.assert_unchanged()

    def test_two_editors_stale_save_preserves_first_recipe_and_audit(self):
        second_user, second_client, second_headers = self.editor('recipe-manager', 'manager')
        first_version = self.read().json()['revision']
        second_version = self.read(client=second_client).json()['revision']
        first_recipe = [{'product': 'flour', 'quantity': '0.500'}, {'product': 'milk', 'quantity': '0.100'}]
        first = self.save_recipe(first_recipe, first_version)
        self.assertEqual(first.status_code, 200)
        self.product.refresh_from_db()
        self.assertEqual(first.json(), {'ok': True, 'product': 'cake', 'revision': revision(self.product)})
        self.assertNotEqual(first.json()['revision'], first_version)
        stale = self.save_recipe([{'product': 'milk', 'quantity': '0.300'}], second_version,
                                 client=second_client, headers=second_headers)
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()['code'], 'revision_conflict')
        self.product.refresh_from_db()
        self.assertEqual(self.product.data, {**self.original, 'recipe': first_recipe})
        event = AuditEvent.objects.get()
        self.assertEqual((event.user_id, event.action, event.subject), (self.user.pk, 'recipe_saved', self.product.pk))
        self.assertEqual(event.detail, {'recipe': first_recipe, 'request_id': first['X-Request-ID']})
        self.assertEqual(str(uuid.UUID(event.detail['request_id'])), first['X-Request-ID'])
        fresh = self.read(client=second_client).json()
        self.assertEqual(fresh['recipe'], first_recipe)
        retry = self.save_recipe([{'product': 'milk', 'quantity': '0.300'}], fresh['revision'],
                                 client=second_client, headers=second_headers)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(AuditEvent.objects.filter(user=second_user, action='recipe_saved').count(), 1)

    def test_missing_empty_or_nonstring_revision_cannot_clear_recipe(self):
        for payload in ({'product': 'cake', 'recipe': []},
                        *({'product': 'cake', 'recipe': [], 'revision': value} for value in ('', None, 1, [], {}))):
            with self.subTest(payload=payload):
                response = self.client.post(self.endpoint, payload, content_type='application/json', **self.headers)
                self.assertEqual(response.status_code, 400)
                self.assert_unchanged()

    def test_changes_to_other_product_fields_or_pricing_settings_conflict(self):
        for change in ('product', 'settings'):
            with self.subTest(change=change):
                version = self.read().json()['revision']
                if change == 'product':
                    self.product.data['name'] = 'Оновлений кекс'
                    self.product.save(update_fields=['data'])
                else:
                    Document.objects.filter(pk='settings/main').update(data={'defaultMarkup': 40, 'rounding': 1})
                expected = deepcopy(self.product.data)
                response = self.save_recipe([], version)
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()['code'], 'revision_conflict')
                self.product.refresh_from_db()
                self.assertEqual(self.product.data, expected)
                self.assertFalse(AuditEvent.objects.exists())

    def test_older_discount_above_regular_price_does_not_block_recipe(self):
        # A later default markup drop left this discount at or above the regular price.
        self.product.data.update(promotion=True, promotionPrice=12.5)
        self.product.data.pop('markup')
        self.product.save(update_fields=['data'])
        Document.objects.filter(pk='settings/main').update(data={'defaultMarkup': 20, 'rounding': .5})
        response = self.save_recipe([{'product': 'milk', 'quantity': '1'}])
        self.assertEqual(response.status_code, 200)
        self.product.refresh_from_db()
        self.assertEqual(self.product.data['recipe'], [{'product': 'milk', 'quantity': '1'}])
        self.assertEqual(self.product.data['promotionPrice'], 12.5)

    def test_invalid_quantities_fail_atomically(self):
        for quantity in ('0', '-1', '0.0001', '0.0011', '1.2345', 'NaN', 'Infinity', 'abc', None):
            with self.subTest(quantity=quantity):
                response = self.save_recipe([{'product': 'flour', 'quantity': '0.001'},
                                             {'product': 'milk', 'quantity': quantity}])
                self.assertEqual(response.status_code, 400)
                self.assert_unchanged()

    def test_minimum_quantity_and_three_decimal_places_are_accepted(self):
        recipe = [{'product': 'flour', 'quantity': '0.001'}, {'product': 'milk', 'quantity': '1.234'}]
        self.assertEqual(self.save_recipe(recipe).status_code, 200)
        self.product.refresh_from_db()
        self.assertEqual(self.product.data['recipe'], recipe)

    def test_self_duplicate_and_missing_ingredient_fail_atomically(self):
        for invalid_row in ({'product': 'cake', 'quantity': '1'},
                            {'product': 'flour', 'quantity': '1'},
                            {'product': 'missing', 'quantity': '1'}):
            with self.subTest(row=invalid_row):
                response = self.save_recipe([{'product': 'flour', 'quantity': '0.250'}, invalid_row])
                self.assertEqual(response.status_code, 400)
                self.assert_unchanged()

    def test_invalid_recipe_shapes_and_row_limit_rejected(self):
        for recipe in (None, {}, 'recipe', [None], [{}], [{'product': 'flour', 'quantity': '1'}] * 101):
            with self.subTest(recipe=recipe):
                self.assertEqual(self.save_recipe(recipe).status_code, 400)
                self.assert_unchanged()

    def test_empty_recipe_clears_existing_recipe_and_audits(self):
        version = self.read().json()['revision']
        response = self.save_recipe([], version)
        self.assertEqual(response.status_code, 200)
        self.product.refresh_from_db()
        self.assertEqual(self.product.data, {**self.original, 'recipe': []})
        self.assertEqual(response.json()['revision'], revision(self.product))
        self.assertNotEqual(response.json()['revision'], version)
        self.assertEqual(AuditEvent.objects.get().detail, {'recipe': [], 'request_id': response['X-Request-ID']})
        self.assertEqual(str(uuid.UUID(response['X-Request-ID'])), response['X-Request-ID'])

    def test_roles_allow_only_owner_manager_and_warehouse(self):
        for role in ('cashier', 'accountant', 'owner', 'manager', 'warehouse'):
            with self.subTest(role=role):
                self.user.profile.role = role
                self.user.profile.save(update_fields=['role'])
                allowed = role in {'owner', 'manager', 'warehouse'}
                response = self.read()
                self.assertEqual(response.status_code, 200 if allowed else 403)
                version = revision(self.product)
                self.assertEqual(self.save_recipe(self.original['recipe'], version).status_code, 200 if allowed else 403)
        self.assertEqual(AuditEvent.objects.count(), 3)

    def test_csrf_and_session_required_for_writes(self):
        for headers in ({}, {'HTTP_ORIGIN': 'http://testserver'},
                        {**self.headers, 'HTTP_X_CSRF_TOKEN': 'wrong'},
                        {**self.headers, 'HTTP_ORIGIN': 'https://example.invalid'}):
            with self.subTest(headers=headers):
                self.assertEqual(self.save_recipe([], headers=headers).status_code, 403)
                self.assert_unchanged()
        self.client.cookies.clear()
        self.assertEqual(self.read().status_code, 401)
        self.assertEqual(self.save_recipe([], version=revision(self.product)).status_code, 401)
        self.assert_unchanged()

    def test_audit_failure_rolls_back_recipe_write(self):
        with patch('server.erp.views.audit', side_effect=BusinessError('Помилка тестового журналу.')):
            self.assertEqual(self.save_recipe([]).status_code, 400)
        self.assert_unchanged()

    def test_missing_finished_product_does_not_write_or_audit(self):
        response = self.save_recipe([], version=revision(self.product), product='missing')
        self.assertEqual(response.status_code, 400)
        self.assert_unchanged()


class RecipeConcurrencyTests(TransactionTestCase):
    endpoint = RecipeEndpointTests.endpoint
    editor = RecipeEndpointTests.editor

    def setUp(self):
        if connection.vendor != 'postgresql':
            self.skipTest('Requires PostgreSQL row locks.')
        RecipeEndpointTests.setUp(self)

    def test_parallel_editors_accept_one_revision_and_audit_only_winner(self):
        second_user, second_client, second_headers = self.editor('recipe-second-editor', 'manager')
        snapshots = [client.get(self.endpoint, {'product': 'cake'}).json()
                     for client in (self.client, second_client)]
        self.assertEqual(snapshots[0]['revision'], snapshots[1]['revision'])
        edits = [
            (self.user.pk, self.client.cookies['ts_session'].value, self.headers, '0.500'),
            (second_user.pk, second_client.cookies['ts_session'].value, second_headers, '0.750'),
        ]
        barrier = Barrier(2)
        from server.erp.views import ledger_lock

        def competing_lock():
            # Both HTTP requests enter their transactions before competing for the real row lock.
            barrier.wait(timeout=10)
            return ledger_lock()

        def save(edit):
            user_id, token, headers, quantity = edit
            close_old_connections()
            try:
                client = Client()
                client.cookies['ts_session'] = token
                recipe = [{'product': 'flour', 'quantity': quantity}]
                response = client.post(self.endpoint, {
                    'product': 'cake', 'recipe': recipe, 'revision': snapshots[0]['revision'],
                }, content_type='application/json', **headers)
                return {'user': user_id, 'recipe': recipe, 'status': response.status_code, 'body': response.json(), 'request_id': response['X-Request-ID']}
            finally:
                connections.close_all()

        with patch('server.erp.views.ledger_lock', side_effect=competing_lock):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(save, edits))

        self.assertCountEqual([result['status'] for result in results], [200, 409])
        winner = next(result for result in results if result['status'] == 200)
        loser = next(result for result in results if result['status'] == 409)
        self.assertEqual(loser['body']['code'], 'revision_conflict')
        self.product.refresh_from_db()
        self.assertEqual(self.product.data, {**self.original, 'recipe': winner['recipe']})
        self.assertEqual(winner['body'], {'ok': True, 'product': 'cake', 'revision': revision(self.product)})
        self.assertNotEqual(winner['body']['revision'], snapshots[0]['revision'])
        event = AuditEvent.objects.get()
        self.assertEqual((event.user_id, event.action, event.subject),
                         (winner['user'], 'recipe_saved', self.product.pk))
        self.assertEqual(event.detail, {'recipe': winner['recipe'], 'request_id': winner['request_id']})
        self.assertEqual(str(uuid.UUID(event.detail['request_id'])), winner['request_id'])
        self.assertNotEqual(winner['request_id'], loser['request_id'])
