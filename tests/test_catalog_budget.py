"""Small deterministic operation-budget rollback; no load benchmark."""
from unittest.mock import Mock, patch
from django.test import TransactionTestCase, RequestFactory, SimpleTestCase
from server.erp.catalog_budget import budget,check,BudgetExceeded
from server.erp.models import Document,AuditEvent
from tests import test_catalog_import as import_fixtures
from tests import test_catalog_reference_management as reference_fixtures
from tests.test_catalog_import_jobs import ImportJobsFixture


class NestedBudgetTests(SimpleTestCase):
    def test_nested_record_budget_cannot_extend_caller_deadline(self):
        clock=[0]
        with patch('server.erp.catalog_budget.monotonic',side_effect=lambda:clock[0]):
            with budget(1):
                clock[0]=.8
                with budget(120):
                    clock[0]=1.1
                    with self.assertRaises(BudgetExceeded):check()


class ReferenceIndexBudgetTests(SimpleTestCase):
    def index(self):
        from server.erp.catalog_reference_index import ReferenceIndex
        with patch.object(ReferenceIndex,'build'):
            index=ReferenceIndex()
        self.addCleanup(index.close)
        for identifier in ('first','second'):
            index.put({'id':identifier,'field':'type','value':identifier,'parentType':'','state':'active'})
        return index

    def test_expired_iterator_refuses_before_consuming_next_disk_row(self):
        index=self.index();database=index.db;consumed=[];cursors=[];clock=[0]
        class Cursor:
            def __init__(self,cursor):self.cursor=cursor;self.closed=False
            def __iter__(self):return self
            def __next__(self):
                row=self.fetchone()
                if row is None:raise StopIteration
                return row
            def fetchone(self):
                row=self.cursor.fetchone()
                if row is not None:consumed.append(row)
                return row
            def close(self):self.closed=True;self.cursor.close()
        def execute(*args):
            cursor=Cursor(database.execute(*args));cursors.append(cursor);return cursor
        index.db=Mock(wraps=database);index.db.execute.side_effect=execute
        with patch('server.erp.catalog_budget.monotonic',side_effect=lambda:clock[0]):
            with budget(1):
                rows=iter(index);self.assertEqual(next(rows),'first');clock[0]=1.1
                with self.assertRaises(BudgetExceeded):next(rows)
        self.assertEqual(consumed,[('first',)])
        self.assertTrue(cursors[0].closed)

    def test_expired_direct_get_and_put_refuse_before_disk_access_or_position_change(self):
        index=self.index()
        self.assertEqual(list(index),['first','second'])
        self.assertEqual([item['id'] for item in index.values()],['first','second'])
        database=index.db;index.db=Mock(wraps=database);clock=[0]
        with patch('server.erp.catalog_budget.monotonic',side_effect=lambda:clock[0]):
            with budget(1):
                clock[0]=1.1
                with self.assertRaises(BudgetExceeded):index['first']
                with self.assertRaises(BudgetExceeded):
                    index.put({'id':'third','field':'type','value':'third','parentType':'','state':'active'})
        index.db.execute.assert_not_called()
        self.assertEqual(index.position,2)
        self.assertEqual(database.execute('SELECT count(*) FROM items').fetchone()[0],2)


class AtomicBudgetTests(TransactionTestCase):
    setUp=import_fixtures.CatalogImportTests.setUp
    post=import_fixtures.CatalogImportTests.post
    row=import_fixtures.CatalogImportTests.row
    commit_payload=import_fixtures.CatalogImportTests.commit_payload
    def test_whole_import_budget_rolls_back_first_written_row_and_receipt(self):
        from server.erp.catalog_import import commit_import
        from server.erp.catalog_projection import save_projection
        payload=self.commit_payload({'entries':[self.row('Кава',cost='20'),self.row('Друга',line=3,cost='2')]})
        clock=[0];written=[]
        def save(*args,**kwargs):
            result=save_projection(*args,**kwargs);written.append(args[0].pk);clock[0]=2;return result
        request=RequestFactory().post('/api/v1/catalog/import/commit',payload,content_type='application/json')
        with patch('server.erp.catalog_budget.monotonic',side_effect=lambda:clock[0]),patch('server.erp.catalog_projection.save_projection',side_effect=save):
            with budget(1),self.assertRaises(BudgetExceeded):commit_import(request,self.user)
        self.assertEqual(written,['products/coffee'])
        self.product.refresh_from_db();self.assertEqual(self.product.data['cost'],10)
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(),1)
        self.assertFalse(Document.objects.filter(path__startswith='import_runs/').exists())
        self.assertFalse(AuditEvent.objects.exists())


class ReferenceBudgetTests(TransactionTestCase):
    setUp=reference_fixtures.ReferenceManagementTests.setUp
    managed=reference_fixtures.ReferenceManagementTests.managed
    proposal=reference_fixtures.ReferenceManagementTests.proposal
    preview=reference_fixtures.ReferenceManagementTests.preview
    def test_reference_budget_rolls_back_written_source_and_all_audit(self):
        from server.erp.catalog_reference_management import commit
        from server.erp.catalog_projection import save_reference
        source=self.managed('type','Напої');payload=self.proposal(source,value='Гарячі напої')
        body={**payload,'snapshot':self.preview(payload).json()['snapshot'],'idempotencyKey':'a65380c9-f766-45e6-bba3-c3f2f8a5befe'}
        before=list(Document.objects.values('path','data'));clock=[0];written=[]
        def save(*args,**kwargs):
            result=save_reference(*args,**kwargs);written.append(args[0]['id']);clock[0]=2;return result
        request=RequestFactory().post('/api/v1/catalog/references/commit',body,content_type='application/json')
        with patch('server.erp.catalog_budget.monotonic',side_effect=lambda:clock[0]),patch('server.erp.catalog_projection.save_reference',side_effect=save):
            with budget(1),self.assertRaises(BudgetExceeded):commit(request,self.user)
        self.assertEqual(len(written),1)
        self.assertEqual(list(Document.objects.values('path','data')),before)
        self.assertFalse(AuditEvent.objects.exists())


class DurableBudgetTests(ImportJobsFixture,TransactionTestCase):
    def setUp(self):self.setup_jobs()
    def test_worker_step_budget_rolls_back_row_cursor_and_catalogue(self):
        from server.erp.import_jobs import claim,step
        key=self.create([self.row(1,cost='2'),self.row(2,cost='3')]);self.ready(key);self.approve(key)
        claimed=claim(key);self.assertIsNotNone(claimed)
        from server.erp.import_models import CatalogImportRun,CatalogImportRow
        from server.erp.import_jobs import apply_row
        clock=[0];attempted=[]
        def apply(*args,**kwargs):
            result=apply_row(*args,**kwargs);attempted.append(args[1].ordinal);clock[0]=2;return result
        with patch('server.erp.catalog_budget.monotonic',side_effect=lambda:clock[0]),patch('server.erp.import_jobs.apply_row',side_effect=apply):
            with budget(1),self.assertRaises(BudgetExceeded):step(*claimed)
        self.assertEqual(attempted,[1])
        self.assertFalse(Document.objects.filter(path__startswith='products/').exists())
        self.assertFalse(AuditEvent.objects.exists())
        self.assertEqual(list(CatalogImportRow.objects.filter(run_id=key).values_list('status',flat=True)),['planned','planned'])
        self.assertEqual(CatalogImportRun.objects.get(pk=key).row_cursor,0)
