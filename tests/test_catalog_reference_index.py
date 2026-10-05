import json
from unittest.mock import patch
from django.test import TransactionTestCase, RequestFactory
from types import SimpleNamespace
from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from server.erp.models import Document, Profile
from server.erp.catalog_references import reference_records, find_reference, public
from server.erp.catalog_reference_index import ReferenceIndex
from server.erp.catalog_reference_management import item_revision
from server.erp.catalog_reference_reads import handle


class ReferenceIndexTests(TransactionTestCase):
    def setUp(self):
        self.owner=User.objects.create_user('references_owner');Profile.objects.create(user=self.owner,role='owner')
    def test_complete_dictionary_oracle_aliases_parent_tombstone_unicode(self):
        docs=[('catalog_refs/group',{'field':'type','value':'Нова група','aliases':[{'value':'Стара група','parentType':''}]}),
              ('catalog_refs/category',{'field':'category','value':'Кава','parentType':'Стара група'}),
              ('catalog_refs/pack',{'field':'pack','value':'Коробка','state':'archived','aliases':[{'value':'Коробки'},{'value':'Коробки'},None,{'value':{'historical':'not a choice'}},{'value':['not a choice']}]}),
              ('catalog_refs/unit',{'field':'unit','value':'шт','state':'archived'}),
              ('products/a',{'name':'A','type':'Стара група','category':'Кава','pack':'Коробки','unit':'шт','size':'Straße','unknown':{'recipe':'x'*300000}}),
              ('products/b',{'name':'B','type':'Інша','category':'Чай','size':'STRASSE'})]
        for path,data in docs:Document.objects.create(path=path,data=data)
        oracle=reference_records()
        with CaptureQueriesContext(connection) as queries:
            with ReferenceIndex() as index:
                self.assertEqual(set(index),set(oracle))
                for identifier,expected in oracle.items():
                    actual=index[identifier]
                    self.assertEqual({**actual,'aliases':list(actual['aliases'])},expected)
                    self.assertEqual(item_revision(actual),item_revision(expected))
                self.assertEqual(index.lookup('category','Кава','Стара група')['id'],find_reference(oracle,'category','Кава','Стара група')['id'])
                self.assertEqual(index.lookup('size','strasse')['id'],find_reference(oracle,'size','strasse')['id'])
                items,total,page,pages=index.page('unit','active','',None,None,1)
                self.assertEqual(total,0)
        self.assertFalse(any('SELECT "erp_document"."data"' in q['sql'] for q in queries))
    def test_pages_details_beyond_first_and_unknown_id_not_archive(self):
        for number in range(65):Document.objects.create(path=f'products/p{number:03}',data={'name':str(number),'type':f'Група {number:03}','unit':'шт'})
        with ReferenceIndex() as index:
            selected=index.lookup('type','Група 064')
            items,total,page,pages=index.page('type','active','',None,None,3)
            self.assertEqual((len(items),total,page,pages),(5,65,3,3))
        factory=RequestFactory()
        request=factory.get('/api/v1/catalog/references/page',{'field':'type','page':'3'});request.portal_session=SimpleNamespace(csrf='isolated')
        response=handle(request,self.owner)
        value=json.loads(response.content);self.assertEqual(value['items'][-1]['id'],selected['id'])
        request=factory.post('/api/v1/catalog/references/details',data=json.dumps({'items':[{'field':'type','id':selected['id'],'value':'Група 064'},{'field':'type','id':'missing','value':'Група 064'}]}),content_type='application/json')
        value=json.loads(handle(request,self.owner).content)
        self.assertEqual([item['resolved'] for item in value['items']],[True,False]);self.assertIsNone(value['items'][1]['item'])
