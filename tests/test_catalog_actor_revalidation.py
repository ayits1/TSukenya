"""Catalogue permissions are current after waiting for the posting lock, even on retry."""
import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from unittest import skipUnless
from unittest.mock import patch

from django.contrib.auth.models import User
from django.db import close_old_connections, connection, connections, transaction
from django.test import RequestFactory, TransactionTestCase

from server.erp import catalog, catalog_import, catalog_pricing, catalog_references, labels, promotions
from server.erp.models import AuditEvent, Document, LedgerLock, Profile, PromotionCampaign, Store
from server.erp.promotion_prices import kyiv_day
from server.erp.services import BusinessError, ledger_lock
from tests.test_labels import config


@skipUnless(connection.vendor == 'postgresql', 'Requires real PostgreSQL ledger locking.')
class CatalogActorRevalidationTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create(username='isolated-catalog-security-owner')
        Profile.objects.create(user=self.user, role='owner')
        self.store = Store.objects.create(name='Дозволений магазин')
        self.other_store = Store.objects.create(name='Інший магазин')
        LedgerLock.objects.create(pk=1)
        Document.objects.create(path='settings/main', data={'defaultMarkup': 30, 'rounding': .5,
                                'chainName': 'Цукерня', 'storeNames': ['Київ']})
        self.product = Document.objects.create(path='products/one', data={'name': 'Кава', 'unit': 'шт',
            'cost': 10, 'markup': 30, 'manualPrice': False, 'price': None, 'promotion': False})

    def request(self, payload, method='post', store=None):
        request = getattr(RequestFactory(), method)('/isolated-catalog' + (f'?store={store}' if store else ''),
                                                   payload, content_type='application/json')
        request.portal_session = SimpleNamespace(csrf='isolated-security-csrf')
        return request

    def operation(self, name):
        self.product, _ = Document.objects.get_or_create(path='products/one', defaults={'data': {
            'name': 'Кава', 'unit': 'шт', 'cost': 10, 'markup': 30, 'manualPrice': False,
            'price': None, 'promotion': False}})
        if name in {'import', 'pricing'}:
            module = catalog_import if name == 'import' else catalog_pricing
            payload = ({'entries': [{'line': 2, 'values': {'name': 'Новий товар', 'cost': '11.00'}}]}
                       if name == 'import' else {'kind': 'markup', 'ids': None, 'markup': '40',
                                               'resetManualPrices': False, 'updateDefault': False})
            preview = getattr(module, 'preview_' + name)(self.request(payload), self.user)
            self.assertEqual(preview.status_code, 200)
            payload.update(snapshot=json.loads(preview.content)['snapshot'], idempotencyKey=str(uuid.uuid4()))
            return module, lambda actor: getattr(module, 'commit_' + name)(self.request(payload), actor)
        if name in {'product', 'delete', 'create'}:
            payload = {'revision': catalog.revision(self.product), 'name': 'Нова кава'}
            method = 'patch'
            identifier = 'one'
            if name == 'delete':
                payload = {'revision': catalog.revision(self.product)}
                method = 'delete'
            if name == 'create':
                payload = {'name': 'Створений товар ' + str(uuid.uuid4()), 'cost': '10', 'unit': 'шт'}
                method, identifier = 'post', None
            return catalog, lambda actor: catalog.save_product(self.request(payload, method), actor, identifier)
        if name == 'reference':
            return catalog_references, lambda actor: catalog_references.create_reference(
                self.request({'field': 'type', 'value': 'Нова група'}), actor)
        if name == 'labels':
            workspace = labels.workspace(self.user, 'isolated-security-csrf')
            payload = {'revision': workspace['revision'], 'config': config(), 'settings': workspace['settings']}
            payload['settings']['chainName'] = 'Нова мережа'
            return labels, lambda actor: labels.save_workspace(self.request(payload, 'patch'), actor)
        payload = {'idempotencyKey': str(uuid.uuid4()), 'name': 'Акція', 'startsOn': kyiv_day().isoformat(),
            'endsOn': kyiv_day().isoformat(), 'active': True, 'scope': 'network', 'stores': [],
            'prices': [{'product': 'one', 'price': '12.00'}], 'reason': 'Погоджена акція'}
        if name == 'archive':
            created = json.loads(promotions.save_campaign(self.request(payload), self.user).content)
            return promotions, lambda actor: promotions.archive_campaign(
                self.request({'revision': created['revision'], 'reason': 'Завершення'}), actor, created['id'])
        return promotions, lambda actor: promotions.save_campaign(self.request(payload), actor)

    def snapshot(self):
        return (list(Document.objects.order_by('pk').values_list('pk', 'data')),
                list(PromotionCampaign.objects.order_by('pk').values()), AuditEvent.objects.count())

    def cached_actor(self):
        return User.objects.select_related('profile').get(pk=self.user.pk)

    def waiting_request(self, module, operation, change):
        entered = Event()
        backend_pid = []

        def blocked_lock():
            backend_pid.append(connection.connection.info.backend_pid)
            entered.set()
            return ledger_lock()

        def worker():
            close_old_connections()
            try:
                actor = self.cached_actor()
                try:
                    return operation(actor)
                except BusinessError as error:
                    return error
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=1) as pool, patch.object(module, 'ledger_lock', blocked_lock):
            with transaction.atomic():
                ledger_lock()
                future = pool.submit(worker)
                self.assertTrue(entered.wait(5), 'Worker did not reach the ledger lock.')
                deadline = time.monotonic() + 5
                waiting = False
                while time.monotonic() < deadline:
                    with connection.cursor() as cursor:
                        cursor.execute('SELECT pg_stat_clear_snapshot()')
                        cursor.execute('SELECT wait_event_type FROM pg_stat_activity WHERE pid = %s', backend_pid)
                        row = cursor.fetchone()
                    if row and row[0] == 'Lock':
                        waiting = True
                        break
                    time.sleep(.01)
                self.assertTrue(waiting, 'PostgreSQL did not observe a real ledger lock wait.')
                change()
            return future.result(timeout=10)

    def test_role_revoked_while_waiting_blocks_all_matching_mutations(self):
        for name in ('import', 'pricing', 'product', 'create', 'delete', 'reference', 'labels', 'campaign', 'archive'):
            with self.subTest(operation=name):
                Profile.objects.filter(user=self.user).update(role='owner')
                self.user = self.cached_actor()
                module, operation = self.operation(name)
                before = self.snapshot()
                result = self.waiting_request(module, operation, lambda: Profile.objects.filter(user=self.user).update(role='cashier'))
                self.assertIsInstance(result, BusinessError, f'{name} accepted a revoked cached role')
                self.assertEqual(self.snapshot(), before)

    def test_deactivated_while_waiting_blocks_import(self):
        module, operation = self.operation('import')
        before = self.snapshot()
        result = self.waiting_request(module, operation, lambda: User.objects.filter(pk=self.user.pk).update(is_active=False))
        self.assertIsInstance(result, BusinessError)
        self.assertEqual(self.snapshot(), before)

    def test_current_scope_blocks_campaign_create_retry_and_archive(self):
        for name in ('campaign', 'archive'):
            with self.subTest(operation=name):
                Profile.objects.filter(user=self.user).update(store=None)
                self.user = self.cached_actor()
                module, operation = self.operation(name)
                if name == 'campaign':
                    self.assertEqual(operation(self.user).status_code, 200)  # Exact create acknowledgement.
                before = self.snapshot()
                result = self.waiting_request(module, operation, lambda: Profile.objects.filter(user=self.user).update(store=self.store))
                self.assertIsInstance(result, BusinessError)
                self.assertEqual(self.snapshot(), before)

    def test_exact_receipt_requires_current_role_and_activity(self):
        for name in ('import', 'pricing'):
            with self.subTest(operation=name):
                Profile.objects.filter(user=self.user).update(role='owner')
                User.objects.filter(pk=self.user.pk).update(is_active=True)
                self.user = self.cached_actor()
                module, operation = self.operation(name)
                first = operation(self.user)
                self.assertEqual(first.status_code, 200)
                before = self.snapshot()
                actor = self.cached_actor()
                Profile.objects.filter(user=self.user).update(role='cashier')
                with self.assertRaises(BusinessError):
                    operation(actor)
                Profile.objects.filter(user=self.user).update(role='owner')
                actor = self.cached_actor()
                User.objects.filter(pk=self.user.pk).update(is_active=False)
                with self.assertRaises(BusinessError):
                    operation(actor)
                User.objects.filter(pk=self.user.pk).update(is_active=True)
                self.assertEqual(json.loads(operation(self.cached_actor()).content), json.loads(first.content))
                self.assertEqual(self.snapshot(), before)

    def test_deactivation_during_exact_receipt_wait_denies_original_result(self):
        for name in ('import', 'pricing'):
            with self.subTest(operation=name):
                User.objects.filter(pk=self.user.pk).update(is_active=True)
                self.user = self.cached_actor()
                module, operation = self.operation(name)
                self.assertEqual(operation(self.user).status_code, 200)
                before = self.snapshot()
                result = self.waiting_request(module, operation, lambda: User.objects.filter(pk=self.user.pk).update(is_active=False))
                self.assertIsInstance(result, BusinessError)
                self.assertEqual(self.snapshot(), before)

    def test_product_response_uses_current_store_and_rolls_back_foreign_scope(self):
        actor = self.cached_actor()
        Profile.objects.filter(user=self.user).update(store=self.store)
        before = self.snapshot()
        with self.assertRaises(BusinessError):
            catalog.save_product(self.request({'revision': catalog.revision(self.product), 'name': 'Нова кава'},
                                             'patch', self.other_store.pk), actor, 'one')
        self.assertEqual(self.snapshot(), before)

    def test_shared_catalog_policy_still_allows_current_scoped_editors(self):
        for role, name in (('owner', 'pricing'), ('owner', 'labels'), ('manager', 'import'), ('warehouse', 'product')):
            with self.subTest(role=role, operation=name):
                Profile.objects.filter(user=self.user).update(role='owner', store=None)
                self.user = self.cached_actor()
                module, operation = self.operation(name)
                result = self.waiting_request(module, operation, lambda: Profile.objects.filter(user=self.user).update(role=role, store=self.store))
                self.assertEqual(result.status_code, 200)
