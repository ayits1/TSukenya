"""Actual recipe reload policy/identity reads preserve immutable approval receipts."""
import threading
import uuid
from contextlib import contextmanager
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.db import connection, connections, transaction
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
        missing = object()
        for hidden in (missing, None, False, 0, 0.0, '', [], {}, True, 1, -1, 'false', [0], {'active': False}):
            data = {**self.output.data, 'recipe': [{'product': 'raw', 'quantity': '2'}] * 501, 'cost': 'private'}
            if hidden is not missing:
                data['hidden'] = hidden
            Document.objects.filter(pk=self.output.pk).update(data=data)
            with CaptureQueriesContext(connection) as queries, patch.object(
                    Document, 'from_db', side_effect=AssertionError('Context must not materialize product data')):
                result = recipe_drafts.recovery_context(self.user, {'mode': 'version', 'product': 'output'})
            self.assertEqual(result['canWrite'], not bool(hidden) if hidden is not missing else True, repr(hidden))
            self.assertTrue(result['exists'])
            selected = next(q['sql'].split(' FROM ', 1)[0] for q in queries if 'FROM "erp_document"' in q['sql'])
            self.assertIn('recovery_hidden', selected)
            self.assertNotIn('"erp_document"."data",', selected)
            self.assertNotIn('"erp_document"."data" AS', selected)
            self.assertNotIn('"recipe"', selected)
        Document.objects.filter(pk=self.output.pk).update(data=self.output.data)
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

    def test_live_first_revision_conflict_proof_then_explicit_current_read_and_save(self):
        body = self.payload()
        Document.objects.filter(pk=self.output.pk).update(data={**self.output.data, 'name': 'Змінено в іншому редакторі'})
        rejected = self.client.post('/api/erp/recipes/versions', body, content_type='application/json', **self.headers)
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()['code'], 'revision_conflict')
        self.assertEqual({key: rejected.json()[key] for key in ('write_rejected', 'request_key', 'product', 'mode')},
                         {'write_rejected': True, 'request_key': body['idempotencyKey'], 'product': 'output', 'mode': 'version'})
        self.assertFalse(RecipeVersion.objects.exists())
        self.assertFalse(AuditEvent.objects.exists())
        current = self.client.get('/api/erp/recipes/versions', {'product': 'output'}).json()
        self.assertFalse(RecipeVersion.objects.exists())  # Reading never resubmits.
        changed = {**body, 'catalogRevision': current['catalogRevision'], 'expectedVersion': current['latestVersion']}
        original = self.approve(changed)
        stale = self.client.post('/api/erp/recipes/versions', self.payload(catalogRevision=current['catalogRevision']),
                                 content_type='application/json', **self.headers)
        self.assertEqual(stale.status_code, 409)
        self.assertTrue(stale.json()['write_rejected'])  # The latest-version guard also has a rollback proof.
        self.assertEqual(RecipeVersion.objects.get().pk, uuid.UUID(original['id']))
        self.assertEqual(AuditEvent.objects.count(), 1)

    def test_live_validation_rollback_proof_excludes_collision_and_permission(self):
        from server.erp import recipes_versions
        body = self.payload(outputQuantity='0')
        rejected = self.client.post('/api/erp/recipes/versions', body, content_type='application/json', **self.headers)
        self.assertEqual(rejected.status_code, 400)
        self.assertTrue(rejected.json()['write_rejected'])
        self.assertFalse(RecipeVersion.objects.exists())
        body = self.payload()
        original_audit = recipes_versions.audit
        def rollback_after_write(*args, **kwargs):
            original_audit(*args, **kwargs)
            raise ValidationError('QA validation after inner writes')
        with patch('server.erp.recipes_versions.audit', side_effect=rollback_after_write):
            rejected = self.client.post('/api/erp/recipes/versions', body, content_type='application/json', **self.headers)
        self.assertEqual(rejected.status_code, 400)
        self.assertTrue(rejected.json()['write_rejected'])
        self.assertFalse(RecipeVersion.objects.exists())
        self.assertFalse(AuditEvent.objects.exists())
        self.approve(body)
        collision = self.client.post('/api/erp/recipes/versions', {**body, 'reason': 'Інші умови'},
                                     content_type='application/json', **self.headers)
        self.assertEqual(collision.status_code, 409)
        self.assertEqual(collision.json()['code'], 'idempotency_conflict')
        self.assertNotIn('write_rejected', collision.json())
        Profile.objects.filter(user=self.user).update(role='warehouse')
        denied = self.client.post('/api/erp/recipes/versions', body, content_type='application/json', **self.headers)
        self.assertEqual(denied.status_code, 403)
        self.assertNotIn('write_rejected', denied.json())

    def test_outer_commit_callback_and_response_failures_have_no_rollback_proof(self):
        from server.erp import recipes_versions, views
        original_audit = recipes_versions.audit
        def fail_after_commit():
            raise BusinessError('QA callback failure after commit')
        def audit_callback(*args, **kwargs):
            original_audit(*args, **kwargs)
            transaction.on_commit(fail_after_commit)
        body = self.payload()
        with patch('server.erp.recipes_versions.audit', side_effect=audit_callback):
            failed = self.client.post('/api/erp/recipes/versions', body, content_type='application/json', **self.headers)
        self.assertEqual(failed.status_code, 400)
        self.assertNotIn('write_rejected', failed.json())
        self.assertTrue(self.identity(body).json()['confirmed'])
        latest = RecipeVersion.objects.get()
        body = self.payload(expectedVersion=str(latest.pk))
        original_response = views.response
        def fail_serialization(value, status=200):
            if isinstance(value, dict) and value.get('id') == body['idempotencyKey']:
                raise BusinessError('QA response failure after commit')
            return original_response(value, status)
        with patch('server.erp.views.response', side_effect=fail_serialization):
            failed = self.client.post('/api/erp/recipes/versions', body, content_type='application/json', **self.headers)
        self.assertEqual(failed.status_code, 400)
        self.assertNotIn('write_rejected', failed.json())
        self.assertTrue(self.identity(body).json()['confirmed'])
        self.assertEqual((RecipeVersion.objects.count(), AuditEvent.objects.count()), (2, 2))
