"""Five order actions: immutable acknowledgements and read-only reload context."""
import hashlib,json,time,uuid
from datetime import timedelta
from unittest.mock import patch
from django.test import TransactionTestCase
from django.db import connection
from django.test.utils import CaptureQueriesContext
import tests.test_order_reservations as order_fixtures
from tests.test_erp import AccountingFixture
from server.erp.models import AuditEvent,CashEntry,OrderControl,OrderOperation,PortalSession,Profile,StockEntry,StockLot,StockReservation,User,Voucher
from server.erp.orders import order_json
from server.erp.order_action_recovery import execute,identity,context
from server.erp.services import BusinessError,Conflict

class OrderActionRecoveryTests(TransactionTestCase):
    v=AccountingFixture.v;sale=AccountingFixture.sale;cash_start=AccountingFixture.cash_start
    setUp=order_fixtures.OrderReservationTests.setUp
    def terms(self,action,order=None,**extra):
        order=order or self.order
        return {'id':order.pk,'kind':order.kind,'store':order.store_id,'body':{'action':action,'revision':order_json(order,self.u)['revision'],'idempotencyKey':str(uuid.uuid4()),**extra}}
    def reserve(self):return self.terms('reserve',expires_on=self.today,lines=[{'line':self.order.lines.get().pk,'quantity':'1.000'}])
    def params(self,t):return {k:str(t[k]) for k in ('id','kind','store')}|{'action':t['body']['action']}|({'reservation':str(t['body']['reservation'])} if t['body']['action']=='release' else {})
    def login(self):
        token='order-action-'+str(uuid.uuid4());PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=self.u,csrf='order-action-csrf',expires=int(time.time())+3600);self.client.cookies['ts_session']=token
    def post(self,action,value):return self.client.post('/api/v1/trading/order-actions/'+action,data=json.dumps(value),content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='order-action-csrf')
    def test_whole_five_exact_receipt_scalar_and_no_accounting_change(self):
        movements=(StockEntry.objects.count(),CashEntry.objects.count());lots=list(StockLot.objects.values_list('quantity','value'))
        t=self.reserve();ack,status=execute(self.u,t);self.assertEqual(status,200);self.assertEqual(set(ack),{'contract','request','outcome'});self.assertEqual(ack['outcome']['revision'],2)
        r=StockReservation.objects.get();release=self.terms('release',reservation=r.pk,quantity='0.500',reason='Частково');execute(self.u,release);r.refresh_from_db();self.assertEqual(str(r.released),'0.500')
        expire=self.terms('expire');execute(self.u,expire)
        close=self.terms('close',reason='Завершено');execute(self.u,close);r.refresh_from_db();self.assertEqual(r.released,r.quantity)
        before=AuditEvent.objects.count();self.assertEqual(execute(self.u,t),(ack,200));self.assertEqual(AuditEvent.objects.count(),before)
        self.assertEqual(identity(self.u,{'request':t}),{'confirmed':True,**ack})
        purchase=self.v('purchase_order',1,5);date=self.terms('expected_date',purchase,expected_date=self.today);execute(self.u,date);clear=self.terms('expected_date',purchase,expected_date='');execute(self.u,clear);self.assertIsNone(OrderControl.objects.get(order=purchase).expected_date)
        self.assertEqual(movements,(StockEntry.objects.count(),CashEntry.objects.count()));self.assertEqual(lots,list(StockLot.objects.values_list('quantity','value')))
        with self.assertRaises(Conflict):execute(self.u,{**t,'body':{**t['body'],'lines':[{'line':t['body']['lines'][0]['line'],'quantity':'2'}]}})
    def test_exact_selected_reservation_outside_page_one_readonly_and_rr(self):
        line=self.order.lines.get();lot=StockLot.objects.first();rows=[StockReservation(order_line=line,lot=lot,owner=self.u,expires_on=self.d+timedelta(days=2),quantity='0.001') for _ in range(65)];StockReservation.objects.bulk_create(rows)
        old=StockReservation.objects.order_by('pk').first();self.assertNotIn(old.pk,[r['id'] for r in order_json(self.order,self.u)['reservations']])
        t=self.terms('release',reservation=old.pk,quantity='0.001',reason='Старий резерв')
        before=(OrderControl.objects.count(),OrderOperation.objects.count(),AuditEvent.objects.count())
        with CaptureQueriesContext(connection) as q:c=context(self.u,self.params(t));unconfirmed=identity(self.u,{'request':t})
        self.assertEqual(c['selected']['id'],old.pk);self.assertEqual(c['selected']['unused'],'0.001');self.assertFalse(unconfirmed['confirmed'])
        self.assertEqual(before,(OrderControl.objects.count(),OrderOperation.objects.count(),AuditEvent.objects.count()));self.assertFalse(any(x['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for x in q))
        if connection.vendor=='postgresql':self.assertTrue(any('REPEATABLE READ' in x['sql'] for x in q));self.assertTrue(any('READ ONLY' in x['sql'] for x in q))
        self.assertEqual(execute(self.u,t)[1],200)
    def test_live_first_rollback_proof_revision_and_postcommit_failure_boundary(self):
        t=self.reserve();bad={**t,'body':{**t['body'],'expires_on':'invalid'}};result,status=execute(self.u,bad);self.assertEqual(status,400);self.assertTrue(result['write_rejected']);self.assertEqual(result['request'],bad);self.assertFalse(OrderOperation.objects.exists());self.assertFalse(StockReservation.objects.exists())
        execute(self.u,t);stale={**t,'body':{**t['body'],'idempotencyKey':str(uuid.uuid4())}};result,status=execute(self.u,stale);self.assertEqual(status,409);self.assertTrue(result['write_rejected'])
        collision={**t,'body':{**t['body'],'expires_on':'different'}}
        with self.assertRaises(Conflict):execute(self.u,collision)
        close=self.terms('close',reason='Закриття')
        original=__import__('server.erp.order_action_recovery',fromlist=['receipt']).receipt
        def after(user,terms):
            result=original(user,terms)
            if result is not None:raise RuntimeError('serialization failed')
            return result
        with patch('server.erp.order_action_recovery.receipt',side_effect=after):
            with self.assertRaises(RuntimeError):execute(self.u,close)
        # Atomic failure rolls back; a non-domain exception never becomes a no-write proof.
        self.assertFalse(OrderOperation.objects.filter(pk=close['body']['idempotencyKey']).exists())
    def test_current_actor_replay_scope_and_http_scalar_query_guards(self):
        self.login();t=self.reserve();self.assertEqual(self.post('execute',t).status_code,200)
        for query in ('id=1&id=2','kind=payroll','action=unexpected'):
            url='/api/v1/trading/order-actions/context?'+__import__('urllib.parse',fromlist=['urlencode']).urlencode(self.params(t))+'&'+query
            self.assertEqual(self.client.get(url).status_code,400)
        another=User.objects.create(username='order-other');Profile.objects.create(user=another,role='owner')
        with self.assertRaises(Conflict):identity(another,{'request':t})
        Profile.objects.filter(user=self.u).update(role='accountant')
        with CaptureQueriesContext(connection) as q:
            with self.assertRaises(BusinessError):execute(self.u,t)
        self.assertFalse(any('erp_orderoperation' in x['sql'].lower() for x in q))
        self.assertEqual(self.post('identity',{'request':t}).status_code,403)
    def test_missing_profile_and_no_write_current_context(self):
        t=self.reserve();Profile.objects.filter(user=self.u).delete()
        with self.assertRaises(BusinessError):context(self.u,self.params(t))
        self.assertFalse(OrderOperation.objects.exists())
    def test_scalar_replay_no_full_payload_and_safe_context_ids(self):
        t=self.reserve();execute(self.u,t)
        with CaptureQueriesContext(connection) as q:
            identity(self.u,{'request':t});context(self.u,self.params(t))
        voucher_reads=[x['sql'] for x in q if 'FROM "erp_voucher"' in x['sql']]
        self.assertTrue(voucher_reads);self.assertFalse(any('"erp_voucher"."payload",' in sql or '"erp_voucher"."payload" AS' in sql for sql in voucher_reads))
        for key in ('id','store'):
            with CaptureQueriesContext(connection) as q:
                with self.assertRaises(BusinessError):context(self.u,{**self.params(t),key:'9007199254740992'})
            self.assertEqual(len(q),0)
    def test_legacy_expected_scalar_sql_gate_and_falsy_parity(self):
        t=self.terms('expire')
        OrderControl.objects.filter(order=self.order).delete()
        for value in (None,False,0,'',[],{}):
            Voucher.objects.filter(pk=self.order.pk).update(payload={'expected_date':value,'other':'unselected'*10000})
            with CaptureQueriesContext(connection) as q:result=context(self.u,self.params(t))
            self.assertIsNone(result['expected_date']);self.assertFalse(any('"erp_voucher"."payload",' in row['sql'] for row in q))
        for value in ({'huge':'private'*10000},['not','scalar'],'x'*81,True,1):
            Voucher.objects.filter(pk=self.order.pk).update(payload={'expected_date':value})
            with self.assertRaisesMessage(BusinessError,'історична очікувана дата'):context(self.u,self.params(t))
    def test_postgresql_same_key_parallel_one_hold_one_audit(self):
        if connection.vendor!='postgresql':self.skipTest('Real ledger concurrency requires PostgreSQL.')
        before=AuditEvent.objects.count();t=self.reserve();outcomes=order_fixtures.OrderReservationTests.concurrent(self,[lambda user:execute(user,t),lambda user:execute(user,t)])
        self.assertEqual([s for s,_ in outcomes],['ok','ok']);self.assertEqual(outcomes[0][1],outcomes[1][1]);self.assertEqual(OrderOperation.objects.count(),1);self.assertEqual(StockReservation.objects.count(),1);self.assertEqual(AuditEvent.objects.count(),before+1)
