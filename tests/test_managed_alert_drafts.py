"""Recovery reads neither replay managed work nor adopt the current cycle."""
import threading
import uuid
from contextlib import contextmanager
from datetime import date, timedelta
from unittest.mock import patch

from django.contrib.auth.models import User
from django.db import connection, connections
from django.test.utils import CaptureQueriesContext

from server.erp import managed_alert_drafts as drafts
from server.erp.historical_reports import read_snapshot
from server.erp.managed_alerts import task_revision
from server.erp.models import AlertTaskAction, AuditEvent, Document, Profile, Store
from tests.test_unit_and_drafts import TransactionApiFixture


class ManagedAlertDraftTests(TransactionApiFixture):
    def setUp(self):
        super().setUp()
        self.identifier = 'auto_' + 'a' * 32
        self.task = Document.objects.create(path='tasks/' + self.identifier, data={
            'scope': 'operations', 'store': self.store.pk, 'title': 'Перевірити нестачу',
            'status': 'todo', '_alertKey': 'low:test', '_alertActive': True,
            '_alertCycle': 1, '_alertWorkState': 'open', 'privateFixture': ['never-return'],
        })
        self.base = '/api/erp/alerts/tasks/' + self.identifier

    def body(self, action='accept', **extra):
        self.task.refresh_from_db()
        return {'action': action, 'revision': task_revision(self.task),
                'idempotencyKey': str(uuid.uuid4()), **extra}

    def post(self, request, endpoint='actions'):
        return self.call('post', self.base + '/' + endpoint,
                         {'request': request} if endpoint == 'identity' else request)

    def test_context_current_roles_read_permission_distinct_from_lifecycle_and_minimal_dto(self):
        owner = self.client.get(self.base + '/recovery-context')
        self.assertEqual(owner.status_code, 200, owner.content)
        self.assertTrue(owner.json()['canAct'])
        self.assertEqual(set(owner.json()['task']), {
            'id', 'kind', 'title', 'revision', 'scope', 'store', 'cycle', 'active', 'workState', 'until', 'reason'})
        self.assertNotIn('privateFixture', str(owner.json()))
        Profile.objects.filter(user=self.u).update(role='warehouse', store=self.store)
        current = drafts.recovery_context(self.u, self.identifier, {})
        self.assertEqual(current['role'], 'warehouse')
        self.assertFalse(current['canAct'])
        Profile.objects.filter(user=self.u).update(role='owner', store=None)
        self.task.data.update(_alertActive=False, _alertWorkState='resolved', status='done')
        self.task.save()
        inactive = drafts.recovery_context(self.u, self.identifier, {})
        self.assertFalse(inactive['canAct'])
        self.assertEqual(inactive['task']['workState'], 'resolved')
        self.assertEqual(self.client.get(self.base + '/recovery-context?request=not-in-query').status_code, 400)

    def test_exact_identity_survives_resolved_new_cycle_and_is_readonly_without_lock(self):
        body = self.body('defer', until=(date.fromisoformat(self.today) + timedelta(days=2)).isoformat(),
                         reason='  Причина з точними пробілами  ')
        saved = self.post(body)
        self.assertEqual(saved.status_code, 200, saved.content)
        applied = saved.json()
        self.task.refresh_from_db()
        self.task.data.update(_alertActive=False, _alertWorkState='resolved', status='done', _alertCycle=2)
        self.task.save()
        before = (AuditEvent.objects.count(), AlertTaskAction.objects.count(), self.task.data)
        with patch('server.erp.managed_alerts.ledger_lock', side_effect=AssertionError('read must not lock')):
            with CaptureQueriesContext(connection) as queries:
                response = self.post(body, 'identity')
                context = self.client.get(self.base + '/recovery-context')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {
            'contract': 'managed-alert-identity-v1', 'confirmed': True,
            'key': body['idempotencyKey'], 'task': self.identifier, 'action': 'defer',
            'observedRevision': body['revision'], 'appliedRevision': applied['appliedRevision'], 'appliedCycle': 1})
        self.assertEqual(context.json()['task']['cycle'], 2)
        self.assertFalse(context.json()['canAct'])
        self.task.refresh_from_db()
        self.assertEqual(before, (AuditEvent.objects.count(), AlertTaskAction.objects.count(), self.task.data))
        sql = [q['sql'].lstrip().upper() for q in queries]
        self.assertFalse(any(q.startswith(('INSERT', 'UPDATE', 'DELETE')) or 'FOR UPDATE' in q for q in sql))
        if connection.vendor == 'postgresql':
            self.assertTrue(any('REPEATABLE READ, READ ONLY' in q for q in sql))

    def test_identity_matches_existing_serializer_author_task_and_raw_uuid_spelling(self):
        body = self.body('defer', until=(date.fromisoformat(self.today) + timedelta(days=1)).isoformat(), reason=' пробіли ')
        body['idempotencyKey'] = body['idempotencyKey'].upper()
        self.assertEqual(self.post(body).status_code, 200)
        self.assertEqual(self.post(body, 'identity').json()['key'], body['idempotencyKey'].lower())
        for changed in ({**body, 'reason': 'пробіли'}, {**body, 'idempotencyKey': body['idempotencyKey'].lower()},
                        {**body, 'action': 'accept'}):
            response = self.post(changed, 'identity')
            self.assertEqual(response.status_code, 409, response.content)
            self.assertEqual(response.json()['code'], 'idempotency_conflict')
        other = Document.objects.create(path='tasks/reprint_' + 'b' * 32, data={
            'scope': 'operations', 'store': self.store.pk, 'title': 'Передрук', 'status': 'done', '_priceTask': True})
        response = self.call('post', '/api/erp/alerts/tasks/' + other.path.split('/')[1] + '/identity', {'request': body})
        self.assertEqual(response.status_code, 409)
        another = User.objects.create(username='another-owner')
        Profile.objects.create(user=another, role='owner')
        from server.erp.services import Conflict
        with self.assertRaises(Conflict):
            drafts.identity(another, self.identifier, {'request': body})
        reprint = drafts.recovery_context(self.u, other.path.split('/')[1], {})
        self.assertTrue(reprint['canAct'])
        self.assertFalse(reprint['task']['active'])

    def test_receipt_absence_is_not_confirmation_and_missing_scope_fails_before_receipt(self):
        body = self.body()
        absent = self.post(body, 'identity')
        self.assertEqual(absent.status_code, 200)
        self.assertFalse(absent.json()['confirmed'])
        self.assertNotIn('appliedRevision', absent.json())
        missing = 'auto_' + 'c' * 32
        with patch.object(AlertTaskAction.objects, 'filter', side_effect=AssertionError('receipt leaked')):
            result = self.call('post', '/api/erp/alerts/tasks/' + missing + '/identity', {'request': body})
        self.assertEqual(result.status_code, 403)
        other = Store.objects.create(name='Інший магазин')
        Profile.objects.filter(user=self.u).update(role='manager', store=other)
        with patch.object(AlertTaskAction.objects, 'filter', side_effect=AssertionError('receipt leaked')):
            response = self.post(body, 'identity')
        self.assertEqual(response.status_code, 403)

    def test_fresh_actor_after_http_auth_enforces_financial_scope_and_deactivation(self):
        self.task.data['_alertKey'] = 'due:test'
        self.task.save()
        body = self.body()
        self.assertEqual(self.post(body).status_code, 200)
        @contextmanager
        def revoked_snapshot():
            Profile.objects.filter(user=self.u).update(role='warehouse', store=self.store)
            with read_snapshot():
                yield
        with patch('server.erp.managed_alert_drafts.read_snapshot', side_effect=revoked_snapshot):
            response = self.post(body, 'identity')
        self.assertEqual(response.status_code, 403)
        User.objects.filter(pk=self.u.pk).update(is_active=False)
        from server.erp.services import BusinessError
        with self.assertRaises(BusinessError):
            drafts.recovery_context(self.u, self.identifier, {})

    def test_postgresql_context_actor_and_task_share_readonly_snapshot(self):
        if connection.vendor != 'postgresql':
            self.skipTest('PostgreSQL snapshot proof')
        changed, errors = [], []
        def writer():
            try:
                task = Document.objects.get(pk=self.task.pk)
                task.data.update(title='Наступна перевірка', _alertCycle=2)
                task.save()
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
            first = drafts.recovery_context(self.u, self.identifier, {})
        self.assertEqual(changed, [True])
        self.assertEqual(first['task']['cycle'], 1)
        self.assertEqual(drafts.recovery_context(self.u, self.identifier, {})['task']['cycle'], 2)
