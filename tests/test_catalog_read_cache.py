from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
import fcntl
import os
from pathlib import Path
import tempfile
import time
from unittest import skipUnless
from unittest.mock import patch
from django.db import connection, transaction, close_old_connections
from django.test import TransactionTestCase, override_settings
from django.test.utils import CaptureQueriesContext
from server.erp.catalog_selection import Selection
from server.erp.catalog_read_cache import key, root, CacheUnavailable
from server.erp.catalog import defaults, filtered_products
from server.erp.historical_reports import read_snapshot
from server.erp.models import Document, PromotionCampaign, PromotionPrice, Store
from server.erp.promotion_prices import kyiv_day, PriceResolver, has_promotion
import tests.test_catalog_pricing as fixture


class CatalogReadCacheTests(TransactionTestCase):
    create = fixture.CatalogPricingTests.create

    def setUp(self):
        self.cache = tempfile.TemporaryDirectory(prefix='tsukenya-cache-proof-')
        self.override = override_settings(CATALOGUE_READ_CACHE=True, CATALOGUE_READ_CACHE_DIR=self.cache.name)
        self.override.enable()
        fixture.CatalogPricingTests.setUp(self)
        self.addCleanup(self.cache.cleanup); self.addCleanup(self.override.disable)

    def campaign(self, *, store=None, price='8', product=None, start=None, end=None):
        today = kyiv_day()
        campaign = PromotionCampaign.objects.create(name='Синтетична акція', starts_on=start or today,
            ends_on=end or today, scope='stores' if store else 'network', author=self.user, request_fingerprint='qa')
        if store: campaign.stores.add(store)
        PromotionPrice.objects.create(campaign=campaign, product=product or self.product, price=Decimal(price))
        return campaign

    def read(self, params=None, *, field='category', q='', page=1):
        with read_snapshot(), Selection(self.user, params or {}, read_cache=True) as selection:
            return selection.facet(field, q, page)

    def test_cold_minimum_and_hit_all_universe_equal_old_membership(self):
        for n in range(65): self.create(f'row-{n:03}', type='Група', category=f'Кава {n:03}', pack='Пакет',
            markup=None if n % 3 else 30, promotion=bool(n % 2), promotionPrice='0' if n % 5 == 0 else '9.99')
        special = self.create('tiny', type='Група', category='Мала', cost='0', promotion=True, promotionPrice='-1')
        self.create('manual-zero', type='Група', category='Нуль', manualPrice=True, price='0', promotion=True, promotionPrice='0')
        for amount in ('13.00', '8.01', '8.00', '8.00'):
            self.campaign(price=amount)
        self.campaign(product=special, price='1.00')
        for promotion in ('yes', 'no'):
            params = {'promotion': promotion, 'type': 'Група'}
            expected = list(filtered_products(self.user, params)[0].order_by('data__type', 'data__category', 'data__name', 'path').values_list('path', flat=True))
            with read_snapshot(), CaptureQueriesContext(connection) as queries, Selection(self.user, params, read_cache=True) as selection:
                self.assertEqual(selection.ids(100), expected)
                self.assertEqual(selection.count(), len(expected))
            scalar = [q['sql'] for q in queries if 'JSON_OBJECT' in q['sql'].upper() or 'JSONB_BUILD_OBJECT' in q['sql'].upper()]
            self.assertLessEqual(len(scalar), 1)  # yes/no share the same all-member index
            if scalar: self.assertIn('erp_promotionprice', scalar[0])
        self.read({'type': 'Група'})
        with patch.object(Selection, '_build_private', side_effect=AssertionError('hit must not rebuild')), CaptureQueriesContext(connection) as queries:
            first = self.read({'type': 'Група', 'category': 'Кава 064'})
            third = self.read({'type': 'Група'}, page=3)
            searched = self.read({'type': 'Група'}, q='064')
        self.assertEqual(first['total'], 67)
        self.assertEqual(third['page'], 3)
        self.assertEqual(searched['items'], ['Кава 064'])
        self.assertFalse(any('JSON_OBJECT' in q['sql'].upper() or 'JSONB_BUILD_OBJECT' in q['sql'].upper() for q in queries))
        resolver = PriceResolver(defaults(), product_paths=[self.product.path, special.path])
        for product in (self.product, special):
            minimum = resolver.candidates.get(product.path)
            self.assertEqual(has_promotion(product.data, defaults(), minimum[0][0] if minimum else None), bool(resolver.resolve(product)['effectivePromotion']))

    def test_atomic_direct_bulk_config_invalidation_and_rollback(self):
        self.create('first', type='Група', category='Початкова')
        initial = self.read({'type': 'Група'})
        try:
            with transaction.atomic():
                Document.objects.filter(pk='products/first').update(data={'name':'first','type':'Група','category':'Rollback'})
                raise RuntimeError('rollback')
        except RuntimeError: pass
        with patch.object(Selection, '_build_private', side_effect=AssertionError('rolled-back counter must hit')):
            self.assertEqual(self.read({'type':'Група'}), initial)
        Document.objects.filter(pk='products/first').update(data={'name':'first','type':'Група','category':'Direct'})
        self.assertEqual(self.read({'type':'Група'})['items'], ['Direct'])
        Document.objects.bulk_create([Document(path='products/new', data={'name':'new','type':'Група','category':'Bulk'})])
        self.assertEqual(self.read({'type':'Група'})['items'], ['Bulk','Direct'])
        Document.objects.filter(pk='products/new').delete()
        self.assertEqual(self.read({'type':'Група'})['items'], ['Direct'])
        with read_snapshot(), Selection(self.user, {'promotion':'yes'}, read_cache=True) as selection: before = key(selection)
        Document.objects.filter(pk='settings/main').update(data={'defaultMarkup':30,'rounding':.5,'privateFinancialSecret':'changed'})
        with read_snapshot(), Selection(self.user, {'promotion':'yes'}, read_cache=True) as selection: self.assertEqual(key(selection), before)
        Document.objects.filter(pk='settings/main').update(data={'defaultMarkup':35,'rounding':.5})
        with read_snapshot(), Selection(self.user, {'promotion':'yes'}, read_cache=True) as selection: self.assertNotEqual(key(selection), before)

    def test_current_scope_day_campaign_projection_and_role_privacy(self):
        stores = [Store.objects.create(name='Свій'), Store.objects.create(name='Чужий')]
        self.user.profile.store = stores[0]; self.user.profile.save()
        today = kyiv_day()
        own = self.campaign(store=stores[0]); foreign = self.campaign(store=stores[1])
        future = self.campaign(store=stores[0], start=today+timedelta(days=1), end=today+timedelta(days=1))
        def token():
            with read_snapshot(), Selection(self.user, {'promotion':'yes'}, read_cache=True) as selection: return key(selection)
        original = token()
        PromotionPrice.objects.filter(campaign=foreign).update(price='7')
        PromotionPrice.objects.filter(campaign=future).update(price='6')
        self.assertEqual(token(), original)
        PromotionPrice.objects.filter(campaign=own).update(price='7.99')
        self.assertNotEqual(token(), original); original = token()
        own.stores.remove(stores[0]); self.assertNotEqual(token(), original)
        original = token()
        with patch('server.erp.promotion_prices.kyiv_day', return_value=today+timedelta(days=1)): self.assertNotEqual(token(), original)
        self.user.profile.store = None; self.user.profile.save()
        self.create('private-hidden', hidden=True, category='Прихована назва')
        self.assertEqual(self.client.get('/api/v1/catalog/selection/facets?field=category&visibility=hidden').status_code, 200)
        self.user.profile.role='cashier'; self.user.profile.save()
        self.assertEqual(self.client.get('/api/v1/catalog/selection/facets?field=category&visibility=hidden').status_code, 403)
        with CaptureQueriesContext(connection) as queries:
            result=self.client.get('/api/v1/catalog/selection/page?promotion=yes')
        self.assertEqual(result.status_code, 200, result.content)
        self.assertTrue(all(row['cost'] is None and row['markup'] is None for row in result.json()['items']))
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        # Explicit inactive store validation happens BEFORE cache lookup.
        stores[0].active=False;stores[0].save()
        self.assertEqual(self.client.get(f'/api/v1/catalog/selection/facets?field=category&store={stores[0].pk}').status_code, 400)

    def test_file_lock_disk_ttl_partial_publication_and_post_bypass(self):
        self.read()
        with read_snapshot(), Selection(self.user, {}, read_cache=True) as selection:
            selection.build(); path=selection._cache_path
            with patch('server.erp.catalog_read_cache.MAX_BYTES', 1):
                from server.erp.catalog_read_cache import trim
                with self.assertRaises(CacheUnavailable): trim(path.parent, 1)
                self.assertTrue(path.exists())  # active reader cannot be evicted
        os.utime(path, (0,0))
        self.read();self.assertGreater(path.stat().st_mtime, 0)
        path.write_bytes(b'corrupt private derived file');self.read();self.assertGreater(path.stat().st_size, 100)
        Document.objects.filter(pk=self.product.pk).update(data={**self.product.data,'category':'new'})
        with patch('server.erp.catalog_read_cache.os.replace', side_effect=OSError('synthetic disk failure')):
            result=self.client.get('/api/v1/catalog/selection/facets?field=category')
        self.assertEqual(result.status_code,503); self.assertEqual(result['Retry-After'],'2')
        self.assertFalse(list(root().glob('.publish-*')))
        self.assertEqual(self.client.get('/api/v1/catalog/selection/facets?field=category').status_code,200)
        with open(root()/'publish.lock','rb') as lock, patch('server.erp.catalog_read_cache.MAX_WAIT', 0):
            fcntl.flock(lock,fcntl.LOCK_EX)
            result=self.client.get('/api/v1/catalog/selection/facets?field=category&q=different')
            self.assertEqual(result.status_code,503)
        with patch('server.erp.catalog_read_cache.load', side_effect=AssertionError('POST must bypass cache')):
            self.create('post-promo',promotion=True,promotionPrice='9')
            result=self.client.post('/api/v1/catalog/pricing/preview', {'kind':'markup','selection':{'q':'','type':'','category':'','pack':'','promotion':'yes','store':''},'markup':'31','resetManualPrices':False,'updateDefault':False},content_type='application/json',**self.headers)
            self.assertEqual(result.status_code,200,result.content)
            self.assertEqual(result.json()['summary']['candidates'],1)

    @skipUnless(connection.vendor=='postgresql', 'Real concurrent RR needs PostgreSQL')
    def test_same_rr_key_and_body_commit_between_cache_key_and_build(self):
        original = Selection._build_private
        def write():
            close_old_connections()
            try: Document.objects.create(path='products/late',data={'name':'late','category':'After snapshot'})
            finally: close_old_connections()
        def build(selection, directory=None):
            with ThreadPoolExecutor(max_workers=1) as workers: workers.submit(write).result(timeout=10)
            return original(selection,directory)
        with patch.object(Selection,'_build_private',build):
            before=self.read()
        self.assertNotIn('After snapshot',before['items'])
        after=self.read()
        self.assertIn('After snapshot',after['items'])

    def test_small_namespace_reservation_rename_peak_and_no_sort_scratch(self):
        self.create('faceted',type='Група',category='Кава',pack='Пакет')
        original=Selection._build_private;peaks=[]
        def bytes_now(): return sum(p.stat().st_size for p in root().rglob('*.sqlite3'))
        def build(selection,directory=None):
            self.assertLessEqual(bytes_now()+64*1024,128*1024)
            original(selection,directory)
            self.assertEqual(selection.db.execute('PRAGMA max_page_count').fetchone()[0],16)
            peaks.append(bytes_now());self.assertLessEqual(peaks[-1],128*1024)
            self.assertFalse(list(root().rglob('*-journal')))
            self.assertFalse(list(root().rglob('*-wal')))
        with patch('server.erp.catalog_read_cache.MAX_BYTES',128*1024),patch('server.erp.catalog_selection.MAX_DISK',64*1024),patch.object(Selection,'_build_private',build):
            self.read({'q':'one'});self.read({'q':'manual'});self.read()
            self.assertTrue(peaks)
            self.assertFalse(list(root().glob('.publish-*'))) # rename, no image copy
            with read_snapshot(),Selection(self.user,{},read_cache=True) as selection:
                selection.build()
                selection.facet('category','',1)
                plans=selection.db.execute('EXPLAIN QUERY PLAN SELECT value FROM facets WHERE field=? AND parent1=? AND parent2=? AND promoted=? AND contains(value,?) ORDER BY folded,value LIMIT 30',('category','','',0,'')).fetchall()
                self.assertFalse(any('TEMP B-TREE' in row[-1] for row in plans))
                plans=selection.db.execute('EXPLAIN QUERY PLAN SELECT path FROM items NOT INDEXED WHERE promoted=? ORDER BY position LIMIT 30',(0,)).fetchall()
                self.assertFalse(any('TEMP B-TREE' in row[-1] for row in plans))
                pinned=selection._cache_path.stat().st_size
                with patch('server.erp.catalog_read_cache.MAX_BYTES',pinned+64*1024-1),patch.object(Selection,'_build_private',side_effect=AssertionError('reservation must precede build')):
                    response=self.client.get('/api/v1/catalog/selection/facets?field=category&q=other')
                self.assertEqual(response.status_code,503)
            Document.objects.bulk_create([Document(path=f'products/huge-{n}',data={'name':f'huge-{n}','type':'Група'+str(n)+'x'*100,'category':'Кава'+str(n)+'x'*100,'pack':'Пакет'+str(n)+'x'*100}) for n in range(100)])
            response=self.client.get('/api/v1/catalog/selection/facets?field=category&q=huge-')
            self.assertEqual(response.status_code,503) # SQLite max_page_count, no truncated universe
            self.assertLessEqual(bytes_now(),128*1024)
            self.assertFalse(list(root().glob('.build-*')))
