import json
from contextlib import nullcontext
import os
import tempfile
from decimal import Decimal
from unittest.mock import patch
from django.test import TestCase
from django.db import connection, transaction
from django.test.utils import CaptureQueriesContext
from server.erp.catalog import revision
from server.erp.catalog_projection import CanonicalStream, document_revision, merge_document, text_chunks
from server.erp.models import Document, StateVersion


class ProjectionTests(TestCase):
    def test_pricing_defaults_scalar_parity_missing_null_zero_fraction_and_unknown(self):
        from server.erp.catalog import defaults,pricing_config
        huge={'arbitrary':['я'*200000,{'private':'not returned'}]}
        for terms in ({},{'defaultMarkup':None,'rounding':None},{'defaultMarkup':0,'rounding':0},{'defaultMarkup':.5,'rounding':'0.25'}):
            Document.objects.update_or_create(path='settings/main',defaults={'data':{**terms,'unknown':huge}})
            with CaptureQueriesContext(connection) as queries:
                self.assertEqual(defaults(),pricing_config(terms))
            self.assertFalse(any('SELECT "erp_document"."data"' in q['sql'] for q in queries))

    def test_scalar_projection_preserves_nested_json_without_sqlite_subtype(self):
        from server.erp.catalog_projection import projected_document, projected_documents, pricing_settings
        # Some SQLite query/virtual-table boundaries discard the internal JSON
        # subtype. An identity UDF reproduces that without changing SQL values.
        def plain_atoms(execute, sql, params, many, context):
            return execute(sql.replace('json_quote(value)', 'json_quote(qa_plain_scalar(value))'), params, many, context)
        if connection.vendor == 'sqlite':
            connection.ensure_connection()
            connection.connection.create_function('qa_plain_scalar', 1, lambda value: value)
        boundary = connection.execute_wrapper(plain_atoms) if connection.vendor == 'sqlite' else nullcontext()
        try:
            with boundary:
                for number, value in enumerate(({'pack': 'unknown_stable', 'nested': [None, True, 0]},
                                                [{'pack': 'historical'}], '{"pack":"text"}', None, False, 0)):
                    with self.subTest(value=value):
                        data = {'name': 'Товар', 'referenceIds': value}
                        path = f'products/projection-{number}'
                        Document.objects.create(path=path, data={**data, 'unknown': {'large': 'я' * 100000}})
                        self.assertEqual(projected_document(path).data, data)
                        self.assertEqual(list(projected_documents([path]))[0].data, data)
                        terms = {'defaultMarkup': value, 'rounding': '0.25'}
                        Document.objects.update_or_create(path='settings/main', defaults={'data': terms})
                        self.assertEqual(pricing_settings(), terms)
        finally:
            if connection.vendor == 'sqlite':
                connection.connection.create_function('qa_plain_scalar', 1, None)

    def test_canonical_old_revision_oracle_nested_unicode_arrays_spelling(self):
        config={'markup':Decimal('0.5000'),'rounding':Decimal('.5')}
        data={'z':[{'é':'Привіт\\\"\n😀','a':None},1.0,1e-7,-0.0,True,False],
              'a':{'long-key':{'é':{'x':2}},'b':[[],{}]},'name':'123','unknown':{'z':7,'a':0}}
        doc=Document.objects.create(path='products/parity',data=data)
        # Match the actual backend's legacy decode, including PostgreSQL -0.0.
        doc.refresh_from_db()
        with CaptureQueriesContext(connection) as queries:
            self.assertEqual(document_revision(doc.path,config),revision(doc,config))
        self.assertFalse(any('SELECT "erp_document"."data"' in q['sql'] for q in queries))
        raw=json.dumps(data,ensure_ascii=True)
        with tempfile.TemporaryDirectory() as directory:
            stream=CanonicalStream((raw[i:i+3] for i in range(0,len(raw),3)),directory)
            try:self.assertEqual(b''.join(stream.canonical()).decode(),json.dumps(data,sort_keys=True,ensure_ascii=False,separators=(',',':')))
            finally:stream.close()

    def test_arbitrary_unknown_json_survives_top_level_null_replacement(self):
        unknown={'tree':[{'content':'я'*40000,'metadata':{'nested':i}} for i in range(8)]}
        original={'name':'Товар','cost':10,'price':12,'referenceIds':{'type':'a','pack':'old'},'unknown':unknown}
        doc=Document.objects.create(path='products/large',data=original)
        version=StateVersion.objects.get(pk='catalog').revision
        with CaptureQueriesContext(connection) as queries:
            merge_document(doc.pk,{'cost':0,'price':None,'referenceIds':{'type':'b'}})
        self.assertEqual(StateVersion.objects.get(pk='catalog').revision,version+1)
        doc.refresh_from_db()
        self.assertEqual(doc.data,{**original,'cost':0,'price':None,'referenceIds':{'type':'b'}})
        self.assertFalse(any('SELECT "erp_document"."data"' in q['sql'] for q in queries))
        self.assertEqual(document_revision(doc.pk,{'markup':Decimal(30),'rounding':Decimal('.5')}),revision(doc,{'markup':Decimal(30),'rounding':Decimal('.5')}))
        self.assertTrue(all(len(chunk)<=16384 for chunk in text_chunks(doc.pk)))

    def test_counters_bulk_direct_delete_rollback(self):
        doc=Document.objects.create(path='products/counter',data={'name':'a','extra':[{'x':1}]})
        before=StateVersion.objects.get(pk='catalog').revision
        Document.objects.filter(pk=doc.pk).update(data={'name':'b','extra':[{'x':1}]})
        self.assertEqual(StateVersion.objects.get(pk='catalog').revision,before+1)
        try:
            with transaction.atomic():
                merge_document(doc.pk,{'name':'rolled back'})
                raise ValueError()
        except ValueError:pass
        self.assertEqual(StateVersion.objects.get(pk='catalog').revision,before+1)
        doc.delete();self.assertEqual(StateVersion.objects.get(pk='catalog').revision,before+2)
        ref=Document.objects.create(path='catalog_refs/counter',data={'field':'type','value':'a'})
        before=StateVersion.objects.get(pk='references').revision
        merge_document(ref.pk,{'value':'b'});ref.delete()
        self.assertEqual(StateVersion.objects.get(pk='references').revision,before+2)


    def test_sqlite_scalar_callback_envelope_no_historical_transport(self):
        if connection.vendor!='sqlite':return
        doc=Document.objects.create(path='products/envelope',data={'name':'n','cost':1,'unknown':{'blob':'x'*400000}})
        Document.objects.update_or_create(path='settings/main',defaults={'data':{'defaultMarkup':.5,'rounding':.5,'unknown':{'private':'x'*400000}}})
        original=json.loads;seen=[]
        def bounded(value,*args,**kwargs):
            if isinstance(value,str):
                seen.append(len(value));self.assertLess(len(value),2048)
            return original(value,*args,**kwargs)
        with patch('server.erp.state_version_sqlite.json.loads',side_effect=bounded):
            merge_document(doc.pk,{'cost':2})
        self.assertTrue(seen)
        version=StateVersion.objects.get(pk='catalog').revision
        with connection.cursor() as cursor:
            cursor.execute('UPDATE erp_document SET data=data WHERE path=%s',[doc.pk])
        self.assertEqual(StateVersion.objects.get(pk='catalog').revision,version)
        Document.objects.filter(pk=doc.pk).update(path='catalog_refs/transition')
        self.assertEqual(StateVersion.objects.get(pk='catalog').revision,version+1)
        self.assertTrue(StateVersion.objects.filter(pk='references').exists())
        Document.objects.filter(pk='catalog_refs/transition').update(path='tasks/transition',data={'title':'t','scope':'operations'})
        self.assertTrue(StateVersion.objects.filter(pk='ops_tasks').exists())

    def test_sqlite_semantic_invalidation_nested_order_numbers_and_arrays(self):
        if connection.vendor!='sqlite':return
        value={'name':'n','unknown':{'b':{'y':True,'x':None},'a':[1,2]},'float':10.0,'huge':99999999999999999999,'zero':0.0}
        doc=Document.objects.create(path='products/semantic',data=value)
        baseline=StateVersion.objects.get(pk='catalog').revision
        reordered={**dict(reversed(list(value.items()))),'unknown':{'a':[1,2],'b':{'x':None,'y':True}}}
        Document.objects.filter(pk=doc.pk).update(data=reordered)
        self.assertEqual(StateVersion.objects.get(pk='catalog').revision,baseline)
        for key,next_value in (('float',10),('zero',-0.0),('huge',99999999999999999998),('unknown',{'a':[2,1],'b':{'x':None,'y':True}})):
            baseline=StateVersion.objects.get(pk='catalog').revision
            reordered={**reordered,key:next_value}
            Document.objects.filter(pk=doc.pk).update(data=reordered)
            self.assertEqual(StateVersion.objects.get(pk='catalog').revision,baseline+1,key)
        # Equal float values with different exponent spelling stay a no-op.
        baseline=StateVersion.objects.get(pk='catalog').revision
        with connection.cursor() as cursor:
            cursor.execute('UPDATE erp_document SET data=replace(data,%s,%s) WHERE path=%s',['"zero": -0.0','"zero": -0e0',doc.pk])
        self.assertEqual(StateVersion.objects.get(pk='catalog').revision,baseline)

    def test_disposable_namespace_disk_guard_precedes_write_and_no_sort_journal(self):
        import server.erp.catalog_projection as module
        from server.erp.services import BusinessError
        with tempfile.TemporaryDirectory() as directory,patch.object(module,'MAX_DISK',32768):
            stream=CanonicalStream(iter(['"',*(['x'*8192]*8),'"']),directory)
            try:
                with self.assertRaises(BusinessError):list(stream.canonical())
                self.assertLessEqual(sum(os.path.getsize(directory+'/'+name) for name in os.listdir(directory)),32768)
                self.assertEqual(stream.db.execute('PRAGMA journal_mode').fetchone()[0],'off')
                plan=stream.db.execute('EXPLAIN QUERY PLAN SELECT key,start,end FROM members WHERE parent=? ORDER BY key COLLATE python',(1,)).fetchall()
                self.assertFalse(any('TEMP B-TREE' in row[-1] for row in plan))
                self.assertFalse(any(name.endswith('-journal') for name in os.listdir(directory)))
            finally:stream.close()
