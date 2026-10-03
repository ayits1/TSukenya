import hashlib
import time

from django.contrib.auth.models import User
from django.test import TestCase

from server.erp.models import AuditEvent, Document, LedgerLock, LegacyCreateReceipt, PortalSession, Profile, Store


class LegacyCreateTests(TestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.store = Store.objects.create(name='Ізольований магазин')
        self.user = User.objects.create(username='isolated-create-owner')
        Profile.objects.create(user=self.user, role='owner')
        self.login(self.user)

    def login(self, user):
        token = f'isolated-create-{user.pk}'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),
            user=user, csrf='isolated-create-csrf', expires=int(time.time()) + 3600)
        self.client.cookies['ts_session'] = token
        self.headers = {'HTTP_ORIGIN': 'http://testserver', 'HTTP_X_CSRF_TOKEN': 'isolated-create-csrf'}

    def create(self, collection, value, key='isolated-create-key-0001'):
        return self.client.post('/api/' + collection, value, content_type='application/json',
            HTTP_IDEMPOTENCY_KEY=key, **self.headers)

    def test_exact_replay_of_each_collection_has_one_document_and_one_audit(self):
        cases = {
            'tasks': {'title': 'Задача', 'scope': 'operations', 'order': 123, 'status': 'todo'},
            'ideas': {'title': 'Ідея', 'text': 'Деталі', 'order': 123},
            'expenses': {'name': ' Оренда ', 'group': 'fixed', 'amount': 12.5, 'order': 123},
        }
        for collection, value in cases.items():
            with self.subTest(collection=collection):
                first = self.create(collection, value, f'isolated-key-{collection}-0001')
                self.assertEqual(first.status_code, 200, first.content)
                audit_count = AuditEvent.objects.count()
                reordered = dict(reversed(list(value.items())))
                retry = self.create(collection, reordered, f'isolated-key-{collection}-0001')
                self.assertEqual(retry.status_code, 200, retry.content)
                self.assertEqual(retry.json()['id'], first.json()['id'])
                self.assertTrue(retry.json()['replayed'])
                self.assertEqual(Document.objects.filter(path__startswith=collection + '/').count(), 1)
                self.assertEqual(AuditEvent.objects.count(), audit_count)
        self.assertEqual(LegacyCreateReceipt.objects.count(), 3)

    def test_changed_payload_and_collection_cannot_reuse_key(self):
        value = {'title': 'Початкова', 'scope': 'operations', 'order': 123}
        first = self.create('tasks', value)
        path = 'tasks/' + first.json()['id']
        for changed in [{**value, 'title': 'Нова'}, {**value, 'order': 124}]:
            result = self.create('tasks', changed)
            self.assertEqual(result.status_code, 409)
            self.assertEqual(result.json()['code'], 'create_payload_conflict')
        self.assertEqual(Document.objects.get(pk=path).data, value)
        result = self.create('ideas', value)
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json()['code'], 'create_key_conflict')
        self.assertEqual(Document.objects.count(), 1)

    def test_changed_and_deleted_record_is_never_overwritten_or_resurrected(self):
        value = {'title': 'Початкова', 'scope': 'operations', 'order': 123}
        identifier = self.create('tasks', value).json()['id']
        path = 'tasks/' + identifier
        changed = {**value, 'title': 'Зміна іншого користувача', 'status': 'done'}
        Document.objects.filter(pk=path).update(data=changed)
        count = AuditEvent.objects.count()
        result = self.create('tasks', value)
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json()['code'], 'create_changed')
        self.assertEqual(result.json()['id'], identifier)
        self.assertEqual(Document.objects.get(pk=path).data, changed)
        Document.objects.get(pk=path).delete()
        result = self.create('tasks', value)
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json()['code'], 'create_deleted')
        self.assertFalse(Document.objects.filter(pk=path).exists())
        self.assertEqual(LegacyCreateReceipt.objects.count(), 1)
        self.assertEqual(AuditEvent.objects.count(), count)

    def test_deleted_receipt_stays_deleted_even_if_legacy_id_is_reused(self):
        value = {'title': 'Ідея', 'order': 123}
        identifier = self.create('ideas', value).json()['id']
        path = '/api/docs/ideas/' + identifier
        deleted = self.client.delete(path, **self.headers)
        self.assertEqual(deleted.status_code, 200)
        self.assertIsNotNone(LegacyCreateReceipt.objects.get().deleted_at)
        restored = self.client.put(path, value, content_type='application/json', **self.headers)
        self.assertEqual(restored.status_code, 200)
        result = self.create('ideas', value)
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json()['code'], 'create_deleted')
        self.assertEqual(Document.objects.get(pk='ideas/' + identifier).data, value)

    def test_receipt_is_bound_to_author(self):
        value = {'title': 'Особиста ідея'}
        identifier = self.create('ideas', value).json()['id']
        other = User.objects.create(username='isolated-other-owner')
        Profile.objects.create(user=other, role='owner')
        self.login(other)
        result = self.create('ideas', value)
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json()['code'], 'create_key_conflict')
        self.assertNotIn('id', result.json())
        self.assertEqual(Document.objects.get(pk='ideas/' + identifier).data, value)
        other.profile.role = 'cashier'
        other.profile.save()
        result = self.create('ideas', value)
        self.assertEqual(result.status_code, 403)
        self.assertNotIn('code', result.json(), 'role refusal must precede receipt lookup')

    def test_replay_rechecks_role_original_scope_and_current_scope(self):
        self.user.profile.role = 'manager'
        self.user.profile.store = self.store
        self.user.profile.save()
        value = {'title': 'Магазинна задача', 'scope': 'operations'}
        result = self.create('tasks', value)
        self.assertEqual(result.status_code, 200, result.content)
        path = 'tasks/' + result.json()['id']
        self.assertEqual(Document.objects.get(pk=path).data['store'], self.store.pk)
        self.assertEqual(self.create('tasks', value).status_code, 200)
        self.user.profile.role = 'cashier'
        self.user.profile.save()
        self.assertEqual(self.create('tasks', value).status_code, 403)
        self.user.profile.role = 'manager'
        self.user.profile.save()
        other_store = Store.objects.create(name='Інший ізольований магазин')
        Document.objects.filter(pk=path).update(data={**value, 'store': other_store.pk})
        self.assertEqual(self.create('tasks', value).status_code, 403)
        self.assertEqual(self.create('tasks', {**value, 'scope': 'development'}).status_code, 403)
        self.assertEqual(Document.objects.count(), 1)

    def test_rejected_create_has_no_document_or_receipt_and_key_can_be_corrected(self):
        for key in ['', 'short', '/' * 20, 'a' * 81]:
            result = self.create('ideas', {'title': 'Ідея'}, key)
            self.assertEqual(result.status_code, 400, result.content)
        result = self.create('expenses', {'name': '', 'group': 'fixed', 'amount': 0})
        self.assertEqual(result.status_code, 400)
        self.assertFalse(LegacyCreateReceipt.objects.exists())
        self.assertFalse(Document.objects.exists())
        result = self.create('expenses', {'name': 'Коректна', 'group': 'fixed', 'amount': 0})
        self.assertEqual(result.status_code, 200, result.content)

    def test_nonfinite_payload_is_rejected_without_internal_error(self):
        result = self.client.post('/api/ideas', '{"title":"Ідея","order":NaN}',
            content_type='application/json', HTTP_IDEMPOTENCY_KEY='isolated-nonfinite-key', **self.headers)
        self.assertEqual(result.status_code, 400)
        self.assertFalse(LegacyCreateReceipt.objects.exists())

    def test_legacy_post_without_key_and_legacy_put_contract_remain_available(self):
        value = {'title': 'Стара інтеграція'}
        first = self.client.post('/api/ideas', value, content_type='application/json', **self.headers)
        second = self.client.post('/api/ideas', value, content_type='application/json', **self.headers)
        self.assertNotEqual(first.json()['id'], second.json()['id'])
        self.assertFalse(LegacyCreateReceipt.objects.exists())
        result = self.client.put('/api/docs/ideas/legacy-id', value, content_type='application/json', **self.headers)
        self.assertEqual(result.status_code, 200)
