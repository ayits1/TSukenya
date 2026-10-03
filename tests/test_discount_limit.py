"""B07 cashier discount limit, manager approval, below-cost rule, snapshot and owner-only setting. Isolated data only."""
import hashlib
import json
import time
from decimal import Decimal
from server.erp.models import *
from server.erp.services import *
from tests.test_unit_and_drafts import ApiFixture


class DiscountBase(ApiFixture):
    def setUp(self):
        super().setUp()
        self.p.data = {'name': 'Product', 'unit': 'шт', 'cost': '100', 'markup': 30}; self.p.save()  # catalogue price 130.00
        self.cashier = self.login('cashier', 'cashier'); self.manager = self.login('manager', 'manager')
        self.v('receipt', 20, 100)

    def login(self, name, role):
        user = User.objects.create(username=name); Profile.objects.create(user=user, role=role, store=self.store); return user

    def draft(self, user, price, reason='', qty=1, **extra):
        payload = {'payments': [{'account': self.bank.pk, 'amount': str(money(Decimal(str(price)) * qty))}], 'discount_reason': reason}
        d = {'kind': 'sale', 'store': self.store.pk, 'warehouse': self.wh.pk, 'date': self.today, 'party': self.customer.pk, 'lines': [{'product': 'p', 'quantity': qty, 'price': price}], 'payload': payload}
        d.update(extra); return save_voucher(user, d)

    def refuses(self, user, v, *needles):
        with self.assertRaises(BusinessError) as ctx: post_voucher(user, v.pk)
        for n in needles: self.assertIn(n, str(ctx.exception))
        self.assertEqual(Voucher.objects.get(pk=v.pk).status, 'draft')

    def set_limit(self, percent):
        response = self.call('post', '/api/erp/discount-limit', {'percent': percent}); self.assertEqual(response.status_code, 200, response.content)


class DiscountLimitTests(DiscountBase):
    def test_full_price_needs_no_reason_and_no_snapshot(self):
        v = post_voucher(self.cashier, self.draft(self.cashier, 130).pk)
        self.assertEqual(v.status, 'posted'); self.assertNotIn('discounts', v.payload)

    def test_cashier_within_limit_with_reason_leaves_snapshot(self):
        v = post_voucher(self.cashier, self.draft(self.cashier, '117.00', 'Постійний клієнт').pk)
        self.assertEqual(v.status, 'posted')
        self.assertEqual(v.payload['discounts'], [{'product': 'p', 'name': 'Product', 'catalogue_price': '130.00', 'effective_price': '130.00', 'price': '117.0000', 'discount_percent': '10.00', 'below_cost': False, 'author': 'cashier', 'reason': 'Постійний клієнт'}])
        self.assertNotIn('"cost"', json.dumps(v.payload))

    def test_discount_without_reason_is_refused(self):
        self.refuses(self.cashier, self.draft(self.cashier, 120), 'Вкажіть причину знижки')

    def test_cashier_above_limit_is_refused_and_manager_approves_with_reason(self):
        draft = self.draft(self.cashier, 110, 'Кінець терміну')
        self.refuses(self.cashier, draft, 'перевищує ліміт касира 10%')
        self.assertEqual(StockLot.objects.get().quantity, 20)
        posted = post_voucher(self.manager, draft.pk)
        self.assertEqual(posted.payload['discounts'][0]['author'], 'manager'); self.assertEqual(posted.payload['discounts'][0]['discount_percent'], '15.38')
        no_reason = self.draft(self.manager, 110)
        self.refuses(self.manager, no_reason, 'Вкажіть причину знижки')

    def test_below_cost_is_refused_for_cashier_without_exposing_cost(self):
        self.set_limit(100)
        draft = self.draft(self.cashier, 90, 'Розпродаж')
        with self.assertRaises(BusinessError) as ctx: post_voucher(self.cashier, draft.pk)
        self.assertIn('нижче собівартості', str(ctx.exception)); self.assertNotIn('100', str(ctx.exception))
        self.assertEqual(post_voucher(self.manager, draft.pk).payload['discounts'][0]['below_cost'], True)

    def test_limit_is_a_setting_and_zero_forbids_any_cashier_discount(self):
        self.set_limit(0)
        self.refuses(self.cashier, self.draft(self.cashier, '129.99', 'Копійка'), 'ліміт касира 0%')
        self.set_limit('12.5'); self.assertEqual(post_voucher(self.cashier, self.draft(self.cashier, 114, 'Акція дня').pk).status, 'posted')

    def test_active_promotion_is_the_effective_price(self):
        self.p.data = {**self.p.data, 'promotion': True, 'promotionPrice': '120.00'}; self.p.save()
        self.assertEqual(post_voucher(self.cashier, self.draft(self.cashier, 120).pk).status, 'posted')  # equals the promotion, no discount
        self.set_limit(5); self.refuses(self.cashier, self.draft(self.cashier, 111, 'Торг'), 'ліміт касира')
        self.assertEqual(post_voucher(self.cashier, self.draft(self.cashier, 114, 'Торг').pk).payload['discounts'][0]['catalogue_price'], '130.00')

    def test_catalogue_change_after_save_is_checked_at_posting(self):
        draft = self.draft(self.cashier, 120, 'Знижка')
        self.p.data = {**self.p.data, 'markup': 80}; self.p.save()  # price becomes 180
        self.refuses(self.cashier, draft, 'перевищує ліміт')

    def test_client_cannot_inject_snapshot(self):
        draft = self.draft(self.cashier, 130, payload={'payments': [{'account': self.bank.pk, 'amount': '130'}], 'discounts': [{'x': 1}]})
        self.assertNotIn('discounts', post_voucher(self.cashier, draft.pk).payload)

    def test_price_fixed_in_approved_order_is_not_a_new_discount(self):
        order = save_voucher(self.manager, {'kind': 'customer_order', 'store': self.store.pk, 'warehouse': self.wh.pk, 'date': self.today, 'party': self.customer.pk, 'lines': [{'product': 'p', 'quantity': 1, 'price': 100}], 'payload': {'discount_reason': 'Оптова ціна'}})
        post_voucher(self.manager, order.pk)
        sale = self.draft(self.cashier, 100, reference=order.pk)
        self.assertEqual(post_voucher(self.cashier, sale.pk).status, 'posted')

    def test_customer_order_is_checked_at_save(self):
        body = {'kind': 'customer_order', 'store': self.store.pk, 'warehouse': self.wh.pk, 'date': self.today, 'party': self.customer.pk, 'lines': [{'product': 'p', 'quantity': 1, 'price': 100}], 'payload': {'discount_reason': 'Опт'}}
        with self.assertRaises(BusinessError): save_voucher(self.cashier, body)
        self.assertEqual(Voucher.objects.filter(kind='customer_order').count(), 0)
        self.assertEqual(save_voucher(self.manager, body).payload['discounts'][0]['author'], 'manager')


class DiscountBoundaryTests(DiscountBase):
    def order(self, user, price, reason='', **payload):
        return save_voucher(user, {'kind': 'customer_order', 'store': self.store.pk, 'warehouse': self.wh.pk,
            'date': self.today, 'party': self.customer.pk, 'lines': [{'product': 'p', 'quantity': 1, 'price': price}],
            'payload': {'discount_reason': reason, **payload}})

    def receipt_cost(self, price):
        reverse_voucher(self.u, Voucher.objects.get(kind='receipt').pk, 'Виправлення закупівлі')
        self.v('receipt', 20, price)

    def test_below_cost_uses_all_consumed_lots_not_catalogue_or_first_lot(self):
        reverse_voucher(self.u, Voucher.objects.get(kind='receipt').pk, 'Виправлення закупівлі')
        self.v('receipt', 1, 80); self.v('receipt', 1, 200)
        draft = self.draft(self.cashier, 130, qty=2)
        self.refuses(self.cashier, draft, 'нижче собівартості')
        self.assertEqual(sum(StockLot.objects.values_list('quantity', flat=True)), 2)
        posted = post_voucher(self.manager, self.draft(self.manager, 130, 'Опт', qty=2).pk)
        self.assertEqual(posted.cost, 280)
        self.assertTrue(posted.payload['discounts'][0]['below_cost'])

    def test_full_promotion_below_cost_needs_manager_reason(self):
        self.p.data = {**self.p.data, 'promotion': True, 'promotionPrice': '80'}; self.p.save()
        draft = self.draft(self.cashier, 80)
        self.refuses(self.cashier, draft, 'нижче собівартості')
        self.refuses(self.manager, draft, 'Вкажіть причину')
        manager = post_voucher(self.manager, self.draft(self.manager, 80, 'Розпродаж').pk)
        self.assertTrue(manager.payload['discounts'][0]['below_cost'])
        self.assertEqual(manager.payload['discounts'][0]['discount_percent'], '0.00')

    def test_full_catalogue_price_uses_actual_receipt_cost_and_rolls_back(self):
        self.receipt_cost(150)
        draft = self.draft(self.cashier, 130)
        entries = StockEntry.objects.count()
        self.refuses(self.cashier, draft, 'нижче собівартості')
        self.refuses(self.manager, draft, 'Вкажіть причину')
        self.assertEqual(StockLot.objects.filter(quantity__gt=0).get().quantity, 20)
        self.assertEqual(StockLot.objects.filter(quantity__gt=0).get().value, 3000)
        self.assertEqual(StockEntry.objects.count(), entries)
        self.assertEqual(CashEntry.objects.count(), 0)
        self.assertEqual(Voucher.objects.get(pk=draft.pk).lines.get().cost, 0)
        posted = post_voucher(self.manager, self.draft(self.manager, 130, 'Узгоджена ціна').pk)
        self.assertEqual(posted.cost, 150)
        self.assertTrue(posted.payload['discounts'][0]['below_cost'])

    def test_cashier_price_above_actual_cost_ignores_stale_catalogue_cost(self):
        self.receipt_cost(80); self.set_limit(100)
        posted = post_voucher(self.cashier, self.draft(self.cashier, 95, 'Знижка').pk)
        self.assertEqual(posted.cost, 80)
        self.assertFalse(posted.payload['discounts'][0]['below_cost'])

    def test_order_posting_rechecks_current_price_and_overwrites_draft_author(self):
        order = self.order(self.cashier, 130, 'Опт')
        self.assertNotIn('price_approvals', order.payload)
        self.p.data = {**self.p.data, 'markup': 100}; self.p.save()
        self.refuses(self.cashier, order, 'перевищує ліміт')
        approved = post_voucher(self.manager, order.pk)
        self.assertEqual(approved.payload['discounts'][0]['author'], 'manager')
        self.assertEqual(approved.payload['price_approvals'][0]['role'], 'manager')
        sale = self.draft(self.cashier, 130, reference=order.pk)
        self.assertEqual(post_voucher(self.cashier, sale.pk).status, 'posted')

    def test_legacy_order_without_posting_proof_cannot_bypass_discount_limit(self):
        order = post_voucher(self.manager, self.order(self.manager, 100, 'Опт').pk)
        order.payload.pop('price_approvals'); order.save(update_fields=['payload'])
        self.refuses(self.cashier, self.draft(self.cashier, 100, 'Опт', reference=order.pk), 'перевищує ліміт')

    def test_client_cannot_inject_price_approval_and_posted_cashier_price_is_fixed(self):
        order = self.order(self.cashier, 130, price_approvals=[{'line': 1, 'price': '1'}])
        self.assertNotIn('price_approvals', order.payload)
        order = post_voucher(self.cashier, order.pk)
        self.assertEqual(order.payload['price_approvals'][0]['author'], 'cashier')
        self.p.data = {**self.p.data, 'markup': 100}; self.p.save()
        self.assertEqual(post_voucher(self.cashier, self.draft(self.cashier, 130, reference=order.pk).pk).status, 'posted')
        # A further reduction is a new discount and is checked against today's price.
        order2 = post_voucher(self.manager, self.order(self.manager, 130, 'Опт').pk)
        self.refuses(self.cashier, self.draft(self.cashier, 129, 'Ще знижка', reference=order2.pk), 'перевищує ліміт')

    def test_manager_approved_below_cost_order_still_forbids_cashier_loss(self):
        order = post_voucher(self.manager, self.order(self.manager, 90, 'Розпродаж').pk)
        self.refuses(self.cashier, self.draft(self.cashier, 90, reference=order.pk), 'нижче собівартості')
        self.refuses(self.manager, self.draft(self.manager, 90, reference=order.pk), 'Вкажіть причину')
        self.assertTrue(post_voucher(self.manager, self.draft(self.manager, 90, 'Затверджено', reference=order.pk).pk).payload['discounts'][0]['below_cost'])

    def test_cashier_discount_dto_hides_loss_flag_without_mutating_model(self):
        from server.erp.reporting import voucher_json
        posted = post_voucher(self.manager, self.draft(self.manager, 90, 'Розпродаж').pk)
        before = json.loads(json.dumps(posted.payload))
        cashier = voucher_json(posted, True, user=self.cashier)
        owner = voucher_json(posted, True, user=self.u)
        self.assertNotIn('below_cost', cashier['payload']['discounts'][0])
        self.assertNotIn('cost', cashier)
        self.assertNotIn('cost', cashier['lines'][0])
        self.assertNotIn('value', cashier['movements'][0])
        self.assertTrue(owner['payload']['discounts'][0]['below_cost'])
        self.assertEqual(posted.payload, before)
        self.assertEqual(Voucher.objects.get(pk=posted.pk).payload, before)


class DiscountApiTests(DiscountBase):
    def session(self, user, token):
        self.client.cookies['ts_session'] = token
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), user=user, csrf='b-csrf', expires=int(time.time()) + 3600)

    def test_cashier_api_detail_of_manager_loss_sale_hides_cost_flag(self):
        posted = post_voucher(self.manager, self.draft(self.manager, 90, 'Розпродаж').pk)
        self.session(self.cashier, 'loss-cashier')
        response = self.client.get(f'/api/erp/vouchers/{posted.pk}')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertNotIn('below_cost', response.json()['payload']['discounts'][0])
        self.assertTrue(Voucher.objects.get(pk=posted.pk).payload['discounts'][0]['below_cost'])

    def test_setting_is_owner_only_validated_and_audited(self):
        for user, token in ((self.cashier, 'tc'), (self.manager, 'tm')):
            self.session(user, token)
            self.assertEqual(self.call('post', '/api/erp/discount-limit', {'percent': 50}).status_code, 403)
        self.assertEqual(discount_limit(), 10)
        self.client.cookies['ts_session'] = 'isolated-b03-b06-token'
        for bad in (-1, 101, 'abc', None, '5.555', 'NaN'):
            self.assertEqual(self.call('post', '/api/erp/discount-limit', {'percent': bad}).status_code, 400, bad)
        self.assertEqual(self.call('post', '/api/erp/discount-limit', {'percent': '7,5'}).json(), {'percent': '7.5'})
        self.set_limit(0)
        events = list(AuditEvent.objects.filter(action='discount_limit_changed').order_by('pk').values_list('detail', flat=True))
        self.assertEqual(events, [{'old': '10', 'new': '7.5'}, {'old': '7.5', 'new': '0'}])
        self.assertEqual(self.client.get('/api/erp/state').json()['max_discount'], '0')

    def test_direct_api_cannot_bypass_the_limit(self):
        self.session(self.cashier, 'tc')
        body = {'kind': 'sale', 'store': self.store.pk, 'warehouse': self.wh.pk, 'date': self.today, 'party': self.customer.pk, 'lines': [{'product': 'p', 'quantity': 1, 'price': 50}], 'payload': {'payments': [{'account': self.bank.pk, 'amount': '50'}], 'discount_reason': 'Обхід'}}
        created = self.call('post', '/api/erp/vouchers', body); self.assertEqual(created.status_code, 201, created.content)
        post = self.call('post', f"/api/erp/vouchers/{created.json()['id']}/post", {})
        self.assertEqual(post.status_code, 400); self.assertIn('нижче собівартості', post.json()['error']); self.assertNotIn('100', post.json()['error'])
        self.assertEqual(Voucher.objects.filter(kind='sale', status='posted').count(), 0)
        self.assertEqual(self.call('post', '/api/erp/vouchers', {**body, 'idempotency_key': 'k2', 'lines': [{'product': 'p', 'quantity': 1, 'price': 100}]}).status_code, 201)
