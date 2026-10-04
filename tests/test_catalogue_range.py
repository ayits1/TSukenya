from decimal import Decimal
from django.contrib.auth.models import User
from django.db import connection
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import Document, Profile, Store
from server.erp.portal_api import sales_margin, summary


class CatalogueRangeTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create(username='range-owner')
        self.profile = Profile.objects.create(user=self.user, role='owner')
        Document.objects.create(path='settings/main', data={'rounding': 0, 'defaultMarkup': 0})
        self.expense = Document.objects.create(path='expenses/rent', data={'amount': '1000.00', 'group': 'fixed'})

    def product(self, key, cost, price, **extra):
        return Document.objects.create(path='products/' + key,
            data={'name': key, 'cost': cost, 'price': price, 'manualPrice': True, **extra})

    def model(self):
        with CaptureQueriesContext(connection) as queries:
            value = summary(self.user, model=True)
        self.assertNotRegex(' '.join(q['sql'].lower() for q in queries), r'\b(insert|update|delete)\b')
        return value

    def test_full_catalogue_extrema_coverage_promotion_and_readonly(self):
        self.product('a', 50, 100)  # 50%
        self.product('b', 75, 150, promotion=True, promotionPrice='100.00')  # 25%
        self.product('no_cost', 0, 100)
        self.product('no_price', 50, 0)
        self.product('example', 1, 100, example=True)
        self.product('hidden', 99, 100, hidden=True)
        result = self.model()
        self.assertEqual((result['coverage'], result['catalogCount']), (2, 4))
        self.assertEqual(result['marginRange'], {
            'basis': 'catalogue_margin_extrema', 'minPercent': '25.00', 'maxPercent': '50.00',
            'nonpositiveCount': 0, 'monthlyLow': '2000.00', 'monthlyHigh': '4000.00', 'reason': 'bounded',
        })
        # Old consumers keep their explicitly labelled equal-weight model.
        self.assertEqual(result['equalWeightMargin'], '0.375')

    def test_zero_and_negative_margin_are_not_silently_excluded(self):
        self.product('a', 50, 100)
        item = self.product('b', 100, 100)
        result = self.model()['marginRange']
        self.assertEqual((result['reason'], result['nonpositiveCount'], result['monthlyLow'], result['monthlyHigh']),
                         ('unbounded', 1, '2000.00', None))
        item.data['cost'] = 120; item.save()
        self.assertEqual(self.model()['marginRange']['minPercent'], '-20.00')
        Document.objects.filter(pk='products/a').delete()
        result = self.model()['marginRange']
        self.assertEqual((result['reason'], result['monthlyLow'], result['monthlyHigh']),
                         ('nonpositive_margin', None, None))

    def test_empty_zero_expenses_and_tiny_positive_margin(self):
        self.assertEqual(self.model()['marginRange']['reason'], 'no_coverage')
        self.expense.data['amount'] = 0; self.expense.save()
        result = self.model()['marginRange']
        self.assertEqual((result['reason'], result['monthlyLow'], result['monthlyHigh']), ('no_expenses', '0.00', '0.00'))
        self.expense.data['amount'] = '1000.00'; self.expense.save()
        self.product('tiny', '99999999.99', '100000000.00')
        result = self.model()['marginRange']
        self.assertEqual((result['reason'], result['nonpositiveCount'], result['minPercent']), ('bounded', 0, '0.00'))
        self.assertEqual(Decimal(result['monthlyHigh']), Decimal('10000000000000.00'))

    def test_fresh_role_and_store_before_private_model(self):
        from server.erp.services import BusinessError
        self.product('a', 50, 100)
        # Prime the caller's cached profile before changing database permissions.
        self.assertEqual(self.user.profile.role, 'owner')
        Profile.objects.filter(pk=self.profile.pk).update(role='cashier')
        with self.assertRaises(BusinessError):
            self.model()
        Profile.objects.filter(pk=self.profile.pk).update(role='owner', store=Store.objects.create(name='Scoped'))
        self.user.profile.refresh_from_db()
        with self.assertRaises(BusinessError):
            self.model()

    def test_sales_margin_rechecks_cached_owner_before_private_reads(self):
        from server.erp.services import BusinessError
        store = Store.objects.create(name='Scoped sales')
        for change in ('role', 'store', 'inactive', 'missing_profile'):
            with self.subTest(change=change):
                User.objects.filter(pk=self.user.pk).update(is_active=True)
                profile, _ = Profile.objects.update_or_create(user=self.user, defaults={'role': 'owner', 'store': None})
                cached = User.objects.select_related('profile').get(pk=self.user.pk)
                self.assertEqual(cached.profile.role, 'owner')
                self.assertIsNone(cached.profile.store_id)
                if change == 'role':
                    Profile.objects.filter(pk=profile.pk).update(role='cashier')
                elif change == 'store':
                    Profile.objects.filter(pk=profile.pk).update(store=store)
                elif change == 'inactive':
                    User.objects.filter(pk=self.user.pk).update(is_active=False)
                else:
                    profile.delete()
                with CaptureQueriesContext(connection) as queries:
                    with self.assertRaises(BusinessError):
                        sales_margin(cached)
                sql = ' '.join(query['sql'].lower() for query in queries)
                self.assertNotRegex(sql, r'\b(insert|update|delete)\b')
                self.assertNotRegex(sql, r'from "erp_(store|voucher|document)"')
