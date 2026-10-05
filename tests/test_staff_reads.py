"""Staff projections: captured payroll terms, scalar bounds, privacy and snapshots."""
from datetime import timedelta
from decimal import Decimal
from threading import Thread
from unittest.mock import patch

from django.contrib.auth.models import User
from django.db import connection, close_old_connections
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from server.erp.models import Profile, Store, Employee, WorkShift, CashAccount, CashShift, Voucher, LedgerLock
from server.erp.services import BusinessError, record_revision, post_voucher
from server.erp import staff_reads as reads


class StaffReadsTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create(username='staff-owner')
        Profile.objects.create(user=self.user, role='owner')
        self.store = Store.objects.create(name='Крамниця')
        self.other = Store.objects.create(name='Чужий магазин')
        self.employee = Employee.objects.create(name='Працівниця', store=self.store, shift_rate='999.99', bonus_percent='99.999', bonus_basis='store')
        self.account = CashAccount.objects.create(store=self.store, name='Каса')
        self.today = timezone.localdate()
        LedgerLock.objects.create(pk=1)

    def work(self, **kwargs):
        return WorkShift.objects.create(employee=self.employee, store=self.store, date=kwargs.pop('date', self.today),
            units=kwargs.pop('units', '1.00'), shift_rate=kwargs.pop('shift_rate', '100.00'),
            bonus_percent=kwargs.pop('bonus_percent', '0.000'), bonus_basis='store', **kwargs)

    def voucher(self, kind='payroll', **kwargs):
        return Voucher.objects.create(store=self.store, employee=self.employee, date=self.today, kind=kind,
            created_by=self.user, **kwargs)

    def test_exact_captured_terms_two_tills_accrual_and_separate_payout_advance(self):
        tills = [CashShift.objects.create(store=self.store, account=self.account, employee=self.employee,
            opened_by=self.user, closed_at=timezone.now(), opening_cash=0) for _ in range(2)]
        for till, amount in zip(tills, ['100.00', '300.00']):
            self.voucher('sale', status='posted', total=amount, shift=till)
        first = self.work(cash_shift=tills[0], bonus_percent='10.000')
        second = self.work(cash_shift=tills[1], units='2.00', shift_rate='200.00', bonus_percent='5.000')
        payroll = self.voucher(payload={'shift_ids': [first.pk, second.pk]})
        result = post_voucher(self.user, payroll.pk)
        self.assertEqual(result.total, Decimal('525.00'))
        Employee.objects.filter(pk=self.employee.pk).update(shift_rate='777.99', bonus_percent='77.777')
        self.voucher('payroll_payment', status='posted', total='600.98')
        employee = reads.read(self.user, 'employees', {})['items'][0]
        self.assertEqual(employee['payrollDebt'], '-75.98')
        work = reads.read(self.user, 'work-shifts', {})['items']
        terms = {x['id']: x for x in work}
        self.assertEqual((terms[first.pk]['shiftRate'], terms[first.pk]['bonusPercent'], terms[first.pk]['accrued']), ('100.00', '10.000', '110.00'))
        self.assertEqual((terms[second.pk]['units'], terms[second.pk]['accrued']), ('2.00', '415.00'))
        self.assertTrue(all(not x['canEdit'] and x['payroll'] == payroll.pk for x in work))
        self.assertEqual({x['cashShift'] for x in work}, {x.pk for x in tills})

    def test_scalar_pages_versions_large_cents_no_voucher_payload_or_models(self):
        large = '99999999999999.99' if connection.vendor == 'postgresql' else '99999999.99'
        Voucher.objects.bulk_create([Voucher(store=self.store, employee=self.employee, date=self.today,
            kind='payroll', status='posted', total=large, created_by=self.user, payload={'calculation': ['x'] * 10000}) for _ in range(35)])
        works = [self.work(date=self.today - timedelta(days=i), note='Збережена примітка') for i in range(35)]
        with patch.object(Voucher, 'from_db', side_effect=AssertionError('No Voucher models')), CaptureQueriesContext(connection) as queries:
            result = reads.read(self.user, 'documents', {})
        self.assertEqual((result['total'], len(result['items'])), (35, 30))
        self.assertEqual(result['items'][0]['total'], large)
        self.assertFalse(any('"payload"' in x['sql'].split(' FROM ')[0] for x in queries))
        page = reads.read(self.user, 'work-shifts', {'page': '2'})
        self.assertEqual((page['total'], len(page['items'])), (35, 5))
        works[30].refresh_from_db()
        self.assertEqual(page['items'][0]['revision'], record_revision(works[30]))
        WorkShift.objects.filter(pk=works[0].pk).update(note='x' * 250000)
        with CaptureQueriesContext(connection) as queries:
            with self.assertRaisesRegex(BusinessError, '2000'):
                reads.read(self.user, 'work-shifts', {})
        sql = next(x['sql'] for x in queries if 'selected_note' in x['sql'])
        self.assertIn('CASE WHEN', sql)
        self.assertIn('ELSE NULL', sql)

    def test_fresh_role_scope_inactive_captions_closed_period_and_current_revision(self):
        other = Employee.objects.create(store=self.other, name='Приватний працівник', shift_rate='888.98')
        Employee.objects.filter(pk=self.employee.pk).update(active=False)
        work = self.work()
        WorkShift.objects.create(employee=other, store=self.other, date=self.today, shift_rate='888.98', bonus_percent=0, bonus_basis='store')
        Profile.objects.filter(user=self.user).update(role='accountant', store=self.store)
        for resource in ['employees', 'work-shifts', 'documents']:
            result = reads.read(self.user, resource, {})
            self.assertEqual(result['policy']['store'], self.store.pk)
            self.assertFalse(result['policy']['canManageEmployees'])
            self.assertTrue(all(x['store'] == self.store.pk for x in result['items']))
        self.assertFalse(reads.read(self.user, 'employees', {})['items'][0]['active'])
        LedgerLock.objects.filter(pk=1).update(closed_through=self.today)
        self.assertFalse(reads.read(self.user, 'work-shifts', {})['items'][0]['canEdit'])
        work.refresh_from_db()
        self.assertEqual(reads.read(self.user, 'work-shifts', {})['items'][0]['revision'], record_revision(work))
        Profile.objects.filter(user=self.user).update(role='manager')
        for resource in ['employees', 'work-shifts', 'documents']:
            with self.assertRaisesRegex(BusinessError, 'прав'):
                reads.read(self.user, resource, {})
        Profile.objects.filter(user=self.user).update(role='owner')
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        with self.assertRaisesRegex(BusinessError, 'доступ'):
            reads.read(self.user, 'employees', {})

    def test_parameters_refuse_without_writes(self):
        for resource, params in [('employees', {'scope': '1'}), ('documents', {'kind': 'sale'}),
            ('employees', {'q': 'x' * 251}), ('work-shifts', {'from': '2026-02-30'}),
            ('documents', {'status': 'unknown'}), ('work-shifts', {'employee': '-1'})]:
            with self.subTest(resource=resource, params=params), self.assertRaises(BusinessError):
                reads.read(self.user, resource, params)
        with CaptureQueriesContext(connection) as queries:
            reads.read(self.user, 'employees', {})
        self.assertFalse(any(x['sql'].lstrip().split()[0] in {'INSERT', 'UPDATE', 'DELETE'} for x in queries))

    def test_pg_count_items_share_readonly_snapshot(self):
        if connection.vendor != 'postgresql':
            self.skipTest('PostgreSQL snapshot')
        for _ in range(30):
            self.voucher()
        original = reads.bounds
        failures = []
        def between(query, params):
            result = original(query, params)
            def writer():
                close_old_connections()
                try:
                    Voucher.objects.create(store_id=self.store.pk, employee_id=self.employee.pk, date=self.today,
                        kind='payroll', created_by_id=self.user.pk)
                except Exception as error:
                    failures.append(error)
                finally:
                    close_old_connections()
            thread = Thread(target=writer)
            thread.start()
            thread.join(10)
            self.assertFalse(thread.is_alive())
            self.assertEqual(failures, [])
            with connection.cursor() as cursor:
                cursor.execute('SHOW transaction_read_only')
                self.assertEqual(cursor.fetchone()[0], 'on')
            return result
        with patch.object(reads, 'bounds', between):
            result = reads.read(self.user, 'documents', {})
        self.assertEqual((result['total'], len(result['items'])), (30, 30))
        self.assertEqual(reads.read(self.user, 'documents', {})['total'], 31)
