import hashlib
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from django.contrib.auth.models import User
from django.db import close_old_connections, connection, connections
from django.test import Client, RequestFactory, TestCase, TransactionTestCase
from server.erp.catalog import defaults, regular_price
from server.erp.models import AuditEvent, Document, LedgerLock, PortalSession, Profile
from server.erp.services import BusinessError


class CatalogPricingTests(TestCase):
    def setUp(self):
        self.user = User.objects.create(username='isolated-pricing-owner')
        Profile.objects.create(user=self.user, role='owner')
        LedgerLock.objects.create(pk=1)
        token = 'isolated-pricing-session'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), user=self.user,
                                     csrf='pricing-csrf', expires=int(time.time()) + 3600)
        self.client.cookies['ts_session'] = token
        self.headers = {'HTTP_ORIGIN': 'http://testserver', 'HTTP_X_CSRF_TOKEN': 'pricing-csrf'}
        self.settings = Document.objects.create(path='settings/main', data={'defaultMarkup': 30, 'rounding': .5, 'chainName': 'Збережена мережа'})
        self.product = self.create('one', cost=10, markup=30)
        self.manual = self.create('manual', cost=10, markup=30, manualPrice=True, price=20)

    def create(self, identifier, **extra):
        return Document.objects.create(path='products/' + identifier, data={'name': identifier, 'unit': 'шт',
                                       'cost': 10, 'manualPrice': False, 'price': None,
                                       'promotion': False, 'priceAt': '2020-01-01', **extra})

    def markup(self, **extra):
        return {'kind': 'markup', 'ids': None, 'markup': '40', 'resetManualPrices': False, 'updateDefault': False, **extra}

    def post(self, action, payload):
        return self.client.post('/api/v1/catalog/pricing/' + action, payload, content_type='application/json', **self.headers)

    def prepare(self, payload):
        response = self.post('preview', payload)
        self.assertEqual(response.status_code, 200)
        return {**payload, 'snapshot': response.json()['snapshot'], 'idempotencyKey': str(uuid.uuid4())}

    def test_preview_is_read_only_and_skips_manual_prices(self):
        before = list(Document.objects.values_list('path', 'data'))
        response = self.post('preview', self.markup())
        self.assertEqual(response.status_code, 200)
        preview = response.json()
        self.assertTrue(preview['valid'])
        self.assertEqual(preview['summary'], {'candidates': 2, 'changedPrices': 1, 'changedRecords': 1, 'skippedManual': 1, 'errors': 0})
        entries = {entry['id']: entry for entry in preview['entries']}
        self.assertEqual(entries['one']['before'], {'regularPrice': '13.00', 'salePrice': '13.00'})
        self.assertEqual(entries['one']['after'], {'regularPrice': '14.00', 'salePrice': '14.00'})
        self.assertEqual(entries['manual']['action'], 'skip')
        self.assertEqual(entries['manual']['after']['regularPrice'], '20.00')
        self.assertEqual(before, list(Document.objects.values_list('path', 'data')))
        self.assertFalse(AuditEvent.objects.exists())

    def test_commit_selected_and_reset_manual_prices(self):
        payload = self.prepare(self.markup(ids=['manual'], resetManualPrices=True))
        response = self.post('commit', payload)
        self.assertEqual(response.status_code, 200)
        self.manual.refresh_from_db()
        self.product.refresh_from_db()
        self.settings.refresh_from_db()
        self.assertFalse(self.manual.data['manualPrice'])
        self.assertIsNone(self.manual.data['price'])
        self.assertEqual(regular_price(self.manual.data), 14)
        self.assertEqual(self.product.data['markup'], 30)
        self.assertEqual(self.settings.data['defaultMarkup'], 30)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(), 1)
        self.assertEqual(response.json()['summary']['changedPrices'], 1)

    def test_future_default_materializes_hidden_and_skipped_manual_fallback_without_price_date(self):
        self.manual.data.pop('markup')
        self.manual.save()
        hidden = self.create('hidden', hidden=True)
        payload = self.markup(updateDefault=True)
        preview = self.post('preview', payload).json()
        self.assertTrue(preview['valid'])
        self.assertEqual(preview['summary'], {'candidates': 3, 'changedPrices': 1, 'changedRecords': 3, 'skippedManual': 1, 'errors': 0})
        entries = {entry['id']: entry for entry in preview['entries']}
        self.assertTrue(entries['hidden']['hidden'])
        self.assertEqual(entries['hidden']['action'], 'update')
        self.assertEqual(entries['hidden']['before'], entries['hidden']['after'])
        response = self.post('commit', self.prepare(payload))
        self.assertEqual(response.status_code, 200)
        self.settings.refresh_from_db()
        self.manual.refresh_from_db()
        hidden.refresh_from_db()
        self.assertEqual(self.settings.data['defaultMarkup'], 40)
        self.assertEqual(self.settings.data['chainName'], 'Збережена мережа')
        self.assertEqual(hidden.data['markup'], 30)
        self.assertEqual(self.manual.data['markup'], 30)
        self.assertEqual(hidden.data['priceAt'], '2020-01-01')
        self.assertEqual(self.manual.data['priceAt'], '2020-01-01')
        self.assertEqual(regular_price(hidden.data), 13)
        self.assertEqual(regular_price(self.manual.data), 20)
        self.assertEqual(defaults()['markup'], 40)

    def test_rounding_preview_includes_hidden_and_preserves_manual(self):
        self.product.data['cost'] = 10.01
        self.product.save()
        hidden = self.create('hidden', hidden=True, cost=10.01, markup=30)
        payload = {'kind': 'rounding', 'rounding': '1'}
        preview = self.post('preview', payload).json()
        self.assertTrue(preview['valid'])
        self.assertEqual(preview['summary'], {'candidates': 3, 'changedPrices': 2, 'changedRecords': 2, 'skippedManual': 0, 'errors': 0})
        entries = {entry['id']: entry for entry in preview['entries']}
        self.assertEqual(entries['one']['before']['regularPrice'], '13.50')
        self.assertEqual(entries['one']['after']['regularPrice'], '14.00')
        self.assertTrue(entries['hidden']['hidden'])
        self.assertEqual(entries['manual']['action'], 'unchanged')
        self.assertEqual(entries['manual']['before'], entries['manual']['after'])
        self.assertEqual(self.post('commit', self.prepare(payload)).status_code, 200)
        hidden.refresh_from_db()
        self.assertNotEqual(hidden.data['priceAt'], '2020-01-01')
        self.settings.refresh_from_db()
        self.assertEqual(self.settings.data['rounding'], 1)

    def test_rounding_discount_validated_against_candidate_configuration(self):
        self.product.data.update(cost=10.01, promotion=True, promotionPrice=13.2)
        self.product.save()
        payload = {'kind': 'rounding', 'rounding': '0.01'}
        preview = self.post('preview', payload).json()
        self.assertFalse(preview['valid'])
        self.assertEqual(preview['summary']['errors'], 1)
        self.assertEqual(next(entry for entry in preview['entries'] if entry['id'] == 'one')['action'], 'error')
        self.assertEqual(self.post('commit', self.prepare(payload)).status_code, 400)
        self.settings.refresh_from_db()
        self.assertEqual(self.settings.data['rounding'], .5)
        self.assertFalse(AuditEvent.objects.exists())
        self.product.data['promotionPrice'] = 12.99
        self.product.save()
        preview = self.post('preview', payload).json()
        self.assertTrue(preview['valid'])
        entry = next(entry for entry in preview['entries'] if entry['id'] == 'one')
        self.assertEqual(entry['after'], {'regularPrice': '13.02', 'salePrice': '12.99'})

    def test_markup_cannot_invalidate_manual_promotion_or_legacy_badge(self):
        self.manual.data.update(promotion=True, promotionPrice=19)
        self.manual.save()
        payload = self.markup(ids=['manual'], resetManualPrices=True)
        self.assertFalse(self.post('preview', payload).json()['valid'])
        self.assertEqual(self.post('commit', self.prepare(payload)).status_code, 400)
        self.product.data.update(promotion=True, promotionPrice=None, cost=10.01)
        self.product.save()
        rounding = {'kind': 'rounding', 'rounding': '1'}
        self.assertFalse(self.post('preview', rounding).json()['valid'])
        self.assertFalse(self.post('preview', self.markup(ids=['one'])).json()['valid'])
        self.assertFalse(AuditEvent.objects.exists())

    def test_unchanged_rounding_and_default_materialization_preserve_legacy_badge(self):
        hidden = self.create('hidden-badge', hidden=True, promotion=True, promotionPrice=None)
        preview = self.post('preview', {'kind': 'rounding', 'rounding': '0.5'}).json()
        self.assertTrue(preview['valid'])
        self.assertEqual(preview['summary']['changedPrices'], 0)
        payload = self.prepare(self.markup(updateDefault=True))
        self.assertEqual(self.post('commit', payload).status_code, 200)
        hidden.refresh_from_db()
        self.assertEqual(hidden.data['markup'], 30)
        self.assertEqual(hidden.data['priceAt'], '2020-01-01')

    def test_invalid_or_hidden_selection_and_strict_numbers(self):
        self.create('hidden', hidden=True)
        payloads = [self.markup(ids=[]), self.markup(ids=['missing']), self.markup(ids=['hidden']),
                    self.markup(ids=['one', 'one']), self.markup(ids=['one'], updateDefault=True),
                    self.markup(resetManualPrices='yes'), self.markup(markup=40),
                    *[self.markup(markup=value) for value in ('NaN', 'Infinity', '-1', '1.00001', '999999999', '1e2', 'bad')],
                    {'kind': 'rounding', 'rounding': 1}, {'kind': 'rounding', 'rounding': '2'},
                    self.markup(unknown=True), {'kind': 'markup'}]
        for payload in payloads:
            with self.subTest(payload=payload):
                self.assertEqual(self.post('preview', payload).status_code, 400)
        self.assertFalse(AuditEvent.objects.exists())

    def test_limits_never_silently_truncate(self):
        self.assertEqual(self.post('preview', self.markup(ids=[str(i) for i in range(1001)])).status_code, 400)
        Document.objects.bulk_create([Document(path='products/bounded_' + str(i), data={'name': str(i), 'cost': 1}) for i in range(1000)])
        self.assertEqual(self.post('preview', self.markup()).status_code, 400)
        self.assertEqual(self.post('preview', {'kind': 'rounding', 'rounding': '1'}).status_code, 400)
        # A small explicit selection remains supported despite a large catalogue.
        self.assertEqual(self.post('preview', self.markup(ids=['one'])).status_code, 200)
        self.assertFalse(AuditEvent.objects.exists())

    def test_error_rolls_back_all_product_writes_and_settings(self):
        payload = self.prepare(self.markup(resetManualPrices=True, updateDefault=True))
        from server.erp.catalog_pricing import commit_pricing
        original_save = Document.save
        def fail_last(document, *args, **kwargs):
            if document.path == 'products/one':
                raise BusinessError('Ізольована помилка запису.')
            return original_save(document, *args, **kwargs)
        request = RequestFactory().post('/api/v1/catalog/pricing/commit', payload, content_type='application/json')
        with patch.object(Document, 'save', fail_last):
            with self.assertRaises(BusinessError):
                commit_pricing(request, self.user)
        self.settings.refresh_from_db()
        self.product.refresh_from_db()
        self.manual.refresh_from_db()
        self.assertEqual(self.settings.data['defaultMarkup'], 30)
        self.assertEqual(self.product.data['markup'], 30)
        self.assertTrue(self.manual.data['manualPrice'])
        self.assertFalse(Document.objects.filter(path__startswith='pricing_runs/').exists())
        self.assertFalse(AuditEvent.objects.exists())
        self.assertEqual(self.post('commit', payload).status_code, 200)

    def test_lost_reply_retry_does_not_write_twice_or_use_new_snapshot(self):
        payload = self.prepare(self.markup(updateDefault=True))
        first = self.post('commit', payload)
        self.assertEqual(first.status_code, 200)
        audits = AuditEvent.objects.count()
        self.product.refresh_from_db()
        self.product.data['cost'] = 99
        self.product.save()
        retry = self.post('commit', payload)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json(), first.json())
        self.assertEqual(AuditEvent.objects.count(), audits)
        self.assertEqual(Document.objects.filter(path__startswith='pricing_runs/').count(), 1)
        self.assertEqual(self.post('commit', {**payload, 'markup': '50'}).status_code, 409)

    def test_snapshot_conflicts_for_product_or_pricing_change(self):
        for change in ('product', 'settings'):
            payload = self.prepare(self.markup())
            if change == 'product':
                self.product.data['cost'] = 20
                self.product.save()
            else:
                self.settings.data['rounding'] = 1
                self.settings.save()
            response = self.post('commit', payload)
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()['code'], 'revision_conflict')
            self.assertFalse(Document.objects.filter(path__startswith='pricing_runs/').exists())
            self.assertFalse(AuditEvent.objects.exists())

    def test_only_owner_csrf_auth_and_get_never_write(self):
        for role in ('manager', 'warehouse', 'accountant', 'cashier'):
            self.user.profile.role = role
            self.user.profile.save()
            self.assertEqual(self.post('preview', self.markup()).status_code, 403)
            self.assertEqual(self.post('commit', {}).status_code, 403)
        self.user.profile.role = 'owner'
        self.user.profile.save()
        self.assertEqual(self.client.post('/api/v1/catalog/pricing/preview', self.markup(), content_type='application/json').status_code, 403)
        self.assertEqual(self.client.get('/api/v1/catalog/pricing/preview').status_code, 405)
        self.assertEqual(self.client.get('/api/v1/catalog/pricing/commit').status_code, 405)
        self.assertFalse(AuditEvent.objects.exists())
        self.assertFalse(Document.objects.filter(path__startswith='pricing_runs/').exists())
        self.client.cookies.clear()
        self.assertEqual(self.post('preview', self.markup()).status_code, 401)

    def test_run_is_user_bound_and_malformed_commit_rejected(self):
        payload = self.prepare(self.markup())
        self.assertEqual(self.post('commit', payload).status_code, 200)
        from server.erp.catalog_pricing import commit_pricing
        other = User.objects.create(username='isolated-other-owner')
        Profile.objects.create(user=other, role='owner')
        request = RequestFactory().post('/api/v1/catalog/pricing/commit', payload, content_type='application/json')
        self.assertEqual(commit_pricing(request, other).status_code, 409)
        self.assertEqual(self.post('commit', {**payload, 'idempotencyKey': 'bad'}).status_code, 400)
        self.assertEqual(self.post('commit', {**payload, 'snapshot': 'bad'}).status_code, 400)


class CatalogPricingConcurrencyTests(TransactionTestCase):
    create = CatalogPricingTests.create
    markup = CatalogPricingTests.markup
    post = CatalogPricingTests.post
    prepare = CatalogPricingTests.prepare

    def setUp(self):
        if connection.vendor != 'postgresql':
            self.skipTest('Requires PostgreSQL row locks.')
        CatalogPricingTests.setUp(self)

    def concurrent_commit(self, payloads):
        barrier = Barrier(2)
        def commit(payload):
            close_old_connections()
            try:
                client = Client()
                client.cookies['ts_session'] = 'isolated-pricing-session'
                barrier.wait(timeout=10)
                response = client.post('/api/v1/catalog/pricing/commit', payload,
                                       content_type='application/json', **self.headers)
                return response.status_code, response.json()
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(pool.map(commit, payloads))

    def test_parallel_same_key_returns_one_pricing_run(self):
        payload = self.prepare(self.markup(ids=['one']))
        results = self.concurrent_commit([payload, payload])
        self.assertEqual([status for status, _ in results], [200, 200])
        self.assertEqual(results[0][1], results[1][1])
        self.assertEqual(Document.objects.filter(path__startswith='pricing_runs/').count(), 1)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(), 1)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_pricing_changed').count(), 1)
        self.product.refresh_from_db()
        self.assertEqual(self.product.data['markup'], 40)

    def test_parallel_different_keys_accept_one_snapshot_atomically(self):
        payloads = [self.prepare(self.markup(markup=value, resetManualPrices=True, updateDefault=True)) for value in ('40', '50')]
        self.assertEqual(payloads[0]['snapshot'], payloads[1]['snapshot'])
        results = self.concurrent_commit(payloads)
        self.assertCountEqual([status for status, _ in results], [200, 409])
        winner = next(index for index, (status, _) in enumerate(results) if status == 200)
        loser = 1 - winner
        self.assertEqual(results[loser][1]['code'], 'revision_conflict')
        self.settings.refresh_from_db()
        self.product.refresh_from_db()
        self.manual.refresh_from_db()
        markup = float(payloads[winner]['markup'])
        self.assertEqual(self.settings.data['defaultMarkup'], markup)
        self.assertEqual(self.product.data['markup'], markup)
        self.assertEqual(self.manual.data['markup'], markup)
        self.assertFalse(self.manual.data['manualPrice'])
        self.assertEqual(Document.objects.filter(path__startswith='pricing_runs/').count(), 1)
        self.assertTrue(Document.objects.filter(pk='pricing_runs/' + payloads[winner]['idempotencyKey']).exists())
        self.assertFalse(Document.objects.filter(pk='pricing_runs/' + payloads[loser]['idempotencyKey']).exists())
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(), 2)
        self.assertEqual(AuditEvent.objects.filter(action='pricing_settings_changed').count(), 1)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_pricing_changed').count(), 1)
