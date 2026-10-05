import copy
import uuid
from unittest.mock import patch
from django.test import TransactionTestCase
from server.erp.models import AuditEvent, Document
from tests import test_catalog_references as fixtures
from tests.reference_pages import read_references


class ReferenceManagementTests(TransactionTestCase):
    setUp = fixtures.CatalogReferenceTests.setUp
    references = fixtures.CatalogReferenceTests.references
    create = fixtures.CatalogReferenceTests.create
    patch = fixtures.CatalogReferenceTests.patch
    # Reuse authentication fixture only; base behaviours run in their own class.
    def managed(self, field, text, parent=''):
        return next(item for item in read_references(self.client,states=('active','archived','merged')) if item['field'] == field and item['value'] == text and item['parentType'] == parent)

    def proposal(self, source, operation='rename', **extra):
        return {'sourceId': source['id'], 'revision': source['revision'], 'operation': operation, **extra}

    def preview(self, payload):
        return self.client.post('/api/v1/catalog/references/preview', payload, content_type='application/json', **self.headers)

    def commit(self, payload, reviewed=None, key=None):
        reviewed = self.preview(payload).json() if reviewed is None else reviewed
        body = {**payload, 'snapshot': reviewed['snapshot'], 'idempotencyKey': key or str(uuid.uuid4())}
        return self.client.post('/api/v1/catalog/references/commit', body, content_type='application/json', **self.headers), body

    def test_rename_pins_stable_group_and_child_identity_without_touching_history(self):
        group = self.managed('type', 'Напої')
        category = self.managed('category', 'Кава', 'Напої')
        Document.objects.create(path='orders/history', data={'type': 'Напої', 'category': 'Кава'})
        payload = self.proposal(group, value='Гарячі напої')
        before = list(Document.objects.values('path', 'data'))
        reviewed = self.preview(payload)
        self.assertEqual(reviewed.status_code, 200)
        self.assertEqual(list(Document.objects.values('path', 'data')), before)
        response, _ = self.commit(payload, reviewed.json())
        self.assertEqual(response.status_code, 200, response.content)
        product = self.client.get('/api/v1/catalog/products/coffee').json()
        self.assertEqual(product['type'], 'Гарячі напої')
        self.assertEqual(product['referenceIds']['type'], group['id'])
        self.assertEqual(product['referenceIds']['category'], category['id'])
        child = self.managed('category', 'Кава', 'Гарячі напої')
        self.assertEqual(child['id'], category['id']); self.assertEqual(child['parentId'], group['id'])
        self.assertEqual(Document.objects.get(pk='orders/history').data, {'type': 'Напої', 'category': 'Кава'})
        changes = AuditEvent.objects.get(action='catalog_reference_changed').detail['references']
        group_change = next(change for change in changes if change['before']['id']==group['id'])
        self.assertEqual((group_change['before']['value'],group_change['after']['value']),('Напої','Гарячі напої'))
        child_change = next(change for change in changes if change['before']['id']==category['id'])
        self.assertEqual((child_change['before']['parentType'],child_change['after']['parentType']),('Напої','Гарячі напої'))
        self.assertEqual(self.create('type', 'Напої').json()['id'], group['id'])
        old_version = product['revision']
        legacy = self.client.patch('/api/docs/products/coffee', {'type': 'Напої', 'category': 'Кава'}, content_type='application/json', HTTP_IF_MATCH=old_version, **self.headers)
        self.assertEqual(legacy.status_code, 200, legacy.content)
        self.assertEqual(Document.objects.get(pk='products/coffee').data['type'], 'Гарячі напої')

    def test_archive_never_resurrects_from_legacy_values_and_unchanged_product_stays_editable(self):
        unit = self.managed('unit', 'шт')
        product = copy.deepcopy(Document.objects.get(pk='products/coffee').data)
        response, _ = self.commit(self.proposal(unit, 'archive'))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Document.objects.get(pk='products/coffee').data, product)
        self.assertNotIn(unit['id'], [item['id'] for item in self.references()])
        self.assertEqual(self.create('unit', 'шт').status_code, 400)
        self.assertEqual(self.patch('coffee', name='Кава нова').status_code, 200)
        self.assertEqual(self.patch('orphan', name='Оновлений без явної одиниці', unit='шт').status_code, 200)
        created = self.client.post('/api/v1/catalog/products', {'name': 'Новий', 'unit': 'шт'}, content_type='application/json', **self.headers)
        self.assertEqual(created.status_code, 400)
        preview = self.client.post('/api/v1/catalog/products/price-preview', {'cost':'10','markup':'30'}, content_type='application/json', **self.headers)
        self.assertEqual(preview.status_code, 200, preview.content)
        Document.objects.filter(path__startswith='products/').delete()
        self.assertNotIn('шт', [item['value'] for item in self.references()])
        archived = self.managed('unit', 'шт')
        self.assertEqual(archived['state'], 'archived')
        self.assertEqual(self.commit(self.proposal(archived, 'restore'))[0].status_code, 200)
        self.assertIn('шт', [item['value'] for item in self.references()])

    def test_group_merge_coalesces_only_same_named_children_in_explicit_target(self):
        self.create('type', 'Подарунки'); self.create('category', 'Кава', parentType='Подарунки')
        self.create('type', 'Третя'); self.create('category', 'Кава', parentType='Третя')
        Document.objects.create(path='products/tea', data={'name': 'Чай', 'type': 'Напої', 'category': 'Чай', 'hidden': True})
        source, target = self.managed('type', 'Напої'), self.managed('type', 'Подарунки')
        child, target_child, third_child = self.managed('category', 'Кава', 'Напої'), self.managed('category', 'Кава', 'Подарунки'), self.managed('category', 'Кава', 'Третя')
        payload = self.proposal(source, 'merge', targetId=target['id'])
        reviewed = self.preview(payload).json()
        self.assertEqual(reviewed['coalescedCategories'], [{'sourceId': child['id'], 'targetId': target_child['id'], 'value': 'Кава'}])
        self.assertEqual(reviewed['usageCount'], 2)
        self.assertEqual(self.commit(payload, reviewed)[0].status_code, 200)
        data = Document.objects.get(pk='products/coffee').data
        self.assertEqual((data['type'], data['category']), ('Подарунки', 'Кава'))
        self.assertEqual(data['referenceIds']['category'], target_child['id'])
        self.assertEqual(self.managed('category', 'Кава', 'Третя')['id'], third_child['id'])
        tea = Document.objects.get(pk='products/tea').data
        self.assertEqual(tea['type'], 'Подарунки'); self.assertTrue(tea['hidden'])
        self.assertEqual(self.managed('category', 'Чай', 'Подарунки')['parentId'], target['id'])
        self.assertEqual(self.create('type', 'Напої').json()['id'], target['id'])
        self.assertEqual(self.create('category', 'Кава', parentType='Напої').json()['id'], target_child['id'])

    def test_unit_recipe_guard_blocks_rename_and_merge_before_any_write(self):
        document = Document.objects.get(pk='products/coffee'); document.data['recipe'] = [{'product': 'ingredient', 'qty': 1}]; document.save()
        self.create('unit', 'кг')
        source, target = self.managed('unit', 'шт'), self.managed('unit', 'кг')
        before = list(Document.objects.order_by('path').values('path', 'data'))
        for payload in [self.proposal(source, value='уп'), self.proposal(source, 'merge', targetId=target['id'])]:
            reviewed = self.preview(payload).json()
            self.assertEqual(reviewed['blockedCount'], 1)
            self.assertEqual(self.commit(payload, reviewed)[0].status_code, 400)
        self.assertEqual(list(Document.objects.order_by('path').values('path', 'data')), before)
        self.assertFalse(AuditEvent.objects.filter(action='catalog_reference_changed').exists())

    def test_stale_impact_and_stale_reference_conflict_without_partial_write(self):
        source = self.managed('pack', 'Пакет'); payload = self.proposal(source, value='Банка')
        reviewed = self.preview(payload).json()
        document = Document.objects.get(pk='products/coffee'); document.data['name'] = 'Оновлено'; document.save()
        response, _ = self.commit(payload, reviewed)
        self.assertEqual((response.status_code, response.json()['code']), (409, 'snapshot_conflict'))
        self.assertEqual(self.commit(payload)[0].status_code, 200)
        response, _ = self.commit(payload, reviewed)
        self.assertEqual((response.status_code, response.json()['code']), (409, 'revision_conflict'))

    def test_exact_retry_returns_original_result_after_later_edit_and_changed_request_conflicts(self):
        source = self.managed('pack', 'Пакет'); payload = self.proposal(source, value='Банка')
        response, body = self.commit(payload)
        self.assertEqual(response.status_code, 200)
        current = self.managed('pack', 'Банка')
        self.assertEqual(self.commit(self.proposal(current, value='Коробка'))[0].status_code, 200)
        count = AuditEvent.objects.count()
        retry = self.client.post('/api/v1/catalog/references/commit', body, content_type='application/json', **self.headers)
        self.assertEqual(retry.json(), response.json()); self.assertEqual(AuditEvent.objects.count(), count)
        changed = self.client.post('/api/v1/catalog/references/commit', {**body, 'value': ' Банка '}, content_type='application/json', **self.headers)
        self.assertEqual((changed.status_code, changed.json()['code']), (409, 'idempotency_conflict'))
        self.user.profile.role = 'cashier'; self.user.profile.save()
        denied = self.client.post('/api/v1/catalog/references/commit', body, content_type='application/json', **self.headers)
        self.assertEqual(denied.status_code, 403)

    def test_invalid_payloads_and_server_owned_product_ids(self):
        source = self.managed('type', 'Напої')
        for payload in [[], {'sourceId': []}, self.proposal(source, 'unknown'), self.proposal(source, value=''), self.proposal(source, 'archive', value='x'), self.proposal(source, 'merge', targetId=source['id'])]:
            self.assertEqual(self.preview(payload).status_code, 400)
        self.assertEqual(self.patch('coffee', referenceIds={'type': 'arbitrary'}).status_code, 400)
        self.assertFalse(AuditEvent.objects.filter(action='catalog_reference_changed').exists())

    def test_atomic_rollback_when_audit_fails(self):
        payload = self.proposal(self.managed('pack', 'Пакет'), value='Коробка'); reviewed = self.preview(payload).json()
        before = list(Document.objects.order_by('path').values('path', 'data'))
        with patch('server.erp.catalog_reference_management.audit', side_effect=RuntimeError('isolated failure')):
            with self.assertRaises(RuntimeError): self.commit(payload, reviewed)
        self.assertEqual(list(Document.objects.order_by('path').values('path', 'data')), before)

    def test_unknown_stable_id_is_not_evidence_of_archival(self):
        document = Document.objects.get(pk='products/coffee'); document.data['referenceIds'] = {'pack': 'unknown_stable'}; document.save()
        detail = self.client.get('/api/v1/catalog/products/coffee').json()
        self.assertEqual(detail['referenceIds']['pack'], 'unknown_stable')
        self.assertIn('Пакет', [item['value'] for item in self.references()])
        self.assertEqual(self.patch('coffee', name='Метадані без втрати невідомого ID').status_code,200)
        self.assertEqual(Document.objects.get(pk='products/coffee').data['referenceIds']['pack'],'unknown_stable')

    def test_archived_child_does_not_resurrect_when_parent_is_renamed_or_merged(self):
        child = self.managed('category', 'Кава', 'Напої')
        self.assertEqual(self.commit(self.proposal(child, 'archive'))[0].status_code, 200)
        group = self.managed('type', 'Напої')
        self.assertEqual(self.commit(self.proposal(group, value='Гарячі'))[0].status_code, 200)
        self.assertEqual(self.managed('category', 'Кава', 'Гарячі')['state'], 'archived')
        self.assertNotIn(child['id'], [item['id'] for item in self.references()])
        self.create('type', 'Подарунки'); self.create('category', 'Кава', parentType='Подарунки')
        group, target = self.managed('type', 'Гарячі'), self.managed('type', 'Подарунки')
        self.assertEqual(self.commit(self.proposal(group, 'merge', targetId=target['id']))[0].status_code, 200)
        category = next(item for item in read_references(self.client,states=('active','archived','merged')) if item['id']==child['id'])
        self.assertEqual((category['state'], category['parentType']), ('archived', 'Подарунки'))
        self.assertEqual(self.patch('coffee', name='Збережена архівована категорія').status_code, 200)
        self.assertEqual(Document.objects.get(pk='products/coffee').data['referenceIds']['category'], child['id'])
        self.assertNotIn(child['id'], [item['id'] for item in self.references()])
        before = list(Document.objects.order_by('path').values('path','data')); audit_count = AuditEvent.objects.count()
        restored = self.preview(self.proposal(category, 'restore'))
        self.assertEqual(restored.status_code,400)
        self.assertIn('Активний запис',restored.json()['error'])
        body = {**self.proposal(category,'restore'),'snapshot':'a'*64,'idempotencyKey':str(uuid.uuid4())}
        response = self.client.post('/api/v1/catalog/references/commit',body,content_type='application/json',**self.headers)
        self.assertEqual(response.status_code,400)
        self.assertEqual(list(Document.objects.order_by('path').values('path','data')),before);self.assertEqual(AuditEvent.objects.count(),audit_count)

    def test_accounting_lot_blocks_unit_rename_and_historical_rows_remain_untouched(self):
        from server.erp.models import Store, Warehouse, StockLot, Voucher, VoucherLine
        from datetime import date
        store = Store.objects.create(name='QA')
        warehouse = Warehouse.objects.create(store=store, name='QA')
        product = Document.objects.get(pk='products/coffee')
        lot = StockLot.objects.create(warehouse=warehouse, product=product, code='QA', quantity=1, value=10)
        voucher = Voucher.objects.create(kind='receipt', store=store, date=date.today(), created_by=self.user)
        line = VoucherLine.objects.create(voucher=voucher, product=product, name='Історична кава', unit='шт',quantity=1,price=10,amount=10)
        unit = self.managed('unit', 'шт'); payload = self.proposal(unit, value='уп')
        self.assertEqual(self.commit(payload)[0].status_code, 400)
        self.assertEqual(self.commit(self.proposal(self.managed('pack', 'Пакет'), value='Банка'))[0].status_code, 200)
        lot.refresh_from_db(); line.refresh_from_db()
        self.assertEqual((lot.quantity, lot.value, line.name, line.unit),(1,10,'Історична кава','шт'))


from django.db import connection, connections
from django.test import TransactionTestCase, Client
from unittest import skipUnless
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier


@skipUnless(connection.vendor == 'postgresql', 'Row-lock proof requires PostgreSQL.')
class ReferenceConcurrentTests(TransactionTestCase):
    setUp = fixtures.CatalogReferenceTests.setUp

    def test_only_one_concurrent_commit_of_same_review_can_change_and_audit(self):
        source = next(item for item in read_references(self.client,states=('active','archived','merged')) if item['field']=='pack')
        payload = {'sourceId':source['id'], 'revision':source['revision'], 'operation':'rename', 'value':'Банка'}
        reviewed = self.client.post('/api/v1/catalog/references/preview', payload,content_type='application/json',**self.headers).json()
        barrier = Barrier(2)
        token = self.client.cookies['ts_session'].value
        def send():
            try:
                client = Client(); client.cookies['ts_session'] = token
                body = {**payload,'snapshot':reviewed['snapshot'],'idempotencyKey':str(uuid.uuid4())}
                barrier.wait(timeout=5)
                result = client.post('/api/v1/catalog/references/commit',body,content_type='application/json',**self.headers)
                return result.status_code,result.json()
            finally: connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _:send(),range(2)))
        self.assertEqual(sorted(status for status,_ in results),[200,409])
        self.assertEqual(AuditEvent.objects.filter(action='catalog_reference_changed').count(),1)
        self.assertEqual(Document.objects.filter(path__startswith='catalog_reference_runs/').count(),1)
        self.assertEqual(Document.objects.get(pk='products/coffee').data['pack'],'Банка')


class ReferenceUnitAliasTests(TransactionTestCase):
    setUp = fixtures.CatalogReferenceTests.setUp
    patch = fixtures.CatalogReferenceTests.patch

    def test_legacy_alias_cannot_bypass_used_unit_guard_after_canonicalisation(self):
        from server.erp.catalog_references import legacy_item
        unit = legacy_item('unit', 'шт')
        Document.objects.create(path='catalog_refs/' + unit['id'], data={**unit,'value':'уп','state':'active','aliases':[{'value':'шт','parentType':''}]})
        document = Document.objects.get(pk='products/coffee'); document.data['recipe'] = [{'product':'ingredient','qty':1}]; document.save()
        version = self.client.get('/api/v1/catalog/products/coffee').json()['revision']
        response = self.client.patch('/api/docs/products/coffee',{'name':'Новий текст','unit':'шт'},content_type='application/json',HTTP_IF_MATCH=version,**self.headers)
        self.assertEqual(response.status_code,400)
        self.assertEqual(Document.objects.get(pk='products/coffee').data['name'],'Кава')
