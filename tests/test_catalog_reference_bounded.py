"""Whole dictionary impacts with paged presentation and untouched history."""
import uuid
from django.test import TransactionTestCase
from django.db import connection
from django.test.utils import CaptureQueriesContext
from server.erp.models import Document,AuditEvent
from tests import test_catalog_reference_management as fixtures


class BoundedReferenceImpactTests(TransactionTestCase):
    setUp=fixtures.ReferenceManagementTests.setUp
    def managed(self,field,text,parent=''):
        data=self.client.get('/api/v1/catalog/references/page',{'field':field,'q':text,**({'parentType':parent} if field=='category' else {})}).json()
        return next(item for item in data['items'] if item['value']==text and item['parentType']==parent)
    proposal=fixtures.ReferenceManagementTests.proposal
    preview=fixtures.ReferenceManagementTests.preview
    commit=fixtures.ReferenceManagementTests.commit
    def test_complete_65_children_products_paged_impact_preserves_arbitrary_unknown_json(self):
        # Original recipe/unknown fields must not be decoded, replaced or capped.
        unknown={'large':['ю'*150000,{'arbitrary':[None,False,0,{'x':'y'}]}]}
        group=self.managed('type','Напої')
        Document.objects.create(path='catalog_refs/'+group['id'],data={'field':'type','value':'Напої','parentType':'','unknown':unknown})
        for i in range(65):
            Document.objects.create(path=f'products/impact-{i:03}',data={'name':f'Товар {i:03}','type':'Напої','category':f'Категорія {i:03}','unit':'шт','cost':0,'markup':0,'recipe':[{'product':'coffee','quantity':1,'unknown':unknown}],'unknown':unknown})
        group=self.managed('type','Напої');payload=self.proposal(group,value='Нові напої')
        with CaptureQueriesContext(connection) as queries:
            reviewed=self.preview(payload)
        self.assertEqual(reviewed.status_code,200,reviewed.content)
        impact=reviewed.json();self.assertEqual(impact['productCount'],66);self.assertEqual(impact['referenceCount'],67)
        self.assertEqual(len(impact['examples']),10)
        self.assertFalse(any('SELECT "erp_document"."data"' in q['sql'] for q in queries))
        all_ids=[]
        for page in range(1,4):
            response=self.client.post('/api/v1/catalog/references/impact-page',{'request':payload,'snapshot':impact['snapshot'],'section':'products','page':page},content_type='application/json',**self.headers)
            self.assertEqual(response.status_code,200,response.content)
            result=response.json();self.assertEqual(result['total'],66);self.assertEqual(result['pages'],3)
            self.assertEqual(len(result['items']),30 if page<3 else 6);all_ids.extend(item['id'] for item in result['items'])
        self.assertEqual(len(set(all_ids)),66)
        response,_=self.commit(payload,impact);self.assertEqual(response.status_code,200,response.content)
        self.assertEqual(Document.objects.get(pk='catalog_refs/'+group['id']).data['unknown'],unknown)
        product=Document.objects.get(pk='products/impact-064')
        self.assertEqual(product.data['type'],'Нові напої');self.assertEqual(product.data['unknown'],unknown);self.assertEqual(product.data['recipe'][0]['unknown'],unknown)
        main=AuditEvent.objects.get(action='catalog_reference_changed').detail
        self.assertEqual(len(main['references']),10);self.assertEqual(main['referenceDetailCount'],57)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_reference_detail').count(),57)
        stale=self.client.post('/api/v1/catalog/references/impact-page',{'request':payload,'snapshot':impact['snapshot'],'section':'products','page':1},content_type='application/json',**self.headers)
        self.assertEqual(stale.status_code,409)
