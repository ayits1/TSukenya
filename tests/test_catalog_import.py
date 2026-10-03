import hashlib
import time
import uuid
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from django.contrib.auth.models import User
from django.test import Client, TestCase, TransactionTestCase
from django.db import close_old_connections, connection, connections
from server.erp.catalog import revision
from server.erp.models import AuditEvent, Document, LedgerLock, PortalSession, Profile


class CatalogImportTests(TestCase):
    def setUp(self):
        self.user = User.objects.create(username='isolated-import-owner')
        Profile.objects.create(user=self.user, role='owner')
        LedgerLock.objects.create(pk=1)
        token = 'isolated-import-session'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), user=self.user,
                                     csrf='import-csrf', expires=int(time.time()) + 3600)
        self.client.cookies['ts_session'] = token
        self.headers = {'HTTP_ORIGIN': 'http://testserver', 'HTTP_X_CSRF_TOKEN': 'import-csrf'}
        Document.objects.create(path='settings/main', data={'defaultMarkup': 30, 'rounding': .5})
        self.product = Document.objects.create(path='products/coffee', data={'name': 'Кава', 'cost': 10, 'markup': 30,
                                             'unit': 'шт', 'minStock': 3, 'recipe': [], 'priceAt': '2020-01-01'})

    def post(self, suffix, payload):
        return self.client.post('/api/v1/catalog/import/' + suffix, payload, content_type='application/json', **self.headers)

    def row(self, name='Новий товар', line=2, **values):
        return {'line': line, 'values': {'name': name, **values}}

    def preview(self, entries=None, **extra):
        return self.post('preview', {'entries': entries or [self.row(cost='11.23')], **extra})

    def commit_payload(self, payload):
        preview = self.post('preview', payload)
        self.assertEqual(preview.status_code, 200)
        return {**payload, 'snapshot': preview.json()['snapshot'], 'idempotencyKey': str(uuid.uuid4())}

    def test_preview_is_read_only_and_computes_prices_with_shared_rounding(self):
        response = self.preview([self.row(cost='11.23', markup='35', promotion=True, promotionPrice='14.99')])
        self.assertEqual(response.status_code, 200)
        preview = response.json()
        self.assertTrue(preview['valid'])
        self.assertEqual(preview['counts'], {'created': 1, 'updated': 0, 'errors': 0})
        self.assertEqual(preview['entries'][0]['regularPrice'], '15.50')
        self.assertEqual(preview['entries'][0]['salePrice'], '14.99')
        self.assertEqual(Document.objects.count(), 2)
        self.assertFalse(AuditEvent.objects.exists())

    def test_atomic_create_update_legacy_references_and_preservation(self):
        payload = {'defaultMarkup': '40', 'entries': [self.row('  КАВА  ', cost='20.00'),
                   self.row(line=9, type='Історична група', category='Моя категорія', unit='порція', cost='10.00')]}
        preview = self.post('preview', payload).json()
        self.assertEqual(preview['entries'][0]['id'], 'coffee')
        self.assertEqual(preview['entries'][0]['revision'], revision(self.product))
        commit = self.post('commit', self.commit_payload(payload))
        self.assertEqual(commit.status_code, 200)
        self.assertEqual(commit.json()['counts'], {'created': 1, 'updated': 1, 'errors': 0})
        self.product.refresh_from_db()
        self.assertEqual(self.product.data['cost'], 20)
        self.assertEqual(self.product.data['markup'], 30)  # Default only initializes new products.
        self.assertEqual(self.product.data['minStock'], 3)
        self.assertEqual(self.product.data['recipe'], [])
        new = Document.objects.filter(path__startswith='products/').exclude(pk=self.product.pk).get()
        self.assertEqual(new.data['markup'], 40)
        self.assertEqual(new.data['unit'], 'порція')
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(), 2)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_imported').count(), 1)
        self.assertFalse(Document.objects.filter(path__startswith='catalog_refs/').exists())

    def test_retry_returns_original_result_after_catalog_changed_without_duplicates(self):
        payload = self.commit_payload({'entries': [self.row(cost='12.00')]})
        first = self.post('commit', payload)
        self.assertEqual(first.status_code, 200)
        new = Document.objects.get(pk='products/' + first.json()['entries'][0]['id'])
        new.data['cost'] = 50
        new.save()
        retry = self.post('commit', payload)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json(), first.json())
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(), 2)
        self.assertEqual(Document.objects.filter(path__startswith='import_runs/').count(), 1)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(), 1)

    def test_same_key_changed_payload_or_user_conflicts(self):
        payload = self.commit_payload({'entries': [self.row(cost='12.00')]})
        self.assertEqual(self.post('commit', payload).status_code, 200)
        changed = {**payload, 'entries': [self.row(cost='13.00')]}
        self.assertEqual(self.post('commit', changed).status_code, 409)
        second_user = User.objects.create(username='another-import-owner')
        Profile.objects.create(user=second_user, role='owner')
        from django.test import RequestFactory
        from server.erp.catalog_import import commit_import
        request = RequestFactory().post('/api/v1/catalog/import/commit', payload, content_type='application/json')
        self.assertEqual(commit_import(request, second_user).status_code, 409)

    def test_snapshot_conflict_for_changed_existing_new_name_and_settings(self):
        for change in ('product', 'settings', 'new-name'):
            with self.subTest(change=change):
                payload = self.commit_payload({'entries': [self.row(cost='12.00')]})
                if change == 'product':
                    self.product.data['cost'] += 1
                    self.product.save()
                elif change == 'settings':
                    Document.objects.filter(pk='settings/main').update(data={'defaultMarkup': 40, 'rounding': 1})
                else:
                    Document.objects.create(path='products/concurrent', data={'name': 'Новий товар', 'cost': 5})
                response = self.post('commit', payload)
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()['code'], 'revision_conflict')
                self.assertFalse(Document.objects.filter(path__startswith='import_runs/').exists())
                self.assertFalse(AuditEvent.objects.exists())

    def test_invalid_row_blocks_whole_batch(self):
        payload = {'entries': [self.row('Добрий', cost='10.00'), self.row('Поганий', line=8, cost='not-a-number')]}
        preview = self.post('preview', payload).json()
        self.assertFalse(preview['valid'])
        self.assertEqual(preview['entries'][1]['line'], 8)
        self.assertEqual(preview['entries'][1]['action'], 'error')
        response = self.post('commit', self.commit_payload(payload))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(), 1)
        self.assertFalse(AuditEvent.objects.exists())
        self.assertFalse(Document.objects.filter(path__startswith='import_runs/').exists())

    def test_write_failure_rolls_back_previous_rows_and_audit(self):
        payload = self.commit_payload({'entries': [self.row('Перший', cost='10'), self.row('Другий', line=5, cost='20')]})
        from server.erp.catalog_import import commit_import
        from django.test import RequestFactory
        from server.erp.services import BusinessError
        original_save = Document.save
        def fail_second(document, *args, **kwargs):
            if document.data.get('name') == 'Другий':
                raise BusinessError('Ізольована помилка запису.')
            return original_save(document, *args, **kwargs)
        request = RequestFactory().post('/api/v1/catalog/import/commit', payload, content_type='application/json')
        with patch.object(Document, 'save', fail_second):
            with self.assertRaises(BusinessError):
                commit_import(request, self.user)
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(), 1)
        self.assertFalse(AuditEvent.objects.exists())
        self.assertFalse(Document.objects.filter(path__startswith='import_runs/').exists())
        self.assertEqual(self.post('commit', payload).status_code, 200)

    def test_strict_pricing_matches_editor(self):
        for values in ({'cost': 'NaN'}, {'cost': 'oops'}, {'cost': '-1'}, {'cost': '1.001'},
                       {'markup': '1.00001'}, {'manualPrice': True}, {'manualPrice': True, 'price': '0'},
                       {'manualPrice': 'yes'}, {'promotion': True},
                       {'cost': '10', 'promotion': True, 'promotionPrice': '13'}, {'promotionPrice': '0'},
                       {'promotionPrice': '11.999'}, {'cost': '999999999.99'}, {'cost': 10}):
            with self.subTest(values=values):
                response = self.preview([self.row(**values)])
                self.assertEqual(response.status_code, 200)
                self.assertFalse(response.json()['valid'])
        preview = self.preview([self.row(manualPrice=True, price='12.99', cost='0')]).json()
        self.assertTrue(preview['valid'])
        self.assertEqual(preview['entries'][0]['regularPrice'], '12.99')

    def test_duplicate_names_lines_barcodes_and_ambiguous_catalogue(self):
        for entries in ([self.row('Кава'), self.row(' кава ', line=5)],
                        [self.row('A'), self.row('B')],
                        [self.row('A', barcode='123'), self.row('B', line=5, barcode='123')]):
            preview = self.preview(entries).json()
            self.assertFalse(preview['valid'])
            self.assertEqual(preview['counts']['errors'], 2)
        Document.objects.create(path='products/duplicate', data={'name': '  кава  '})
        preview = self.preview([self.row('КАВА')]).json()
        self.assertFalse(preview['valid'])
        self.assertIn('кілька', preview['entries'][0]['error'])

    def test_id_revision_and_reference_guards(self):
        for row in ({**self.row('Кава'), 'id': 'missing'}, {**self.row('Кава'), 'revision': 'stale'},
                    {**self.row(), 'id': 'coffee'}, {**self.row(), 'revision': 'stale'},
                    self.row(recipe=[{'product': 'missing', 'quantity': '1'}]), self.row(hidden=False)):
            self.assertFalse(self.preview([row]).json()['valid'])
        self.product.data['recipe'] = [{'product': 'missing', 'quantity': 1}]
        self.product.save()
        self.assertFalse(self.preview([self.row('Кава')]).json()['valid'])

    def test_hidden_product_is_updated_and_not_unhidden_or_duplicated(self):
        self.product.data['hidden'] = True
        self.product.save()
        payload = self.commit_payload({'entries': [self.row('кава', cost='15')]})
        response = self.post('commit', payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['counts']['updated'], 1)
        self.product.refresh_from_db()
        self.assertTrue(self.product.data['hidden'])
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(), 1)

    def test_roles_csrf_auth_methods_and_bounded_rows(self):
        for role in ('cashier', 'accountant'):
            self.user.profile.role = role
            self.user.profile.save()
            self.assertEqual(self.preview().status_code, 403)
            self.assertEqual(self.post('commit', {}).status_code, 403)
        for role in ('owner', 'manager', 'warehouse'):
            self.user.profile.role = role
            self.user.profile.save()
            self.assertEqual(self.preview().status_code, 200)
        self.assertEqual(self.client.post('/api/v1/catalog/import/preview', {'entries': [self.row()]}, content_type='application/json').status_code, 403)
        self.assertEqual(self.client.get('/api/v1/catalog/import/preview').status_code, 405)
        self.assertEqual(self.preview([self.row(str(i), line=i + 1) for i in range(1001)]).status_code, 400)
        self.assertEqual(self.post('preview', {'entries': []}).status_code, 400)
        self.client.cookies.clear()
        self.assertEqual(self.preview().status_code, 401)

    def test_malformed_payloads_do_not_raise_server_errors(self):
        for payload in ({'entries': [None]}, {'entries': [self.row(name='A', minStock=None)]},
                        {'entries': [self.row()], 'defaultMarkup': 'NaN'},
                        {'entries': [self.row()], 'defaultMarkup': 30}, {'entries': [self.row()], 'unknown': 1}):
            response = self.post('preview', payload)
            self.assertIn(response.status_code, (200, 400))
            if response.status_code == 200:
                self.assertFalse(response.json()['valid'])
        payload = self.commit_payload({'entries': [self.row()]})
        payload['idempotencyKey'] = 'invalid'
        self.assertEqual(self.post('commit', payload).status_code, 400)

    def test_existing_barcode_and_decimal_default_rejected_without_writes(self):
        self.product.data['barcode'] = 'existing-code'
        self.product.save()
        preview = self.preview([self.row(barcode='existing-code')]).json()
        self.assertFalse(preview['valid'])
        self.assertIn('штрихкод', preview['entries'][0]['error'].lower())
        for amount in ('-1', '1.00001', '999999999', 'invalid'):
            self.assertEqual(self.preview(defaultMarkup=amount).status_code, 400)
        self.assertFalse(AuditEvent.objects.exists())

    def test_deterministic_id_collision_does_not_replace_product_or_save_partial_batch(self):
        key = str(uuid.uuid4())
        collision_id = str(uuid.uuid5(uuid.UUID(key), '5')).replace('-', '_')
        collision = Document.objects.create(path='products/' + collision_id, data={'name': 'Інший товар', 'cost': 88})
        payload = self.commit_payload({'entries': [self.row('Перший'), self.row('Другий', line=5)]})
        payload['idempotencyKey'] = key
        response = self.post('commit', payload)
        self.assertEqual(response.status_code, 400)
        collision.refresh_from_db()
        self.assertEqual(collision.data, {'name': 'Інший товар', 'cost': 88})
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(), 2)
        self.assertFalse(Document.objects.filter(path__startswith='import_runs/').exists())
        self.assertFalse(AuditEvent.objects.exists())

    def test_request_size_limit_is_explicit_and_non_mutating(self):
        response = self.post('preview', {'entries': [self.row(name='A' * 1048576)]})
        self.assertEqual(response.status_code, 400)
        self.assertIn('1000', response.json()['error'])
        self.assertFalse(AuditEvent.objects.exists())
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(), 1)

    def test_preview_placeholder_never_excludes_a_real_product_from_barcode_check(self):
        Document.objects.create(path='products/import_preview', data={'name': 'Існуючий', 'barcode': 'placeholder-code'})
        preview = self.preview([self.row(barcode='placeholder-code')]).json()
        self.assertFalse(preview['valid'])


class CatalogImportConcurrencyTests(TransactionTestCase):
    def setUp(self):
        if connection.vendor != 'postgresql':
            self.skipTest('Requires PostgreSQL row locks.')
        CatalogImportTests.setUp(self)

    def prepare(self, entries):
        payload = {'entries': entries}
        response = self.client.post('/api/v1/catalog/import/preview', payload,
                                    content_type='application/json', **self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['valid'])
        return {**payload, 'snapshot': response.json()['snapshot'], 'idempotencyKey': str(uuid.uuid4())}

    def concurrent_commit(self, payloads):
        barrier = Barrier(2)
        def commit(payload):
            close_old_connections()
            try:
                client = Client()
                client.cookies['ts_session'] = 'isolated-import-session'
                barrier.wait(timeout=10)
                response = client.post('/api/v1/catalog/import/commit', payload,
                                       content_type='application/json', **self.headers)
                return response.status_code, response.json()
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(pool.map(commit, payloads))

    def test_parallel_same_key_returns_one_committed_import(self):
        payload = self.prepare([{'line': 2, 'values': {'name': 'Одноразовий новий товар', 'cost': '12.00'}}])
        results = self.concurrent_commit([payload, payload])
        self.assertEqual([status for status, _ in results], [200, 200])
        self.assertEqual(results[0][1], results[1][1])
        identifier = results[0][1]['entries'][0]['id']
        self.assertEqual(Document.objects.filter(pk='products/' + identifier).count(), 1)
        self.assertEqual(Document.objects.filter(path__startswith='products/').exclude(pk=self.product.pk).count(), 1)
        self.assertEqual(Document.objects.filter(path__startswith='import_runs/').count(), 1)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(), 1)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_imported').count(), 1)
        self.assertEqual(Document.objects.get(pk='import_runs/' + payload['idempotencyKey']).data['result'], results[0][1])

    def test_parallel_different_keys_accept_one_snapshot_without_partial_writes(self):
        payloads = [self.prepare([
            {'line': 2, 'values': {'name': 'Кава', 'cost': amount}},
            {'line': 3, 'values': {'name': name, 'cost': '10.00'}},
        ]) for amount, name in [('20.00', 'Перший новий товар'), ('30.00', 'Другий новий товар')]]
        self.assertEqual(payloads[0]['snapshot'], payloads[1]['snapshot'])
        self.assertNotEqual(payloads[0]['idempotencyKey'], payloads[1]['idempotencyKey'])
        results = self.concurrent_commit(payloads)
        self.assertCountEqual([status for status, _ in results], [200, 409])
        winner = next(index for index, (status, _) in enumerate(results) if status == 200)
        loser = 1 - winner
        self.assertEqual(results[loser][1]['code'], 'revision_conflict')
        self.product.refresh_from_db()
        self.assertEqual(self.product.data['cost'], float(payloads[winner]['entries'][0]['values']['cost']))
        self.assertEqual(Document.objects.filter(path__startswith='products/').exclude(pk=self.product.pk).count(), 1)
        new_product = Document.objects.filter(path__startswith='products/').exclude(pk=self.product.pk).get()
        self.assertEqual(new_product.data['name'], payloads[winner]['entries'][1]['values']['name'])
        self.assertEqual(Document.objects.filter(path__startswith='import_runs/').count(), 1)
        self.assertTrue(Document.objects.filter(pk='import_runs/' + payloads[winner]['idempotencyKey']).exists())
        self.assertFalse(Document.objects.filter(pk='import_runs/' + payloads[loser]['idempotencyKey']).exists())
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(), 2)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_imported').count(), 1)
