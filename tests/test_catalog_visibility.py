from unittest.mock import patch
from django.test import TransactionTestCase
from server.erp.models import Document, AuditEvent
from tests import test_catalog


class CatalogVisibilityTests(TransactionTestCase):
    setUp = test_catalog.CatalogTests.setUp
    detail = test_catalog.CatalogTests.detail

    def change(self, hidden, revision=None, **extra):
        if revision is None:
            revision = self.client.get('/api/v1/catalog/products/one?includeHidden=true').json()['revision']
        return self.client.patch('/api/v1/catalog/products/one/visibility', {'revision': revision, 'hidden': hidden, **extra}, content_type='application/json', **self.headers)

    def test_bounded_hidden_mode_and_dependent_facets(self):
        active = self.client.get('/api/v1/catalog/products?limit=10').json()
        hidden = self.client.get('/api/v1/catalog/products?visibility=hidden&limit=10').json()
        self.assertEqual((active['visibility'], active['total']), ('active', 3))
        self.assertEqual((hidden['visibility'], hidden['total']), ('hidden', 1))
        self.assertEqual([p['id'] for p in hidden['items']], ['hidden'])
        self.assertTrue(hidden['items'][0]['hidden'])
        self.assertEqual(hidden['facets']['type'], [])
        self.assertEqual(self.client.get('/api/v1/catalog/products/hidden').status_code, 404)
        self.assertEqual(self.client.get('/api/v1/catalog/products?visibility=all').status_code, 400)
        self.assertEqual(self.client.get('/api/v1/catalog/products/hidden?includeHidden=1').status_code, 400)

    def test_metadata_only_hide_restore_noop_and_audit(self):
        original = dict(Document.objects.get(pk='products/one').data)
        response = self.change(True)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['hidden'])
        self.assertTrue(response.json()['canEdit'])
        self.assertEqual(Document.objects.get(pk='products/one').data, {**original, 'hidden': True})
        revision = response.json()['revision']
        self.assertEqual(self.change(True, revision).json()['revision'], revision)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(), 1)
        self.assertEqual(self.change(False, revision).status_code, 200)
        self.assertEqual(Document.objects.get(pk='products/one').data, {**original, 'hidden': False})
        event = AuditEvent.objects.filter(action='catalog_changed').last()
        self.assertEqual(event.detail['contract'], 'v1-visibility')
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(), 2)

    def test_stale_and_malformed_intents_cannot_replay_other_form_fields(self):
        original = self.detail()['revision']
        doc = Document.objects.get(pk='products/one');doc.data['cost'] = 75;doc.save()
        self.assertEqual(self.change(True, original).status_code, 409)
        current = self.detail()['revision']
        for extra in [{'cost':'5'}, {'name':'draft'}, {'hidden':'true'}]:
            hidden = extra.pop('hidden', True)
            self.assertEqual(self.change(hidden, current, **extra).status_code, 400)
        self.assertEqual(self.client.patch('/api/v1/catalog/products/one/visibility', {'hidden':True}, content_type='application/json', **self.headers).status_code, 400)
        self.assertEqual(Document.objects.get(pk=doc.pk).data['cost'], 75)
        self.assertNotIn('hidden', Document.objects.get(pk=doc.pk).data)
        self.assertFalse(AuditEvent.objects.exists())

    def test_current_actor_after_lock_blocks_revoked_role_and_redacts_read(self):
        revision = self.detail()['revision']
        from server.erp.catalog import ledger_lock
        def wait():
            self.user.profile.role='cashier';self.user.profile.save()
            return ledger_lock()
        with patch('server.erp.catalog.ledger_lock', side_effect=wait):
            self.assertEqual(self.change(True, revision).status_code, 403)
        self.assertFalse(AuditEvent.objects.exists())
        self.user.profile.role='cashier';self.user.profile.save()
        current = self.client.get('/api/v1/catalog/products/hidden?includeHidden=true').json()
        self.assertFalse(current['canEdit']);self.assertIsNone(current['cost']);self.assertIsNone(current['markup'])

    def test_deleted_original_no_resurrection_and_hidden_usage_delete_guard(self):
        revision = self.detail()['revision']
        Document.objects.filter(pk='products/one').delete()
        self.assertEqual(self.change(True, revision).status_code, 404)
        self.assertFalse(Document.objects.filter(pk='products/one').exists())
        doc = Document.objects.get(pk='products/two');doc.data['recipe']=[{'product':'hidden','qty':1}];doc.save()
        revision = self.client.get('/api/v1/catalog/products/hidden?includeHidden=true').json()['revision']
        response = self.client.delete('/api/v1/catalog/products/hidden', {'revision':revision}, content_type='application/json', **self.headers)
        self.assertEqual(response.status_code, 400)
        self.assertTrue(Document.objects.filter(pk='products/hidden').exists())

    def test_hidden_recovery_is_readonly_and_generic_patch_cannot_toggle(self):
        before = list(Document.objects.values_list('path','data'))
        result = self.client.get('/api/v1/catalog/products/hidden?includeHidden=true')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(before, list(Document.objects.values_list('path','data')))
        self.assertFalse(AuditEvent.objects.exists())
        response = self.client.patch('/api/v1/catalog/products/hidden', {'revision':result.json()['revision'],'hidden':False}, content_type='application/json', **self.headers)
        self.assertEqual(response.status_code,400)

    def test_hiding_invalidates_label_proof_and_default_pricing_selection(self):
        selection = {'selection':[{'id':'one','quantity':2}]}
        prepare = lambda: self.client.post('/api/v1/labels/prepare', selection, content_type='application/json', **self.headers)
        original = prepare();self.assertEqual(original.status_code,200)
        first_snapshot = original.json()['snapshot']
        hidden = self.change(True);self.assertEqual(hidden.status_code,200)
        self.assertEqual(prepare().status_code,400)
        from server.erp.catalog import filtered_products
        query, *_ = filtered_products(self.user, {'visibility':'hidden'})
        self.assertFalse(query.filter(pk='products/one').exists())
        self.assertEqual(self.change(False, hidden.json()['revision']).status_code,200)
        restored = prepare();self.assertEqual(restored.status_code,200)
        self.assertNotEqual(restored.json()['snapshot'],first_snapshot)

    def test_postgres_concurrent_hide_serializes_revision_and_one_audit(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        from django.db import connection, close_old_connections, connections
        from django.test import Client
        if connection.vendor != 'postgresql': self.skipTest('PostgreSQL ledger concurrency only')
        version = self.detail()['revision'];barrier=Barrier(2)
        def attempt():
            close_old_connections()
            try:
                client=Client();client.cookies['ts_session']='isolated-catalog-token'
                barrier.wait(timeout=5)
                result=client.patch('/api/v1/catalog/products/one/visibility', {'revision':version,'hidden':True},content_type='application/json',**self.headers)
                return result.status_code
            finally: connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as workers:
            statuses=list(workers.map(lambda _:attempt(),range(2)))
        self.assertEqual(sorted(statuses),[200,409])
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),1)
        self.assertTrue(Document.objects.get(pk='products/one').data['hidden'])
        self.assertEqual(Document.objects.get(pk='products/one').data['cost'],10)
