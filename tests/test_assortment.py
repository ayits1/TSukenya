"""B13 warehouse assortment: sold-here flag and per-warehouse minimum drive stock totals, alerts and replenishment. Isolated data only."""
from django.contrib.auth.models import User
from server.erp.alerts import sync_alerts
from server.erp.models import *
from server.erp.replenishment import replenishment
from server.erp.reporting import stock
from tests.test_unit_and_drafts import ApiFixture


class AssortmentTests(ApiFixture):
    def setUp(self):
        super().setUp()
        self.p.data['minStock'] = 2
        self.p.save()

    def totals(self, user=None):
        return {(row['warehouse'], row['product']): row for row in stock(user or self.u)['totals']}

    def low_alerts(self):
        return sorted(d.data['_alertKey'] for d in Document.objects.filter(path__startswith='tasks/auto_') if d.data.get('_alertActive') and d.data['_alertKey'].startswith('low:'))

    def user(self, name, role, store=None):
        u = User.objects.create(username=name)
        Profile.objects.create(user=u, role=role, store=store)
        return u

    def save(self, warehouse, sold=True, min_stock=None, revision=None, product='p', user=None):
        value = {'warehouse': warehouse.pk, 'product': product, 'sold': sold, 'min_stock': min_stock, **({'revision': revision} if revision else {})}
        if user:
            from server.erp.assortment import save_assortment
            return save_assortment(user, value)
        return self.call('post', '/api/erp/assortment', value)

    def test_fallback_without_rows_is_unchanged(self):
        totals = self.totals()
        self.assertEqual({k: (r['minimum'], r['low'], r['sold']) for k, r in totals.items()}, {(self.wh.pk, 'p'): ('2.000', True, True), (self.other.pk, 'p'): ('2.000', True, True)})
        sync_alerts(self.u)
        self.assertEqual(self.low_alerts(), sorted([f'low:{self.other.pk}:p', f'low:{self.wh.pk}:p']))

    def test_not_sold_warehouse_gets_no_alert_or_replenishment(self):
        self.assertEqual(self.save(self.other, sold=False).status_code, 200)
        totals = self.totals()
        self.assertNotIn((self.other.pk, 'p'), totals)
        self.assertTrue(totals[(self.wh.pk, 'p')]['low'])
        sync_alerts(self.u)
        self.assertEqual(self.low_alerts(), [f'low:{self.wh.pk}:p'])
        self.assertEqual([g['warehouse'] for g in replenishment(self.u)['groups']], [self.wh.pk])

    def test_not_sold_product_with_real_stock_stays_in_totals_without_control(self):
        self.v('receipt', 1, 5, warehouse=self.other.pk)
        self.save(self.other, sold=False)
        row = self.totals()[(self.other.pk, 'p')]
        self.assertEqual((row['quantity'], row['sold'], row['low']), ('1.000', False, False))

    def test_warehouse_minimum_overrides_product_minimum(self):
        self.v('receipt', 3, 5)
        self.save(self.wh, min_stock='5')
        self.save(self.other, min_stock='0')
        totals = self.totals()
        self.assertEqual((totals[(self.wh.pk, 'p')]['minimum'], totals[(self.wh.pk, 'p')]['low']), ('5.000', True))
        self.assertNotIn((self.other.pk, 'p'), totals)
        groups = replenishment(self.u)['groups']
        self.assertEqual([(g['warehouse'], g['lines'][0]['quantity'], g['lines'][0]['minimum']) for g in groups], [(self.wh.pk, '2.000', '5.000')])
        sync_alerts(self.u)
        task = [d for d in Document.objects.filter(path__startswith='tasks/auto_') if d.data.get('_alertActive')]
        self.assertEqual(len(task), 1)
        self.assertIn('мінімум 5.000', task[0].data['title'])

    def test_null_row_minimum_falls_back_to_product_minimum(self):
        self.save(self.wh, min_stock='')
        self.assertEqual(self.totals()[(self.wh.pk, 'p')]['minimum'], '2.000')

    def test_sold_out_product_with_history_but_no_minimum_is_listed(self):
        self.p.data.pop('minStock')
        self.p.save()
        self.v('receipt', 2, 5)
        self.sale(2)
        self.assertEqual(StockLot.objects.get().quantity, 0)
        totals = self.totals()
        self.assertEqual(list(totals), [(self.wh.pk, 'p')])
        self.assertEqual((totals[(self.wh.pk, 'p')]['quantity'], totals[(self.wh.pk, 'p')]['low']), ('0.000', False))
        self.assertEqual(stock(self.u)['lots'], [])

    def test_alert_closes_when_product_leaves_assortment(self):
        sync_alerts(self.u)
        self.save(self.other, sold=False)
        result = sync_alerts(self.u)
        self.assertEqual(result['resolved'], 1)
        self.assertEqual(self.low_alerts(), [f'low:{self.wh.pk}:p'])

    def test_api_lists_rows_and_saves_with_revision(self):
        listed = self.client.get(f'/api/erp/assortment?warehouse={self.wh.pk}').json()
        self.assertEqual(listed['rows'], [{'product': 'p', 'name': 'Product', 'unit': 'шт', 'default_min': '2.000', 'sold': True, 'min_stock': None, 'minimum': '2.000', 'revision': None}])
        created = self.save(self.wh, sold=False, min_stock='1.5').json()
        self.assertEqual((created['sold'], created['min_stock'], created['minimum']), (False, '1.500', '1.500'))
        self.assertTrue(AuditEvent.objects.filter(action='assortment_saved').exists())
        # Saving again without the version, or with an old one, is a stale form.
        self.assertEqual(self.save(self.wh, sold=True).status_code, 409)
        updated = self.save(self.wh, sold=True, revision=created['revision'])
        self.assertEqual(updated.status_code, 200)
        stale = self.save(self.wh, sold=False, revision=created['revision'])
        self.assertEqual((stale.status_code, stale.json()['code']), (409, 'revision_conflict'))
        row = Assortment.objects.get()
        self.assertEqual((row.sold, row.min_stock), (True, None))
        self.assertEqual(self.client.get(f'/api/erp/assortment?warehouse={self.wh.pk}').json()['rows'][0]['revision'], updated.json()['revision'])

    def test_create_with_a_version_is_a_conflict(self):
        response = self.save(self.wh, revision='made-up')
        self.assertEqual(response.status_code, 409)
        self.assertFalse(Assortment.objects.exists())

    def test_validation(self):
        self.assertEqual(self.save(self.wh, min_stock='-1').status_code, 400)
        self.assertEqual(self.save(self.wh, min_stock='1.0001').status_code, 400)
        self.assertEqual(self.call('post', '/api/erp/assortment', {'warehouse': self.wh.pk, 'product': 'p', 'sold': 'yes'}).status_code, 400)
        self.assertEqual(self.save(self.wh, product='missing').status_code, 400)
        self.assertFalse(Assortment.objects.exists())

    def test_roles_and_store_scope(self):
        from server.erp.assortment import assortment
        from server.erp.services import BusinessError
        other_store = Store.objects.create(name='Other store')
        foreign = Warehouse.objects.create(store=other_store, name='Foreign')
        for role in ('cashier', 'accountant'):
            with self.assertRaisesMessage(BusinessError, 'Недостатньо прав'):
                assortment(self.user(role, role, self.store), {'warehouse': self.wh.pk})
            with self.assertRaisesMessage(BusinessError, 'Недостатньо прав'):
                self.save(self.wh, user=User.objects.get(username=role))
        for role in ('manager', 'warehouse'):
            u = self.user(role, role, self.store)
            self.assertEqual(len(assortment(u, {'warehouse': self.wh.pk})['rows']), 1)
            with self.assertRaisesMessage(BusinessError, 'Немає доступу'):
                assortment(u, {'warehouse': foreign.pk})
            with self.assertRaisesMessage(BusinessError, 'Немає доступу'):
                self.save(foreign, user=u)
        saved = self.save(self.wh, sold=False, user=User.objects.get(username='manager'))
        self.save(self.wh, sold=True, revision=saved['revision'], user=User.objects.get(username='warehouse'))
        self.assertTrue(Assortment.objects.get().sold)
        # Network owner may edit any store's warehouse.
        self.save(foreign, sold=False, user=self.u)
        self.assertEqual(Assortment.objects.filter(warehouse=foreign).count(), 1)

    def test_http_forbidden_for_cashier(self):
        import hashlib, time
        cashier = self.user('till', 'cashier', self.store)
        PortalSession.objects.create(token_hash=hashlib.sha256(b'till-token').hexdigest(), user=cashier, csrf='till-csrf', expires=int(time.time()) + 3600)
        self.client.cookies['ts_session'] = 'till-token'
        self.headers = {'HTTP_ORIGIN': 'http://testserver', 'HTTP_X_CSRF_TOKEN': 'till-csrf'}
        self.assertEqual(self.client.get(f'/api/erp/assortment?warehouse={self.wh.pk}').status_code, 403)
        self.assertEqual(self.save(self.wh).status_code, 403)

    def test_store_manager_stock_uses_rows_of_own_warehouses(self):
        manager = self.user('m', 'manager', self.store)
        self.save(self.other, sold=False)
        self.assertEqual(list(self.totals(manager)), [(self.wh.pk, 'p')])
