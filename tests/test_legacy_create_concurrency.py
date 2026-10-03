from concurrent.futures import ThreadPoolExecutor
import hashlib
import time
from threading import Barrier

from django.contrib.auth.models import User
from django.db import close_old_connections, connection, connections
from django.test import Client, TransactionTestCase

from server.erp.models import AuditEvent, Document, LedgerLock, LegacyCreateReceipt, PortalSession, Profile


class LegacyCreateConcurrencyTests(TransactionTestCase):
    def setUp(self):
        if connection.vendor != 'postgresql':
            self.skipTest('Requires PostgreSQL row locks.')
        LedgerLock.objects.create(pk=1)
        user = User.objects.create(username='isolated-concurrent-create')
        Profile.objects.create(user=user, role='owner')
        self.token = 'isolated-concurrent-create-token'
        PortalSession.objects.create(token_hash=hashlib.sha256(self.token.encode()).hexdigest(),
            user=user, csrf='isolated-create-csrf', expires=int(time.time()) + 3600)

    def concurrent(self, values):
        ready = Barrier(len(values))
        def create(value):
            close_old_connections()
            try:
                client = Client()
                client.cookies['ts_session'] = self.token
                ready.wait(timeout=5)
                result = client.post('/api/ideas', value, content_type='application/json',
                    HTTP_ORIGIN='http://testserver', HTTP_X_CSRF_TOKEN='isolated-create-csrf',
                    HTTP_IDEMPOTENCY_KEY='isolated-concurrent-create-key')
                return result.status_code, result.json()
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=len(values)) as pool:
            return list(pool.map(create, values))

    def test_parallel_exact_retries_create_and_audit_once(self):
        results = self.concurrent([{'title': 'Ідея', 'order': 123}] * 4)
        self.assertEqual([code for code, _ in results], [200] * 4)
        self.assertEqual(len({value['id'] for _, value in results}), 1)
        self.assertEqual(Document.objects.count(), 1)
        self.assertEqual(LegacyCreateReceipt.objects.count(), 1)
        self.assertEqual(AuditEvent.objects.count(), 1)

    def test_parallel_different_payloads_cannot_replace_winning_create(self):
        results = self.concurrent([{'title': 'Перша', 'order': 123}, {'title': 'Друга', 'order': 124}])
        self.assertCountEqual([code for code, _ in results], [200, 409])
        self.assertEqual(next(value for code, value in results if code == 409)['code'], 'create_payload_conflict')
        self.assertEqual(Document.objects.count(), 1)
        self.assertEqual(LegacyCreateReceipt.objects.count(), 1)
        self.assertEqual(AuditEvent.objects.count(), 1)
        self.assertIn(Document.objects.get().data['title'], ['Перша', 'Друга'])
