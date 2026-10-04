"""Isolated legacy network-finance boundary checks."""
import hashlib
import time
import uuid
from django.utils import timezone

from django.contrib.auth.models import User
from django.test import TestCase, TransactionTestCase

from server.erp.models import AuditEvent, Document, LedgerLock, PortalSession, Profile, Store, LegacyCreateReceipt, ExpenseCategory, MonthlyBudget, CashEntry, StockEntry


class LegacyFinancialScopeTests(TestCase):
    def test_network_scope_rechecked_after_ledger_wait(self):
        from unittest.mock import patch
        from server.erp import views
        self.user.profile.store=None;self.user.profile.save()
        original=views.ledger_lock
        before=AuditEvent.objects.count()
        def revoked_scope():
            lock=original()
            Profile.objects.filter(user=self.user).update(store=self.b)
            return lock
        with patch('server.erp.views.ledger_lock',side_effect=revoked_scope):
            response=self.write('patch','/api/docs/expenses/network-rent',{'amount':1})
        self.assertEqual(response.status_code,403,response.content)
        self.expense.refresh_from_db()
        self.assertEqual(self.expense.data['amount'],15000)
        self.assertEqual(AuditEvent.objects.count(),before)

    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.a = Store.objects.create(name='Власний магазин')
        self.b = Store.objects.create(name='Інший магазин')
        self.user = User.objects.create(username='scope-owner')
        Profile.objects.create(user=self.user, role='owner', store=self.a)
        token = 'isolated-finance-scope-token'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),
            user=self.user, csrf='scope-csrf', expires=int(time.time()) + 3600)
        self.client.cookies['ts_session'] = token
        self.headers = {'HTTP_ORIGIN': 'http://testserver', 'HTTP_X_CSRF_TOKEN': 'scope-csrf'}
        self.original = {'chainName': 'Спільна мережа', 'storeNames': ['Цінник A', 'Цінник B'],
                         'tag': {}, 'staleDays': 30, 'defaultMarkup': 20, 'rounding': .5,
                         'gsId': 'synthetic-id', 'gsTitle': 'Спільний каталог',
                         'gsUrl': 'https://example.invalid/shared', 'gsSheetName': 'Товари',
                         'stores': 7, 'budgetStores': 4, 'privateFuture': {'plan': 15000}}
        self.settings = Document.objects.create(path='settings/main', data=self.original)
        self.expense = Document.objects.create(path='expenses/network-rent',
            data={'name': 'Оренда всієї мережі', 'group': 'fixed', 'amount': 15000})
        AuditEvent.objects.create(user=self.user, action='legacy_changed', subject=self.expense.pk,
            detail={'before': {'amount': '15000.00'}, 'after': {'amount': '16000.00'}})
        for store, name in [(self.a, 'mine'), (self.b, 'foreign'), (None, 'network')]:
            Document.objects.create(path='tasks/auto_due_' + name, data={
                'scope': 'operations', 'store': store.pk if store else None,
                '_alertKey': 'due:' + name, 'title': 'Борг 15000 грн', 'status': 'todo'})
        Document.objects.create(path='tasks/manual-dev', data={'scope': 'development', 'title': 'Розвиток'})
        Document.objects.create(path='products/shared', data={'name': 'Спільний товар', 'cost': 10})

    def role(self, role, store=None):
        self.user.profile.role = role
        self.user.profile.store = store
        self.user.profile.save(update_fields=['role', 'store'])

    def write(self, method, path, value=None, **headers):
        return getattr(self.client, method)(path, value, content_type='application/json', **(self.headers | headers))

    def test_scoped_owner_read_dto_is_nonmutating_and_shared_catalog_survives(self):
        from server.erp.labels import revision
        before = list(Document.objects.values('path', 'data'))
        events = AuditEvent.objects.count()
        result = self.client.get('/api/state').json()
        self.assertFalse(result['networkOwner'])
        state = result['data']
        self.assertEqual(state['expenses'], [])
        expected = {key: value for key, value in self.original.items()
                    if key not in {'stores', 'budgetStores', 'privateFuture'}}
        self.assertEqual(state['settings/main'], expected)
        self.assertEqual(result['labelRevision'], revision(self.original))
        self.assertEqual(state['products'][0]['id'], 'shared')
        self.assertEqual(set(state['products'][0]['data']['storeSalePrices']), {str(self.a.pk)})
        erp = self.client.get('/api/erp/state').json()
        self.assertFalse(erp['canViewAudit'])
        self.assertEqual([store['id'] for store in erp['stores']], [self.a.pk])
        self.assertEqual(list(Document.objects.values('path', 'data')), before)
        self.assertEqual(AuditEvent.objects.count(), events)

    def test_network_expenses_cannot_be_read_or_written_by_scoped_owner_or_manager(self):
        for role in ['owner', 'manager']:
            self.role(role, self.a)
            for method, path, value in [
                    ('post', '/api/expenses', {'name': 'Forged own', 'group': 'fixed', 'amount': 1, 'store': self.a.pk}),
                    ('patch', '/api/docs/expenses/network-rent', {'amount': 16000}),
                    ('put', '/api/docs/expenses/network-rent', {'name': 'Own', 'group': 'fixed', 'amount': 1, 'store': self.a.pk}),
                    ('delete', '/api/docs/expenses/network-rent', None),
                    ('put', '/api/docs/expenses/new', {'name': 'Own', 'group': 'fixed', 'amount': 1})]:
                with self.subTest(role=role, method=method):
                    before = (Document.objects.count(), AuditEvent.objects.count(), LegacyCreateReceipt.objects.count())
                    result = self.write(method, path, value)
                    self.assertEqual(result.status_code, 403, result.content)
                    self.assertEqual((Document.objects.count(), AuditEvent.objects.count(), LegacyCreateReceipt.objects.count()), before)
                    self.expense.refresh_from_db()
                    self.assertEqual(self.expense.data['amount'], 15000)
            for path in ['/api/erp/audit', '/api/erp/budget-fact']:
                self.assertEqual(self.client.get(path).status_code, 403)
            self.assertEqual(self.client.get('/api/state').json()['data']['expenses'], [])

    def test_revoked_network_scope_blocks_exact_create_replay_before_receipt_lookup(self):
        self.role('owner')
        value = {'name': 'Мережевий план', 'group': 'fixed', 'amount': 2}
        key = 'network-create-key-12345678'
        result = self.write('post', '/api/expenses', value, HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(result.status_code, 200, result.content)
        self.role('owner', self.a)
        before = (Document.objects.count(), AuditEvent.objects.count(), LegacyCreateReceipt.objects.count())
        replay = self.write('post', '/api/expenses', value, HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(replay.status_code, 403, replay.content)
        self.assertEqual((Document.objects.count(), AuditEvent.objects.count(), LegacyCreateReceipt.objects.count()), before)

    def test_settings_private_writes_and_delete_are_denied_without_audit_or_label_changes(self):
        from server.erp.labels import revision
        old_revision = revision(self.original)
        for method in ['put', 'patch']:
            for value in [{'budgetStores': 4}, {'stores': 7}, {'privateFuture': {}}, {'unknown': 1},
                          {'chainName': 'Would change', 'budgetStores': 9}]:
                with self.subTest(method=method, value=value):
                    before = AuditEvent.objects.count()
                    result = self.write(method, '/api/docs/settings/main', value)
                    self.assertEqual(result.status_code, 403, result.content)
                    self.settings.refresh_from_db()
                    self.assertEqual(self.settings.data, self.original)
                    self.assertEqual(revision(self.settings.data), old_revision)
                    self.assertEqual(AuditEvent.objects.count(), before)
        self.assertEqual(self.write('delete', '/api/docs/settings/main').status_code, 403)
        self.assertTrue(Document.objects.filter(pk='settings/main').exists())

    def test_shared_settings_put_merges_hidden_fields_and_keeps_label_concurrency(self):
        from server.erp.labels import revision
        result = self.write('put', '/api/docs/settings/main', {'chainName': 'Нова назва'},
                            HTTP_IF_MATCH=revision(self.original))
        self.assertEqual(result.status_code, 200, result.content)
        self.settings.refresh_from_db()
        self.assertEqual(self.settings.data, self.original | {'chainName': 'Нова назва'})
        self.assertEqual(result.json()['revision'], revision(self.settings.data))
        conflict = self.write('patch', '/api/docs/settings/main', {'chainName': 'Stale'},
                              HTTP_IF_MATCH=revision(self.original))
        self.assertEqual(conflict.status_code, 409, conflict.content)
        result = self.write('patch', '/api/docs/settings/main', {'gsTitle': 'Каталог'})
        self.assertEqual(result.status_code, 200, result.content)
        self.settings.refresh_from_db()
        self.assertEqual(self.settings.data['budgetStores'], 4)
        self.assertEqual(self.settings.data['privateFuture'], self.original['privateFuture'])
        self.assertEqual(self.settings.data['gsTitle'], 'Каталог')

    def test_shared_identity_put_freezes_legacy_budget_fallback_without_exposing_it(self):
        self.settings.data = {'storeNames': ['A', 'B'], 'chainName': 'Old'}
        self.settings.save()
        result = self.write('put', '/api/docs/settings/main', {'storeNames': ['New']})
        self.assertEqual(result.status_code, 200, result.content)
        self.settings.refresh_from_db()
        self.assertEqual(self.settings.data, {'storeNames': ['New'], 'chainName': 'Old', 'budgetStores': 2})
        state = self.client.get('/api/state').json()['data']['settings/main']
        self.assertEqual(state, {'storeNames': ['New'], 'chainName': 'Old'})

    def test_generated_due_scope_applies_before_owner_bypass_only(self):
        state = self.client.get('/api/state').json()['data']
        tasks = {task['id']: task for task in state['tasks']}
        self.assertEqual(set(tasks), {'auto_due_mine', 'manual-dev'})
        self.assertEqual(tasks['auto_due_mine']['permissions'], {'canEdit': True, 'canDelete': False})
        self.assertEqual(self.write('patch', '/api/docs/tasks/auto_due_mine', {'status': 'doing'}).status_code, 200)
        for identifier in ['foreign', 'network']:
            for method, value in [('patch', {'status': 'done', 'store': self.a.pk}),
                                  ('put', {'status': 'done'}), ('delete', None)]:
                result = self.write(method, '/api/docs/tasks/auto_due_' + identifier, value)
                self.assertEqual(result.status_code, 403, result.content)
        # Existing owner development/manual policy is preserved.
        self.assertEqual(self.write('patch', '/api/docs/tasks/manual-dev', {'status': 'doing'}).status_code, 200)

    def test_network_owner_and_manager_existing_contracts(self):
        self.role('owner')
        state = self.client.get('/api/state').json()
        self.assertTrue(state['networkOwner'])
        self.assertEqual(state['data']['settings/main'], self.original)
        self.assertEqual(len(state['data']['expenses']), 1)
        self.assertEqual(self.client.get('/api/erp/audit').status_code, 200)
        self.assertTrue(self.client.get('/api/erp/state').json()['canViewAudit'])
        self.assertEqual(self.client.get('/api/erp/budget-fact').status_code, 200)
        self.assertEqual(self.write('patch', '/api/docs/expenses/network-rent', {'amount': 16000}).status_code, 200)
        self.assertEqual(self.write('patch', '/api/docs/settings/main', {'budgetStores': 9}).status_code, 200)
        self.role('manager', self.a)
        state = self.client.get('/api/state').json()
        self.assertFalse(state['networkOwner'])
        self.assertEqual(set(state['data']['settings/main']), {'chainName', 'storeNames', 'tag', 'staleDays', 'defaultMarkup', 'rounding'})
        self.assertEqual(self.client.get('/api/erp/audit').status_code, 403)

    def test_store_owner_shared_catalog_price_preview_commit_preserves_financial_settings(self):
        request = {'kind': 'rounding', 'rounding': '1'}
        endpoint = '/api/v1/catalog/pricing/'
        preview = self.write('post', endpoint + 'preview', request)
        self.assertEqual(preview.status_code, 200, preview.content)
        self.assertTrue(preview.json()['valid'])
        saved = self.write('post', endpoint + 'commit', request | {
            'snapshot': preview.json()['snapshot'], 'idempotencyKey': str(uuid.uuid4())})
        self.assertEqual(saved.status_code, 200, saved.content)
        self.settings.refresh_from_db()
        self.assertEqual(self.settings.data['budgetStores'], 4)
        self.assertEqual(self.settings.data['privateFuture'], self.original['privateFuture'])
        self.assertEqual(self.settings.data['rounding'], 1)


class ScopedMonthlyBudgetCompatibilityTests(TransactionTestCase):
    # Snapshot API must run outside TestCase's READ WRITE wrapper on PostgreSQL.
    def setUp(self):
        LegacyFinancialScopeTests.setUp(self)
        if not ExpenseCategory.objects.exists():
            import importlib
            from types import SimpleNamespace
            from django.apps import apps
            from django.db import connection
            importlib.import_module('server.erp.migrations.0010_monthly_budgets').seed_categories(
                apps, SimpleNamespace(connection=connection))

    role = LegacyFinancialScopeTests.role
    write = LegacyFinancialScopeTests.write

    def test_scoped_monthly_budget_and_shared_labels_remain_usable(self):
        from tests.test_labels import config
        from server.erp.labels import revision
        month = timezone.localdate().strftime('%Y-%m')
        endpoint = '/api/erp/monthly-budgets'
        read = self.client.get(endpoint, {'month': month, 'store': self.a.pk})
        self.assertEqual(read.status_code, 200, read.content)
        value = {'month': month, 'store': self.a.pk, 'planned_revenue': '1000',
                 'idempotency_key': str(uuid.uuid4()), 'lines': [
                    {'id': str(uuid.uuid4()), 'category': str(ExpenseCategory.objects.get(semantic_key='rent').pk),
                     'mode': 'fixed_amount', 'amount': '100', 'rate': '0', 'base': 'revenue'}]}
        before = (CashEntry.objects.count(), StockEntry.objects.count())
        saved = self.write('post', endpoint, value)
        self.assertEqual(saved.status_code, 201, saved.content)
        self.assertEqual(MonthlyBudget.objects.get(pk=saved.json()['id']).store_id, self.a.pk)
        self.assertEqual(self.client.get(endpoint, {'month': month, 'store': self.b.pk}).status_code, 403)
        self.assertEqual(self.client.get(endpoint, {'month': month}).status_code, 403)
        self.assertEqual((CashEntry.objects.count(), StockEntry.objects.count()), before)
        workspace = self.client.get('/api/v1/labels/workspace').json()
        self.assertTrue(workspace['canEdit'])
        result = self.write('patch', '/api/v1/labels/workspace', {
            'revision': workspace['revision'], 'config': config(),
            'settings': {'chainName': 'Цінники', 'storeNames': ['A'], 'staleDays': 20}})
        self.assertEqual(result.status_code, 200, result.content)
        self.settings.refresh_from_db()
        self.assertEqual(self.settings.data['budgetStores'], 4)
        self.assertEqual(self.settings.data['privateFuture'], self.original['privateFuture'])
        self.assertEqual(result.json()['revision'], revision(self.settings.data))
