"""Actual recipe reload policy/identity reads preserve immutable approval receipts."""
import threading
import uuid
from contextlib import contextmanager
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext

from server.erp import recipe_drafts
from server.erp.catalog import revision
from server.erp.historical_reports import read_snapshot
from server.erp.models import AuditEvent, Document, Profile, RecipeVersion, Store, User
from server.erp.services import BusinessError, Conflict
from tests import test_recipe_recovery


class RecipeDraftTests(TransactionTestCase):
    def setUp(self):
        test_recipe_recovery.RecipeRecoveryTests.setUp(self)

    def payload(self, **extra):
        return {'idempotencyKey': str(uuid.uuid4()), 'product': 'output', 'expectedVersion': None,
                'catalogRevision': revision(self.output), 'outputQuantity': '1.000',
                'components': [{'product': 'raw', 'quantity': '2.000'}], 'expiryPolicy': 'unspecified',
                'shelfLifeDays': None, 'reason': 'QA незмінний первісний запит', **extra}

    def approve(self, payload):
        response = self.client.post('/api/erp/recipes/versions', payload, content_type='application/json', **self.headers)
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def identity(self, payload):
        return self.client.post('/api/erp/recipes/versions/identity', {'request': payload}, content_type='application/json', **self.headers)

    def test_identity_exact_original_survives_later_version_hidden_catalog_and_no_writes(self):
        body = self.payload()
        original = self.approve(body)
        later = self.approve(self.payload(expectedVersion=original['id'], reason='Наступна версія'))
        Document.objects.filter(pk=self.output.pk).update(data={**self.output.data, 'hidden': True, 'name': 'Інша назва'})
        before = AuditEvent.objects.count()
        with CaptureQueriesContext(connection) as queries:
            response = self.identity(body)
            context = self.client.get('/api/erp/recipes/recovery-context', {'mode': 'version', 'product': 'output'})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {'confirmed': True, 'key': body['idempotencyKey'], 'product': 'output', 'original': original})
        self.assertNotEqual(response.json()['original']['id'], later['id'])
        self.assertFalse(context.json()['canWrite'])
        self.assertEqual(AuditEvent.objects.count(), before)
        self.assertEqual(RecipeVersion.objects.count(), 2)
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for q in queries))
        if connection.vendor == 'postgresql':
            self.assertTrue(any('REPEATABLE READ, READ ONLY' in q['sql'] for q in queries))

    def test_identity_absence_malformed_and_creator_fingerprint_collisions(self):
        body = self.payload()
        empty = self.identity(body)
        self.assertEqual(empty.json(), {'confirmed': False, 'key': body['idempotencyKey'], 'product': 'output'})
        original = self.approve(body)
        before = AuditEvent.objects.count()
        for changed in ({**body, 'reason': 'Інший запит'}, {**body, 'outputQuantity': '1'},
                        {**body, 'product': 'raw'}, {**body, 'catalogRevision': '0' * 64}):
            denied = self.identity(changed)
            self.assertEqual(denied.status_code, 409, denied.content)
            self.assertEqual(denied.json()['code'], 'idempotency_conflict')
            self.assertNotIn('original', denied.json())
        other = User.objects.create(username='other-creator')
        Profile.objects.create(user=other, role='manager')
        with self.assertRaises(Conflict):
            recipe_drafts.identity(other, {'request': body})
        for value in ({}, {'request': []}, {'request': {**body, 'extra': True}},
                      {'request': {**body, 'idempotencyKey': 'invalid'}},
                      {'request': {**body, 'outputQuantity': float('nan')}}):
            with self.assertRaises(BusinessError):
                recipe_drafts.identity(self.user, value)
        self.assertEqual(self.client.get('/api/erp/recipes/versions/identity').status_code, 405)
        self.assertEqual(AuditEvent.objects.count(), before)
        self.assertEqual(RecipeVersion.objects.get(pk=original['id']).version, 1)

    def test_context_fresh_role_store_active_actor_and_empty_or_missing_selection(self):
        self.assertEqual(recipe_drafts.recovery_context(self.user, {'mode': 'version'}),
                         {'mode': 'version', 'product': '', 'role': 'owner', 'storeId': None,
                          'networkOwner': True, 'canWrite': True, 'exists': None})
        self.assertFalse(recipe_drafts.recovery_context(self.user, {'mode': 'legacy', 'product': 'missing'})['canWrite'])
        store = Store.objects.create(name='Поточний магазин', active=False)
        self.assertEqual(self.user.profile.role, 'owner')  # Cache a role before the fresh read.
        Profile.objects.filter(user=self.user).update(role='manager', store=store)
        context = recipe_drafts.recovery_context(self.user, {'mode': 'version', 'product': 'output'})
        self.assertEqual((context['role'], context['storeId'], context['networkOwner']), ('manager', store.pk, False))
        self.assertTrue(context['canWrite'])  # Existing recipes are global, not store posting operations.
        Profile.objects.filter(user=self.user).update(role='warehouse')
        self.assertTrue(recipe_drafts.recovery_context(self.user, {'mode': 'legacy', 'product': 'output'})['canWrite'])
        with self.assertRaises(BusinessError):
            recipe_drafts.recovery_context(self.user, {'mode': 'version', 'product': 'output'})
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        with self.assertRaises(BusinessError):
            recipe_drafts.recovery_context(self.user, {'mode': 'legacy'})

    def test_actual_read_role_revoked_after_http_auth_denies_before_identity_lookup(self):
        body = self.payload()
        self.approve(body)
        @contextmanager
        def revoked_snapshot():
            Profile.objects.filter(user=self.user).update(role='warehouse')
            with read_snapshot():
                yield
        with patch('server.erp.recipe_drafts.read_snapshot', side_effect=revoked_snapshot):
            response = self.identity(body)
        self.assertEqual(response.status_code, 403)
        self.assertNotIn('original', response.json())
        self.assertEqual(AuditEvent.objects.filter(action='recipe_version_approved').count(), 1)

    def test_postgresql_context_has_one_readonly_snapshot_during_catalog_change(self):
        if connection.vendor != 'postgresql':
            self.skipTest('PostgreSQL snapshot contract')
        changed, errors = [], []
        def writer():
            try:
                Document.objects.filter(pk=self.output.pk).update(data={**self.output.data, 'hidden': True})
                changed.append(True)
            except BaseException as error:
                errors.append(error)
            finally:
                connections.close_all()
        def interleave(execute, sql, params, many, context):
            result = execute(sql, params, many, context)
            if not changed and 'auth_user' in sql and sql.lstrip().upper().startswith('SELECT'):
                thread = threading.Thread(target=writer)
                thread.start()
                thread.join(10)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
            return result
        with connection.execute_wrapper(interleave):
            first = recipe_drafts.recovery_context(self.user, {'mode': 'version', 'product': 'output'})
        self.assertEqual(changed, [True])
        self.assertTrue(first['canWrite'])
        self.assertFalse(recipe_drafts.recovery_context(self.user, {'mode': 'version', 'product': 'output'})['canWrite'])
