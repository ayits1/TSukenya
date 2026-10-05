"""Whole small and durable imports retain arbitrary historical JSON, exact guards."""
import uuid
from datetime import timedelta
from unittest.mock import patch
from django.test import TransactionTestCase
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from server.erp.models import Document, Store, PromotionCampaign, PromotionPrice, AuditEvent
from server.erp.catalog import defaults
from server.erp.catalog_projection import recipe_usage
from server.erp.catalog_source_guard import snapshot
from tests.test_catalog_import_jobs import ImportJobsFixture

class BoundedImportTests(ImportJobsFixture,TransactionTestCase):
    def setUp(self):self.setup_jobs()
    def product(self):
        Document.objects.create(path='products/ingredient',data={'name':'Інгредієнт','unit':'кг'})
        data={'name':'Історичний','unit':'шт','cost':10,'markup':.5,'price':None,'manualPrice':False,'hidden':True,
              'recipe':[{'product':'ingredient','quantity':1,'unknown':'я'*150000}],
              'arbitrary':{'a':[{'nested':'x'*300000}], 'z':None}}
        Document.objects.create(path='products/old',data=data);return data
    def test_atomic_existing_large_history_preserved_exact_receipt_before_new_guard(self):
        old=self.product();payload={'entries':[self.row(1,'Історичний',cost='12.00',markup='0.5000')]}
        with CaptureQueriesContext(connection) as queries:
            preview=self.post('preview',payload);self.assertEqual(preview.status_code,200,preview.content)
            self.assertTrue(preview.json()['valid'],preview.content)
            body={**payload,'snapshot':preview.json()['snapshot'],'idempotencyKey':str(uuid.uuid4())}
            first=self.post('commit',body);self.assertEqual(first.status_code,200,first.content)
        actual=Document.objects.get(pk='products/old').data
        self.assertEqual(actual['arbitrary'],old['arbitrary']);self.assertEqual(actual['recipe'],old['recipe'])
        self.assertEqual((actual['cost'],actual['markup'],actual['manualPrice'],actual['hidden']),(12,.5,False,True))
        self.assertFalse(any('SELECT "erp_document"."data"' in q['sql'] and 'products/' in q['sql'] for q in queries))
        Document.objects.filter(pk='products/old').delete()
        self.assertEqual(self.post('commit',body).json(),first.json());self.assertFalse(Document.objects.filter(pk='products/old').exists())
        other={**body,'idempotencyKey':str(uuid.uuid4())};self.assertEqual(self.post('commit',other).status_code,409)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),1)
    def test_durable_large_unknown_recipe_metadata_preserved_and_old_revision_conflicts(self):
        old=self.product();key=self.create([self.row(1,'Історичний',cost='12.00',markup='0.5000')]);ready=self.ready(key)
        self.assertEqual(ready['status'],'ready',ready);self.approve(key)
        with CaptureQueriesContext(connection) as queries:self.drain(key)
        final=self.get('runs/'+key).json();self.assertEqual(final['counts']['updated'],1,final)
        actual=Document.objects.get(pk='products/old').data
        self.assertEqual(actual['arbitrary'],old['arbitrary']);self.assertEqual(actual['recipe'],old['recipe'])
        self.assertEqual((actual['cost'],actual['markup']),(12,.5))
        self.assertFalse(any('SELECT "erp_document"."data"' in q['sql'] and 'products/' in q['sql'] for q in queries))
        key2=self.create([self.row(2,'Історичний',cost='13')]);self.ready(key2);self.approve(key2)
        Document.objects.filter(pk='products/old').update(data={**actual,'arbitrary':{'changed':True}})
        self.drain(key2);self.assertEqual(self.get('runs/'+key2).json()['counts']['conflicted'],1)
    def test_source_guard_tracks_counter_config_day_membership_price_and_store(self):
        day=timezone.localdate();config=defaults();before=snapshot(config,day=day)
        self.assertNotEqual(snapshot(config,day=day+timedelta(days=1)),before)
        self.assertNotEqual(snapshot({**config,'markup':config['markup']+1},day=day),before)
        product=Document.objects.create(path='products/guard',data={'name':'Guard'})
        current=snapshot(config,day=day);self.assertNotEqual(current,before)
        Document.objects.filter(pk=product.pk).update(data={'name':'Guard','unknown':True})
        updated=snapshot(config,day=day);self.assertNotEqual(updated,current)
        store=Store.objects.create(name='Ізольований');storeguard=snapshot(config,day=day);self.assertNotEqual(storeguard,updated)
        campaign=PromotionCampaign.objects.create(name='Кампанія',scope='stores',starts_on=day,ends_on=day,author=self.user)
        campaign.stores.add(store);PromotionPrice.objects.create(campaign=campaign,product=product,price='1.00')
        active=snapshot(config,day=day);self.assertNotEqual(active,storeguard)
        PromotionPrice.objects.filter(campaign=campaign).update(price='2.00');self.assertNotEqual(snapshot(config,day=day),active)
    def test_scalar_legacy_recipe_usage_bool_null_numeric_oracle(self):
        Document.objects.create(path='products/recipe',data={'recipe':[{'product':True},{'product':False},{'product':None},{'product':123},{'product':'target','extra':'x'*300000}]})
        for value in ('True','False','None','123','target'):self.assertTrue(recipe_usage(value,'products/not-this'))
        self.assertFalse(recipe_usage('target','products/recipe'));self.assertFalse(recipe_usage('true','products/not-this'))
