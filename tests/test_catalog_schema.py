"""Current exchange, actual browser parser, isolated API and workbook provenance."""
import hashlib
import io
import json
import subprocess
import time
import uuid
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from django.test import TransactionTestCase
from django.utils import timezone
from server.erp.models import Document, User, Profile, PortalSession, LedgerLock, PromotionCampaign, PromotionPrice, AuditEvent
from server.erp.catalog_schema import schema, columns

ROOT=Path(__file__).resolve().parents[1]

def parsed(source):
    script="const fs=require('node:fs'),csv=require('./app/csv.js'),parser=require('./app/catalog-import.js');process.stdout.write(JSON.stringify(parser.parseRows(csv.parse(fs.readFileSync(0,'utf8')),'exchange.csv')));"
    return json.loads(subprocess.check_output(['node','-e',script],input=source,cwd=ROOT))

class CatalogSchemaTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create(username='schema-owner');Profile.objects.create(user=self.user,role='owner')
        LedgerLock.objects.create(pk=1)
        PortalSession.objects.create(token_hash=hashlib.sha256(b'schema-session').hexdigest(),user=self.user,csrf='schema-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='schema-session'
        Document.objects.create(path='settings/main',data={'defaultMarkup':30,'rounding':.5})
    def post(self,suffix,value):
        return self.client.post('/api/v1/catalog/import/'+suffix,value,content_type='application/json',HTTP_X_CSRF_TOKEN='schema-csrf',HTTP_ORIGIN='http://testserver')
    def export(self):
        response=self.client.get('/api/v1/portal/catalogue.csv?includeHidden=true')
        self.assertEqual(response.status_code,200)
        return b''.join(response.streaming_content)
    def test_export_parse_commit_keeps_automatic_manual_campaign_zero_readonly_and_retry(self):
        common={'unit':'кг','type':'Історична група','cost':0,'markup':0,'priceAt':'2020-01-01','hidden':True}
        auto=Document.objects.create(path='products/auto',data={**common,'name':'Автоматична','cost':10,'markup':30,'manualPrice':False,'price':None,'promotion':False,'barcode':'001234'})
        manual=Document.objects.create(path='products/manual',data={**common,'name':'Ручна','manualPrice':True,'price':49,'promotion':True,'promotionPrice':39})
        zero=Document.objects.create(path='products/zero',data={**common,'name':'Нуль','manualPrice':False,'price':None,'promotion':False})
        missing=Document.objects.create(path='products/missing',data={'name':'Без закупівлі','unit':'шт','manualPrice':True,'price':9,'priceAt':'2020-01-01'})
        fraction=Document.objects.create(path='products/fraction',data={**common,'name':'Дробова націнка','cost':100,'markup':.5,'manualPrice':False,'price':None,'promotion':False})
        campaign=PromotionCampaign.objects.create(name='Кампанія',starts_on=timezone.localdate(),ends_on=timezone.localdate(),author=self.user,request_fingerprint='a'*64)
        PromotionPrice.objects.create(campaign=campaign,product=auto,price=11)
        source=self.export();result=parsed(source)
        self.assertFalse(result.get('error'));self.assertTrue(all(not r['errors'] for r in result['rows']))
        by_id={row['id']:row for row in result['rows']}
        self.assertEqual(by_id['auto']['values']['manualPrice'],False);self.assertNotIn('price',by_id['auto']['values'])
        self.assertEqual(by_id['auto']['values']['promotion'],False);self.assertEqual(by_id['auto']['values']['barcode'],'001234')
        self.assertEqual(by_id['zero']['values']['cost'],'0.00');self.assertEqual(by_id['zero']['values']['markup'],'0')
        self.assertEqual(by_id['fraction']['values']['markup'],'0.5')
        self.assertNotIn('cost',by_id['missing']['values']);self.assertNotIn('markup',by_id['missing']['values'])
        for row in result['rows']:
            self.assertNotIn('priceAt',row['values']);self.assertNotIn('hidden',row['values']);self.assertNotIn('salePrice',row['values'])
        payload={'entries':[{key:value for key,value in row.items() if key in {'id','line','values'}} for row in result['rows']]}
        preview=self.post('preview',payload);self.assertEqual(preview.status_code,200,preview.content);self.assertTrue(preview.json()['valid'],preview.content)
        self.assertFalse(AuditEvent.objects.exists())
        body={**payload,'snapshot':preview.json()['snapshot'],'idempotencyKey':str(uuid.uuid4())}
        saved=self.post('commit',body);self.assertEqual(saved.status_code,200,saved.content)
        count=AuditEvent.objects.count();again=self.post('commit',body);self.assertEqual(again.json(),saved.json());self.assertEqual(AuditEvent.objects.count(),count)
        for p in [auto,manual,zero,fraction]:p.refresh_from_db();self.assertEqual(p.data['priceAt'],'2020-01-01');self.assertTrue(p.data['hidden'])
        self.assertFalse(auto.data['manualPrice']);self.assertFalse(auto.data['promotion']);self.assertIsNone(auto.data['price'])
        self.assertEqual(manual.data['price'],49);self.assertEqual(manual.data['promotionPrice'],39);self.assertEqual(zero.data['cost'],0);self.assertEqual(zero.data['markup'],0)
        fraction.refresh_from_db();self.assertEqual(fraction.data['markup'],.5)
        missing.refresh_from_db();self.assertNotIn('cost',missing.data);self.assertNotIn('markup',missing.data)
    def test_template_current_actor_private_export_and_explicit_modes(self):
        p=Document.objects.create(path='products/p',data={'name':'Товар','unit':'шт','cost':10,'markup':30,'manualPrice':True,'price':49})
        r=self.client.get('/api/v1/catalog/template.xlsx');self.assertEqual(r.status_code,200);self.assertIn('no-store',r['Cache-Control']);self.assertEqual(b''.join(r.streaming_content),(ROOT/'data/catalogue-template-v1.xlsx').read_bytes())
        current=schema();header=[f['label']+(current['marker'] if i==0 else '') for i,f in enumerate(columns('exchange'))]
        import csv
        buffer=io.StringIO();writer=csv.writer(buffer);writer.writerow(header)
        writer.writerow(['Товар','','','','','шт','','0','0','Автоматична','','Ні','','p'])
        row=parsed(buffer.getvalue().encode())['rows'][0];payload={'entries':[{k:v for k,v in row.items() if k in {'id','line','values'}}]}
        preview=self.post('preview',payload).json();self.assertTrue(preview['valid']);self.assertEqual(preview['entries'][0]['regularPrice'],'0.00')
        response=self.post('commit',{**payload,'snapshot':preview['snapshot'],'idempotencyKey':str(uuid.uuid4())});self.assertEqual(response.status_code,200)
        p.refresh_from_db();self.assertFalse(p.data['manualPrice']);self.assertIsNone(p.data['price'])
        Profile.objects.filter(user=self.user).update(role='cashier')
        denied=self.client.get('/api/v1/catalog/template.xlsx');self.assertEqual(denied.status_code,403)
        export=self.client.get('/api/v1/portal/catalogue.csv');data=b''.join(export.streaming_content).decode('utf-8-sig')
        self.assertNotIn('Закупівля',data);self.assertNotIn('Націнка',data);self.assertEqual(len(next(csv.reader(io.StringIO(data),delimiter=';'))),18)
        Profile.objects.filter(user=self.user).update(role='owner');User.objects.filter(pk=self.user.pk).update(is_active=False)
        self.assertEqual(self.client.get('/api/v1/catalog/template.xlsx').status_code,401)
    def test_workbook_schema_text_validation_panes_and_historical_files_unchanged(self):
        namespace={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        with zipfile.ZipFile(ROOT/'data/catalogue-template-v1.xlsx') as archive:
            sheet=ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
            self.assertEqual(len(sheet.find('s:sheetData/s:row',namespace)),14)
            pane=sheet.find('.//s:pane',namespace);self.assertEqual(pane.get('ySplit'),'1');self.assertEqual(pane.get('xSplit'),'1')
            self.assertGreaterEqual(len(sheet.findall('s:dataValidations/s:dataValidation',namespace)),5)
            self.assertEqual(sheet.find("s:sheetData/s:row[@r='2']/s:c[@r='G2']",namespace).get('t'),'str')
            self.assertFalse(sheet.findall('.//s:f',namespace))
            first=[cell.find('s:v',namespace).text for cell in sheet.find('s:sheetData/s:row',namespace)]
            self.assertEqual(first,[f['label']+(schema()['marker'] if i==0 else '') for i,f in enumerate(columns('exchange'))])
        for name,digest in [('baza-tovariv-template.xlsx','b60f5ceb713f768aff70c771fe7d6cab60225a5adcb3db5126dcb36cf1bc1150'),('baza-tovariv-2026-09-29.csv','3561c9fdc7024bb4cbc5d93944ecd5c7f9f4308d0cc07fdbd951816baf242325'),('tovary-source-2026-09-29.csv','8f6a84a6c7715aa1003aec174c5c8f04d9fe0ada927f4a86dfb9066129b930c5')]:self.assertEqual(hashlib.sha256((ROOT/'data'/name).read_bytes()).hexdigest(),digest)
