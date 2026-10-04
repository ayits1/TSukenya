"""Current trading permissions after cached authentication and a ledger wait."""
from django.contrib.auth.models import User
from server.erp.models import AuditEvent, CashEntry, CashShift, StockEntry, Voucher
from server.erp.services import BusinessError, post_voucher, reverse_voucher, save_voucher
from server.erp.views import entity_save, shift_action
from server.erp.assortment import save_assortment
from server.erp.monthly_budgets import save_category
from tests.test_erp import AccountingFixture


class TradingActorRevalidationTests(AccountingFixture):
    def setUp(self):
        super().setUp()
        self.payload = {'kind': 'cash_opening', 'store': self.store.pk, 'date': self.today,
                        'account': self.cash.pk, 'amount': '100', 'idempotency_key': 'isolated-trading-actor-create'}
        self.draft = save_voucher(self.u, self.payload)
        self.posted = self.v('cash_opening', amount='200', account=self.bank.pk)

    def snapshot(self):
        return (list(Voucher.objects.values_list('pk', 'status', 'revision', 'payload')),
                CashEntry.objects.count(), StockEntry.objects.count(), CashShift.objects.count(), AuditEvent.objects.count())

    def cached(self):
        return User.objects.select_related('profile').get(pk=self.u.pk)

    def test_inactive_cached_actor_cannot_write_or_receive_posted_create_ack(self):
        actor = self.cached()
        User.objects.filter(pk=actor.pk).update(is_active=False)
        before = self.snapshot()
        operations = [
            lambda: save_voucher(actor, self.payload),  # durable existing create acknowledgement
            lambda: save_voucher(actor, {**self.payload, 'idempotency_key': 'new-isolated-key'}),
            lambda: post_voucher(actor, self.draft.pk),
            lambda: post_voucher(actor, self.posted.pk),  # posted retry must also be refused
            lambda: reverse_voucher(actor, self.posted.pk, 'Перевірка відкликання доступу'),
            lambda: entity_save(actor, 'parties', {'name': 'Unwanted contact', 'kind': 'customer'}),
            lambda: shift_action(actor, {'action': 'open', 'account': self.cash.pk}),
            lambda: save_assortment(actor, {'warehouse': self.wh.pk, 'product': 'p', 'sold': False}),
            lambda: save_category(actor, {'name': 'Unwanted category'}),
        ]
        for index, operation in enumerate(operations):
            with self.subTest(operation=index):
                with self.assertRaisesMessage(BusinessError, 'Обліковий запис вимкнено'):
                    operation()
                self.assertEqual(before, self.snapshot())

    def test_inactive_cached_actor_cannot_change_admin_settings_recipe_or_delete_draft(self):
        from types import SimpleNamespace
        from datetime import timedelta
        from django.test import RequestFactory
        from django.utils import timezone
        from server.erp.models import Document, LedgerLock, Setting
        from server.erp.catalog import revision
        from server.erp.views import handle
        from server.erp.monthly_budgets import save as save_budget
        actor = self.cached()
        User.objects.filter(pk=actor.pk).update(is_active=False)
        routes = [
            ('post', '/api/erp/period', {'date': (timezone.localdate() - timedelta(days=1)).isoformat(), 'reason': 'Перевірка'}),
            ('post', '/api/erp/fiscal', {'required': True}),
            ('post', '/api/erp/discount-limit', {'percent': '20'}),
            ('post', '/api/erp/users', {'username': 'blocked-user', 'role': 'cashier', 'password': 'isolated-blocked-password'}),
            ('post', '/api/erp/recipes', {'product': 'p', 'revision': revision(self.p), 'recipe': []}),
            ('delete', '/api/erp/vouchers/' + str(self.draft.pk), {'revision': self.draft.revision}),
        ]
        before = (self.snapshot(), list(Document.objects.values_list('pk', 'data')), Setting.objects.count(), User.objects.count())
        for method, path, body in routes:
            with self.subTest(path=path):
                request = getattr(RequestFactory(), method)(path, body, content_type='application/json',
                    HTTP_ORIGIN='http://testserver', HTTP_X_CSRF_TOKEN='isolated-actor-csrf')
                request.portal_user = actor
                request.portal_session = SimpleNamespace(csrf='isolated-actor-csrf')
                with self.assertRaisesMessage(BusinessError, 'Обліковий запис вимкнено'):
                    handle(request)
                self.assertEqual(before, (self.snapshot(), list(Document.objects.values_list('pk', 'data')), Setting.objects.count(), User.objects.count()))
                self.assertIsNone(LedgerLock.objects.get(pk=1).closed_through)
        with self.assertRaisesMessage(BusinessError, 'Обліковий запис вимкнено'):
            save_budget(actor, {'month': self.today[:7], 'store': self.store.pk, 'lines': [],
                               'planned_revenue': '100', 'idempotency_key': 'isolated-budget'})

    def test_current_role_and_store_refuse_cached_owner_before_idempotent_ack(self):
        from server.erp.models import Profile, Store
        actor = self.cached()
        Profile.objects.filter(user=actor).update(role='cashier')
        before = self.snapshot()
        with self.assertRaisesMessage(BusinessError, 'роль'):
            save_voucher(actor, self.payload)
        self.assertEqual(before, self.snapshot())
        other = Store.objects.create(name='Forbidden store')
        Profile.objects.filter(user=actor).update(role='owner', store=other)
        with self.assertRaisesMessage(BusinessError, 'магазину'):
            save_voucher(actor, self.payload)
        self.assertEqual(before, self.snapshot())

    def test_allowed_downgraded_sale_serializes_with_current_cashier_redaction(self):
        from server.erp.models import Profile
        from server.erp.reporting import voucher_json
        self.v('receipt', 10, 5)
        payload = {'kind': 'sale', 'store': self.store.pk, 'warehouse': self.wh.pk,
                   'date': self.today, 'lines': [{'product': 'p', 'quantity': '1', 'price': '10'}],
                   'payload': {'payments': [{'account': self.bank.pk, 'amount': '10'}]}}
        draft = save_voucher(self.u, payload)
        actor = self.cached()
        Profile.objects.filter(user=actor).update(role='cashier')
        posted = post_voucher(actor, draft.pk)
        output = voucher_json(posted, True, user=actor)
        self.assertEqual(actor.profile.role, 'cashier')
        self.assertNotIn('cost', output)
        for row in output['lines']:
            self.assertNotIn('cost', row)
            self.assertNotIn('value', row)

    def test_missing_profile_is_refused_without_internal_attribute_error(self):
        from server.erp.models import Profile
        actor = self.cached()
        Profile.objects.filter(user=actor).delete()
        with self.assertRaisesMessage(BusinessError, 'доступ відкликано'):
            save_voucher(actor, self.payload)


from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import monotonic, sleep
from unittest import skipUnless
from unittest.mock import patch
from django.db import connection, connections, close_old_connections, transaction
from django.test import TransactionTestCase
from server.erp.models import Profile, Store
from server.erp.services import ledger_lock


@skipUnless(connection.vendor == 'postgresql', 'Requires actual PostgreSQL ledger wait.')
class TradingActorLedgerWaitTests(TransactionTestCase):
    def setUp(self):
        AccountingFixture.setUp(self)

    def wait_and_revoke(self, change, message):
        import server.erp.services as services
        actor = User.objects.select_related('profile').get(pk=self.u.pk)
        entered = Event()
        pid = []
        real_lock = ledger_lock

        def waiting_lock():
            with connection.cursor() as cursor:
                cursor.execute('SELECT pg_backend_pid()')
                pid.append(cursor.fetchone()[0])
            entered.set()
            return real_lock()

        def worker():
            close_old_connections()
            try:
                with patch.object(services, 'ledger_lock', waiting_lock):
                    try:
                        save_voucher(actor, {'kind': 'cash_opening', 'store': self.store.pk,
                            'date': self.today, 'account': self.cash.pk, 'amount': '100'})
                    except BusinessError as error:
                        return str(error)
                    return 'unexpected write'
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=1) as pool:
            with transaction.atomic():
                real_lock()
                with connection.cursor() as cursor:
                    cursor.execute('SELECT pg_backend_pid()')
                    holder = cursor.fetchone()[0]
                future = pool.submit(worker)
                self.assertTrue(entered.wait(5))
                deadline, blocked = monotonic() + 4, False
                while monotonic() < deadline:
                    with connection.cursor() as cursor:
                        cursor.execute('SELECT pg_blocking_pids(%s)', [pid[0]])
                        blocked = holder in cursor.fetchone()[0]
                    if blocked:
                        break
                    sleep(.01)
                self.assertTrue(blocked, 'Accounting request must actually wait on LedgerLock')
                self.assertFalse(future.done())
                change()
            self.assertIn(message, future.result(10))
        self.assertEqual(Voucher.objects.count(), 0)
        self.assertEqual(CashEntry.objects.count(), 0)
        self.assertEqual(AuditEvent.objects.count(), 0)

    def test_deactivation_during_real_ledger_wait_is_refused(self):
        self.wait_and_revoke(lambda: User.objects.filter(pk=self.u.pk).update(is_active=False), 'Обліковий запис вимкнено')

    def test_role_change_during_real_ledger_wait_is_refused(self):
        self.wait_and_revoke(lambda: Profile.objects.filter(user=self.u).update(role='cashier'), 'роль')

    def test_store_change_during_real_ledger_wait_is_refused(self):
        other = Store.objects.create(name='Other scoped store')
        self.wait_and_revoke(lambda: Profile.objects.filter(user=self.u).update(store=other), 'магазину')
