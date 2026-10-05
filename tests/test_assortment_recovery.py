"""Whole pair recovery boundary; isolated data, no stock/pricing formula changes."""
import copy
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from django.db import connection, connections, close_old_connections, transaction
from django.test import TransactionTestCase, Client
from django.test.utils import CaptureQueriesContext
from server.erp import assortment_recovery as recovery
from server.erp.models import Assortment, AuditEvent, Document, Profile, Store, Warehouse
from server.erp.services import BusinessError, Conflict
from tests import test_assortment as fixtures


class AssortmentRecoveryTests(TransactionTestCase):
    setUp = fixtures.AssortmentTests.setUp
    user = fixtures.AssortmentTests.user

    def value(self, **changes):
        return {'key': str(uuid.uuid4()), 'warehouse': self.wh.pk, 'product': 'p', 'revision': None,
                'unit': 'шт', 'terms': {'sold': True, 'min_stock': None}, **changes}

    def post(self, action, value):
        return self.client.post('/api/v1/trading/assortment/' + action, value, content_type='application/json', **self.headers)

    def test_exact_receipt_before_current_guards_null_zero_and_legacy_parity(self):
        value = self.value(); first = self.post('execute', value)
        self.assertEqual(first.status_code, 200, first.content)
        original = first.json(); self.assertIsNone(original['original']['min_stock'])
        newer = self.value(revision=original['original']['revision'], terms={'sold': False, 'min_stock': '0'})
        second = self.post('execute', newer); self.assertEqual(second.status_code, 200, second.content)
        self.assertEqual(second.json()['original']['min_stock'], '0.000')
        self.p.data['unit'] = 'кг'; self.p.save()
        self.assertEqual(self.post('execute', value).json(), original)
        self.assertEqual(AuditEvent.objects.filter(action='assortment_saved').count(), 2)
        self.assertEqual((Assortment.objects.get().sold, Assortment.objects.get().min_stock), (False, 0))
        identity = self.post('identity', {'request': value}).json()
        self.assertTrue(identity['confirmed']); self.assertEqual(identity['original'], original['original'])
        changed = copy.deepcopy(value); changed['terms']['sold'] = False
        for action, body in [('execute', changed), ('identity', {'request': changed})]:
            response = self.post(action, body)
            self.assertEqual((response.status_code, response.json()['code']), (409, 'idempotency_conflict'))
            self.assertNotIn('write_rejected', response.json())
        other = self.user('other', 'owner')
        with self.assertRaises(Conflict): recovery.identity(other, {'request': value})
        self.p.delete()
        self.assertEqual(self.post('execute', value).json(), original)
        self.assertIsNone(recovery.context(self.u, {'warehouse': self.wh.pk, 'product': 'p'})['row'])

    def test_rejections_are_bound_and_after_inner_rollback_only(self):
        value = self.value(terms={'sold': True, 'min_stock': '-1'})
        rejected = self.post('execute', value)
        self.assertEqual(rejected.status_code, 400, rejected.content)
        self.assertTrue(rejected.json()['write_rejected']); self.assertEqual(rejected.json()['key'], value['key'])
        self.assertFalse(Assortment.objects.exists()); self.assertFalse(AuditEvent.objects.exists())
        self.assertFalse(self.post('identity', {'request': value}).json()['confirmed'])
        original = self.post('execute', self.value()).json()['original']
        stale = self.value(); response = self.post('execute', stale)
        self.assertEqual((response.status_code, response.json()['code']), (409, 'revision_conflict'))
        self.assertTrue(response.json()['write_rejected'])
        unit = self.value(revision=original['revision'], unit='кг')
        self.assertEqual(self.post('execute', unit).status_code, 400)
        self.assertEqual(AuditEvent.objects.filter(action='assortment_saved').count(), 1)
        request = self.value(revision=original['revision'], terms={'sold': False, 'min_stock': '1.25'})
        from server.erp import assortment
        real_audit = assortment.audit
        def audited(*args, **kwargs):
            real_audit(*args, **kwargs)
            def failed(): raise BusinessError('after committed callback')
            transaction.on_commit(failed)
        with patch.object(assortment, 'audit', side_effect=audited):
            with self.assertRaisesRegex(BusinessError, 'after committed'): recovery.execute(self.u, request)
        self.assertTrue(Document.objects.filter(pk=recovery.PREFIX + request['key']).exists())
        self.assertEqual(recovery.execute(self.u, request)[1], 200)
        self.assertEqual(AuditEvent.objects.filter(action='assortment_saved').count(), 2)

    def test_scalar_context_readonly_json_strings_and_current_access(self):
        self.p.data.update(name='false', unit='null', irrelevant=['private'] * 10000); self.p.save()
        with patch.object(Document, 'from_db', side_effect=AssertionError('whole product loaded')):
            with CaptureQueriesContext(connection) as queries:
                context = recovery.context(self.u, {'warehouse': self.wh.pk, 'product': 'p'})
        self.assertEqual((context['row']['name'], context['row']['unit'], context['row']['minimum']), ('false', 'null', '2.000'))
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) or 'FOR UPDATE' in q['sql'].upper() for q in queries))
        if connection.vendor == 'postgresql':
            self.assertTrue(any('REPEATABLE READ, READ ONLY' in q['sql'] for q in queries))
        value = self.value(unit='null'); self.post('execute', value)
        with CaptureQueriesContext(connection) as queries: self.post('identity', {'request': value})
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) or 'FOR UPDATE' in q['sql'].upper() for q in queries))
        self.assertEqual(self.u.profile.role, 'owner')
        Profile.objects.filter(user=self.u).update(role='cashier')
        for action, body in [('execute', value), ('identity', {'request': value})]: self.assertEqual(self.post(action, body).status_code, 403)
        self.assertEqual(self.client.get('/api/v1/trading/assortment/current', {'warehouse': self.wh.pk, 'product': 'p'}).status_code, 403)
        with self.assertRaises(recovery.Denied): recovery.context(self.u, {'warehouse': self.wh.pk, 'product': 'p'})
        Profile.objects.filter(user=self.u).update(role='manager', store_id=self.store.pk)
        foreign = Warehouse.objects.create(store=Store.objects.create(name='Foreign'), name='Foreign')
        self.assertEqual(self.client.get('/api/v1/trading/assortment/current', {'warehouse': foreign.pk, 'product': 'p'}).status_code, 403)
        self.p.data['unit'] = 'a' * 20000; self.p.save()
        with self.assertRaisesRegex(BusinessError, 'розмір'): recovery.context(self.u, {'warehouse': self.wh.pk, 'product': 'p'})

    def test_private_receipt_prefix_and_strict_envelope(self):
        value = self.value(); self.assertEqual(self.post('execute', value).status_code, 200)
        path = '/api/docs/' + recovery.PREFIX + value['key']
        for method in ('get', 'put', 'patch', 'delete'):
            result = getattr(self.client, method)(path, **({'data': {}, 'content_type': 'application/json', **self.headers} if method != 'get' else {}))
            self.assertGreaterEqual(result.status_code, 400)
        self.assertTrue(Document.objects.filter(pk=recovery.PREFIX + value['key']).exists())
        for change in ({'key': []}, {'warehouse': True}, {'product': '../x'}, {'revision': 7}, {'unit': []}, {'extra': True}):
            result = self.post('execute', {**value, **change}); self.assertEqual(result.status_code, 400); self.assertNotIn('write_rejected', result.json())
        self.assertEqual(self.client.get('/api/v1/trading/assortment/current?warehouse=1&warehouse=2&product=p').status_code, 400)

    def test_concurrent_exact_request_has_one_audit(self):
        if connection.vendor != 'postgresql': self.skipTest('PostgreSQL ledger concurrency')
        value = self.value()
        def send(_):
            close_old_connections()
            try:
                client = Client(); client.cookies['ts_session'] = 'isolated-b03-b06-token'
                result = client.post('/api/v1/trading/assortment/execute', value, content_type='application/json', **self.headers)
                return result.status_code, result.json()
            finally: connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(send, range(2)))
        self.assertEqual(results[0], results[1]); self.assertEqual(results[0][0], 200)
        self.assertEqual(AuditEvent.objects.filter(action='assortment_saved').count(), 1)
        self.assertEqual(Document.objects.filter(path__startswith=recovery.PREFIX).count(), 1)
