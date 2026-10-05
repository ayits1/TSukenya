"""Fresh Unicode index/transactional queue and bounded worker progress."""
import uuid
from unittest.mock import patch
from django.db import connection,transaction
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import Document
from server.erp.import_models import CatalogNameIndex,CatalogRecipeIndex,CatalogIndexDirty,CatalogImportRun
from server.erp.import_index import drain,indexed_duplicate,legacy_recipe_lookup
from server.erp.catalog import duplicate_name,unit_in_use
from server.erp.import_jobs import claim,step,process_one
from tests.test_catalog_import_jobs import ImportJobsFixture


class CatalogImportIndexTests(ImportJobsFixture,TestCase):
    def setUp(self):self.setup_jobs()
    def flush_index(self):
        while True:
            _,pending=drain()
            if not pending:break
    def test_python_exact_unicode_whitespace_names_match_legacy_scan(self):
        names=['Straße','  КАВА\u00a0\tмелена  ','İ','ς','123']
        Document.objects.bulk_create([Document(path='products/'+str(i),data={'name':name}) for i,name in enumerate(names)])
        self.flush_index()
        for name in ('STRASSE','кава мелена','i\u0307','Σ','123','strase','i','124'):
            with self.subTest(name=name):self.assertEqual(indexed_duplicate({'name':name},{},'products/new'),duplicate_name({'name':name},{},'products/new'))
        self.assertFalse(indexed_duplicate({'name':'STRASSE'},{'name':'Straße'},'products/0'))
        self.assertFalse(CatalogIndexDirty.objects.exists())
    def test_bulk_update_delete_rollback_and_queue_generations(self):
        doc=Document.objects.create(path='products/base',data={'name':'Old'});self.flush_index()
        Document.objects.filter(pk=doc.pk).update(data={'name':'New','recipe':[{'product':True},{'product':123},{'product':{'unknown':1}}]})
        original=CatalogIndexDirty.objects.get(pk=doc.pk).revision
        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                Document.objects.filter(pk=doc.pk).update(data={'name':'Rollback'});drain();raise RuntimeError('rollback')
        self.assertEqual(CatalogIndexDirty.objects.get(pk=doc.pk).revision,original)
        self.flush_index();self.assertTrue(indexed_duplicate({'name':'NEW'},{},'products/other'));self.assertFalse(indexed_duplicate({'name':'OLD'},{},'products/other'))
        self.assertTrue(legacy_recipe_lookup('True','products/other'));self.assertTrue(legacy_recipe_lookup('123','products/other'))
        self.assertFalse(legacy_recipe_lookup('123',doc.pk))
        Document.objects.filter(pk=doc.pk).delete();self.assertTrue(CatalogIndexDirty.objects.filter(pk=doc.pk).exists());self.flush_index();self.assertFalse(CatalogNameIndex.objects.exists());self.assertFalse(CatalogRecipeIndex.objects.exists())
    def test_external_create_and_rename_after_plan_produce_fresh_conflict(self):
        old=Document.objects.create(path='products/other',data={'name':'Інше'})
        key=self.create([self.row(1,'Straße',cost='10'),self.row(2,'Кава мелена',cost='20'),self.row(3,'Добре',cost='10')]);self.ready(key);self.approve(key)
        Document.objects.bulk_create([Document(path='products/competitor',data={'name':'STRASSE'})])
        Document.objects.filter(pk=old.pk).update(data={'name':' КАВА\u00a0мелена '})
        self.drain(key);final=self.get('runs/'+key).json();self.assertEqual(final['counts']['conflicted'],2);self.assertEqual(final['counts']['created'],1)
        self.assertGreaterEqual(final['indexedPaths'],3)
    def test_unit_guard_legacy_reference_matches_exact_scan(self):
        Document.objects.create(path='products/base',data={'name':'Base','unit':'кг'})
        Document.objects.create(path='products/recipe',data={'name':'Recipe','recipe':[{'product':'base','quantity':1}]})
        self.flush_index();self.assertEqual(unit_in_use('products/base',{}),unit_in_use('products/base',{},legacy_recipe_lookup=legacy_recipe_lookup))
        key=self.create([self.row(1,'Base',unit='шт')]);detail=self.ready(key);self.assertEqual(detail['status'],'invalid')
        Document.objects.filter(pk='products/recipe').update(data={'name':'Recipe','recipe':[]});self.flush_index()
        self.assertIsNone(unit_in_use('products/base',{},legacy_recipe_lookup=legacy_recipe_lookup))
    def test_backlog_is_drained_in_steps_before_any_plan_or_apply_uses_index(self):
        Document.objects.bulk_create([Document(path='products/'+str(i),data={'name':f'Назва {i}'}) for i in range(450)])
        key=self.create([self.row(1)]);self.post('runs/'+key+'/seal',{})
        self.assertTrue(process_one(uuid.UUID(key)));run=CatalogImportRun.objects.get(pk=key)
        self.assertEqual(run.indexed_paths,200);self.assertEqual(run.phase_done,0);self.assertEqual(CatalogIndexDirty.objects.count(),250)
        self.assertTrue(process_one(uuid.UUID(key)));run.refresh_from_db();self.assertEqual(run.indexed_paths,400);self.assertEqual(run.phase_done,0)
        self.drain(key);self.assertEqual(self.get('runs/'+key).json()['status'],'ready')
    def test_adaptive_one_row_progress_survives_elapsed_lease_and_restart(self):
        key=self.create([self.row(1,cost='10'),self.row(2,cost='20')]);self.ready(key);self.approve(key)
        identifier,token=claim(uuid.UUID(key))
        from django.utils import timezone
        from datetime import timedelta
        original_apply=__import__('server.erp.import_jobs',fromlist=['apply_row']).apply_row
        def delayed(run,row,user,config,**kwargs):
            original_apply(run,row,user,config,**kwargs);run.lease_until=timezone.now()-timedelta(seconds=1)
        with patch('server.erp.import_jobs.apply_row',delayed),patch('server.erp.import_jobs.monotonic',side_effect=[0,6]):
            self.assertTrue(step(identifier,token))
        run=CatalogImportRun.objects.get(pk=key);self.assertEqual(run.phase_done,1);self.assertEqual(run.counts['created'],1);self.assertEqual(run.status,'queued')
        self.drain(key);self.assertEqual(self.get('runs/'+key).json()['counts']['created'],2)
    def test_oversized_existing_record_is_explicit_failure_and_recovers_after_fix(self):
        Document.objects.create(path='products/oversized',data={'name':'Bad','recipe':[{'product':str(i)} for i in range(101)]})
        key=self.create([self.row(1)]);self.post('runs/'+key+'/seal',{});self.assertTrue(process_one(uuid.UUID(key)))
        run=self.get('runs/'+key).json();self.assertEqual(run['status'],'failed');self.assertEqual(run['error']['code'],'catalog_index_limit');self.assertIn('products/oversized',run['error']['message'])
        Document.objects.filter(pk='products/oversized').update(data={'name':'Bad','recipe':[]})
        self.assertEqual(self.post('runs/'+key+'/resume',{}).status_code,200);self.drain(key);self.assertEqual(self.get('runs/'+key).json()['status'],'ready')
    def test_fresh_lookup_never_queries_product_catalogue_or_full_recipes_per_row(self):
        Document.objects.bulk_create([Document(path='products/'+str(i),data={'name':f'Назва {i}'}) for i in range(1500)]);self.flush_index()
        with CaptureQueriesContext(connection) as captured:
            for i in range(30):self.assertFalse(indexed_duplicate({'name':f'Новий {i}'},{},'products/new'));self.assertFalse(legacy_recipe_lookup('new','products/another'))
        self.assertEqual(len(captured),60)
        self.assertFalse(any('erp_document' in q['sql'].lower() for q in captured))


    def test_dirty_generation_change_during_refresh_cannot_be_silently_removed(self):
        document=Document.objects.create(path='products/base',data={'name':'Old'})
        original=CatalogNameIndex.objects.update_or_create
        def changed(*args,**kwargs):
            result=original(*args,**kwargs)
            Document.objects.filter(pk=document.pk).update(data={'name':'New'})
            return result
        with patch.object(CatalogNameIndex.objects,'update_or_create',changed):
            n,pending=drain();self.assertEqual(n,1);self.assertTrue(pending)
        self.flush_index();self.assertTrue(indexed_duplicate({'name':'NEW'},{},'products/other'));self.assertFalse(indexed_duplicate({'name':'OLD'},{},'products/other'))


    def test_same_chunk_unicode_collisions_and_final_normalizer_key_match(self):
        key=self.create([self.row(1,'Straße'),self.row(2,'  STRASSE  ')])
        detail=self.ready(key);self.assertEqual(detail['status'],'invalid');self.assertEqual(detail['counts']['invalid'],2)
        self.assertFalse(Document.objects.filter(path__startswith='products/').exists())
        from server.erp.import_jobs import name_hash
        key=self.create([self.row(3,'  Кава\u00a0мелена  ',cost='10'),self.row(4,'Чай',cost='10')]);self.ready(key)
        run=CatalogImportRun.objects.get(pk=key)
        for row in run.rows.all():self.assertEqual(row.name_hash,name_hash(row.data['name']))
        self.approve(key);self.drain(key);self.assertEqual(self.get('runs/'+key).json()['counts']['created'],2)
        for row in run.rows.all():self.assertEqual(row.name_hash,name_hash(Document.objects.get(pk=row.product_path).data['name']))

    def test_recipe_inserted_after_ready_is_seen_by_current_unit_guard(self):
        base=Document.objects.create(path='products/base',data={'name':'Base','unit':'кг'})
        key=self.create([self.row(1,'Base',unit='шт')]);self.ready(key);self.approve(key)
        Document.objects.bulk_create([Document(path='products/recipe',data={'name':'Recipe','recipe':[{'product':'base','quantity':1}]})])
        self.drain(key);self.assertEqual(self.get('runs/'+key).json()['counts']['failed'],1)
        base.refresh_from_db();self.assertEqual(base.data['unit'],'кг')

    def test_reference_cache_matches_shared_alias_archive_merge_and_orphan_binding(self):
        from types import SimpleNamespace
        from server.erp.catalog_references import reference_records,bind_reference_fields
        from server.erp.import_references import ReferenceCache
        Document.objects.bulk_create([
            Document(path='catalog_refs/group',data={'field':'type','value':'Нова група','aliases':[{'value':'Стара група'}]}),
            Document(path='catalog_refs/category',data={'field':'category','value':'Нова категорія','parentType':'Стара група','parentId':'group','aliases':[{'value':'Стара категорія','parentType':'Стара група'}]}),
            Document(path='catalog_refs/pack-old',data={'field':'pack','value':'Старе пакування','state':'merged','mergedInto':'pack-new'}),
            Document(path='catalog_refs/pack-new',data={'field':'pack','value':'Нове пакування'}),
            Document(path='catalog_refs/size',data={'field':'size','value':'Архів','state':'archived'})])
        cache=ReferenceCache()
        for old,value in (
            ({},{'type':'Стара група','category':'Стара категорія','pack':'Старе пакування','unit':'шт'}),
            ({'name':'Старий','type':'Стара група','category':'Стара категорія','size':'Архів','referenceIds':{'type':'group','category':'category'}},{'type':'Стара група','category':'Стара категорія','size':'Архів'}),
            ({'name':'Старий','pack':'Невідоме','referenceIds':{'pack':'missing'}},{'pack':'Невідоме'}),
            ({},{'type':'Група з файла','category':'Нова з файла','unit':'порція'})):
            base={**old,**value};expected=dict(base);actual=dict(base)
            shared=reference_records(legacy_values=[SimpleNamespace(data=old),SimpleNamespace(data=base)])
            bind_reference_fields(expected,old,references=shared);bind_reference_fields(actual,old,references=cache.scope(old,value))
            self.assertEqual(actual,expected)
    def test_many_explicit_refs_are_read_and_materialized_once_per_worker_step(self):
        import server.erp.import_references as module
        Document.objects.bulk_create([Document(path=f'catalog_refs/pack-{i:04}',data={'field':'pack','value':f'Пакування {i}'}) for i in range(1000)])
        key=self.create([self.row(i,pack=f'Пакування {i}') for i in range(1,11)]);self.post('runs/'+key+'/seal',{})
        self.assertTrue(process_one(uuid.UUID(key)))  # Empty catalogue index -> validating.
        with CaptureQueriesContext(connection) as queries,patch.object(module,'ReferenceIndex',wraps=module.ReferenceIndex) as built:
            self.assertTrue(process_one(uuid.UUID(key)));self.assertEqual(built.call_count,1)
        self.assertEqual(sum('catalog_refs/' in q['sql'].replace('\\','') for q in queries),2)
        self.assertFalse(any('SELECT \"erp_document\".\"data\"' in q['sql'] for q in queries))
        self.assertEqual(self.get('runs/'+key).json()['planned']['create'],10);self.approve(key)
        with CaptureQueriesContext(connection) as queries,patch.object(module,'ReferenceIndex',wraps=module.ReferenceIndex) as built:
            self.assertTrue(process_one(uuid.UUID(key)));self.assertEqual(built.call_count,1)
        self.assertEqual(sum('catalog_refs/' in q['sql'].replace('\\','') for q in queries),2)
        self.assertFalse(any('SELECT \"erp_document\".\"data\"' in q['sql'] for q in queries))
        self.assertEqual(self.get('runs/'+key).json()['counts']['created'],10)
