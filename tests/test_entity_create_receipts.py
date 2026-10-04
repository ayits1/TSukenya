"""Matching B06 entity-create receipt, current policy and PostgreSQL retry boundaries."""
import hashlib
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event

from django.contrib.auth.models import User
from django.db import close_old_connections, connection, connections, transaction
from django.test import Client, TransactionTestCase
from server.erp.models import AuditEvent, Counterparty, Employee, EntityCreateReceipt, LedgerLock, PortalSession, Profile, Store
from server.erp.services import BusinessError, Conflict, record_revision
from server.erp.views import entity_save
from server.erp.entity_receipts import identity


class EntityCreateReceiptTests(TransactionTestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.store = Store.objects.create(name='Свій')
        self.foreign = Store.objects.create(name='Інший')
        self.user = User.objects.create(username='entity-create-owner')
        Profile.objects.create(user=self.user, role='owner', store=self.store)
        self.key = str(uuid.uuid4())
        self.body = {'idempotency_key': self.key, 'name': 'Олена', 'store': str(self.store.pk), 'active': True,
                     'shift_rate': '100', 'bonus_percent': '2.3', 'bonus_basis': 'store'}

    def save(self, body=None, resource='employees'):
        import json
        return json.loads(entity_save(self.user, resource, body or self.body).content)

    def test_normalized_exact_replay_keeps_original_after_edit_and_delete(self):
        first = self.save()
        employee = Employee.objects.get(pk=first['id'])
        self.assertEqual(first['original']['revision'], record_revision(employee))
        Employee.objects.filter(pk=employee.pk).update(name='Нова назва', shift_rate='200')
        self.assertEqual(self.save({**self.body, 'name': ' Олена ', 'store': self.store.pk, 'shift_rate': '100.00', 'bonus_percent': '2.300'}), first)
        found = identity(self.user, 'employees', {'request': self.body})
        self.assertTrue(found['exists'])
        self.assertEqual(found['original'], first['original'])
        employee.delete()
        self.assertEqual(self.save(), first)
        self.assertFalse(identity(self.user, 'employees', {'request': self.body})['exists'])
        self.assertFalse(Employee.objects.exists())
        self.assertEqual(EntityCreateReceipt.objects.count(), 1)
        self.assertEqual(AuditEvent.objects.filter(action='entity_saved').count(), 1)

    def test_payload_author_and_resource_collisions_refused_without_writes(self):
        first = self.save()
        with self.assertRaises(Conflict): self.save({**self.body, 'id': first['id'], 'revision': first['original']['revision'], 'shift_rate': '101'})
        with self.assertRaises(Conflict): self.save({**self.body, 'shift_rate': '101'})
        with self.assertRaises(Conflict): self.save({'name': 'Олена', 'kind': 'customer', 'active': True, 'idempotency_key': self.key}, 'parties')
        other = User.objects.create(username='other-owner')
        Profile.objects.create(user=other, role='owner', store=self.store)
        with self.assertRaises(Conflict): entity_save(other, 'employees', self.body)
        self.assertEqual(Employee.objects.count(), 1)
        self.assertEqual(AuditEvent.objects.count(), 1)

    def test_cached_policy_revalidated_before_retry_and_private_identity(self):
        self.save()
        self.user.profile
        Profile.objects.filter(user=self.user).update(role='accountant')
        with self.assertRaises(BusinessError): self.save()
        with self.assertRaises(BusinessError): identity(self.user, 'employees', {'request': self.body})
        Profile.objects.filter(user=self.user).update(role='owner', store=self.foreign)
        with self.assertRaises(BusinessError): self.save()
        with self.assertRaises(BusinessError): identity(self.user, 'employees', {'request': self.body})
        Profile.objects.filter(user=self.user).update(store=self.store)
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        with self.assertRaises(BusinessError): self.save()
        with self.assertRaises(BusinessError): identity(self.user, 'employees', {'request': self.body})
        self.assertEqual(AuditEvent.objects.count(), 1)

    def test_all_resources_keep_legacy_create_and_current_create_rules(self):
        Profile.objects.filter(user=self.user).update(store=None)
        cases = [('stores', {}), ('warehouses', {'store': self.store.pk}), ('accounts', {'store': self.store.pk, 'kind': 'bank'}), ('parties', {'kind': 'customer', 'phone': '123', 'email': 'a@example.test', 'notes': 'Примітка', 'active': False})]
        for resource, extra in cases:
            body = {'name': 'Новий запис', 'idempotency_key': str(uuid.uuid4()), **extra}
            first = self.save(body, resource)
            self.assertEqual(self.save(body, resource), first)
            self.assertEqual(first['type'], resource)
            self.assertTrue(identity(self.user, resource, {'request': body})['confirmed'])
        legacy = entity_save(self.user, 'parties', {'name': 'Без ключа', 'kind': 'supplier'})
        self.assertEqual(legacy.status_code, 200)
        unknown = {**self.body, 'idempotency_key': str(uuid.uuid4())}
        self.assertEqual(identity(self.user, 'employees', {'request': unknown})['confirmed'], False)
        self.assertEqual(EntityCreateReceipt.objects.count(), 4)

    def test_read_identity_is_real_readonly_snapshot_and_endpoint_csrf(self):
        self.save()
        token = 'entity-test-session'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), user=self.user, csrf='entity-csrf', expires=int(time.time()) + 3600)
        client = Client(); client.cookies['ts_session'] = token
        path = '/api/v1/trading/entities/employees/identity'
        self.assertEqual(client.post(path, {'request': self.body}, content_type='application/json').status_code, 403)
        result = client.post(path, {'request': self.body}, content_type='application/json', HTTP_ORIGIN='http://testserver', HTTP_X_CSRF_TOKEN='entity-csrf')
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json()['confirmed'])
        self.assertEqual(AuditEvent.objects.count(), 1)
        if connection.vendor == 'postgresql':
            with transaction.atomic():
                with self.assertRaisesMessage(BusinessError, 'REPEATABLE READ'):
                    identity(self.user, 'employees', {'request': self.body})

    def test_pg_parallel_retry_and_ledger_wait_current_policy(self):
        if connection.vendor != 'postgresql': self.skipTest('PostgreSQL row lock proof')
        ready = Barrier(3)
        def create():
            close_old_connections()
            try:
                actor = User.objects.get(pk=self.user.pk); actor.profile
                ready.wait(timeout=5)
                import json
                return json.loads(entity_save(actor, 'employees', self.body).content)
            finally: connections.close_all()
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(create) for _ in range(3)]
            values = [future.result(timeout=10) for future in futures]
        self.assertEqual(values, [values[0]] * 3)
        self.assertEqual(Employee.objects.count(), 1)
        self.assertEqual(AuditEvent.objects.count(), 1)
        entered = Event()
        def blocked_retry():
            close_old_connections()
            try:
                actor = User.objects.get(pk=self.user.pk); actor.profile
                entered.set()
                try: entity_save(actor, 'employees', self.body)
                except BusinessError: return 'refused'
                return 'bad acknowledged'
            finally: connections.close_all()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with transaction.atomic():
                LedgerLock.objects.select_for_update().get(pk=1)
                future = pool.submit(blocked_retry)
                self.assertTrue(entered.wait(timeout=3))
                time.sleep(.08)
                self.assertFalse(future.done())
                Profile.objects.filter(user=self.user).update(role='cashier')
            self.assertEqual(future.result(timeout=5), 'refused')
        self.assertEqual(AuditEvent.objects.count(), 1)


    def test_selected_manage_read_revalidates_cached_private_policy_inside_snapshot(self):
        first = self.save()
        self.user.profile
        Profile.objects.filter(user=self.user).update(role='accountant')
        from server.erp.directories import details
        with self.assertRaises(BusinessError):
            details(self.user, {'purpose': 'manage', 'ids': [{'type': 'employees', 'id': first['id']}]})
        self.assertEqual(AuditEvent.objects.count(), 1)
