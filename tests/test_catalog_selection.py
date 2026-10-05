from unittest.mock import patch
from django.test import TransactionTestCase
from django.db import connection
from django.test.utils import CaptureQueriesContext
from server.erp.catalog_selection import Selection
from server.erp.catalog import filtered_products
from server.erp.models import Document
from server.erp.services import BusinessError
import tests.test_catalog_pricing as fixture


class CatalogSelectionTests(TransactionTestCase):
    def setUp(self):
        from tests.catalog_index_fixture import clear_flushed_catalogue_tombstones
        clear_flushed_catalogue_tombstones()
        fixture.CatalogPricingTests.setUp(self)
    create = fixture.CatalogPricingTests.create

    def test_page_and_promotion_equal_legacy_filters_with_scalar_payload(self):
        self.create('promo', type='Група', category='Кава', pack='Пакет', cost='10.10', promotion=True, promotionPrice='9.99', recipe=[{'privateLargePayload': 'x' * 100000}])
        self.create('explicit-null-markup', type='Група', markup=None, promotion=True, promotionPrice='9.99')
        for promotion in ('', 'yes', 'no'):
            params = {'promotion': promotion, 'type': 'Група'}
            query, *_ = filtered_products(self.user, params)
            expected = list(query.order_by('data__type', 'data__category', 'data__name', 'path').values_list('path', flat=True))
            with CaptureQueriesContext(connection) as queries, Selection(self.user, params) as selection:
                actual = selection.ids(50)
                self.assertEqual(actual, expected)
                self.assertEqual(selection.count(), len(expected))
            if promotion:
                scalar = [q['sql'] for q in queries if 'json_object' in q['sql'].lower() or 'jsonb_build_object' in q['sql'].lower() or 'json_object' in q['sql'].lower()]
                self.assertEqual(len(scalar), 1)
                self.assertNotIn('recipe', scalar[0])
                self.assertNotIn('privateLargePayload', scalar[0])

    def test_all_facet_values_accessible_parents_not_self_and_exact_paging(self):
        Document.objects.bulk_create([Document(path=f'products/many-{n:03}', data={'name': str(n), 'type': 'Група', 'category': f'Категорія {n:03}', 'pack': 'Пакет'}) for n in range(65)])
        with Selection(self.user, {'type': 'Група', 'category': 'Категорія 064'}) as selection:
            first = selection.facet('category', '', 1)
            last = selection.facet('category', '', 999)
            self.assertEqual((first['total'], first['pages'], len(first['items'])), (65, 3, 30))
            self.assertEqual((last['page'], last['items']), (3, [f'Категорія {n:03}' for n in range(60, 65)]))
            self.assertEqual(selection.facet('category', '064', 1)['items'], ['Категорія 064'])
            self.assertEqual(selection.facet('pack', '', 1)['items'], ['Пакет'])

    def test_bounded_api_role_page_clamp_no_dml_and_private_cost(self):
        response = self.client.get('/api/v1/catalog/selection/page?limit=10&page=999')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()['contract'], 'catalog-page-v2')
        self.assertIsNone(response.json()['facets'])
        self.user.profile.role = 'cashier'; self.user.profile.save()
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get('/api/v1/catalog/selection/page?promotion=no')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(all(item['cost'] is None and item['markup'] is None for item in response.json()['items']))
        self.assertFalse(any(q['sql'].lstrip().split()[0] in {'INSERT', 'UPDATE', 'DELETE'} for q in queries))
        self.assertEqual(self.client.get('/api/v1/catalog/selection/page?visibility=hidden').status_code, 403)
        self.assertEqual(self.client.get('/api/v1/catalog/selection/facets?field=category&page=0').status_code, 400)

    def test_spool_limit_is_explicit_and_cleanup_on_failure(self):
        selection = Selection(self.user, {})
        with self.assertRaises(BusinessError), patch('server.erp.catalog_selection.MAX_DISK', 1):
            with selection: selection.build()
        self.assertFalse(__import__('os').path.exists(selection.directory.name))

    def test_oversized_scalar_is_rejected_in_sql_before_batch_decode(self):
        self.create('oversized', name='😀' * 18000)
        selection = Selection(self.user, {})
        with self.assertRaisesMessage(BusinessError, '64 КіБ'):
            with selection: selection.build()
        self.assertFalse(__import__('os').path.exists(selection.directory.name))

    def test_fresh_index_normal_save_unicode_direct_rename_and_pending_no_write(self):
        from server.erp.catalog import revision
        self.create('named', name='Straße  Кава')
        response = self.client.post('/api/v1/catalog/products', {'name': ' STRASSE   Кава ', 'unit': 'шт', 'cost': '10'}, content_type='application/json', **self.headers)
        self.assertEqual((response.status_code, response.json()['code']), (409, 'duplicate_name'))
        # Direct source edits are drained before the indexed lookup.
        Document.objects.filter(pk='products/named').update(data={'name': 'Перейменовано', 'unit': 'шт'})
        response = self.client.post('/api/v1/catalog/products', {'name': ' перейменовано ', 'unit': 'шт', 'cost': '10'}, content_type='application/json', **self.headers)
        self.assertEqual(response.json()['code'], 'duplicate_name')
        Document.objects.bulk_create([Document(path=f'products/backlog-{n}', data={'name': f'Залишок {n}'}) for n in range(205)])
        before = Document.objects.count()
        response = self.client.post('/api/v1/catalog/products', {'name': 'Новий', 'unit': 'шт', 'cost': '10'}, content_type='application/json', **self.headers)
        self.assertEqual(response.json()['code'], 'catalog_index_pending')
        self.assertEqual(Document.objects.count(), before)
        # A same-name cost edit needs no stale name/recipe lookup or global drain.
        response = self.client.patch('/api/v1/catalog/products/one', {'revision': revision(self.product), 'cost': '11'}, content_type='application/json', **self.headers)
        self.assertEqual(response.status_code, 200, response.content)

    def test_streaming_pricing_snapshot_bindings_and_independent_cashier_page(self):
        from datetime import timedelta
        from decimal import Decimal
        from server.erp.catalog import defaults
        from server.erp.catalog_snapshot import snapshot
        from server.erp.models import PromotionCampaign, PromotionPrice, Store
        from server.erp.promotion_prices import kyiv_day
        today = kyiv_day()
        stores = [Store.objects.create(name=f'Ціна {n}') for n in range(2)]
        campaign = PromotionCampaign.objects.create(name='Кампанія', starts_on=today, ends_on=today, scope='stores', author=self.user, request_fingerprint='x')
        campaign.stores.add(stores[0])
        price = PromotionPrice.objects.create(campaign=campaign, product=self.product, price=Decimal('9'))
        documents = Document.objects.filter(path__startswith='products/').order_by('path')
        token = lambda: snapshot(documents, defaults(), day=today)
        previous = token()
        changes = [lambda: campaign.stores.add(stores[1]),
                   lambda: PromotionPrice.objects.filter(pk=price.pk).update(price='8'),
                   lambda: PromotionCampaign.objects.filter(pk=campaign.pk).update(name='Інший підпис'),
                   lambda: Store.objects.filter(pk=stores[1].pk).update(active=False),
                   lambda: Document.objects.filter(pk=self.manual.pk).update(data={**self.manual.data, 'hidden': True}),
                   lambda: Document.objects.filter(pk=self.settings.pk).update(data={'defaultMarkup': 35, 'rounding': .5})]
        for change in changes:
            change(); current = token(); self.assertNotEqual(previous, current); previous = current
        self.assertNotEqual(previous, snapshot(documents, defaults(), day=today + timedelta(days=1)))
        # This guard never joins cashier list transport or its effective context.
        self.user.profile.role = 'cashier'; self.user.profile.save()
        response = self.client.get('/api/v1/catalog/selection/page')
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('snapshot', response.json())
        self.assertTrue(all(row['priceContext']['storeId'] is None for row in response.json()['items']))

    def test_streamed_minimum_matches_full_winner_oracle_invalid_tie_and_overlap(self):
        from datetime import date
        from decimal import Decimal
        from types import SimpleNamespace
        from server.erp.promotion_prices import PriceResolver
        config = {'markup': Decimal('30'), 'rounding': Decimal('.5')}
        amounts = [('-1', 'negative'), ('0', 'zero'), ('30', 'equal'), ('20', 'b'), ('20', 'a')]
        amounts += [(str(21 + n), f'overlap-{n}') for n in range(1000)]
        records = [SimpleNamespace(product_id=self.product.path, price=Decimal(amount).quantize(Decimal('.01')), campaign=SimpleNamespace(pk=identifier, name=identifier, starts_on=date(2026,1,1), ends_on=date(2026,12,31), revision=1)) for amount, identifier in amounts]
        query = __import__('unittest.mock', fromlist=['MagicMock']).MagicMock()
        query.select_related.return_value = query; query.distinct.return_value = query; query.filter.return_value = query
        query.iterator.side_effect = lambda **kwargs: iter(records)
        with patch('server.erp.promotion_prices.PromotionPrice.objects.filter', return_value=query):
            resolver = PriceResolver(config, product_paths=[self.product.path])
        self.assertEqual(len(resolver.candidates[self.product.path]), 1)
        self.assertEqual(resolver.candidates[self.product.path][0][:2], (Decimal('20'), 'a'))
        for regular, legacy in [('30', None), ('20', None), ('19', None), ('30', '19'), ('30', '20'), ('0', '1')]:
            candidate = Document(path=self.product.path, data={'manualPrice':True, 'price':regular, 'promotion':legacy is not None, 'promotionPrice':legacy})
            expected = [(amount, '1:' + identifier) for amount, identifier in [(Decimal(a), i) for a, i in amounts] if 0 < amount < Decimal(regular)]
            if legacy is not None and 0 < Decimal(legacy) < Decimal(regular): expected.append((Decimal(legacy), '0:legacy'))
            winner = min(expected) if expected else None
            result = resolver.resolve(candidate)
            self.assertEqual(result['salePrice'], format(winner[0] if winner else Decimal(regular), '.2f'))
            self.assertEqual(result['effectivePromotion']['source'] if winner else None, ('legacy' if winner[1]=='0:legacy' else 'campaign') if winner else None)

    def test_scoped_reference_scan_matches_global_alias_archive_unknown_and_first_caption(self):
        from server.erp.catalog_references import reference_records, bind_reference_fields, validate_reference_fields, legacy_item
        from server.erp.catalog_scoped_references import scoped_records
        Document.objects.bulk_create([
            Document(path='catalog_refs/group', data={'field':'type','value':'Нова група','aliases':[{'value':'Стара група'}]}),
            Document(path='catalog_refs/category', data={'field':'category','value':'Кава','parentType':'Нова група','parentId':'group','aliases':[{'value':'Кава','parentType':'Стара група'}]}),
            Document(path='catalog_refs/archived', data={'field':'size','value':'Архів','state':'archived'}),
            Document(path='products/aaa', data={'name':'Перший','type':'Напої','category':'Чай','pack':'Straße банка','unit':'шт'}),
            Document(path='products/zzz', data={'name':'Другий','type':'напої','category':'чай','pack':'STRASSE БАНКА','unit':'шт'}),
            Document(path='products/other-group', data={'name':'Інший','type':'Інша','category':'ЧАЙ','unit':'шт'}),
        ])
        global_records = reference_records()
        cases = [({'name':'Старий','type':'Стара група','category':'Кава','size':'Архів','referenceIds':{'type':'group','category':'category'}}, {}),
                 ({'name':'Старий','pack':'Невідоме','referenceIds':{'pack':'missing'}}, {}),
                 ({'name':'Старий','type':'напої','category':'чай','pack':'STRASSE БАНКА'}, {}),
                 ({'name':'Старий','type':'Напої','category':'чай','referenceIds':{'type':legacy_item('type','Інша')['id']}}, {}),
                 ({'name':'Старий'}, {'pack':'Вигадане'}),
                 ({}, {'type':'напої','category':'чай','pack':'STRASSE БАНКА','unit':'шт'})]
        for old, values in cases:
            expected, actual = {**old, **values}, {**old, **values}
            scoped = scoped_records((old, actual))
            bind_reference_fields(expected, old, references=global_records)
            bind_reference_fields(actual, old, references=scoped)
            self.assertEqual(actual, expected)
            for records in (global_records, scoped):
                if values.get('pack') == 'Вигадане':
                    with self.assertRaises(BusinessError): validate_reference_fields({**old, **values}, old, references=records)
        # Repeated keys do not retain one object per source row; full recipes never load.
        Document.objects.bulk_create([Document(path=f'products/repeated-{n}', data={'name':str(n),'pack':'STRASSE БАНКА','recipe':['x'*100000]}) for n in range(210)])
        with CaptureQueriesContext(connection) as queries:
            scoped = scoped_records(({'pack':'STRASSE БАНКА'},))
        self.assertEqual(len(scoped), len(reference_records()))  # complete disk mapping; no first-page/selected-only truncation
        scalar = next(q['sql'] for q in queries if 'scalar' in q['sql'])
        self.assertNotIn('recipe', scalar)

    def test_filter_preview_whole_selection_manual_hidden_fallback_and_1001_refusal(self):
        Document.objects.bulk_create([Document(path=f'products/selected-{n:03}', data={'name':f'Вибір {n}', 'type':'Вибір', 'cost':'10', 'markup':30, 'unit':'шт'}) for n in range(65)])
        payload={'kind':'markup','markup':'40','resetManualPrices':False,'updateDefault':False,
                 'selection':{'q':'','type':'Вибір','category':'','pack':'','promotion':'','store':''}}
        before = list(Document.objects.values_list('path', 'data'))
        response=self.client.post('/api/v1/catalog/pricing/preview',payload,content_type='application/json',**self.headers)
        self.assertEqual(response.status_code,200,response.content)
        result=response.json(); self.assertEqual(result['summary']['candidates'],65)
        self.assertEqual({item['id'] for item in result['entries']},{f'selected-{n:03}' for n in range(65)})
        self.assertEqual(before,list(Document.objects.values_list('path','data')))
        Document.objects.bulk_create([Document(path=f'products/selected-extra-{n:04}',data={'name':str(n),'type':'Вибір','cost':'10','markup':30}) for n in range(936)])
        response=self.client.post('/api/v1/catalog/pricing/preview',payload,content_type='application/json',**self.headers)
        self.assertEqual(response.status_code,400,response.content)
        self.assertIn('1000',response.json()['error'])

    def test_full_snapshot_guard_is_separate_from_scalar_and_candidate_cap(self):
        from server.erp.catalog_snapshot import snapshot, bounded_documents
        from server.erp.catalog import defaults
        self.create('large-unselected', recipe=['x'*300000])
        # A non-price legacy payload never enters scalar selection; it does enter
        # the full revision guard and is refused instead of weakened/omitted.
        with Selection(self.user, {}) as selection: selection.build()
        with self.assertRaisesMessage(BusinessError,'256 КіБ'):
            snapshot(Document.objects.filter(path__startswith='products/').order_by('path'), defaults())
        Document.objects.filter(pk='products/large-unselected').delete()
        with self.assertRaisesMessage(BusinessError,'16 МіБ'):
            list(bounded_documents(Document.objects.filter(path__startswith='products/'), total_limit=1))

    def test_old_v1_guard_refused_and_committed_receipt_precedes_full_guard(self):
        import uuid
        from server.erp.catalog import defaults
        from server.erp.catalog_import import snapshot as old_snapshot
        payload={'kind':'markup','markup':'40','ids':['one'],'resetManualPrices':False,'updateDefault':False}
        old=old_snapshot(list(Document.objects.filter(path__startswith='products/').order_by('path')),defaults())
        key=str(uuid.uuid4())
        response=self.client.post('/api/v1/catalog/pricing/commit',{**payload,'snapshot':old,'idempotencyKey':key},content_type='application/json',**self.headers)
        self.assertEqual((response.status_code,response.json()['code']),(409,'revision_conflict'))
        preview=self.client.post('/api/v1/catalog/pricing/preview',payload,content_type='application/json',**self.headers).json()
        frozen={**payload,'snapshot':preview['snapshot'],'idempotencyKey':key}
        first=self.client.post('/api/v1/catalog/pricing/commit',frozen,content_type='application/json',**self.headers)
        self.assertEqual(first.status_code,200,first.content)
        self.create('unsupported-after-commit',recipe=['x'*300000])
        retry=self.client.post('/api/v1/catalog/pricing/commit',frozen,content_type='application/json',**self.headers)
        self.assertEqual(retry.status_code,200,retry.content)
        self.assertEqual(retry.json(),first.json())
