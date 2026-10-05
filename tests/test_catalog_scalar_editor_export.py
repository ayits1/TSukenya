"""Actual editor/exchange projections retain arbitrary historical JSON."""
import csv
import io
from unittest.mock import patch
from django.test import TransactionTestCase
from django.db import connection
from django.test.utils import CaptureQueriesContext
from server.erp.models import Document
from tests import test_catalog as fixtures
from server.erp.catalog_schema import columns


class ScalarEditorExportTests(TransactionTestCase):
    setUp=fixtures.CatalogTests.setUp
    detail=fixtures.CatalogTests.detail
    patch=fixtures.CatalogTests.patch
    def test_actual_detail_save_visibility_preserve_unknown_and_recipe_child_metadata(self):
        doc=Document.objects.get(pk='products/one');extra={'arbitrary':[{'blob':'Ж'*200000},None,False,0]}
        doc.data.update(promotion=False,unknown=extra,recipe=[{'product':'two','quantity':1,'unknown':extra}]);doc.save()
        with CaptureQueriesContext(connection) as queries:
            before=self.detail()
            result=self.patch({'revision':before['revision'],'cost':'0','name':'Coffee changed'})
        self.assertEqual(result.status_code,200,result.content)
        self.assertFalse(any('SELECT "erp_document"."data"' in q['sql'] for q in queries))
        hidden=self.client.patch('/api/v1/catalog/products/one/visibility',{'revision':result.json()['revision'],'hidden':True},content_type='application/json',**self.headers)
        self.assertEqual(hidden.status_code,200,hidden.content)
        doc.refresh_from_db();self.assertEqual(doc.data['unknown'],extra);self.assertEqual(doc.data['recipe'][0]['unknown'],extra);self.assertEqual(doc.data['cost'],0)
        self.assertNotEqual(before['revision'],result.json()['revision'])
        self.assertEqual(self.patch({'revision':before['revision'],'cost':'9'}).status_code,409)

    def test_full_filtered_csv_has_65_rows_exact_blank_zero_and_cashier_redaction(self):
        for i in range(65):
            data={'name':f'Кава {i:03}','type':'Фільтр','unit':'шт','unknown':{'blob':'ю'*5000},'cost':0,'markup':.5,'manualPrice':i%2==0,'price':12.34 if i%2==0 else None}
            if i==1:data.pop('cost');data.pop('markup')
            Document.objects.create(path=f'products/export-{i:03}',data=data)
        with CaptureQueriesContext(connection) as queries:
            result=self.client.get('/api/v1/portal/catalogue.csv?q=Кава&type=Фільтр&visibility=active')
            self.assertEqual(result.status_code,200)
            data=b''.join(result.streaming_content).decode('utf-8-sig');result.close()
        rows=list(csv.reader(io.StringIO(data),delimiter=';'));self.assertEqual(len(rows),66)
        self.assertFalse(any('SELECT "erp_document"."data"' in q['sql'] for q in queries))
        keys=[field['key'] for field in columns(private=True)]
        zero=dict(zip(keys,rows[1]));blank=dict(zip(keys,rows[2]))
        self.assertEqual((zero['cost'],zero['markup'],zero['price']),('0.00','0.5','12.34'))
        self.assertEqual((blank['cost'],blank['markup'],blank['price']),('','',''))
        self.user.profile.role='cashier';self.user.profile.save()
        public=self.client.get('/api/v1/portal/catalogue.csv?q=Кава&type=Фільтр');public_rows=list(csv.reader(io.StringIO(b''.join(public.streaming_content).decode('utf-8-sig')),delimiter=';'));public.close()
        self.assertEqual(len(public_rows),66)
        self.assertEqual(len(public_rows[0]),len(columns(private=False)))
        self.assertNotIn('Собівартість',public_rows[0])
        self.assertEqual(self.client.get('/api/v1/portal/catalogue.csv?visibility=hidden').status_code,403)
        self.assertEqual(self.client.get('/api/v1/portal/catalogue.csv?q=a&q=b').status_code,400)

    def test_export_disk_refusal_is_json_before_any_csv_header(self):
        with patch('server.erp.catalog_export.MAX_DISK',64):
            result=self.client.get('/api/v1/portal/catalogue.csv')
        self.assertEqual(result.status_code,400)
        self.assertFalse(result.streaming);self.assertIn('ліміт',result.json()['error'])

    def test_campaign_export_keeps_regular_manual_and_local_promotion_terms_separate(self):
        from server.erp.models import PromotionCampaign,PromotionPrice
        from server.erp.promotion_prices import kyiv_day
        doc=Document.objects.get(pk='products/one')
        doc.data.update(unit='шт',manualPrice=True,price=30,promotion=False,promotionPrice=None);doc.save()
        campaign=PromotionCampaign.objects.create(name='Campaign',starts_on=kyiv_day(),ends_on=kyiv_day(),author=self.user,reason='QA',request_fingerprint='a'*64)
        PromotionPrice.objects.create(campaign=campaign,product=doc,price='20.00')
        original=doc.data.copy()
        result=self.client.get('/api/v1/portal/catalogue.csv?q=Coffee&promotion=yes')
        self.assertEqual(result.status_code,200,result)
        rows=list(csv.reader(io.StringIO(b''.join(result.streaming_content).decode('utf-8-sig')),delimiter=';'));result.close()
        self.assertEqual(len(rows),2)
        row=dict(zip([field['key'] for field in columns(private=True)],rows[1]))
        self.assertEqual((row['price'],row['regularPrice'],row['salePrice'],row['promotion'],row['promotionPrice']),('30.00','30.00','20.00','Ні',''))
        doc.refresh_from_db();self.assertEqual(doc.data,original)

    def test_editor_duplicate_name_and_unit_recipe_guard_never_load_foreign_json(self):
        from server.erp.catalog import duplicate_name,unit_in_use
        Document.objects.create(path='products/huge-foreign',data={'name':' Coffee duplicate ','recipe':[{'product':'one','quantity':1,'unknown':'Ж'*200000}],'unknown':'Ж'*200000})
        with CaptureQueriesContext(connection) as queries:
            self.assertTrue(duplicate_name({'name':'coffee duplicate'},{'name':'Coffee'},'products/one'))
            self.assertEqual(unit_in_use('products/one',{'name':'Coffee','unit':'шт'}),'товар використовується як інгредієнт у рецептурі')
        self.assertFalse(any('SELECT "erp_document"."data"' in q['sql'] or 'SELECT U0."data"' in q['sql'] for q in queries))
