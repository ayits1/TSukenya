"""B03 base unit lock and B06 draft/directory revisions with exact create retries. Isolated data only."""
import hashlib
import json
import time
from django.utils import timezone
from server.erp.models import *
from server.erp.services import *
from tests.test_erp import AccountingFixture
from django.test import TransactionTestCase


class ApiSessionFixture:
    def setup_api_session(self):
        token = 'isolated-b03-b06-token'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), user=self.u, csrf='b-csrf', expires=int(time.time()) + 3600)
        self.client.cookies['ts_session'] = token
        self.headers = {'HTTP_ORIGIN': 'http://testserver', 'HTTP_X_CSRF_TOKEN': 'b-csrf'}
        Document.objects.create(path='settings/main', data={'defaultMarkup': 30, 'rounding': .5})

    def call(self, method, path, value=None, **extra):
        return getattr(self.client, method)(path, json.dumps(value if value is not None else {}), content_type='application/json', **self.headers, **extra)

    def product(self, identifier='p'):
        return self.client.get('/api/v1/catalog/products/' + identifier).json()


class ApiFixture(ApiSessionFixture, AccountingFixture):
    def setUp(self):
        super().setUp()
        self.setup_api_session()


class TransactionApiFixture(ApiSessionFixture, TransactionTestCase):
    """HTTP snapshot reads need committed setup and their own transaction boundary."""
    v = AccountingFixture.v
    cash_start = AccountingFixture.cash_start
    sale = AccountingFixture.sale

    def setUp(self):
        from tests.catalog_index_fixture import clear_flushed_catalogue_tombstones
        clear_flushed_catalogue_tombstones()
        AccountingFixture.setUp(self)
        self.setup_api_session()


class UnitLockTests(TransactionApiFixture):
    def test_unused_product_unit_can_still_be_corrected(self):
        # The legacy portal path stores free-text units; v1 additionally requires a directory entry.
        response = self.call('patch', '/api/docs/products/p', {'unit': 'кг'}, HTTP_IF_MATCH=self.product()['revision'])
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(Document.objects.get(pk='products/p').data['unit'], 'кг')

    def test_used_product_unit_is_fixed_on_every_write_path(self):
        self.v('receipt', 10, 5)
        before = dict(Document.objects.get(pk='products/p').data)
        v1 = self.call('patch', '/api/v1/catalog/products/p', {'revision': self.product()['revision'], 'unit': 'кг'})
        self.assertEqual(v1.status_code, 400)
        self.assertIn('Одиницю обліку «шт» змінити не можна', v1.json()['error'])
        legacy = self.call('patch', '/api/docs/products/p', {'unit': 'кг'}, HTTP_IF_MATCH=self.product()['revision'])
        self.assertEqual(legacy.status_code, 400)
        preview = self.call('post', '/api/v1/catalog/import/preview', {'entries': [{'line': 2, 'values': {'name': 'Product', 'unit': 'кг'}}]})
        self.assertEqual(preview.status_code, 200, preview.content)
        self.assertEqual(preview.json()['counts']['errors'], 1)
        self.assertIn('Одиницю обліку', preview.json()['entries'][0]['error'])
        self.assertEqual(Document.objects.get(pk='products/p').data, before)
        # Other fields of a used product stay editable, and resending the same unit is not a change.
        renamed = self.call('patch', '/api/v1/catalog/products/p', {'revision': self.product()['revision'], 'name': 'Product 2', 'unit': 'шт'})
        self.assertEqual(renamed.status_code, 200, renamed.content)
        self.assertEqual(StockLot.objects.get().quantity, 10)

    def test_draft_lines_and_recipes_also_fix_the_unit(self):
        save_voucher(self.u, {'kind': 'purchase_order', 'date': self.today, 'store': self.store.pk, 'warehouse': self.wh.pk, 'party': self.party.pk, 'lines': [{'product': 'p', 'quantity': 1, 'price': 5}]})
        self.assertEqual(self.call('patch', '/api/v1/catalog/products/p', {'revision': self.product()['revision'], 'unit': 'кг'}).status_code, 400)
        Document.objects.create(path='products/flour', data={'name': 'Flour', 'unit': 'кг'})
        Document.objects.create(path='products/bun', data={'name': 'Bun', 'unit': 'шт', 'recipe': [{'product': 'flour', 'quantity': '0.1'}]})
        ingredient = self.call('patch', '/api/v1/catalog/products/flour', {'revision': self.product('flour')['revision'], 'unit': 'г'})
        self.assertIn('інгредієнт', ingredient.json()['error'])
        finished = self.call('patch', '/api/v1/catalog/products/bun', {'revision': self.product('bun')['revision'], 'unit': 'кг'})
        self.assertIn('рецептуру', finished.json()['error'])


class DraftRevisionTests(ApiFixture):
    def body(self, **extra):
        return {'kind': 'receipt', 'date': self.today, 'store': self.store.pk, 'warehouse': self.wh.pk, 'party': self.party.pk,
                'lines': [{'product': 'p', 'quantity': 1, 'price': 5}], **extra}

    def test_stale_draft_form_gets_409_and_keeps_newer_lines(self):
        created = self.call('post', '/api/erp/vouchers', self.body(idempotency_key='draft-a')).json()
        self.assertEqual(created['revision'], 1)
        first = self.call('put', f'/api/erp/vouchers/{created["id"]}', self.body(revision=1, lines=[{'product': 'p', 'quantity': 2, 'price': 5}]))
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(first.json()['revision'], 2)
        stale = self.call('put', f'/api/erp/vouchers/{created["id"]}', self.body(revision=1, lines=[{'product': 'p', 'quantity': 7, 'price': 5}]))
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()['code'], 'revision_conflict')
        self.assertEqual(stale.json()['revision'], 2)
        self.assertEqual(Voucher.objects.get().lines.get().quantity, 2)
        missing = self.call('put', f'/api/erp/vouchers/{created["id"]}', self.body())
        self.assertEqual(missing.status_code, 409)

    def test_create_retry_returns_the_same_draft_but_a_changed_request_conflicts(self):
        body = self.body(idempotency_key='retry-key')
        a = self.call('post', '/api/erp/vouchers', body).json()
        b = self.call('post', '/api/erp/vouchers', body).json()
        self.assertEqual(a['id'], b['id'])
        changed = self.call('post', '/api/erp/vouchers', {**body, 'lines': [{'product': 'p', 'quantity': 9, 'price': 5}]})
        self.assertEqual(changed.status_code, 409)
        self.assertEqual(changed.json()['code'], 'idempotency_conflict')
        self.assertEqual(changed.json()['id'], a['id'])
        self.assertEqual(Voucher.objects.count(), 1)
        self.assertEqual(Voucher.objects.get().lines.get().quantity, 1)

    def test_post_observed_revision_refuses_unseen_changes_without_movements(self):
        created = self.call('post', '/api/erp/vouchers', self.body()).json()
        url = f'/api/erp/vouchers/{created["id"]}'
        updated = self.call('put', url, self.body(revision=1, lines=[{'product': 'p', 'quantity': 7, 'price': 5}]))
        self.assertEqual(updated.status_code, 200, updated.content)
        for revision in (1, '2', True, None):
            refused = self.call('post', url + '/post', {'revision': revision})
            self.assertEqual(refused.status_code, 409, refused.content)
            self.assertEqual(refused.json()['code'], 'revision_conflict')
        self.assertEqual(StockEntry.objects.count(), 0)
        self.assertEqual(Voucher.objects.get().status, 'draft')
        posted = self.call('post', url + '/post', {'revision': 2})
        self.assertEqual(posted.status_code, 200, posted.content)
        self.assertEqual(StockLot.objects.get().quantity, 7)
        # Lost posting response is safe to retry, including an older observed version.
        self.assertEqual(self.call('post', url + '/post', {'revision': 1}).status_code, 200)
        self.assertEqual(StockEntry.objects.count(), 1)

    def test_deliberate_post_current_api_remains_available(self):
        created = self.call('post', '/api/erp/vouchers', self.body()).json()
        self.assertEqual(self.call('post', f'/api/erp/vouchers/{created["id"]}/post').status_code, 200)

    def test_delete_observed_revision_preserves_newer_draft(self):
        created = self.call('post', '/api/erp/vouchers', self.body()).json()
        url = f'/api/erp/vouchers/{created["id"]}'
        self.call('put', url, self.body(revision=1, lines=[{'product': 'p', 'quantity': 7, 'price': 5}]))
        refused = self.call('delete', url, {'revision': 1})
        self.assertEqual(refused.status_code, 409, refused.content)
        self.assertEqual(Voucher.objects.get().lines.get().quantity, 7)
        self.assertEqual(self.call('delete', url, {'revision': 2}).status_code, 200)

    def test_create_retry_after_another_editor_never_adopts_their_revision(self):
        body = self.body(idempotency_key='lost-response')
        created = self.call('post', '/api/erp/vouchers', body).json()
        self.call('put', f'/api/erp/vouchers/{created["id"]}', self.body(revision=1, lines=[{'product': 'p', 'quantity': 7, 'price': 5}]))
        for _ in range(2):
            refused = self.call('post', '/api/erp/vouchers', body)
            self.assertEqual(refused.status_code, 409)
            self.assertEqual(refused.json()['code'], 'idempotency_conflict')
            self.assertEqual(Voucher.objects.get().lines.get().quantity, 7)

    def test_create_key_is_bound_to_its_author(self):
        body = self.body(idempotency_key='author-key')
        save_voucher(self.u, body)
        other = User.objects.create(username='second-owner')
        Profile.objects.create(user=other, role='owner')
        with self.assertRaises(Conflict):
            save_voucher(other, body)

    def test_documents_saved_before_fingerprints_keep_kind_only_retry(self):
        body = self.body(idempotency_key='legacy-key')
        v = save_voucher(self.u, body)
        Voucher.objects.filter(pk=v.pk).update(request_fingerprint='')
        self.assertEqual(save_voucher(self.u, {**body, 'note': 'changed'}).pk, v.pk)


class DirectoryAndTimesheetRevisionTests(TransactionApiFixture):
    def test_stale_directory_form_gets_409(self):
        state = self.client.get('/api/erp/state').json()
        party = next(row for row in state['parties'] if row['id'] == self.party.pk)
        saved = self.call('post', '/api/erp/entities/parties', {'id': party['id'], 'name': 'Renamed', 'kind': 'supplier', 'revision': party['revision']})
        self.assertEqual(saved.status_code, 200, saved.content)
        stale = self.call('post', '/api/erp/entities/parties', {'id': party['id'], 'name': 'Older form', 'kind': 'supplier', 'phone': '1', 'revision': party['revision']})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(Counterparty.objects.get(pk=self.party.pk).name, 'Renamed')
        self.assertEqual(self.call('post', '/api/erp/entities/parties', {'id': party['id'], 'name': 'No version', 'kind': 'supplier'}).status_code, 409)
        self.assertEqual(self.call('post', '/api/erp/entities/parties', {'name': 'New', 'kind': 'customer'}).status_code, 200)

    def test_stale_timesheet_form_gets_409(self):
        employee = Employee.objects.create(name='Worker', store=self.store, shift_rate=300)
        created = self.call('post', '/api/erp/work-shifts', {'employee': employee.pk, 'date': self.today, 'units': 1})
        self.assertEqual(created.status_code, 200, created.content)
        row = self.client.get('/api/erp/work-shifts', {'id': created.json()['id']}).json()['items'][0]
        value = {'id': row['id'], 'employee': employee.pk, 'date': self.today, 'units': 1}
        self.assertEqual(self.call('post', '/api/erp/work-shifts', {**value, 'shift_rate': 350, 'revision': row['revision']}).status_code, 200)
        stale = self.call('post', '/api/erp/work-shifts', {**value, 'shift_rate': 999, 'revision': row['revision']})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(WorkShift.objects.get().shift_rate, 350)

    def test_only_editing_roles_receive_directory_versions(self):
        Employee.objects.create(name='Worker', store=self.store, shift_rate=300)
        self.u.profile.role = 'manager'
        self.u.profile.save()
        state = self.client.get('/api/erp/state').json()
        self.assertNotIn('revision', state['employees'][0])
        self.assertIn('revision', state['parties'][0])
