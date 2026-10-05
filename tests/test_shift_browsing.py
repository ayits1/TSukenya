import hashlib
import time
from datetime import date, datetime, timedelta, timezone as datetime_timezone
from unittest.mock import patch

from django.contrib.auth.models import User
from django.test import TransactionTestCase
from django.utils import timezone

from server.erp.models import (
    CashAccount, CashShift, Employee, LedgerLock, PortalSession, Profile, Store,
    Voucher, WorkShift,
)
from server.erp.shift_browsing import WORK_FIELDS


class ShiftBrowsingTests(TransactionTestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.store = Store.objects.create(name='Магазин A')
        self.other_store = Store.objects.create(name='Магазин B')
        self.employee = Employee.objects.create(name='Працівник A', store=self.store, shift_rate='500', bonus_percent='3')
        self.other_employee = Employee.objects.create(name='Працівник B', store=self.other_store)
        self.account = CashAccount.objects.create(name='Каса A', store=self.store)
        self.owner = self.user('owner', 'owner')
        self.accountant = self.user('accountant', 'accountant', self.store)
        self.cashier = self.user('cashier', 'cashier', self.store)
        self.manager = self.user('manager', 'manager', self.store)
        self.cash = CashShift.objects.bulk_create([
            CashShift(store=self.store, account=self.account, employee=self.employee,
                      opened_by=self.owner, opening_cash='100',
                      closed_at=datetime(2026, 10, 1, 8, tzinfo=datetime_timezone.utc) if index else None)
            for index in range(130)
        ])
        CashShift.objects.all().update(opened_at=datetime(2026, 9, 30, 19, tzinfo=datetime_timezone.utc))
        self.work = WorkShift.objects.bulk_create([
            WorkShift(employee=self.employee, store=self.store, date=date(2024, 1, 1) + timedelta(days=index),
                      units='1', shift_rate='500', bonus_percent='0', bonus_basis='store')
            for index in range(520)
        ])

        self.sign_in(self.owner)

    @classmethod
    def user(cls, name, role, store=None):
        user = User.objects.create(username=name)
        Profile.objects.create(user=user, role=role, store=store)
        return user

    def sign_in(self, user):
        token = f'isolated-shift-{user.pk}'
        PortalSession.objects.update_or_create(token_hash=hashlib.sha256(token.encode()).hexdigest(),
            defaults={'user': user, 'csrf': 'isolated-csrf', 'expires': int(time.time()) + 3600})
        self.client.cookies['ts_session'] = token

    def get(self, resource, **params):
        result = self.client.get('/api/erp/' + resource, params)
        self.assertEqual(result.status_code, 200, result.content)
        return result.json()

    def test_cash_paging_exact_old_id_and_all_active_state(self):
        first = self.get('shifts')
        self.assertEqual((first['total'], first['page'], first['pages'], len(first['items'])), (130, 1, 5, 30))
        last = self.get('shifts', page='999')
        self.assertEqual((last['page'], len(last['items'])), (5, 10))
        oldest = self.get('shifts', id=str(self.cash[0].pk))['items'][0]
        self.assertEqual(oldest['opening_cash'], '100.00')
        self.assertEqual(oldest['opened_by'], self.owner.username)
        self.assertEqual(set(oldest), {'id', 'store_id', 'account_id', 'employee_id', 'opened_at',
                                     'closed_at', 'opening_cash', 'expected_cash', 'counted_cash', 'opened_by'})
        state = self.get('state')
        self.assertEqual((state['shifts_total'], len(state['shifts'])), (130, 100))
        self.assertNotIn(self.cash[0].pk, [item['id'] for item in state['shifts']])
        self.assertEqual([item['id'] for item in state['active_shifts']], [self.cash[0].pk])
        self.assertEqual(self.get('shifts', status='open')['total'], 1)
        self.assertEqual(self.get('shifts', status='closed')['total'], 129)

    @patch('server.erp.shift_browsing.timezone.localdate', return_value=date(2026, 10, 3))
    def test_local_kyiv_dates_and_midnight_day_containment(self, localdate):
        identifier = self.cash[1].pk
        # September 30 in UTC, October 1 in Kyiv; closed after the next local midnight.
        CashShift.objects.filter(pk=identifier).update(
            opened_at=datetime(2026, 9, 30, 21, 30, tzinfo=datetime_timezone.utc),
            closed_at=datetime(2026, 10, 1, 21, 30, tzinfo=datetime_timezone.utc),
        )
        self.assertEqual(self.get('shifts', id=str(identifier), **{'from': '2026-10-01', 'to': '2026-10-01'})['total'], 1)
        self.assertEqual(self.get('shifts', id=str(identifier), **{'to': '2026-09-30'})['total'], 0)
        self.assertEqual(self.get('shifts', id=str(identifier), day='2026-10-02')['total'], 1)
        self.assertEqual(self.get('shifts', id=str(identifier), day='2026-09-30')['total'], 0)
        self.assertEqual(self.get('shifts', id=str(identifier), day='2026-10-03')['total'], 0)
        self.assertEqual(self.get('shifts', id=str(self.cash[0].pk), day='2026-10-03')['total'], 1)

    def test_work_paging_old_exact_and_selected_ids_preserves_dto(self):
        result = self.get('work-shifts')
        self.assertEqual((result['total'], result['pages'], len(result['items'])), (520, 18, 30))
        self.assertEqual(set(result['items'][0]), set(WORK_FIELDS) | {'revision'})
        last = self.get('work-shifts', page='999')
        self.assertEqual((last['page'], len(last['items'])), (18, 10))
        self.assertEqual(self.get('work-shifts', id=str(self.work[0].pk))['items'][0]['date'], '2024-01-01')
        selected = self.get('work-shifts', ids=f'{self.work[0].pk},{self.work[519].pk},{self.work[0].pk}')
        self.assertEqual(selected['total'], 2)
        self.assertEqual({x['id'] for x in selected['items']}, {self.work[0].pk, self.work[519].pk})
        state = self.get('state')
        self.assertEqual((state['work_shifts_total'], len(state['work_shifts'])), (520, 500))

    def test_payroll_eligibility_dates_closed_cash_and_unaccrued_records(self):
        payroll = Voucher.objects.create(kind='payroll', status='posted', date='2024-01-01',
                                         store=self.store, employee=self.employee, created_by=self.owner)
        WorkShift.objects.filter(pk=self.work[0].pk).update(payroll=payroll)
        WorkShift.objects.filter(pk=self.work[1].pk).update(cash_shift=self.cash[0])
        WorkShift.objects.filter(pk=self.work[2].pk).update(cash_shift=self.cash[1])
        result = self.get('work-shifts', eligible='payroll', employee=str(self.employee.pk), **{'to': '2024-01-04'})
        self.assertEqual({x['id'] for x in result['items']}, {self.work[2].pk, self.work[3].pk})
        self.assertEqual(self.get('work-shifts', eligible='payroll', ids=f'{self.work[0].pk},{self.work[1].pk}')['items'], [])
        # Browsing existing accrued records remains possible when eligible is absent.
        self.assertEqual(self.get('work-shifts', id=str(self.work[0].pk))['total'], 1)
        self.assertEqual(self.get('work-shifts', **{'from': '2024-01-03', 'to': '2024-01-03'})['total'], 1)

    def test_salary_and_store_guards_apply_to_every_lookup_and_state(self):
        foreign_account = CashAccount.objects.create(name='Каса B', store=self.other_store)
        foreign_cash = CashShift.objects.create(store=self.other_store, account=foreign_account,
            employee=self.other_employee, opened_by=self.owner, opening_cash='0')
        foreign_work = WorkShift.objects.create(employee=self.other_employee, store=self.other_store,
            date='2024-01-01', units='1', shift_rate='0', bonus_percent='0', bonus_basis='store')
        self.sign_in(self.accountant)
        self.assertEqual(self.get('shifts')['total'], 130)
        self.assertEqual(self.get('shifts', id=str(foreign_cash.pk))['items'], [])
        self.assertEqual(self.get('shifts', store=str(self.other_store.pk))['items'], [])
        self.assertEqual(self.get('work-shifts', id=str(foreign_work.pk))['items'], [])
        self.assertEqual(self.get('work-shifts', employee=str(self.other_employee.pk))['items'], [])
        selected = self.get('work-shifts', ids=f'{self.work[0].pk},{foreign_work.pk}')
        self.assertEqual([x['id'] for x in selected['items']], [self.work[0].pk])
        self.assertEqual(self.get('state')['shifts_total'], 130)
        for user in [self.cashier, self.manager]:
            self.sign_in(user)
            self.assertEqual(self.client.get('/api/erp/work-shifts').status_code, 403)
            self.assertEqual(self.client.get('/api/erp/work-shifts', {'ids': str(self.work[0].pk)}).status_code, 403)
            self.assertEqual(self.get('shifts')['total'], 130)
            state = self.get('state')
            self.assertNotIn('work_shifts', state)
            self.assertNotIn('work_shifts_total', state)
            self.assertEqual([x['id'] for x in state['active_shifts']], [self.cash[0].pk])

    def test_warehouse_role_sees_no_till_counts(self):
        self.sign_in(self.user('warehouse', 'warehouse', self.store))
        self.assertEqual(self.client.get('/api/erp/shifts').status_code, 403)
        state = self.get('state')
        self.assertEqual((state['shifts'], state['shifts_total'], state['active_shifts']), ([], 0, []))

    def test_validation_and_empty_page_clamp(self):
        for resource, params in [
            ('shifts', {'page': '²'}), ('shifts', {'page': '0'}), ('shifts', {'store': 'abc'}),
            ('shifts', {'status': 'posted'}), ('shifts', {'day': '2026-99-01'}),
            ('shifts', {'from': '2026-10-03', 'to': '2026-10-01'}),
            ('work-shifts', {'ids': '1,,2'}), ('work-shifts', {'employee': '-1'}),
            ('work-shifts', {'eligible': 'unknown'}), ('work-shifts', {'ids': ','.join(['1'] * 1001)}),
        ]:
            with self.subTest(resource=resource, params=params):
                self.assertEqual(self.client.get('/api/erp/' + resource, params).status_code, 400)
        result = self.get('shifts', employee=str(self.other_employee.pk), page='999')
        self.assertEqual(result, {'items': [], 'total': 0, 'page': 1, 'pages': 1})

    def test_open_shift_does_not_match_a_future_attendance_day(self):
        future = (timezone.localdate() + timedelta(days=1)).isoformat()
        response = self.client.get('/api/erp/shifts', {'id': str(self.cash[0].pk), 'day': future})
        self.assertEqual(response.status_code, 400)
        self.assertIn('майбутньому', response.json()['error'])
