from decimal import Decimal
from datetime import timedelta, datetime
from zoneinfo import ZoneInfo
from django.test import TransactionTestCase, Client
from django.test.utils import CaptureQueriesContext
from django.db import connection, connections, close_old_connections
from django.db.migrations.executor import MigrationExecutor
from django.contrib.auth.models import User
from threading import Thread, Barrier
from tests.test_erp import AccountingFixture
from server.erp.models import *
from server.erp.services import *
from server.erp.settlements import unused
from server.erp.party_finance import advances, statement_data
from server.erp.historical_reports import balances
from server.erp.reconcile import reconcile
from server.erp.financial_browsing import current_debts


class PaymentAllocationTests(AccountingFixture):
    def payment(self,amount,allocations=None,**extra):
        body={'kind':'payment','date':self.today,'store':self.store.pk,'party':self.party.pk,'account':self.cash.pk,'amount':amount,**extra}
        if allocations is not None:body['allocations']=allocations
        v=save_voucher(self.u,body);return post_voucher(self.u,v.pk)
    def event(self,kind,payment,amount,allocations=None,**extra):
        body={'kind':kind,'date':self.today,'store':self.store.pk,'reference':payment.pk,'amount':amount,**extra}
        if kind=='payment_refund':body.setdefault('account',self.cash.pk)
        if allocations is not None:body['allocations']=allocations
        v=save_voucher(self.u,body);return post_voucher(self.u,v.pk)

    def test_one_payment_multiple_documents_one_cash_and_idempotent_post(self):
        self.v('cash_opening',amount=2000,account=self.cash.pk);a=self.v('receipt',10,100);b=self.v('receipt',10,50)
        p=self.payment('1500',[{'source':a.pk,'amount':'1000'},{'source':b.pk,'amount':'500'}])
        self.assertEqual(p.cash_entries.count(),1);self.assertEqual(obligation(a),0);self.assertEqual(obligation(b),0);self.assertEqual(unused(p),0)
        post_voucher(self.u,p.pk);self.assertEqual(p.cash_entries.count(),1)
        self.assertEqual(p.allocation_entries.count(),2);self.assertEqual(reconcile()['issues'],0)

    def test_advance_later_explicit_allocation_refund_and_reversal(self):
        self.cash_start();p=self.payment('100')
        r=self.v('receipt',10,5)
        self.assertEqual(obligation(r),50);self.assertEqual(unused(p),100)
        allocated=self.event('advance_allocation',p,'30',[{'source':r.pk,'amount':'30'}])
        self.assertEqual(allocated.cash_entries.count(),0);self.assertEqual(obligation(r),20);self.assertEqual(unused(p),70)
        refund=self.event('payment_refund',p,'20')
        self.assertEqual(refund.cash_entries.get().amount,20);self.assertEqual(unused(p),50)
        with self.assertRaises(BusinessError):reverse_voucher(self.u,p.pk,'too early')
        with self.assertRaises(BusinessError):reverse_voucher(self.u,r.pk,'linked allocation')
        reverse_voucher(self.u,refund.pk,'QA');self.assertEqual(unused(p),70)
        reverse_voucher(self.u,allocated.pk,'QA');self.assertEqual(unused(p),100);self.assertEqual(obligation(r),50)
        reverse_voucher(self.u,p.pk,'QA');self.assertEqual(cash_balance(self.cash),1000);self.assertEqual(reconcile()['issues'],0)

    def test_customer_advance_direction_and_partial_return_refund_remain_separate(self):
        self.v('receipt',10,5)
        sale=self.v('sale',5,10,party=self.customer.pk)
        p=self.payment('100',party=self.customer.pk,account=self.bank.pk)
        allocated=self.event('advance_allocation',p,'50',[{'source':sale.pk,'amount':'50'}])
        returned=self.v('customer_return',2,999,reference=sale.pk,party=self.customer.pk,payload={'payments':[{'account':self.bank.pk,'amount':'20'}]})
        self.assertEqual(obligation(sale),0);self.assertEqual(unused(p),50)
        refund=self.event('payment_refund',p,'50',account=self.bank.pk)
        self.assertEqual(refund.cash_entries.get().amount,-50);self.assertEqual(unused(p),0)
        with self.assertRaises(BusinessError):self.event('payment_refund',p,'.01',account=self.bank.pk)
        statement=statement_data(self.u,{'party':str(self.customer.pk)})
        self.assertEqual(statement['closing_balance'],'0.00');self.assertTrue(statement['reconciliation']['matches'])

    def test_legacy_single_reference_and_draft_delete_revision_keep_exact_cash(self):
        self.cash_start();r=self.v('receipt',10,5)
        p=self.v('payment',amount=20,reference=r.pk,account=self.cash.pk)
        self.assertEqual(p.allocation_entries.get().amount,20);self.assertEqual(p.cash_entries.get().amount,-20)
        self.assertEqual(obligation(r),30);self.assertEqual(unused(p),0)
        draft=save_voucher(self.u,{'kind':'payment','date':self.today,'store':self.store.pk,'reference':r.pk,'account':self.cash.pk,'amount':10})
        revision=draft.revision
        body={'kind':'payment','date':self.today,'store':self.store.pk,'reference':r.pk,'account':self.cash.pk,'amount':15,'revision':revision}
        saved=save_voucher(self.u,body,draft.pk);self.assertEqual(saved.allocation_entries.get().amount,15)
        with self.assertRaises(Conflict):save_voucher(self.u,body,draft.pk)
        saved.delete();self.assertFalse(PaymentAllocation.objects.filter(settlement_id=draft.pk).exists())

    def test_invalid_scope_direction_dates_amounts_and_duplicate_rows_are_atomic(self):
        r=self.v('receipt',10,5);other=Store.objects.create(name='Other');wh=Warehouse.objects.create(store=other,name='Other')
        foreign=save_voucher(self.u,{'kind':'receipt','date':self.today,'store':other.pk,'warehouse':wh.pk,'party':self.party.pk,'lines':[{'product':'p','quantity':1,'price':1}]});post_voucher(self.u,foreign.pk)
        bad=[([{'source':r.pk,'amount':'1.001'}],{}),([{'source':r.pk,'amount':True}],{}),([{'source':r.pk,'amount':'1'},{'source':r.pk,'amount':'2'}],{}),([{'source':foreign.pk,'amount':'1'}],{}),([{'source':r.pk,'amount':'1'}],{'party':self.customer.pk}),([{'source':'²','amount':'1'}],{}),([{'source':False,'amount':'1'}],{})]
        for rows,extra in bad:
            before=(Voucher.objects.count(),PaymentAllocation.objects.count(),CashEntry.objects.count())
            with self.assertRaises(BusinessError):self.payment('10',rows,**extra)
            self.assertEqual((Voucher.objects.count(),PaymentAllocation.objects.count(),CashEntry.objects.count()),before)
        with self.assertRaises(BusinessError):self.payment('10',[{'source':r.pk,'amount':'11'}])
        yesterday=(timezone.localdate()-timedelta(days=1)).isoformat()
        with self.assertRaises(BusinessError):self.payment('10',[{'source':r.pk,'amount':'1'}],date=yesterday)

    def test_asof_allocation_payment_and_source_activity_kyiv_reversal_and_statement(self):
        start=timezone.localdate().replace(day=1)-timedelta(days=4);later=start+timedelta(days=2)
        self.v('cash_opening',amount=1000,account=self.cash.pk,date=start.isoformat())
        source=self.v('receipt',10,5,date=start.isoformat())
        p=self.payment('100',date=start.isoformat());alloc=self.event('advance_allocation',p,'30',[{'source':source.pk,'amount':'30'}],date=later.isoformat())
        early=balances(self.u,{'as_of':start.isoformat()});self.assertEqual(early['debts'][0]['amount'],'50.00');self.assertEqual(early['advances'][0]['amount'],'100.00')
        cut=balances(self.u,{'as_of':later.isoformat()});self.assertEqual(cut['debts'][0]['amount'],'20.00');self.assertEqual(cut['advances'][0]['amount'],'70.00')
        reverse_voucher(self.u,alloc.pk,'historical')
        reversal=later+timedelta(days=1);Voucher.objects.filter(pk=alloc.pk).update(reversed_at=datetime.combine(reversal,datetime.min.time(),tzinfo=ZoneInfo('Europe/Kyiv')))
        historical=balances(self.u,{'as_of':later.isoformat()});self.assertEqual(historical['debts'][0]['amount'],'20.00')
        after=balances(self.u,{'as_of':reversal.isoformat()});self.assertEqual(after['debts'][0]['amount'],'50.00');self.assertEqual(after['advances'][0]['amount'],'100.00')
        proof=statement_data(self.u,{'party':str(self.party.pk),'from':start.isoformat(),'to':reversal.isoformat()});self.assertTrue(proof['reconciliation']['matches']);self.assertEqual(proof['closing_balance'],'50.00')

    def test_batch_65_sources_and_advances_no_per_source_queries(self):
        self.cash_start();sources=[self.v('receipt',1,1) for _ in range(65)]
        p=self.payment('100',[{'source':v.pk,'amount':'1'} for v in sources])
        with CaptureQueriesContext(connection) as captured:rows,totals=current_debts(self.u,{})
        self.assertLessEqual(len(captured),5);self.assertEqual(rows,[])
        with CaptureQueriesContext(connection) as captured:result=advances(self.u,{})
        self.assertLessEqual(len(captured),6);self.assertEqual(result['items'][0]['unallocated'],'35.00')

    def test_statement_pages_running_saldo_and_all_aging_buckets(self):
        today=timezone.localdate()
        due_days=[None,0,10,40,70,100]
        for i in range(65):
            days=due_days[i%len(due_days)]
            payload={} if days is None else {'due_date':(today-timedelta(days=days)).isoformat()}
            self.v('debt_opening',amount='1',party=self.party.pk,payload=payload)
        first=statement_data(self.u,{'party':str(self.party.pk)})
        last=statement_data(self.u,{'party':str(self.party.pk),'page':'3'})
        self.assertEqual((first['total'],first['pages'],len(first['items']),len(last['items'])),(65,3,30,5))
        self.assertEqual(first['items'][-1]['balance'],'-30.00');self.assertEqual(last['items'][-1]['balance'],'-65.00')
        self.assertEqual(last['debt_total'],'65.00');self.assertTrue(last['reconciliation']['matches'])
        self.assertTrue(all(Decimal(value)>0 for value in last['age'].values()))
        clamp=statement_data(self.u,{'party':str(self.party.pk),'page':'1000'});self.assertEqual(clamp['page'],3)

    def test_many_explicit_sources_save_and_post_use_batched_ledger_reads(self):
        self.cash_start()
        sources=[self.v('receipt',1,1) for _ in range(65)]
        body={'kind':'payment','date':self.today,'store':self.store.pk,'party':self.party.pk,'account':self.cash.pk,'amount':'65','allocations':[{'source':v.pk,'amount':'1'} for v in sources]}
        with CaptureQueriesContext(connection) as saved:payment=save_voucher(self.u,body)
        self.assertLessEqual(len(saved),30)
        with CaptureQueriesContext(connection) as posted:post_voucher(self.u,payment.pk)
        self.assertLessEqual(len(posted),40)
        self.assertEqual(payment.allocation_entries.count(),65)
        self.assertEqual(reconcile()['issues'],0)

    def test_refund_date_closed_period_and_corrupted_refund_are_guarded(self):
        self.cash_start();p=self.payment('100')
        yesterday=(timezone.localdate()-timedelta(days=1)).isoformat()
        with self.assertRaises(BusinessError):self.event('payment_refund',p,'10',date=yesterday)
        draft=save_voucher(self.u,{'kind':'payment_refund','date':self.today,'store':self.store.pk,'reference':p.pk,'account':self.cash.pk,'amount':'10'})
        LedgerLock.objects.filter(pk=1).update(closed_through=timezone.localdate())
        with self.assertRaises(BusinessError):post_voucher(self.u,draft.pk)
        self.assertFalse(draft.cash_entries.exists());LedgerLock.objects.filter(pk=1).update(closed_through=None)
        posted=post_voucher(self.u,draft.pk);self.assertEqual(unused(p),90)
        other=Store.objects.create(name='Other')
        Voucher.objects.filter(pk=posted.pk).update(store=other)
        self.assertTrue(reconcile()['checks']['allocations']['issues'])

    def test_omitted_allocations_preserve_existing_multi_draft_but_explicit_empty_clears(self):
        a=self.v('receipt',2,10);b=self.v('receipt',2,10)
        body={'kind':'payment','date':self.today,'store':self.store.pk,'party':self.party.pk,'account':self.cash.pk,'amount':'30','allocations':[{'source':a.pk,'amount':'10'},{'source':b.pk,'amount':'10'}]}
        v=save_voucher(self.u,body)
        body.pop('allocations');body['revision']=v.revision
        v=save_voucher(self.u,body,v.pk);self.assertEqual(v.allocation_entries.count(),2)
        body['revision']=v.revision;body['allocations']=[]
        v=save_voucher(self.u,body,v.pk);self.assertEqual(v.allocation_entries.count(),0)


class PaymentApiTests(TransactionTestCase):
    setUp=AccountingFixture.setUp
    v=AccountingFixture.v
    cash_start=AccountingFixture.cash_start
    def test_api_roles_csrf_scope_read_privacy_create_retry_and_advance_limits(self):
        import hashlib,time,json
        self.cash_start();r=self.v('receipt',10,5)
        manager=User.objects.create(username='manager');Profile.objects.create(user=manager,role='manager',store=self.store)
        accountant=User.objects.create(username='accountant');Profile.objects.create(user=accountant,role='accountant',store=self.store)
        cashier=User.objects.create(username='cashier');Profile.objects.create(user=cashier,role='cashier',store=self.store)
        warehouse=User.objects.create(username='warehouse');Profile.objects.create(user=warehouse,role='warehouse',store=self.store)
        def login(user):
            token=f'payment-test-{user.pk}';PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=user,csrf='test-csrf',expires=int(time.time())+3600);self.client.cookies['ts_session']=token
        def post(path,value,csrf='test-csrf'):
            return self.client.post(path,data=json.dumps(value),content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN=csrf)
        login(accountant)
        body={'kind':'payment','date':self.today,'store':self.store.pk,'party':self.party.pk,'account':self.cash.pk,'amount':'60','allocations':[{'source':r.pk,'amount':'50'}],'idempotency_key':'api-payment-stable'}
        response=post('/api/erp/vouchers',body);self.assertEqual(response.status_code,201,response.content);key=response.json()['id']
        self.assertEqual(post('/api/erp/vouchers',body).json()['id'],key)
        self.assertEqual(post(f'/api/erp/vouchers/{key}/post',{}).status_code,200)
        self.assertEqual(Voucher.objects.get(pk=key).cash_entries.count(),1)
        detail=self.client.get(f'/api/erp/vouchers/{key}');self.assertEqual(detail.json()['unallocated'],'10.00')
        self.assertEqual(self.client.get('/api/erp/advances',{'party':self.party.pk}).json()['total'],1)
        statement=self.client.get('/api/erp/party-statement',{'party':self.party.pk});self.assertEqual(statement.status_code,200);self.assertTrue(statement.json()['reconciliation']['matches'])
        refund={'kind':'payment_refund','date':self.today,'store':self.store.pk,'reference':key,'account':self.cash.pk,'amount':'11'}
        draft=post('/api/erp/vouchers',refund).json()['id'];self.assertEqual(post(f'/api/erp/vouchers/{draft}/post',{}).status_code,400)
        self.assertEqual(post('/api/erp/vouchers',body,csrf='wrong').status_code,403)
        for user in (cashier,warehouse):
            login(user)
            self.assertEqual(self.client.get('/api/erp/advances').status_code,403)
            self.assertEqual(self.client.get('/api/erp/party-statement',{'party':self.party.pk}).status_code,403)
            self.assertEqual(post('/api/erp/vouchers',body).status_code,403)
        login(manager)
        other=Store.objects.create(name='foreign')
        self.assertEqual(self.client.get('/api/erp/advances',{'store':other.pk}).json()['items'],[])
        self.assertEqual(self.client.get('/api/erp/party-statement',{'party':self.party.pk,'store':other.pk}).json()['items'],[])
        self.assertEqual(self.client.get('/api/erp/party-statement',{'party':self.party.pk,'page':'²'}).status_code,400)



class PaymentConcurrencyTests(TransactionTestCase):
    setUp=AccountingFixture.setUp
    v=AccountingFixture.v
    def test_parallel_allocation_and_refund_share_one_advance(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL ledger lock')
        self.v('cash_opening',amount=1000,account=self.cash.pk)
        source=self.v('receipt',10,10)
        payment=save_voucher(self.u,{'kind':'payment','date':self.today,'store':self.store.pk,'party':self.party.pk,'account':self.cash.pk,'amount':'100'});payment=post_voucher(self.u,payment.pk)
        allocate=save_voucher(self.u,{'kind':'advance_allocation','date':self.today,'store':self.store.pk,'reference':payment.pk,'amount':'60','allocations':[{'source':source.pk,'amount':'60'}]})
        refund=save_voucher(self.u,{'kind':'payment_refund','date':self.today,'store':self.store.pk,'reference':payment.pk,'account':self.cash.pk,'amount':'60'})
        barrier=Barrier(2);results=[]
        def run(pk):
            close_old_connections()
            try:barrier.wait(timeout=10);post_voucher(User.objects.get(pk=self.u.pk),pk);results.append('posted')
            except BusinessError:results.append('blocked')
            finally:connections.close_all()
        threads=[Thread(target=run,args=(doc.pk,)) for doc in (allocate,refund)]
        for t in threads:t.start()
        for t in threads:t.join(timeout=15)
        self.assertFalse(any(t.is_alive() for t in threads));self.assertCountEqual(results,['posted','blocked']);self.assertEqual(unused(payment),40);self.assertEqual(reconcile()['issues'],0)


class PaymentMigrationTests(TransactionTestCase):
    def test_legacy_payment_backfill_preserves_cash_dates_status_and_reference(self):
        executor=MigrationExecutor(connection);executor.migrate([('erp','0008_promotion_campaigns')])
        try:
            old=executor.loader.project_state([('erp','0008_promotion_campaigns')]).apps
            user=old.get_model('auth','User').objects.create(username='legacy-payment')
            store=old.get_model('erp','Store').objects.create(name='Legacy')
            party=old.get_model('erp','Counterparty').objects.create(name='Supplier',kind='supplier')
            account=old.get_model('erp','CashAccount').objects.create(name='Bank',kind='bank',store=store)
            V=old.get_model('erp','Voucher');day=timezone.localdate()
            source=V.objects.create(kind='receipt',status='posted',date=day,store=store,party=party,created_by=user,total=50)
            payment=V.objects.create(kind='payment',status='reversed',date=day,store=store,party=party,account=account,reference=source,created_by=user,total=20,reversed_at=timezone.now())
            cash=old.get_model('erp','CashEntry');cash.objects.create(voucher=payment,account=account,amount=-20);cash.objects.create(voucher=payment,account=account,amount=20,is_reversal=True)
            before=list(cash.objects.values_list('pk','voucher_id','account_id','amount','is_reversal'))
            executor=MigrationExecutor(connection);executor.migrate([('erp','0009_payment_allocations')])
            allocation=PaymentAllocation.objects.get();self.assertEqual((allocation.settlement_id,allocation.payment_id,allocation.source_id,allocation.amount),(payment.pk,payment.pk,source.pk,Decimal(20)))
            self.assertEqual(list(CashEntry.objects.values_list('pk','voucher_id','account_id','amount','is_reversal')),before)
            saved=Voucher.objects.get(pk=payment.pk);self.assertEqual(saved.reference_id,source.pk);self.assertEqual(saved.status,'reversed');self.assertEqual(saved.date,day)
        finally:
            executor=MigrationExecutor(connection)
            executor.migrate(executor.loader.graph.leaf_nodes('erp'))
