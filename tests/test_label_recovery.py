"""Isolated label save receipts and fresh read boundaries; no print/product writes."""
import copy
import hashlib
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from django.contrib.auth.models import User
from django.db import connection, connections, close_old_connections
from django.test import TransactionTestCase, RequestFactory, Client
from django.test.utils import CaptureQueriesContext
from server.erp.models import Document, Profile, PortalSession, AuditEvent
from server.erp import label_recovery
from server.erp.labels import handle_labels
from tests import test_labels as fixtures


class LabelRecoveryTests(TransactionTestCase):
    setUp = fixtures.LabelTests.setUp
    workspace = fixtures.LabelTests.workspace
    payload = fixtures.LabelTests.payload
    def request_body(self): return {'key': str(uuid.uuid4()), **self.payload()}
    def post(self, action, value):
        return self.client.post('/api/v1/labels/workspace/' + action, value, content_type='application/json', **self.headers)
    def test_exact_creator_receipt_precedes_current_revision_and_never_reapplies(self):
        body = self.request_body()
        body['settings']['storeNames'] = ['Перший', 'Другий']; body['config']['storeIdx'] = 1
        result = self.post('execute', body)
        self.assertEqual(result.status_code, 200, result.content)
        ack = result.json(); self.assertEqual(set(ack), {'contract', 'key', 'appliedRevision', 'ok'})
        saved = Document.objects.get(pk='settings/main').data
        self.assertEqual((saved['storeNames'], saved['tag']['storeIdx']), (['Перший', 'Другий'], 1))
        self.assertEqual(saved['rounding'], .5)
        newer = self.request_body(); newer['settings']['storeNames'] = ['Новий']; newer['config']['storeIdx'] = 0
        self.assertEqual(self.post('execute', newer).status_code, 200)
        self.assertEqual(self.post('execute', body).json(), ack)
        self.assertEqual(Document.objects.get(pk='settings/main').data['storeNames'], ['Новий'])
        self.assertEqual(AuditEvent.objects.filter(action='label_layout_changed').count(), 2)
        with CaptureQueriesContext(connection) as queries:
            identity = self.post('identity', {'request': body})
        self.assertEqual(identity.json(), {'contract': label_recovery.CONTRACT, 'key': body['key'], 'confirmed': True, 'appliedRevision': ack['appliedRevision']})
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) or 'FOR UPDATE' in q['sql'].upper() for q in queries))
        changed = {**body, 'settings': {**body['settings'], 'chainName': 'Інше'}}
        for action, value in [('execute', changed), ('identity', {'request': changed})]:
            response = self.post(action, value)
            self.assertEqual((response.status_code, response.json()['code']), (409, 'idempotency_conflict'))
        # Another owner cannot discover or replay the original creator's receipt.
        other = User.objects.create(username='other-owner'); Profile.objects.create(user=other, role='owner')
        with self.assertRaisesRegex(Exception, 'Ключ макета'):
            label_recovery.identity(other, {'request': body})

    def test_first_rejection_is_bound_atomic_and_missing_identity_not_rollback(self):
        body = self.request_body(); body['config']['storeIdx'] = 5
        before = copy.deepcopy(Document.objects.get(pk='settings/main').data)
        result = self.post('execute', body)
        self.assertEqual(result.status_code, 400)
        self.assertEqual(result.json()['key'], body['key']); self.assertTrue(result.json()['write_rejected'])
        self.assertFalse(Document.objects.filter(path__startswith=label_recovery.PREFIX).exists())
        self.assertFalse(AuditEvent.objects.exists()); self.assertEqual(Document.objects.get(pk='settings/main').data, before)
        self.assertEqual(self.post('identity', {'request': body}).json()['confirmed'], False)
        body['config']['storeIdx'] = 0; body['revision'] = 'a' * 64
        result = self.post('execute', body)
        self.assertEqual((result.status_code, result.json()['code']), (409, 'revision_conflict'))
        self.assertTrue(result.json()['write_rejected'])
        # A failed audit rolls back without a false business-rejection receipt.
        body['revision'] = self.workspace()['revision']
        with patch('server.erp.labels.audit', side_effect=RuntimeError('audit failure')):
            with self.assertRaises(RuntimeError): self.post('execute', body)
        self.assertEqual(Document.objects.get(pk='settings/main').data, before)
        self.assertFalse(Document.objects.filter(path__startswith=label_recovery.PREFIX).exists())

    def test_current_role_fresh_workspace_context_execute_and_private_prefix(self):
        body = self.request_body(); self.assertEqual(self.post('execute', body).status_code, 200)
        path = '/api/docs/' + label_recovery.PREFIX + body['key']
        for method in ('get', 'put', 'patch', 'delete'):
            response = getattr(self.client, method)(path, **({'data': {}, 'content_type': 'application/json', **self.headers} if method != 'get' else {}))
            self.assertGreaterEqual(response.status_code, 400)
        self.assertTrue(Document.objects.filter(pk=label_recovery.PREFIX + body['key']).exists())
        # Stale object read must reload its profile inside the read transaction.
        self.user.profile.role
        Profile.objects.filter(user=self.user).update(role='cashier')
        request = RequestFactory().get('/api/v1/labels/workspace')
        request.portal_session = PortalSession.objects.get(user=self.user)
        self.assertFalse(__import__('json').loads(handle_labels(request, self.user).content)['canEdit'])
        self.assertEqual(self.client.get('/api/v1/labels/recovery-context').status_code, 403)
        for action, value in [('execute', body), ('identity', {'request': body})]:
            self.assertEqual(self.post(action, value).status_code, 403)
        self.assertEqual(self.client.patch('/api/v1/labels/workspace', {k:v for k,v in body.items() if k!='key'}, content_type='application/json', **self.headers).status_code, 403)
        self.assertEqual(AuditEvent.objects.filter(action='label_layout_changed').count(), 1)

    def test_parallel_exact_request_has_one_effect_and_current_read_is_rr(self):
        if connection.vendor != 'postgresql': self.skipTest('Requires PostgreSQL row locks.')
        body = self.request_body()
        with CaptureQueriesContext(connection) as queries:
            self.assertEqual(self.client.get('/api/v1/labels/recovery-context').status_code, 200)
            self.assertEqual(self.client.get('/api/v1/labels/workspace').status_code, 200)
        snapshots = [q['sql'] for q in queries if 'SET TRANSACTION' in q['sql']]
        self.assertEqual(len(snapshots), 2)
        self.assertTrue(all('REPEATABLE READ, READ ONLY' in q for q in snapshots))
        def send(_):
            close_old_connections()
            try:
                client = Client(); client.cookies['ts_session'] = 'isolated-label-token'
                result = client.post('/api/v1/labels/workspace/execute', body, content_type='application/json', **self.headers)
                return result.status_code, result.json()
            finally: connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool: result = list(pool.map(send, range(2)))
        self.assertEqual(result[0], result[1]); self.assertEqual(result[0][0], 200)
        self.assertEqual(AuditEvent.objects.filter(action='label_layout_changed').count(), 1)
        self.assertEqual(Document.objects.filter(path__startswith=label_recovery.PREFIX).count(), 1)
