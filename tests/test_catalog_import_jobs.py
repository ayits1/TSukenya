"""Isolated durable import API/worker checks; no production catalogue or Sheet."""
import hashlib
import json
import time
import uuid
from datetime import timedelta
from unittest.mock import patch
from django.contrib.auth.models import User
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from server.erp.models import Document, Profile, LedgerLock, PortalSession, AuditEvent
from server.erp.import_models import CatalogImportRun, CatalogImportRow, CatalogImportChunk
from server.erp.import_jobs import process_one, claim, step, canonical
from server.erp.catalog import revision


class ImportJobsFixture:
    def setup_jobs(self):
        self.user=User.objects.create(username='isolated-job-author');Profile.objects.create(user=self.user,role='owner')
        LedgerLock.objects.get_or_create(pk=1)
        Document.objects.create(path='settings/main',data={'defaultMarkup':30,'rounding':.5})
        self.attach(self.user)
    def attach(self,user):
        token=str(uuid.uuid4());csrf=str(uuid.uuid4())
        PortalSession.objects.create(user=user,token_hash=hashlib.sha256(token.encode()).hexdigest(),csrf=csrf,expires=int(time.time())+3600)
        self.client.cookies['ts_session']=token;self.headers={'HTTP_ORIGIN':'http://testserver','HTTP_X_CSRF_TOKEN':csrf}
    def post(self,path,data):return self.client.post('/api/v1/catalog/import/'+path,data,content_type='application/json',**self.headers)
    def get(self,path):return self.client.get('/api/v1/catalog/import/'+path)
    def row(self,line,name=None,**values):return {'line':line,'values':{'name':name or f'Ізольований товар {line}',**values}}
    def create(self,entries,key=None):
        key=key or str(uuid.uuid4());result=self.post('runs',{'idempotencyKey':key,'fileName':'Тест.csv','expectedRows':len(entries)})
        self.assertEqual(result.status_code,200,result.content)
        for offset in range(0,len(entries),200):
            response=self.post('runs/'+key+'/chunks',{'offset':offset,'entries':entries[offset:offset+200]})
            self.assertEqual(response.status_code,200,response.content)
        return key
    def ready(self,key):
        response=self.post('runs/'+key+'/seal',{});self.assertEqual(response.status_code,200,response.content)
        self.drain(key);return self.get('runs/'+key).json()
    def drain(self,key,max_steps=100):
        for _ in range(max_steps):
            if not process_one(uuid.UUID(key)):return
        self.fail('worker did not finish')
    def approve(self,key):
        detail=self.get('runs/'+key).json();self.assertEqual(detail['status'],'ready',detail)
        result=self.post('runs/'+key+'/apply',{'planRevision':detail['planRevision']});self.assertEqual(result.status_code,200,result.content);return result.json()


class CatalogImportJobsTests(ImportJobsFixture,TestCase):
    def setUp(self):self.setup_jobs()
    def test_upload_receipts_lost_ack_exact_retry_seal_and_read_only_journal(self):
        key=str(uuid.uuid4());body={'idempotencyKey':key,'fileName':'Тест.csv','expectedRows':2}
        first=self.post('runs',body);self.assertEqual(first.status_code,200)
        self.assertEqual(self.post('runs',body).json(),first.json())
        self.assertEqual(self.post('runs',{**body,'fileName':'Інший.csv'}).status_code,409)
        chunk={'offset':0,'entries':[self.row(2),self.row(3)]};ack=self.post('runs/'+key+'/chunks',chunk).json()
        self.assertEqual(self.post('runs/'+key+'/chunks',chunk).json(),ack)
        self.assertEqual(self.post('runs/'+key+'/chunks',{'offset':0,'entries':[self.row(2,'Інше')]}).status_code,409)
        seal=self.post('runs/'+key+'/seal',{}).json()
        self.assertEqual(self.post('runs/'+key+'/seal',{}).json(),seal)
        self.assertEqual(self.post('runs/'+key+'/chunks',chunk).json(),ack)
        before=(Document.objects.count(),AuditEvent.objects.count(),CatalogImportRow.objects.count(),CatalogImportRun.objects.get(pk=key).updated_at)
        receipts=self.get('runs/'+key+'/chunks?page=2').json();self.assertEqual(receipts['items'],[ack]);self.assertEqual(receipts['page'],1)
        self.assertEqual(self.get('history').json()['total'],1);self.assertEqual(self.get('runs/'+key+'/rows').json()['total'],2)
        self.assertEqual(before,(Document.objects.count(),AuditEvent.objects.count(),CatalogImportRow.objects.count(),CatalogImportRun.objects.get(pk=key).updated_at))
        self.assertFalse(Document.objects.filter(path__startswith='products/').exists())
    def test_cross_chunk_file_duplicates_block_every_apply(self):
        entries=[self.row(i,barcode=f'{i:06}') for i in range(1,202)]
        entries[-1]=self.row(202,'  ІЗОЛЬОВАНИЙ  товар 1 ',barcode='000001')
        key=self.create(entries);detail=self.ready(key)
        self.assertEqual(detail['status'],'invalid');self.assertEqual(detail['counts']['invalid'],2)
        rows=self.get('runs/'+key+'/rows?status=invalid').json()['items'];self.assertEqual([x['ordinal'] for x in rows],[1,201])
        self.assertFalse(detail['canApply']);self.assertEqual(self.post('runs/'+key+'/apply',{'planRevision':detail['planRevision']}).status_code,409)
        self.assertFalse(Document.objects.filter(path__startswith='products/').exists());self.assertFalse(AuditEvent.objects.exists())
    def test_apply_created_updated_skipped_conflicted_and_exact_completed_ack(self):
        old=Document.objects.create(path='products/old',data={'name':'Старий','unit':'шт','cost':10,'markup':30,'price':None,'manualPrice':False,'priceAt':'2020-01-01'})
        same=Document.objects.create(path='products/same',data={'name':'Незмінний','unit':'шт','cost':5,'markup':30,'price':None,'manualPrice':False})
        stale=Document.objects.create(path='products/stale',data={'name':'Конфлікт','unit':'шт','cost':8,'markup':30,'price':None,'manualPrice':False})
        key=self.create([self.row(1,'Старий',cost='12.00'),self.row(2,'Незмінний'),self.row(3,'Конфлікт',cost='15'),self.row(4,cost='10',type='Історична група',category='Категорія',unit='порція')])
        ready=self.ready(key);self.assertEqual(ready['planned'],{'create':1,'update':2,'skip':1})
        ack=self.approve(key);stale.data['cost']=9;stale.save();self.drain(key)
        final=self.get('runs/'+key).json();self.assertEqual(final['status'],'completed_with_issues');self.assertEqual(final['counts'],{'created':1,'updated':1,'skipped':1,'conflicted':1,'failed':0,'invalid':0,'pending':0})
        self.assertEqual(self.post('runs/'+key+'/apply',{'planRevision':ready['planRevision']}).json(),ack)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),2)
        old.refresh_from_db();same.refresh_from_db();stale.refresh_from_db();self.assertEqual(old.data['cost'],12);self.assertNotIn('referenceIds',same.data);self.assertEqual(stale.data['cost'],9)
        product=Document.objects.get(path='products/'+str(uuid.uuid5(uuid.UUID(key),'4')).replace('-','_'));self.assertEqual(product.data['unit'],'порція')
        self.assertFalse(Document.objects.filter(path__startswith='catalog_refs/').exists())
    def test_worker_failure_rolls_back_whole_chunk_and_recovery_is_exact(self):
        key=self.create([self.row(1,cost='10'),self.row(2,cost='20')]);self.ready(key);self.approve(key)
        original=Document.save
        def fail(doc,*args,**kwargs):
            if doc.data.get('name')=='Ізольований товар 2':raise RuntimeError('synthetic private traceback')
            return original(doc,*args,**kwargs)
        with patch.object(Document,'save',fail):self.assertTrue(process_one(uuid.UUID(key)))
        run=self.get('runs/'+key).json();self.assertEqual(run['status'],'failed');self.assertNotIn('private',json.dumps(run));self.assertEqual(run['counts']['pending'],2)
        self.assertFalse(Document.objects.filter(path__startswith='products/').exists());self.assertFalse(AuditEvent.objects.exists())
        self.assertEqual(self.post('runs/'+key+'/resume',{'planRevision':run['planRevision']}).status_code,200);self.drain(key)
        self.assertEqual(self.get('runs/'+key).json()['counts']['created'],2);self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),2)
    def test_expired_worker_cannot_commit_and_new_worker_resumes_cursor(self):
        key=self.create([self.row(1)]);self.post('runs/'+key+'/seal',{})
        old=claim(uuid.UUID(key));CatalogImportRun.objects.filter(pk=key).update(lease_until=timezone.now()-timedelta(seconds=1))
        new=claim(uuid.UUID(key));self.assertNotEqual(old[1],new[1]);self.assertFalse(step(*old));self.assertTrue(step(*new));self.drain(key)
        self.assertEqual(self.get('runs/'+key).json()['status'],'ready')
    def test_creator_only_and_current_role_revocation_blocks_worker(self):
        key=self.create([self.row(1)]);self.post('runs/'+key+'/seal',{})
        other=User.objects.create(username='other-owner');Profile.objects.create(user=other,role='owner');self.attach(other)
        self.assertEqual(self.get('history').json()['total'],0);self.assertEqual(self.get('runs/'+key).status_code,404);self.assertEqual(self.post('runs/'+key+'/cancel',{}).status_code,404)
        self.attach(self.user);Profile.objects.filter(user=self.user).update(role='cashier');self.assertTrue(process_one(uuid.UUID(key)))
        self.assertEqual(CatalogImportRun.objects.get(pk=key).status,'blocked');self.assertEqual(self.get('runs/'+key).status_code,403)
        Profile.objects.filter(user=self.user).update(role='manager');self.assertEqual(self.post('runs/'+key+'/resume',{}).status_code,200);self.drain(key)
        self.assertEqual(self.get('runs/'+key).json()['status'],'ready')
    def test_resource_limits_invalid_pages_and_payloads_no_mutation(self):
        key=self.create([self.row(1)]);before=CatalogImportRow.objects.count()
        for payload in ({'offset':True,'entries':[self.row(1)]},{'offset':1,'entries':[]},{'offset':1,'entries':[self.row(2)]*201},{'offset':1,'entries':[self.row(2,name='x'*17000)]}):
            self.assertEqual(self.post('runs/'+key+'/chunks',payload).status_code,400)
        for query in ('?page=0','?page=-1','?page=²','?page=1.5','?status=[]','?mode=other','?secret=1'):
            self.assertEqual(self.get('history'+query).status_code,400)
        self.assertEqual(CatalogImportRow.objects.count(),before)
        self.assertEqual(self.post('runs/'+key+'/seal',{'unknown':1}).status_code,400)
    def test_pricing_change_before_approval_and_during_apply(self):
        key=self.create([self.row(1,cost='10')]);ready=self.ready(key)
        Document.objects.filter(pk='settings/main').update(data={'defaultMarkup':40,'rounding':1})
        self.assertEqual(self.post('runs/'+key+'/apply',{'planRevision':ready['planRevision']}).status_code,409)
        Document.objects.filter(pk='settings/main').update(data={'defaultMarkup':30,'rounding':.5});self.approve(key)
        Document.objects.filter(pk='settings/main').update(data={'defaultMarkup':40,'rounding':1});self.drain(key)
        self.assertEqual(self.get('runs/'+key).json()['counts']['conflicted'],1);self.assertFalse(Document.objects.filter(path__startswith='products/').exists())
    def test_cancel_preserves_committed_chunks_and_stops_pending(self):
        key=self.create([self.row(i) for i in range(1,102)]);self.ready(key);self.approve(key);self.assertTrue(process_one(uuid.UUID(key)))
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(),100)
        result=self.post('runs/'+key+'/cancel',{});self.assertEqual(result.status_code,200);self.assertEqual(result.json()['counts']['pending'],1)
        self.assertFalse(process_one(uuid.UUID(key)));self.assertEqual(Document.objects.filter(path__startswith='products/').count(),100)
    def test_small_atomic_contract_mirrors_journal_and_key_collision_rejected(self):
        payload={'entries':[self.row(1,cost='10')]};preview=self.post('preview',payload).json();key=str(uuid.uuid4())
        payload.update(snapshot=preview['snapshot'],idempotencyKey=key);first=self.post('commit',payload);self.assertEqual(first.status_code,200)
        self.assertEqual(first.json()['counts'],{'created':1,'updated':0,'errors':0});self.assertEqual(self.post('commit',payload).json(),first.json())
        run=self.get('runs/'+key).json();self.assertEqual(run['mode'],'atomic');self.assertFalse(run['canApply']);self.assertEqual(run['counts']['created'],1)
        self.assertEqual(self.get('runs/'+key+'/rows').json()['items'][0]['values'],{})
        self.assertEqual(self.post('runs',{'idempotencyKey':key,'fileName':'Тест.csv','expectedRows':1}).status_code,409)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),1)
        large=self.create([self.row(10,'Інший')]);payload['idempotencyKey']=large
        self.assertEqual(self.post('commit',payload).status_code,409)

    def test_source_fingerprint_and_parser_options_are_immutable_and_readable(self):
        key=str(uuid.uuid4());payload={'idempotencyKey':key,'fileName':'Тест.csv','expectedRows':2,'sourceHash':'a'*64,'genericAs':'price','defaultMarkup':'40.0000'}
        first=self.post('runs',payload);self.assertEqual(first.status_code,200);self.assertEqual(first.json()['sourceHash'],'a'*64)
        self.assertEqual(self.post('runs',payload).json(),first.json())
        detail=self.get('runs/'+key).json();self.assertEqual((detail['sourceHash'],detail['genericAs'],detail['defaultMarkup']),('a'*64,'price','40.0000'))
        for field,value in (('sourceHash','b'*64),('genericAs','cost'),('defaultMarkup','45')):
            self.assertEqual(self.post('runs',{**payload,field:value}).status_code,409)
        for extra in ({'sourceHash':True},{'genericAs':[]},{'sourceHash':'ABC'},{'genericAs':'anything'}):
            self.assertEqual(self.post('runs',{**payload,'idempotencyKey':str(uuid.uuid4()),**extra}).status_code,400)
        self.assertEqual(CatalogImportRun.objects.count(),1)

    def test_campaign_transition_after_plan_conflicts_and_product_price_audit_is_preserved(self):
        from server.erp.models import PromotionCampaign,PromotionPrice,PriceObservation,PriceChange
        product=Document.objects.create(path='products/promo',data={'name':'Акційний','cost':10,'markup':30,'unit':'шт'})
        key=self.create([self.row(1,'Акційний',cost='20')]);self.ready(key);self.approve(key)
        today=timezone.localdate();campaign=PromotionCampaign.objects.create(name='Ізольована акція',scope='network',starts_on=today,ends_on=today,author=self.user)
        PromotionPrice.objects.create(campaign=campaign,product=product,price='11.00')
        self.drain(key);self.assertEqual(self.get('runs/'+key).json()['counts']['conflicted'],1)
        product.refresh_from_db();self.assertEqual(product.data['cost'],10);self.assertFalse(AuditEvent.objects.filter(action='catalog_changed').exists())
        key2=self.create([self.row(2,'Акційний',cost='20')]);self.ready(key2);self.approve(key2);self.drain(key2)
        self.assertEqual(self.get('runs/'+key2).json()['counts']['updated'],1)
        self.assertEqual(PriceObservation.objects.filter(product_path=product.path).count(),1)
        change=PriceChange.objects.get(product_path=product.path);self.assertEqual(change.before['salePrice'],'11.00');self.assertEqual(change.after['salePrice'],'11.00')
        self.assertEqual(change.before['regularPrice'],'13.00');self.assertEqual(change.after['regularPrice'],'26.00')
        self.assertEqual(AuditEvent.objects.filter(action='price_changed').count(),1)


    def test_more_than_1000_rows_uses_bounded_steps_and_restarts_without_duplicate_audit(self):
        entries=[self.row(i,cost='10.01',type=f'Група {i}',barcode=f'B21-{i}') for i in range(1,1002)]
        key=self.create(entries);detail=self.ready(key)
        self.assertEqual(detail['status'],'ready');self.assertEqual(detail['planned']['create'],1001)
        self.assertEqual(CatalogImportChunk.objects.filter(run_id=key).count(),6)
        ack=self.approve(key);self.assertTrue(process_one(uuid.UUID(key)))
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(),100)
        self.assertEqual(self.get('runs/'+key).json()['progress'],{'done':100,'total':1001})
        # A newly constructed worker process reads only persisted cursors/results.
        self.drain(key);final=self.get('runs/'+key).json()
        self.assertEqual(final['counts']['created'],1001);self.assertEqual(final['counts']['pending'],0)
        self.assertEqual(final['status'],'completed');self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),1001)
        self.assertEqual(self.post('runs/'+key+'/apply',{'planRevision':detail['planRevision']}).json(),ack)
        self.assertEqual(self.get('runs/'+key+'/rows?page=11').json()['items'][0]['ordinal'],1001)
        self.assertEqual(self.get('runs/'+key+'/rows?page=999').json()['page'],11)
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(),1001)
        self.assertFalse(Document.objects.filter(path__startswith='catalog_refs/').exists())

    def test_existing_catalog_revision_and_base_unit_remain_authoritative(self):
        # The common unit guard protects historical accounting references too.
        from server.erp.models import Store,Warehouse,Counterparty,Voucher,VoucherLine
        store=Store.objects.create(name='Тест');warehouse=Warehouse.objects.create(name='Тест',store=store)
        document=Document.objects.create(path='products/base',data={'name':'Облікований','unit':'кг','cost':10,'markup':30})
        voucher=Voucher.objects.create(kind='receipt',store=store,warehouse=warehouse,date=timezone.localdate(),created_by=self.user)
        VoucherLine.objects.create(voucher=voucher,product=document,quantity='1',price='10',cost='10',amount='10')
        key=self.create([{'line':1,'id':'base','revision':revision(document),'values':{'name':'Облікований','unit':'шт'}}]);detail=self.ready(key)
        self.assertEqual(detail['status'],'invalid');self.assertIn('Одиницю',self.get('runs/'+key+'/rows').json()['items'][0]['error']['message'])
        document.refresh_from_db();self.assertEqual(document.data['unit'],'кг');self.assertFalse(AuditEvent.objects.exists())

    def test_row_validation_failure_after_plan_does_not_abort_other_rows(self):
        key=self.create([self.row(1,cost='10',barcode='UNIQUE'),self.row(2,cost='20')]);self.ready(key);self.approve(key)
        Document.objects.create(path='products/competing',data={'name':'Зовнішній товар','unit':'шт','barcode':'UNIQUE'})
        self.drain(key);final=self.get('runs/'+key).json();self.assertEqual(final['counts']['failed'],1);self.assertEqual(final['counts']['created'],1)
        self.assertEqual(self.get('runs/'+key+'/rows?status=failed').json()['items'][0]['error']['code'],'apply_validation_failed')
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),1)

    def test_explicit_reference_resource_limit_fails_plan_without_mutating_catalogue(self):
        key=self.create([self.row(1,cost='10')]);self.post('runs/'+key+'/seal',{})
        Document.objects.create(path='catalog_refs/huge',data={'field':'type','value':'Історична','aliases':[{'value':'x'*2100000}]})
        self.drain(key);detail=self.get('runs/'+key).json();self.assertEqual(detail['status'],'invalid');self.assertEqual(detail['counts']['invalid'],1)
        self.assertFalse(Document.objects.filter(path__startswith='products/').exists());self.assertFalse(AuditEvent.objects.exists())


class CatalogImportJobsPostgresTests(ImportJobsFixture,TransactionTestCase):
    def setUp(self):
        from django.db import connection
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL row locks required')
        self.setup_jobs()
    def test_parallel_workers_claim_once_and_do_not_duplicate_products_or_audit(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        from django.db import close_old_connections,connections
        key=self.create([self.row(1,cost='10'),self.row(2,cost='20')]);self.ready(key);self.approve(key)
        gate=Barrier(2)
        def worker():
            close_old_connections()
            try:gate.wait(5);return process_one(uuid.UUID(key))
            finally:connections['default'].close()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:worker(),range(2)))
        self.assertIn(True,results);self.drain(key)
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(),2)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),2)
        self.assertEqual(self.get('runs/'+key).json()['status'],'completed')
    def test_current_actor_revoked_during_ledger_wait_is_blocked(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from django.db import close_old_connections,connections,transaction
        from server.erp.services import ledger_lock as original_lock
        key=self.create([self.row(1,cost='10')]);self.ready(key);self.approve(key)
        waiting=Event()
        def lock_signal():waiting.set();original_lock()
        def worker():
            close_old_connections()
            try:
                with patch('server.erp.import_jobs.ledger_lock',lock_signal):return process_one(uuid.UUID(key))
            finally:connections['default'].close()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with transaction.atomic():
                LedgerLock.objects.select_for_update().get(pk=1)
                future=pool.submit(worker);self.assertTrue(waiting.wait(5))
                Profile.objects.filter(user=self.user).update(role='cashier')
            self.assertTrue(future.result(10))
        run=CatalogImportRun.objects.get(pk=key);self.assertEqual(run.status,'blocked');self.assertEqual(run.error['code'],'access_revoked')
        self.assertFalse(Document.objects.filter(path__startswith='products/').exists());self.assertFalse(AuditEvent.objects.exists())
    def test_parallel_approve_exact_ack_and_changed_payload_conflict(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        from django.db import close_old_connections,connections
        from server.erp.import_jobs import approve
        key=self.create([self.row(1,cost='10')]);detail=self.ready(key);barrier=Barrier(2)
        def worker():
            close_old_connections()
            try:
                actor=User.objects.get(pk=self.user.pk);barrier.wait(5)
                return approve(actor,uuid.UUID(key),{'planRevision':detail['planRevision']})
            finally:connections['default'].close()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:worker(),range(2)))
        self.assertEqual(results[0],results[1]);self.drain(key)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),1)


class CatalogImportJobsMigrationTests(TransactionTestCase):
    def test_backfill_atomic_receipts_bounded_valid_only_and_reverse_forward(self):
        from django.db import connection
        from django.db.migrations.executor import MigrationExecutor
        executor=MigrationExecutor(connection);leaves=executor.loader.graph.leaf_nodes('erp')
        try:
            executor.migrate([('erp','0016_multiple_daily_work_shifts')]);old=executor.loader.project_state([('erp','0016_multiple_daily_work_shifts')]).apps
            OldUser=old.get_model('auth','User');OldDocument=old.get_model('erp','Document');owner=OldUser.objects.create(username='migration-import-author')
            key=str(uuid.uuid4());data={'owner':owner.pk,'payloadHash':'a'*64,'result':{'entries':[{'line':2,'action':'create','id':'old','revision':'b'*64}],'counts':{'created':1,'updated':0,'errors':0}}}
            OldDocument.objects.create(path='import_runs/'+key,data=data)
            OldDocument.objects.create(path='import_runs/'+str(uuid.uuid4()),data={'owner':owner.pk,'payloadHash':'x','result':{}})
            OldDocument.objects.create(path='import_runs/not-uuid',data=data)
            executor=MigrationExecutor(connection);executor.migrate([('erp','0017_catalog_import_jobs')])
            apps=executor.loader.project_state([('erp','0017_catalog_import_jobs')]).apps;Run=apps.get_model('erp','CatalogImportRun');Row=apps.get_model('erp','CatalogImportRow')
            run=Run.objects.get(pk=key);self.assertEqual(run.owner_id,owner.pk);self.assertEqual(run.mode,'atomic');self.assertEqual(run.counts['created'],1)
            self.assertEqual(Run.objects.count(),1);self.assertEqual(Row.objects.get(run=run).product_path,'products/old')
            executor.migrate([('erp','0016_multiple_daily_work_shifts')]);executor=MigrationExecutor(connection);executor.migrate([('erp','0017_catalog_import_jobs')]);self.assertEqual(Run.objects.count(),1)
        finally:MigrationExecutor(connection).migrate(leaves)
