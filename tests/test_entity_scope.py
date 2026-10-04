"""Entity writes obey the same current store scope as directory reads."""
from django.contrib.auth.models import User
from django.test import TransactionTestCase

from server.erp.models import AuditEvent, CashAccount, Counterparty, Employee, LedgerLock, Profile, Store, Warehouse
from server.erp.services import BusinessError, record_revision
from server.erp.views import entity_save


class EntityScopeTests(TransactionTestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.local = Store.objects.create(name='Local')
        self.foreign = Store.objects.create(name='Foreign')
        self.actor = User.objects.create(username='scoped-owner')
        Profile.objects.create(user=self.actor, role='owner', store=self.local)

    def rows(self, store):
        return [
            ('stores', store, {}),
            ('warehouses', Warehouse.objects.create(name='Warehouse', store=store), {'store': store.pk}),
            ('accounts', CashAccount.objects.create(name='Account', store=store, kind='cash'), {'store': store.pk, 'kind': 'cash'}),
            ('employees', Employee.objects.create(name='Employee', store=store), {'store': store.pk, 'shift_rate': '100.00', 'bonus_percent': '2.345', 'bonus_basis': 'store'}),
        ]

    def test_foreign_existing_records_rejected_before_revision_or_audit(self):
        for name, obj, extra in self.rows(self.foreign):
            with self.subTest(resource=name):
                obj.refresh_from_db()
                before = record_revision(obj)
                with self.assertRaisesMessage(BusinessError, 'Немає доступу до цього магазину.'):
                    entity_save(self.actor, name, {'id': obj.pk, 'revision': before, 'name': 'Unauthorized', **extra})
                obj.refresh_from_db()
                self.assertEqual(record_revision(obj), before)
                self.assertFalse(AuditEvent.objects.exists())

    def test_foreign_creation_and_new_store_are_rejected(self):
        for name, model, extra in [
            ('warehouses', Warehouse, {}),
            ('accounts', CashAccount, {'kind': 'cash'}),
            ('employees', Employee, {'shift_rate': '100', 'bonus_percent': '1'}),
        ]:
            with self.subTest(resource=name):
                with self.assertRaisesMessage(BusinessError, 'Немає доступу до цього магазину.'):
                    entity_save(self.actor, name, {'name': 'Unauthorized', 'store': self.foreign.pk, **extra})
                self.assertFalse(model.objects.filter(name='Unauthorized').exists())
        with self.assertRaisesMessage(BusinessError, 'Нові магазини може створювати лише власник мережі.'):
            entity_save(self.actor, 'stores', {'name': 'Unauthorized'})
        self.assertFalse(Store.objects.filter(name='Unauthorized').exists())
        self.assertFalse(AuditEvent.objects.exists())

    def test_local_edits_and_network_owner_foreign_edit_remain_supported(self):
        for name, obj, extra in self.rows(self.local):
            with self.subTest(resource=name):
                obj.refresh_from_db()
                result = entity_save(self.actor, name, {'id': obj.pk, 'revision': record_revision(obj), 'name': 'Updated', **extra})
                self.assertEqual(result.status_code, 200)
                obj.refresh_from_db()
                self.assertEqual(obj.name, 'Updated')
        Profile.objects.filter(user=self.actor).update(store=None)
        result = entity_save(self.actor, 'stores', {'id': self.foreign.pk, 'revision': record_revision(self.foreign), 'name': 'Network update'})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(entity_save(self.actor, 'stores', {'name': 'New network store'}).status_code, 200)

    def test_current_store_scope_revalidated_and_shared_parties_unchanged(self):
        # The original caller has a cached profile; access must use current_actor after the lock.
        self.actor.profile
        Profile.objects.filter(user=self.actor).update(store=self.foreign)
        with self.assertRaisesMessage(BusinessError, 'Немає доступу до цього магазину.'):
            entity_save(self.actor, 'stores', {'id': self.local.pk, 'revision': record_revision(self.local), 'name': 'Stale scope'})
        result = entity_save(self.actor, 'parties', {'name': 'Shared contact', 'kind': 'customer'})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(Counterparty.objects.get(name='Shared contact').kind, 'customer')
