"""B14 price context, immutable legacy fields, read-only proof and posting authority."""
import uuid
from datetime import date, timedelta
from unittest.mock import patch
from django.db import transaction
from server.erp.models import Document, Store, PromotionCampaign, PromotionPrice, PriceChange, PriceObservation, AuditEvent, User, Profile
from server.erp.promotion_prices import PriceResolver, kyiv_day
from server.erp.promotion_history import scan_prices
from server.erp.services import ledger_lock, post_voucher, BusinessError, save_voucher
from tests.test_unit_and_drafts import ApiFixture

class CampaignTests(ApiFixture):
    def setUp(self):
        super().setUp()
        self.other=Store.objects.create(name='Інший')
        self.p.data={'name':'Кава','unit':'шт','cost':10,'manualPrice':True,'price':30};self.p.save()
        self.today=kyiv_day().isoformat()
    def payload(self,**extra):
        return {'idempotencyKey':str(uuid.uuid4()),'name':'Тиждень кави','startsOn':self.today,'endsOn':self.today,'active':True,'scope':'network','stores':[],'prices':[{'product':'p','price':'25.00'}],'reason':'Сезонна пропозиція',**extra}
    def create(self,**extra):
        r=self.call('post','/api/v1/promotions/campaigns',self.payload(**extra));self.assertEqual(r.status_code,200,r.content);return r.json()
    def test_resolver_fetches_only_requested_products_in_one_query(self):
        other = Document.objects.create(path='products/another',data={**self.p.data,'name':'Інший товар'})
        self.create(prices=[{'product':'p','price':'20.00'},{'product':'another','price':'21.00'}])
        with self.assertNumQueries(1):
            resolver = PriceResolver(config={'markup':0,'rounding':0},product_paths=[self.p.path])
        self.assertEqual(set(resolver.candidates),{self.p.path})
        self.assertEqual(resolver.resolve(self.p)['salePrice'],'20.00')
        self.assertEqual(resolver.resolve(other)['salePrice'],'30.00')
    def test_overlap_scope_tie_and_legacy_fallback(self):
        a=self.create(scope='stores',stores=[self.store.pk],prices=[{'product':'p','price':'20.00'}])
        b=self.create(prices=[{'product':'p','price':'22.00'}])
        self.assertEqual(PriceResolver(store=self.store).resolve(self.p)['salePrice'],'20.00')
        self.assertEqual(PriceResolver(store=self.other).resolve(self.p)['salePrice'],'22.00')
        self.assertEqual(PriceResolver().resolve(self.p)['salePrice'],'22.00')
        c=self.create(prices=[{'product':'p','price':'22.00'}])
        self.assertEqual(PriceResolver().resolve(self.p)['effectivePromotion']['id'],min(b['id'],c['id']))
        self.p.data.update(promotion=True,promotionPrice='21.00');self.p.save()
        self.assertEqual(PriceResolver(effective_day=kyiv_day()+timedelta(days=1)).resolve(self.p)['salePrice'],'21.00')
        self.p.data['promotion']=False;self.p.save()
        self.assertEqual(PriceResolver(effective_day=kyiv_day()+timedelta(days=1)).resolve(self.p)['salePrice'],'30.00')
    def test_raw_editor_fields_and_readonly_gets_do_not_create_history(self):
        self.create()
        counts=(PriceObservation.objects.count(),PriceChange.objects.count(),AuditEvent.objects.count())
        product=self.product();self.assertFalse(product['promotion']);self.assertIsNone(product['promotionPrice'])
        self.assertEqual(product['effectivePromotion']['source'],'campaign');self.assertEqual(product['salePrice'],'25.00')
        self.assertEqual(self.client.get('/api/v1/catalog/products?promotion=yes').json()['total'],1)
        proof=self.call('post','/api/v1/labels/prepare',{'selection':[{'id':'p','quantity':2}],'store':self.store.pk}).json()
        self.assertEqual(proof['settings']['storeNames'],[self.store.name]);self.assertEqual(proof['products'][0]['salePrice'],'25.00')
        preview=self.call('post','/api/v1/catalog/products/price-preview',{'id':'p','revision':product['revision'],'manualPrice':True,'price':'31.00'}).json()
        self.assertEqual(preview['salePrice'],'25.00')
        self.assertEqual(counts,(PriceObservation.objects.count(),PriceChange.objects.count(),AuditEvent.objects.count()))
        saved=self.call('patch','/api/v1/catalog/products/p',{'revision':product['revision'],'name':'Кава нова'})
        self.assertEqual(saved.status_code,200,saved.content);self.assertFalse(Document.objects.get(pk=self.p.pk).data.get('promotion',False))
    def test_repeat_revision_archive_and_validation(self):
        payload=self.payload();a=self.call('post','/api/v1/promotions/campaigns',payload).json();count=AuditEvent.objects.count()
        self.assertEqual(self.call('post','/api/v1/promotions/campaigns',payload).json()['id'],a['id']);self.assertEqual(AuditEvent.objects.count(),count)
        changed={k:v for k,v in payload.items() if k!='idempotencyKey'};changed.update(revision=a['revision'],prices=[{'product':'p','price':'24.00'}])
        url='/api/v1/promotions/campaigns/'+a['id'];self.assertEqual(self.call('patch',url,changed).status_code,200)
        self.assertEqual(self.call('patch',url,changed).status_code,409)
        detail=self.client.get(url);self.assertEqual(detail.status_code,200);self.assertEqual(detail.json()['revision'],2)
        self.assertEqual(self.call('post','/api/v1/promotions/campaigns',payload).json()['code'],'create_changed')
        archived=self.call('delete',url,{'revision':2,'reason':'Пропозицію завершено'});self.assertEqual(archived.status_code,200)
        self.assertEqual(self.product()['salePrice'],'30.00');self.assertEqual(PromotionPrice.objects.count(),1)
        self.assertEqual(self.call('post','/api/v1/promotions/campaigns',self.payload(stores=[self.store.pk])).status_code,400)
        self.assertEqual(self.call('post','/api/v1/promotions/campaigns',self.payload(prices=[{'product':'p','price':'30.00'}])).status_code,400)
    def test_scheduled_activation_expiry_stable_task_and_invalid_proof(self):
        tomorrow=kyiv_day()+timedelta(days=1);self.create(startsOn=tomorrow.isoformat(),endsOn=tomorrow.isoformat())
        proof=lambda:self.call('post','/api/v1/labels/prepare',{'selection':[{'id':'p','quantity':1}]}).json()['snapshot']
        old=proof();self.assertEqual(PriceChange.objects.count(),0)
        with patch('server.erp.promotion_prices.kyiv_day',return_value=tomorrow):
            with transaction.atomic():ledger_lock();scan_prices(self.u)
            current=proof();self.assertNotEqual(old,current);self.assertEqual(PriceChange.objects.count(),3)
            paths=set(Document.objects.filter(path__startswith='tasks/reprint_').values_list('path',flat=True));self.assertEqual(len(paths),3)
            with transaction.atomic():ledger_lock();scan_prices(self.u)
            self.assertEqual(PriceChange.objects.count(),3)
        with patch('server.erp.promotion_prices.kyiv_day',return_value=tomorrow+timedelta(days=1)):
            with transaction.atomic():ledger_lock();scan_prices(self.u)
            self.assertEqual(PriceChange.objects.count(),6);self.assertEqual(paths,set(Document.objects.filter(path__startswith='tasks/reprint_').values_list('path',flat=True)))
            self.assertEqual(self.product()['salePrice'],'30.00')
    def test_scoped_context_cannot_escape_or_read_campaigns(self):
        self.u.profile.store=self.store;self.u.profile.role='manager';self.u.profile.save()
        ctx=self.client.get('/api/v1/promotions/context').json();self.assertEqual(ctx['storeId'],self.store.pk);self.assertEqual(len(ctx['stores']),1)
        self.assertEqual(self.client.get('/api/v1/promotions/context?store='+str(self.other.pk)).status_code,403)
        self.assertEqual(self.client.get('/api/v1/promotions/campaigns').status_code,403)
        self.assertEqual(self.call('post','/api/v1/labels/prepare',{'selection':[{'id':'p','quantity':1}],'store':self.other.pk}).status_code,403)
    def test_posting_current_day_campaign_guard_and_actual_cost(self):
        self.v('receipt',5,10,date=(kyiv_day()-timedelta(days=2)).isoformat());cashier=User.objects.create(username='b14-cashier');Profile.objects.create(user=cashier,role='cashier',store=self.store)
        a=self.create(prices=[{'product':'p','price':'20.00'}])
        data={'kind':'sale','store':self.store.pk,'warehouse':self.wh.pk,'party':self.customer.pk,'date':(kyiv_day()-timedelta(days=1)).isoformat(),'lines':[{'product':'p','quantity':1,'price':'20.00'}],'payload':{'payments':[{'account':self.bank.pk,'amount':'20.00'}]}}
        draft=save_voucher(cashier,data)
        with patch('server.erp.promotion_prices.kyiv_day',return_value=kyiv_day()+timedelta(days=1)):
            with self.assertRaises(BusinessError):post_voucher(cashier,draft.pk)
        posted=post_voucher(cashier,draft.pk);self.assertEqual(posted.payload['price_context']['effective_day'],self.today)
        self.assertEqual(posted.payload['price_versions'][0]['effective_price'],'20.00')
        self.create(prices=[{'product':'p','price':'5.00'}]);data['lines'][0]['price']='5.00';data['payload']['payments'][0]['amount']='5.00';data['idempotency_key']=str(uuid.uuid4())
        loss=save_voucher(cashier,data)
        with self.assertRaisesMessage(BusinessError,'нижче собівартості'):post_voucher(cashier,loss.pk)
    def test_price_task_identity_is_protected_but_completion_is_stable(self):
        self.create();task=Document.objects.filter(path__startswith='tasks/reprint_').first()
        response=self.call('patch','/api/docs/'+task.path,{'status':'done'});self.assertEqual(response.status_code,200,response.content)
        with transaction.atomic():ledger_lock();scan_prices(self.u)
        task.refresh_from_db();self.assertEqual(task.data['status'],'done')
        self.assertEqual(self.call('patch','/api/docs/'+task.path,{'title':'Неправильне завдання'}).status_code,400)
        self.assertEqual(self.call('delete','/api/docs/'+task.path).status_code,400)
        self.assertEqual(self.call('put','/api/docs/tasks/forged',{'scope':'operations','_priceTask':True,'title':'Підробка'}).status_code,400)
    def test_campaign_change_invalidates_open_bulk_price_preview(self):
        payload={'kind':'rounding','rounding':'1'}
        preview=self.call('post','/api/v1/catalog/pricing/preview',payload)
        self.assertEqual(preview.status_code,200,preview.content)
        self.create()
        commit=self.call('post','/api/v1/catalog/pricing/commit',{**payload,'snapshot':preview.json()['snapshot'],'idempotencyKey':str(uuid.uuid4())})
        self.assertEqual(commit.status_code,409,commit.content)
        self.assertEqual(commit.json()['code'],'revision_conflict')
    def test_stale_expired_observation_records_transition_before_actual_edit(self):
        self.create()
        # Last control still remembers 25.00, but this edit happens after expiry.
        after=kyiv_day()+timedelta(days=1)
        with patch('server.erp.promotion_prices.kyiv_day',return_value=after):
            product=self.product();before=PriceChange.objects.count()
            response=self.call('patch','/api/v1/catalog/products/p',{'revision':product['revision'],'price':'32.00'})
            self.assertEqual(response.status_code,200,response.content)
            changes=list(PriceChange.objects.filter(store__isnull=True).order_by('pk'))
            self.assertEqual(changes[-2].source,'observed_transition')
            self.assertEqual((changes[-2].before['salePrice'],changes[-2].after['salePrice']),('25.00','30.00'))
            self.assertEqual((changes[-1].before['salePrice'],changes[-1].after['salePrice']),('30.00','32.00'))
            self.assertEqual(changes[-1].source,'catalog');self.assertEqual(PriceChange.objects.count(),before+6)
    def test_malformed_scope_and_pagination_reach_all_201_records(self):
        for malformed in [[],{},False,None]:
            response=self.call('post','/api/v1/promotions/campaigns',self.payload(scope=malformed))
            self.assertEqual(response.status_code,400,response.content)
        PromotionCampaign.objects.bulk_create([PromotionCampaign(name=f'Запис {i}',starts_on=kyiv_day(),ends_on=kyiv_day(),scope='network',author=self.u,request_fingerprint=str(i),archived=True,active=False) for i in range(201)])
        last=self.client.get('/api/v1/promotions/campaigns?page=5&limit=50').json()
        self.assertEqual((last['total'],last['pages'],last['page'],len(last['items'])),(201,5,5,1))
        self.assertEqual(self.client.get('/api/v1/promotions/campaigns?page=NaN').status_code,400)
        terms={'regularPrice':'30.00','salePrice':'25.00','effectivePromotion':None}
        PriceChange.objects.bulk_create([PriceChange(product_path=self.p.path,store=self.store,before=terms,after=terms,author=self.u,source='fixture',reason='Ізольовані дані') for _ in range(201)])
        history=self.client.get(f'/api/v1/promotions/history?store={self.store.pk}&page=5&limit=50').json()
        self.assertEqual((history['total'],history['pages'],history['page'],len(history['items'])),(201,5,5,1))
        self.assertEqual(history['items'][0]['name'],'Кава')

from concurrent.futures import ThreadPoolExecutor
import hashlib,time
from django.db import connection, close_old_connections, connections
from django.test import TransactionTestCase, Client
from server.erp.models import PortalSession, LedgerLock

class CampaignConcurrencyTests(TransactionTestCase):
    def setUp(self):
        if connection.vendor!='postgresql':self.skipTest('Campaign ledger serialization requires PostgreSQL.')
        self.u=User.objects.create(username='b14-concurrent-owner');Profile.objects.create(user=self.u,role='owner');LedgerLock.objects.create(pk=1)
        self.store=Store.objects.create(name='Ізольований')
        Document.objects.create(pk='products/p',data={'name':'Товар','manualPrice':True,'price':30})
        token='isolated-b14-race';PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=self.u,csrf='b14-csrf',expires=int(time.time())+3600)
        self.token=token
    def request(self,method,path,value):
        close_old_connections()
        try:
            c=Client();c.cookies['ts_session']=self.token
            r=getattr(c,method)(path,value,content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='b14-csrf')
            return r.status_code,r.json()
        finally:connections.close_all()
    def test_same_create_key_race_writes_one_campaign_and_history_once(self):
        payload={'idempotencyKey':str(uuid.uuid4()),'name':'Акція','startsOn':kyiv_day().isoformat(),'endsOn':kyiv_day().isoformat(),'active':True,'scope':'network','stores':[],'prices':[{'product':'p','price':'25.00'}],'reason':'Ізольована перевірка'}
        with ThreadPoolExecutor(max_workers=2) as pool:r=list(pool.map(lambda _:self.request('post','/api/v1/promotions/campaigns',payload),range(2)))
        self.assertEqual([s for s,_ in r],[200,200]);self.assertEqual(r[0][1]['id'],r[1][1]['id']);self.assertEqual(PromotionCampaign.objects.count(),1);self.assertEqual(AuditEvent.objects.filter(action='promotion_changed').count(),1);self.assertEqual(PriceChange.objects.count(),2)
        edited={k:v for k,v in payload.items() if k!='idempotencyKey'};edited.update(revision=1,prices=[{'product':'p','price':'24.00'}])
        with ThreadPoolExecutor(max_workers=2) as pool:r=list(pool.map(lambda _:self.request('patch','/api/v1/promotions/campaigns/'+payload['idempotencyKey'],edited),range(2)))
        self.assertEqual(sorted(s for s,_ in r),[200,409]);self.assertEqual(PromotionCampaign.objects.get().revision,2);self.assertEqual(PriceChange.objects.count(),4)
