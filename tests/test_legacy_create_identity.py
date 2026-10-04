"""B06 original legacy CREATE identity, safe snapshot, authorization and readonly recovery."""
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from django.contrib.auth.models import User
from django.db import close_old_connections, connection, connections, transaction
from django.test import Client, TransactionTestCase
from server.erp.models import AuditEvent, Document, LedgerLock, LegacyCreateReceipt, PortalSession, Profile, Store
from server.erp.services import BusinessError
from server.erp.legacy_create_identity import identity


class LegacyCreateIdentityTests(TransactionTestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.store = Store.objects.create(name='Початковий магазин')
        self.foreign = Store.objects.create(name='Інший магазин')
        self.user = User.objects.create(username='legacy-identity-owner')
        Profile.objects.create(user=self.user, role='owner')
        self.login(self.user)
        self.key = 'isolated-legacy-identity-key'

    def login(self, user):
        token = 'legacy-identity-' + str(user.pk)
        PortalSession.objects.update_or_create(token_hash=hashlib.sha256(token.encode()).hexdigest(), defaults={'user': user, 'csrf': 'legacy-identity-csrf', 'expires': int(time.time()) + 3600})
        self.client.cookies['ts_session'] = token
        self.headers = {'HTTP_ORIGIN': 'http://testserver', 'HTTP_X_CSRF_TOKEN': 'legacy-identity-csrf'}

    def create(self, collection, value, key=None, client=None):
        return (client or self.client).post('/api/' + collection, value, content_type='application/json', HTTP_IDEMPOTENCY_KEY=key or self.key, **self.headers)

    def lookup(self, collection='tasks', key=None):
        return self.client.get('/api/v1/portal/create-identity', {'collection': collection, 'createKey': key or self.key})

    def test_original_unchanged_changed_deleted_and_tombstone_reused_id(self):
        value = {'title': 'Початкова', 'scope': 'operations', 'status': 'todo', 'order': 123}
        first = self.create('tasks', value).json(); path = 'tasks/' + first['id']
        self.assertEqual(first['collection'], 'tasks'); self.assertEqual(first['createKey'], self.key)
        original = first['original']
        read = self.lookup().json(); self.assertEqual(read['state'], 'unchanged'); self.assertEqual(read['original'], original)
        Document.objects.filter(pk=path).update(data={**value, 'title': 'Серверна нова'})
        read = self.lookup().json(); self.assertEqual(read['state'], 'changed'); self.assertEqual(read['original'], original)
        self.assertEqual(read['current']['data']['title'], 'Серверна нова')
        retry = self.create('tasks', value); self.assertEqual(retry.status_code, 409); self.assertEqual(retry.json()['code'], 'create_changed')
        Document.objects.filter(pk=path).delete()
        receipt = LegacyCreateReceipt.objects.get(pk=self.key); from django.utils import timezone
        receipt.deleted_at = timezone.now(); receipt.save(update_fields=['deleted_at'])
        Document.objects.create(pk=path, data={**value, 'title': 'Інший запис із повторним ID'})
        read = self.lookup().json(); self.assertEqual(read['state'], 'deleted'); self.assertIsNone(read['current'])
        self.assertEqual(self.create('tasks', value).json()['code'], 'create_deleted')
        self.assertEqual(Document.objects.get(pk=path).data['title'], 'Інший запис із повторним ID')
        self.assertEqual(AuditEvent.objects.count(), 1)

    def test_current_manager_scope_original_scope_after_delete_and_historical_unknown(self):
        Profile.objects.filter(user=self.user).update(role='manager', store=self.store)
        value = {'title': 'Моя задача', 'scope': 'operations', 'status': 'todo', 'order': 123}
        first = self.create('tasks', value).json(); path = 'tasks/' + first['id']
        self.assertEqual(first['original']['data']['store'], self.store.pk)
        Document.objects.filter(pk=path).delete()
        self.user.profile
        Profile.objects.filter(user=self.user).update(store=self.foreign)
        with self.assertRaises(BusinessError): identity(self.user, {'collection': 'tasks', 'createKey': self.key})
        self.assertEqual(self.lookup().status_code, 403)
        Profile.objects.filter(user=self.user).update(store=self.store)
        self.assertEqual(self.lookup().json()['state'], 'deleted')
        LegacyCreateReceipt.objects.filter(pk=self.key).update(original=None)
        self.assertEqual(self.lookup().status_code, 403)
        Profile.objects.filter(user=self.user).update(role='owner')
        self.assertEqual(self.lookup().json()['state'], 'deleted')
        self.assertIsNone(self.lookup().json()['original'])

    def test_current_actor_private_expense_and_author_collection_collision(self):
        self.create('expenses', {'name': 'Оренда', 'group': 'fixed', 'amount': 10, 'order': 123})
        self.assertEqual(self.lookup('ideas').status_code, 409)
        other = User.objects.create(username='other-legacy-owner'); Profile.objects.create(user=other, role='owner')
        self.login(other); self.assertEqual(self.lookup('expenses').status_code, 409)
        self.login(self.user)
        Profile.objects.filter(user=self.user).update(store=self.store)
        self.assertEqual(self.lookup('expenses').status_code, 403)
        Profile.objects.filter(user=self.user).update(store=None, role='accountant')
        self.assertEqual(self.lookup('expenses').status_code, 403)
        Profile.objects.filter(user=self.user).update(role='owner')
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        with self.assertRaises(BusinessError): identity(self.user, {'collection': 'expenses', 'createKey': self.key})
        self.assertEqual(AuditEvent.objects.count(), 1)

    def test_safe_snapshot_and_current_data_whitelist_no_raw_credentials(self):
        first = self.create('ideas', {'title': 'Ідея', 'text': 'Опис', 'reaction': None, 'order': 123, 'password': 'must-not-return', 'session': {'csrf': 'private'}, 'gsBase': 'private'}).json()
        self.assertEqual(set(first['original']['data']), {'title', 'text', 'reaction', 'order'})
        result = self.lookup('ideas'); self.assertEqual(result.status_code, 200)
        self.assertNotIn('must-not-return', result.content.decode()); self.assertNotIn('gsBase', result.content.decode()); self.assertNotIn('session', result.content.decode())
        self.assertIn('no-store', result['Cache-Control'])
        self.assertEqual(self.lookup('ideas', 'unknown-isolated-key').json(), {'collection': 'ideas', 'createKey': 'unknown-isolated-key', 'confirmed': False})
        self.assertEqual(self.client.get('/api/v1/portal/create-identity', {'collection': 'ideas', 'createKey': self.key, 'extra': 'x'}).status_code, 400)

    def test_readonly_snapshot_nested_guard_and_no_audit(self):
        first = self.create('ideas', {'title': 'Ідея', 'text': 'Опис', 'order': 123}).json()
        from server.erp.legacy_records import read_record
        def observed(*args):
            if connection.vendor == 'postgresql':
                with connection.cursor() as cursor:
                    cursor.execute('SHOW transaction_isolation'); self.assertEqual(cursor.fetchone()[0], 'repeatable read')
                    cursor.execute('SHOW transaction_read_only'); self.assertEqual(cursor.fetchone()[0], 'on')
            return read_record(*args)
        with patch('server.erp.legacy_create_identity.read_record', side_effect=observed):
            self.assertEqual(identity(self.user, {'collection': 'ideas', 'createKey': self.key})['id'], first['id'])
        self.assertEqual(AuditEvent.objects.count(), 1)
        if connection.vendor == 'postgresql':
            with transaction.atomic():
                with self.assertRaisesMessage(BusinessError, 'REPEATABLE READ'):
                    identity(self.user, {'collection': 'ideas', 'createKey': self.key})

    def test_pg_parallel_receipt_snapshot_is_written_once(self):
        if connection.vendor != 'postgresql': self.skipTest('PostgreSQL row lock proof')
        token = self.client.cookies['ts_session'].value; ready = Barrier(2)
        def create():
            close_old_connections()
            try:
                client = Client(); client.cookies['ts_session'] = token; ready.wait(timeout=5)
                response = self.create('tasks', {'title': 'Задача', 'scope': 'operations', 'status': 'todo', 'order': 123}, client=client)
                return response.status_code, response.json()
            finally: connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [future.result(timeout=8) for future in [pool.submit(create), pool.submit(create)]]
        self.assertEqual([status for status, _ in results], [200, 200])
        self.assertEqual(results[0][1]['id'], results[1][1]['id'])
        self.assertEqual(results[0][1]['original'], results[1][1]['original'])
        self.assertEqual(LegacyCreateReceipt.objects.count(), 1); self.assertEqual(AuditEvent.objects.count(), 1)
