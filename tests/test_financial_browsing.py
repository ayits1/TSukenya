import hashlib
import time
from datetime import datetime, timedelta, timezone as datetime_timezone
from decimal import Decimal

from django.contrib.auth.models import User
from django.db import connection
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from server.erp.models import AuditEvent, CashAccount, CashEntry, Counterparty, LedgerLock, PortalSession, Profile, Store, Voucher
from server.erp.services import obligation


class FinancialBrowsingTests(TransactionTestCase):
    @classmethod
    def seed(cls):
        LedgerLock.objects.create(pk=1)
        cls.store = Store.objects.create(name='Магазин A')
        cls.other_store = Store.objects.create(name='Магазин B')
        cls.owner = cls.user('owner', 'owner')
        cls.manager = cls.user('manager', 'manager', cls.store)
        cls.accountant = cls.user('accountant', 'accountant', cls.store)
        cls.cashier = cls.user('cashier', 'cashier', cls.store)
        cls.party = Counterparty.objects.create(name='Постачальник сонце', kind='supplier')
        cls.customer = Counterparty.objects.create(name='Покупець', kind='customer')
        cls.account = CashAccount.objects.create(name='Банк A', kind='bank', store=cls.store)
        cls.foreign_account = CashAccount.objects.create(name='Банк B', kind='bank', store=cls.other_store)
        cls.today = timezone.localdate()
        cls.expenses = Voucher.objects.bulk_create([
            Voucher(kind='expense', status='posted', date=cls.today, store=cls.store,
                    account=cls.account, total='10', note=f'Операція {index}', created_by=cls.owner)
            for index in range(65)
        ])
        cls.entries = CashEntry.objects.bulk_create([
            CashEntry(voucher=voucher, account=cls.account, amount='-10') for voucher in cls.expenses
        ])
        cls.receipts = Voucher.objects.bulk_create([
            Voucher(kind='receipt', status='posted', date=cls.today, store=cls.store,
                    party=cls.party, total='100', payload={'due_date': (cls.today - timedelta(days=1)).isoformat()},
                    created_by=cls.owner) for _ in range(65)
        ])
        cls.events = AuditEvent.objects.bulk_create([
            AuditEvent(user=cls.owner, action='draft_saved', subject=f'voucher/{index}', detail={'synthetic': True})
            for index in range(205)
        ])

    @classmethod
    def user(cls, name, role, store=None):
        user = User.objects.create(username=name)
        Profile.objects.create(user=user, role=role, store=store)
        return user

    def setUp(self):
        self.seed()
        self.sign_in(self.owner)

    def sign_in(self, user):
        token = f'isolated-finance-{user.pk}'
        PortalSession.objects.update_or_create(token_hash=hashlib.sha256(token.encode()).hexdigest(),
            defaults={'user': user, 'csrf': 'isolated-csrf', 'expires': int(time.time()) + 3600})
        self.client.cookies['ts_session'] = token

    def get(self, resource, **params):
        result = self.client.get('/api/erp/' + resource, params)
        self.assertEqual(result.status_code, 200, result.content)
        return result.json()

    def voucher(self, kind, store=None, **values):
        return Voucher.objects.create(kind=kind, status='posted', date=self.today,
            store=store or self.store, total=Decimal('100'), created_by=self.owner, **values)

    def test_ledger_old_records_filters_and_compatibility_keys(self):
        result = self.get('ledger')
        self.assertEqual((result['total'], result['pages'], len(result['entries'])), (65, 3, 30))
        last = self.get('ledger', page='99')
        self.assertEqual((last['page'], len(last['entries'])), (3, 5))
        found = self.get('ledger', q=f'№ {self.expenses[0].pk:06d}')
        self.assertEqual([x['id'] for x in found['entries']], [self.entries[0].pk])
        self.assertEqual(found['entries'][0]['amount'], '-10.00')
        self.assertEqual(found['entries'][0]['account_id'], self.account.pk)
        self.assertEqual(self.get('ledger', q='Банк A', account=str(self.account.pk))['total'], 65)
        self.assertEqual(self.get('ledger', **{'to': (self.today - timedelta(days=1)).isoformat()})['entries'], [])

    def test_ledger_scope_salary_privacy_and_finance_roles(self):
        foreign = self.voucher('expense', store=self.other_store)
        CashEntry.objects.create(voucher=foreign, account=self.foreign_account, amount='-5')
        for kind in ['payroll', 'payroll_payment']:
            payroll = self.voucher(kind, note='Персональна зарплата')
            CashEntry.objects.create(voucher=payroll, account=self.account, amount='-12')
        self.sign_in(self.manager)
        self.assertEqual(self.get('ledger')['total'], 65)
        self.assertEqual(self.get('ledger', q='Персональна')['entries'], [])
        self.assertEqual(self.get('ledger', account=str(self.foreign_account.pk))['entries'], [])
        self.assertEqual(self.get('ledger', store=str(self.other_store.pk))['entries'], [])
        self.sign_in(self.accountant)
        self.assertEqual(self.get('ledger')['total'], 67)
        self.sign_in(self.cashier)
        self.assertEqual(self.client.get('/api/erp/ledger').status_code, 403)
        self.assertEqual(self.client.get('/api/erp/debts').status_code, 403)

    def test_audit_full_history_owner_only_and_local_dates(self):
        result = self.get('audit')
        self.assertEqual((result['total'], result['pages'], len(result['events'])), (205, 7, 30))
        last = self.get('audit', page='99')
        self.assertEqual((last['page'], len(last['events'])), (7, 25))
        self.assertEqual(self.get('audit', q=str(self.events[0].pk))['events'][0]['id'], self.events[0].pk)
        self.assertEqual(self.get('audit', user=str(self.owner.pk), action='draft_saved')['total'], 205)
        AuditEvent.objects.filter(pk=self.events[0].pk).update(at=datetime(2026, 9, 30, 21, 30, tzinfo=datetime_timezone.utc))
        local = self.get('audit', q=str(self.events[0].pk), **{'from': '2026-10-01', 'to': '2026-10-01'})
        self.assertEqual(local['total'], 1)
        self.assertEqual(self.get('audit', q=str(self.events[0].pk), **{'to': '2026-09-30'})['total'], 0)
        for user in [self.manager, self.accountant, self.cashier]:
            self.sign_in(user)
            self.assertEqual(self.client.get('/api/erp/audit').status_code, 403)

    def test_debt_pages_exact_search_aggregate_and_report_compatibility(self):
        with CaptureQueriesContext(connection) as queries:
            result = self.get('debts')
        self.assertLessEqual(len(queries), 15)
        self.assertEqual((result['total'], result['pages'], len(result['items'])), (65, 3, 30))
        self.assertEqual(result['debt_totals'], {'owed_to_us': '0.00', 'owed_by_us': '6500.00'})
        self.assertEqual(self.get('debts', page='99')['page'], 3)
        oldest = self.get('debts', q=f'{self.receipts[0].pk:06d}')['items'][0]
        self.assertEqual((oldest['voucher'], oldest['amount'], oldest['total']), (self.receipts[0].pk, '100.00', '100.00'))
        self.assertEqual(self.get('debts', q='Постачальник')['total'], 65)
        report = self.get('report')
        self.assertEqual((report['debt_count'], len(report['debts'])), (65, 65))
        self.assertEqual(report['debt_totals'], result['debt_totals'])

    def test_debt_settlements_status_due_dates_and_document_dates(self):
        receipt = self.receipts[0]
        self.voucher('payment', reference=receipt)
        sale = self.voucher('sale', party=self.customer, payload={
            'payments': [{'account': self.account.pk, 'amount': '30'}], 'due_date': self.today.isoformat(),
        })
        returned = self.voucher('customer_return', reference=sale, party=self.customer,
            payload={'payments': [{'account': self.account.pk, 'amount': '5'}]})
        returned.total = Decimal('20')
        returned.save(update_fields=['total'])
        opening = self.voucher('debt_opening', party=self.customer, payload={})
        found = self.get('debts', party=str(self.customer.pk))
        expected = {v.pk: str(obligation(v)) for v in [sale, opening]}
        self.assertEqual({x['voucher']: x['amount'] for x in found['items']}, expected)
        self.assertEqual(found['debt_totals']['owed_to_us'], '155.00')
        self.assertEqual(self.get('debts', status='overdue')['total'], 64)
        self.assertEqual(self.get('debts', status='not_overdue')['total'], 2)
        self.assertEqual(self.get('debts', due=self.today.isoformat())['total'], 1)
        self.assertEqual(self.get('debts', due_from=self.today.isoformat())['total'], 1)
        self.assertEqual(self.get('debts', q=f'{receipt.pk:06d}')['total'], 0)
        self.assertEqual(self.get('debts', **{'to': (self.today - timedelta(days=1)).isoformat()})['total'], 0)

    def test_debt_scoped_roles_and_foreign_party_filters(self):
        foreign = self.voucher('receipt', store=self.other_store, party=self.customer)
        for user in [self.manager, self.accountant]:
            self.sign_in(user)
            self.assertEqual(self.get('debts')['total'], 65)
            self.assertEqual(self.get('debts', q=f'{foreign.pk:06d}')['total'], 0)
            self.assertEqual(self.get('debts', store=str(self.other_store.pk))['total'], 0)
            self.assertEqual(self.get('debts', party=str(self.customer.pk))['total'], 0)

    def test_debt_summary_overdue_both_ways_and_supplier_calendar(self):
        due = lambda days: {'due_date': (self.today + timedelta(days=days)).isoformat()}
        soon = self.voucher('receipt', party=self.party, payload=due(3))
        now = self.voucher('receipt', party=self.party, payload=due(0))
        self.voucher('receipt', party=self.party, payload=due(20))
        self.voucher('sale', party=self.customer, payload={'payments': [{'account': self.account.pk, 'amount': '40'}], **due(-2)})
        self.voucher('receipt', store=self.other_store, party=self.party, payload=due(1))
        summary = self.get('debts/summary')
        self.assertEqual(summary['overdue'], {'to_us': {'amount': '60.00', 'count': 1}, 'by_us': {'amount': '6500.00', 'count': 65}})
        self.assertEqual([(x['voucher'], x['due_date'], x['amount']) for x in summary['payments']][:2],
            [(now.pk, self.today.isoformat(), '100.00'), (summary['payments'][1]['voucher'], (self.today + timedelta(days=1)).isoformat(), '100.00')])
        self.assertEqual([x['voucher'] for x in summary['payments']][-1], soon.pk)
        self.assertEqual((summary['payments_total'], summary['days']), ('300.00', 14))
        self.sign_in(self.manager)
        scoped = self.get('debts/summary')
        self.assertEqual([x['voucher'] for x in scoped['payments']], [now.pk, soon.pk])
        self.assertEqual(scoped['payments_total'], '200.00')
        self.sign_in(self.cashier)
        self.assertEqual(self.client.get('/api/erp/debts/summary').status_code, 403)

    def test_invalid_filters_return_user_errors_and_empty_page_clamps(self):
        for resource, params in [
            ('ledger', {'page': '0'}), ('ledger', {'account': '²'}), ('ledger', {'store': '-1'}),
            ('ledger', {'from': '2026-10-03', 'to': '2026-10-01'}), ('ledger', {'q': '9' * 20}),
            ('audit', {'page': 'NaN'}), ('audit', {'user': 'abc'}), ('audit', {'action': 'x' * 41}),
            ('audit', {'from': '2026-99-01'}), ('debts', {'page': '-1'}), ('debts', {'party': '0'}),
            ('debts', {'status': 'paid'}), ('debts', {'due': '2026-99-01'}),
            ('debts', {'due_from': '2026-10-03', 'due_to': '2026-10-01'}),
            ('report', {'store': 'nan'}),
        ]:
            with self.subTest(resource=resource, params=params):
                self.assertEqual(self.client.get('/api/erp/' + resource, params).status_code, 400)
        result = self.get('debts', party=str(self.customer.pk), page='99')
        self.assertEqual((result['items'], result['total'], result['page'], result['pages']), ([], 0, 1, 1))
        self.assertEqual(self.get('ledger', q='000')['entries'], [])
        self.assertEqual(self.get('audit', q='0')['events'], [])
