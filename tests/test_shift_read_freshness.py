"""B24 legacy pickers: fresh grants and one read-only snapshot, unchanged DTOs."""
from datetime import timedelta
from threading import Thread
from unittest.mock import patch

from django.db import close_old_connections, connection, transaction
from django.test import RequestFactory, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from server.erp import shift_browsing as reads
from server.erp.models import CashAccount, CashShift, Employee, Profile, Store, User, WorkShift
from server.erp.services import BusinessError
from server.erp.views import portal


class ShiftReadFreshnessTests(TransactionTestCase):
    def setUp(self):
        self.actor = User.objects.create(username='picker-owner')
        Profile.objects.create(user=self.actor, role='owner')
        self.store = Store.objects.create(name='Дозволений магазин')
        self.foreign = Store.objects.create(name='Інший магазин')
        self.employee = Employee.objects.create(store=self.store, name='Працівник', shift_rate='123.45')
        self.other = Employee.objects.create(store=self.foreign, name='Приватний працівник', shift_rate='999.99')
        self.account = CashAccount.objects.create(store=self.store, name='Каса')
        self.other_account = CashAccount.objects.create(store=self.foreign, name='Інша каса')
        self.today = timezone.localdate()
        self.cash = self.till()
        self.work = self.attendance(0, cash_shift=self.cash, bonus_percent='2.000')
        self.foreign_cash = self.till(foreign=True)
        self.foreign_work = self.attendance(0, foreign=True, cash_shift=self.foreign_cash)

    def till(self, foreign=False):
        return CashShift.objects.create(store=self.foreign if foreign else self.store,
            account=self.other_account if foreign else self.account, opened_by=self.actor,
            employee=self.other if foreign else self.employee, opening_cash='10.00', closed_at=timezone.now())

    def attendance(self, index, foreign=False, **values):
        return WorkShift.objects.create(store=self.foreign if foreign else self.store,
            employee=self.other if foreign else self.employee, date=self.today - timedelta(days=index),
            shift_rate='123.45', units='1.00', bonus_percent=values.pop('bonus_percent', '0.000'),
            bonus_basis='store', **values)

    def cached_actor(self):
        # Exactly the object PortalMiddleware obtains before entering the endpoint.
        return User.objects.select_related('profile').get(pk=self.actor.pk)

    def http(self, resource, actor, **params):
        request = RequestFactory().get('/api/erp/' + resource, params)
        request.portal_user = actor
        return portal(request)

    def assert_readonly_sql(self, queries):
        sql = [q['sql'].upper() for q in queries]
        self.assertFalse(any(q.lstrip().startswith(('INSERT ', 'UPDATE ', 'DELETE ')) for q in sql))
        self.assertFalse(any('FOR UPDATE' in q for q in sql))
        if connection.vendor == 'postgresql':
            setting = next(i for i, q in enumerate(sql) if 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY' in q)
            actor = next(i for i, q in enumerate(sql) if 'FROM "AUTH_USER"' in q)
            self.assertLess(setting, actor)

    def test_http_rechecks_role_activity_and_missing_profile_before_private_queries(self):
        for resource, role in [('work-shifts', 'cashier'), ('work-shifts', 'manager'), ('shifts', 'warehouse')]:
            for denial in ('role', 'inactive', 'profile'):
                with self.subTest(resource=resource, denial=denial, role=role):
                    User.objects.filter(pk=self.actor.pk).update(is_active=True)
                    Profile.objects.update_or_create(user=self.actor, defaults={'role': 'owner', 'store': None})
                    cached = self.cached_actor()
                    if denial == 'role':
                        Profile.objects.filter(user=self.actor).update(role=role)
                    elif denial == 'inactive':
                        User.objects.filter(pk=self.actor.pk).update(is_active=False)
                    else:
                        Profile.objects.filter(user=self.actor).delete()
                    with CaptureQueriesContext(connection) as queries:
                        result = self.http(resource, cached, ids=str(self.work.pk))
                    self.assertEqual(result.status_code, 403, result.content)
                    self.assertNotIn(b'123.45', result.content)
                    self.assertFalse(any('FROM "erp_workshift"' in q['sql'] or 'FROM "erp_cashshift"' in q['sql'] for q in queries))
                    self.assert_readonly_sql(queries)

    def test_current_store_exact_ids_hint_and_cashier_dto_are_preserved(self):
        cached = self.cached_actor()
        Profile.objects.filter(user=self.actor).update(role='accountant', store=self.store)
        with CaptureQueriesContext(connection) as queries:
            selected = reads.work_shifts(cached, {'ids': f'{self.work.pk},{self.foreign_work.pk}'})
            foreign = reads.work_shifts(cached, {'id': str(self.foreign_work.pk)})
            hint = reads.work_shifts(cached, {'cash_shift': str(self.cash.pk), 'percent': '1', 'exclude_employee': str(self.other.pk)})
            payroll = reads.work_shifts(cached, {'employee': str(self.employee.pk), 'eligible': 'payroll'})
            foreign_cash = reads.cash_shifts(cached, {'id': str(self.foreign_cash.pk)})
        self.assertEqual([x['id'] for x in selected['items']], [self.work.pk])
        self.assertEqual(set(selected['items'][0]), set(reads.WORK_FIELDS) | {'revision'})
        self.assertEqual(foreign['items'], [])
        self.assertEqual(foreign_cash['items'], [])
        self.assertEqual([x['id'] for x in hint['items']], [self.work.pk])
        self.assertEqual([x['id'] for x in payroll['items']], [self.work.pk])
        self.assert_readonly_sql(queries)
        Profile.objects.filter(user=self.actor).update(role='cashier', store=self.store)
        with CaptureQueriesContext(connection) as queries:
            result = reads.cash_shifts(cached, {})
        self.assertEqual([x['id'] for x in result['items']], [self.cash.pk])
        self.assertEqual(set(result['items'][0]), {'id', 'store_id', 'account_id', 'employee_id', 'opened_at',
            'closed_at', 'opening_cash', 'expected_cash', 'counted_cash', 'opened_by'})
        self.assertFalse(any('shift_rate' in q['sql'] or 'bonus_percent' in q['sql'] or 'FROM "erp_workshift"' in q['sql'] for q in queries))
        self.assert_readonly_sql(queries)

    def test_pg_count_items_and_actor_use_one_readonly_snapshot(self):
        if connection.vendor != 'postgresql':
            self.skipTest('PostgreSQL snapshot and concurrent writer')
        for resource, reader, denied_role in [('shifts', reads.cash_shifts, 'warehouse'), ('work-shifts', reads.work_shifts, 'cashier')]:
            with self.subTest(resource=resource):
                Profile.objects.filter(user=self.actor).update(role='owner', store=None)
                for index in range(1, 30):
                    self.till() if resource == 'shifts' else self.attendance(index)
                cached = self.cached_actor()
                original = reads.page_bounds
                inserted, failures = [], []
                def after_count(*args):
                    bounds = original(*args)
                    with connection.cursor() as cursor:
                        cursor.execute('SHOW transaction_isolation')
                        self.assertEqual(cursor.fetchone()[0], 'repeatable read')
                        cursor.execute('SHOW transaction_read_only')
                        self.assertEqual(cursor.fetchone()[0], 'on')
                    def writer():
                        close_old_connections()
                        try:
                            inserted.append((self.till() if resource == 'shifts' else self.attendance(31)).pk)
                            Profile.objects.filter(user=self.actor).update(role=denied_role, store=self.foreign)
                        except Exception as error:
                            failures.append(error)
                        finally:
                            close_old_connections()
                    thread = Thread(target=writer)
                    thread.start(); thread.join(10)
                    self.assertFalse(thread.is_alive(), 'Writer must commit before page SELECT')
                    self.assertEqual(failures, [])
                    return bounds
                with CaptureQueriesContext(connection) as queries, patch.object(reads, 'page_bounds', after_count):
                    result = reader(cached, {'store': str(self.store.pk), 'page': '2'})
                self.assertEqual((result['total'], result['page'], result['pages'], len(result['items'])), (30, 1, 1, 30))
                self.assertNotIn(inserted[0], [x['id'] for x in result['items']])
                self.assert_readonly_sql(queries)
                self.assertEqual(self.http(resource, cached).status_code, 403)
                Profile.objects.filter(user=self.actor).update(role='owner', store=None)
                self.assertEqual(reader(cached, {'store': str(self.store.pk)})['total'], 31)

    def test_pg_nested_mutable_transaction_is_rejected(self):
        if connection.vendor != 'postgresql':
            self.skipTest('PostgreSQL transaction isolation')
        for reader in (reads.cash_shifts, reads.work_shifts):
            with self.subTest(reader=reader.__name__), transaction.atomic():
                with self.assertRaisesMessage(BusinessError, 'REPEATABLE READ та READ ONLY'):
                    reader(self.actor, {})
