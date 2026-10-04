"""B28 read-only pricing, save parity, permissions and stale policy protection. Isolated data."""
import hashlib
import re
import time
from django.contrib.auth.models import User
from django.db import connection
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import AuditEvent, Document, LedgerLock, PortalSession, Profile
from server.erp.catalog import pricing_revision


class ProductPricePreviewTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create(username='price-preview-owner')
        Profile.objects.create(user=self.user, role='owner')
        LedgerLock.objects.create(pk=1)
        token = 'isolated-preview-token'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), user=self.user,
                                    csrf='preview-csrf', expires=int(time.time()) + 3600)
        self.client.cookies['ts_session'] = token
        self.headers = {'HTTP_ORIGIN': 'http://testserver', 'HTTP_X_CSRF_TOKEN': 'preview-csrf'}
        Document.objects.create(path='settings/main', data={'defaultMarkup': 30, 'rounding': .5, 'gsUrl': 'private'})
        Document.objects.create(path='products/one', data={'name': 'Кава', 'unit': 'шт', 'cost': 10, 'priceAt': '2020-01-01'})

    def preview(self, value, **headers):
        return self.client.post('/api/v1/catalog/products/price-preview', value,
                                content_type='application/json', **(headers or self.headers))

    def product(self):
        return self.client.get('/api/v1/catalog/products/one').json()

    def save(self, value, existing=False):
        path = '/api/v1/catalog/products/one' if existing else '/api/v1/catalog/products'
        method = self.client.patch if existing else self.client.post
        return method(path, value, content_type='application/json', **self.headers)

    def test_preview_does_not_execute_writes_or_change_review_date(self):
        before = list(Document.objects.order_by('path').values())
        with CaptureQueriesContext(connection) as queries:
            response = self.preview({'id': 'one', 'revision': self.product()['revision'], 'cost': '11.29', 'markup': '12.3456'})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()['regularPrice'], '13.00')
        self.assertEqual(response.json()['config'], {'markup': '30', 'rounding': '0.5'})
        self.assertEqual(response.json()['warnings'], [])
        self.assertFalse(response.json()['promotionValid'])
        self.assertFalse(any(re.match(r'\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE)\b', q['sql'], re.I) for q in queries))
        self.assertEqual(list(Document.objects.order_by('path').values()), before)
        self.assertEqual(AuditEvent.objects.count(), 0)
        self.assertEqual(LedgerLock.objects.count(), 1)
        self.assertNotIn('gsUrl', str(response.json()))

    def test_create_and_patch_use_exact_same_decimal_price_and_validation(self):
        for inputs in [
            {'cost': '10.01', 'markup': '12.3456'},
            {'manualPrice': True, 'price': '21.99', 'promotion': True, 'promotionPrice': '17.50'},
            {'cost': '0.29', 'markup': '10'},
        ]:
            preview = self.preview(inputs)
            self.assertEqual(preview.status_code, 200, preview.content)
            saved = self.save({'name': 'Новий ' + str(Document.objects.count()), **inputs,
                               'pricingRevision': preview.json()['pricingRevision']})
            self.assertEqual(saved.status_code, 201, saved.content)
            for key in ('regularPrice', 'salePrice'):
                self.assertEqual(saved.json()[key], preview.json()[key])
            data = Document.objects.get(pk='products/' + saved.json()['id']).data
            self.assertNotIn('pricingRevision', data)
        inputs = {'id': 'one', 'revision': self.product()['revision'], 'cost': '11.99'}
        preview = self.preview(inputs).json()
        saved = self.save({'revision': inputs['revision'], 'cost': inputs['cost'], 'pricingRevision': preview['pricingRevision']}, True)
        self.assertEqual(saved.status_code, 200, saved.content)
        self.assertEqual(saved.json()['regularPrice'], preview['regularPrice'])

    def test_preview_shares_strict_save_rejections(self):
        for inputs in [{'cost': '1.001'}, {'cost': '-1'}, {'cost': True}, {'markup': '1.00001'},
                       {'markup': '100000000'}, {'manualPrice': True, 'price': '0'},
                       {'manualPrice': 'true'}, {'promotion': True},
                       {'promotion': True, 'promotionPrice': '999'}, {'promotionPrice': 'NaN'}]:
            preview = self.preview(inputs)
            saved = self.save({'name': 'Invalid', **inputs})
            self.assertEqual(preview.status_code, 400, inputs)
            self.assertEqual(saved.status_code, 400, inputs)
            self.assertEqual(preview.json()['error'], saved.json()['error'], inputs)
        self.assertEqual(Document.objects.count(), 2)
        self.assertEqual(AuditEvent.objects.count(), 0)

    def test_unchanged_legacy_promotions_return_warning_but_repricing_needs_fix(self):
        for price in (None, 30):
            document = Document.objects.get(pk='products/one')
            document.data.update(promotion=True, promotionPrice=price); document.save()
            inputs = {'id': 'one', 'revision': self.product()['revision'], 'cost': '10', 'markup': '30'}
            result = self.preview(inputs)
            self.assertEqual(result.status_code, 200, result.content)
            self.assertEqual(result.json()['salePrice'], '13.00')
            self.assertFalse(result.json()['promotionValid'])
            self.assertEqual(len(result.json()['warnings']), 1)
            self.assertEqual(self.preview({**inputs, 'cost': '11'}).status_code, 400)
            # Preserve the existing Save contract: badge-only date review is grandfathered;
            # an explicit invalid promotion is revalidated when reviewed.
            self.assertEqual(self.preview({**inputs, 'priceReviewed': True}).status_code, 200 if price is None else 400)
            saved = self.save({'revision': inputs['revision'], 'name': 'Кава нова', 'pricingRevision': result.json()['pricingRevision']}, True)
            self.assertEqual(saved.status_code, 200, saved.content)

    def test_valid_promotion_and_disabled_retained_price(self):
        inputs = {'cost': '10', 'promotion': True, 'promotionPrice': '12.01'}
        result = self.preview(inputs).json()
        self.assertTrue(result['promotionValid'])
        self.assertEqual((result['regularPrice'], result['salePrice']), ('13.00', '12.01'))
        disabled = self.preview({**inputs, 'promotion': False}).json()
        self.assertFalse(disabled['promotionValid'])
        self.assertEqual(disabled['salePrice'], '13.00')

    def test_role_and_csrf_guards_prevent_cost_preview_for_cashier_and_accountant(self):
        for role in ('owner', 'manager', 'warehouse', 'cashier', 'accountant'):
            self.user.profile.role = role; self.user.profile.save()
            self.assertEqual(self.preview({'id': 'one'}).status_code, 200 if role in {'owner', 'manager', 'warehouse'} else 403)
        self.user.profile.role = 'owner'; self.user.profile.save()
        self.assertEqual(self.preview({'id': 'one'}, HTTP_ORIGIN='http://testserver').status_code, 403)
        self.client.cookies.clear()
        self.assertEqual(self.preview({'id': 'one'}).status_code, 401)

    def test_optional_existing_revision_and_request_validation(self):
        self.assertEqual(self.preview({'id': 'one', 'revision': 'stale'}).status_code, 409)
        self.assertEqual(self.preview({'id': 'missing'}).status_code, 404)
        for value in ({'id': None}, {'id': '../one'}, {'revision': 'orphan'}, {'name': 'Not a price input'}, {'rounding': '1'}):
            self.assertEqual(self.preview(value).status_code, 400, value)
        self.assertEqual(self.preview({'id': 'one'}).status_code, 200)

    def test_changed_pricing_settings_conflict_blocks_create_and_patch_without_writes(self):
        preview = self.preview({'id': 'one'}).json()
        settings = Document.objects.get(pk='settings/main'); settings.data['rounding'] = 1; settings.save()
        before = list(Document.objects.order_by('path').values())
        for existing, value in [(False, {'name': 'New', 'cost': '11'}),
                                (True, {'revision': self.product()['revision'], 'cost': '11'})]:
            result = self.save({**value, 'pricingRevision': preview['pricingRevision']}, existing)
            self.assertEqual(result.status_code, 409)
            self.assertEqual(result.json()['code'], 'pricing_revision_conflict')
        self.assertEqual(list(Document.objects.order_by('path').values()), before)
        self.assertEqual(AuditEvent.objects.count(), 0)
        fresh = self.preview({'cost': '11'}).json()
        self.assertEqual(self.save({'name': 'New', 'cost': '11', 'pricingRevision': fresh['pricingRevision']}).status_code, 201)

    def test_pricing_revision_ignores_unrelated_settings_and_equal_numeric_spelling(self):
        before = pricing_revision()
        document = Document.objects.get(pk='settings/main'); document.data.update(defaultMarkup='30.0000', rounding='0.50', tagChain='New'); document.save()
        self.assertEqual(pricing_revision(), before)
        document.data['defaultMarkup'] = 31; document.save()
        self.assertNotEqual(pricing_revision(), before)
        self.assertEqual(self.save({'name': 'Old client', 'cost': '10'}).status_code, 201)

    def test_openapi_preview_fields_and_observed_errors_match_contract(self):
        import json
        from django.conf import settings
        spec = json.loads((settings.BASE_DIR / 'contracts/catalog.openapi.json').read_text())
        post = spec['paths']['/api/v1/catalog/products/price-preview']['post']
        self.assertEqual(post['requestBody']['content']['application/json']['schema'], {'$ref': '#/components/schemas/ProductPricePreviewRequest'})
        self.assertEqual(post['responses']['200']['content']['application/json']['schema'], {'$ref': '#/components/schemas/ProductPricePreview'})
        for status in ('400', '401', '403', '404', '409'):
            self.assertIn(status, post['responses'])
        inputs = spec['components']['schemas']['ProductPricePreviewRequest']
        self.assertFalse(inputs['additionalProperties'])
        self.assertEqual(set(inputs['properties']), {'id', 'revision', 'cost', 'markup', 'manualPrice', 'price', 'promotion', 'promotionPrice', 'priceReviewed'})
        result = self.preview({}).json()
        self.assertEqual(set(result), set(spec['components']['schemas']['ProductPricePreview']['required']))
        for schema in ('ProductCreate', 'ProductPatch'):
            self.assertIn('pricingRevision', spec['components']['schemas'][schema]['properties'])
            self.assertNotIn('pricingRevision', spec['components']['schemas'][schema]['required'])

    def test_legacy_zero_rounding_reports_effective_half_hryvnia_without_changing_revision(self):
        settings = Document.objects.get(pk='settings/main'); settings.data['rounding'] = 0; settings.save()
        token = pricing_revision()
        result = self.preview({'cost': '10.01', 'markup': '0'}).json()
        self.assertEqual(result['config']['rounding'], '0.5')
        self.assertEqual(result['regularPrice'], '10.50')
        self.assertEqual(result['pricingRevision'], token)
        saved = self.save({'name': 'Fallback', 'cost': '10.01', 'markup': '0', 'pricingRevision': token})
        self.assertEqual(saved.status_code, 201)
        self.assertEqual(saved.json()['regularPrice'], result['regularPrice'])
        self.assertEqual(Document.objects.get(pk='settings/main').data['rounding'], 0)
