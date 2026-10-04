"""B10 real orders, physical FEFO holds and repeated actions, isolated data."""
from datetime import timedelta,date,datetime,timezone as utc
from decimal import Decimal
from unittest.mock import patch
from threading import Thread,Barrier
import uuid
from django.test import TransactionTestCase
from django.db import connection,connections,close_old_connections
from django.test.utils import CaptureQueriesContext
from tests.test_erp import AccountingFixture
from server.erp.models import *
from server.erp.services import *
from server.erp.orders import mutate,order_json
from server.erp.reservations import held_quantities,expiry_instant
from server.erp.reporting import stock
from server.erp.browsing import references
from server.erp.replenishment import on_order


class OrderReservationTests(TransactionTestCase):
    v=AccountingFixture.v;sale=AccountingFixture.sale;cash_start=AccountingFixture.cash_start
    def setUp(self):
        AccountingFixture.setUp(self);self.d=date.fromisoformat(self.today)
        self.receipt=self.v('receipt',5,5,lines=[{'product':'p','quantity':'5','price':'5','lot':'EARLY','expiry':str(self.d+timedelta(days=2))},{'product':'p','quantity':'5','price':'7','lot':'LATE','expiry':str(self.d+timedelta(days=7))}])
        self.order=self.v('customer_order',6,12,party=self.customer.pk)
    def act(self,action,order=None,**extra):
        order=order or self.order
        return mutate(self.u,order.pk,{'action':action,'revision':order_json(order,self.u)['revision'],'idempotencyKey':str(uuid.uuid4()),**extra})
    def reserve(self,quantity='6',**extra):
        return self.act('reserve',expires_on=str(self.d+timedelta(days=2)),lines=[{'line':self.order.lines.get().pk,'quantity':quantity}],**extra)
    def fulfill(self,quantity,**extra):
        return self.v('sale',quantity,12,party=self.customer.pk,reference=self.order.pk,**extra)
    def test_fefo_explicit_reserve_no_accounting_effect_and_own_partial_fulfillment(self):
        counts=(StockEntry.objects.count(),CashEntry.objects.count(),Voucher.objects.count());lots=list(StockLot.objects.values_list('quantity','value'))
        data=self.reserve()['order'];self.assertEqual([r['code'] for r in data['reservations']],['EARLY','LATE']);self.assertEqual([r['quantity'] for r in data['reservations']],['5.000','1.000'])
        self.assertEqual(counts,(StockEntry.objects.count(),CashEntry.objects.count(),Voucher.objects.count()));self.assertEqual(lots,list(StockLot.objects.values_list('quantity','value')))
        self.assertEqual(stock(self.u)['totals'][0]['available'],'4.000');self.assertEqual(stock(self.u)['totals'][0]['reserved'],'6.000')
        sold=self.fulfill(2);self.assertEqual(sold.cost,10);self.assertEqual(sold.stock_entries.get().lot.code,'EARLY');self.assertEqual(ReservationUse.objects.get(line__voucher=sold).quantity,2)
        data=order_json(self.order,self.u);self.assertEqual(data['state'],'partial');self.assertEqual(data['lines'][0]['remaining'],'4.000');self.assertEqual(data['lines'][0]['reserved'],'4.000')
        other=self.sale(4,12);self.assertEqual(other.cost,28);self.assertTrue(all(e.lot.code=='LATE' for e in other.stock_entries.all()))
        with self.assertRaises(BusinessError):self.sale(1,12)
        sold=self.fulfill(4);self.assertEqual(sold.cost,22);self.assertEqual(order_json(self.order,self.u)['state'],'fulfilled');self.assertEqual(stock(self.u)['totals'][0]['quantity'],'0.000')
    def test_expiry_is_kyiv_inclusive_only_unused_freed_and_reverse_does_not_rehold_expired(self):
        self.reserve();sold=self.fulfill(2)
        midnight=expiry_instant(self.d+timedelta(days=2));self.assertTrue(midnight.startswith(str(self.d+timedelta(days=3))+'T00:00:00'))
        with patch('server.erp.reservations.kyiv_day',return_value=self.d+timedelta(days=3)):
            self.assertEqual(sum(held_quantities(list(StockLot.objects.values_list('pk',flat=True))).values()),0)
            data=self.act('expire')['order'];self.assertEqual(data['reservations'][0]['used'],'2.000');self.assertEqual(data['reservations'][0]['released'],'3.000')
            reverse_voucher(self.u,sold.pk,'Після строку')
        first=StockReservation.objects.get(lot__code='EARLY');self.assertEqual((first.used,first.released),(0,5));self.assertTrue(ReservationUse.objects.get().released_on_reverse);self.assertIsNotNone(ReservationUse.objects.get().reversed_at)
    def test_active_reversal_restores_own_hold_and_lifecycle_then_closed_reversal_releases(self):
        self.reserve();sold=self.fulfill(2);reverse_voucher(self.u,sold.pk,'Помилка');data=order_json(self.order,self.u);self.assertEqual(data['state'],'approved');self.assertEqual(data['lines'][0]['reserved'],'6.000')
        sold=self.fulfill(1);self.act('close',reason='Решта не потрібна');reverse_voucher(self.u,sold.pk,'Після закриття');self.assertEqual(order_json(self.order,self.u)['state'],'closed');self.assertEqual(sum(held_quantities(list(StockLot.objects.values_list('pk',flat=True))).values()),0)
        with self.assertRaises(BusinessError):self.fulfill(1)
        with self.assertRaises(BusinessError):self.reserve('1')
        self.assertEqual(references(self.u,{'purpose':'sale'})['items'],[])
    def test_partial_release_expiry_validation_and_atomic_failures(self):
        with self.assertRaises(BusinessError):self.act('reserve',expires_on=str(self.d+timedelta(days=8)),lines=[{'line':self.order.lines.get().pk,'quantity':'1'}])
        self.assertEqual(StockReservation.objects.count(),0);self.reserve();first=StockReservation.objects.get(lot__code='EARLY')
        self.act('release',reservation=first.pk,quantity='1.500',reason='Змінився попит');self.assertEqual(order_json(self.order,self.u)['lines'][0]['reserved'],'4.500')
        for quantity in ('5','1e0','NaN'):
            with self.assertRaises(BusinessError):self.act('release',reservation=first.pk,quantity=quantity,reason='Помилка')
        first.refresh_from_db();self.assertEqual(first.released,Decimal('1.5'))
    def test_all_outgoing_and_reversal_of_incoming_cannot_steal_a_hold(self):
        self.reserve()
        for kind,qty,extra in [('writeoff',5,{}),('transfer',5,{'target':self.other.pk}),('supplier_return',5,{'reference':self.receipt.pk,'party':self.party.pk,'lines':[{'product':'p','reference_line':self.receipt.lines.get(lot='EARLY').pk,'quantity':5,'price':5}]}),('inventory',1,{'lines':[{'product':'p','quantity':'1','price':'5'}]})]:
            before=list(StockLot.objects.values_list('quantity','value'));count=StockEntry.objects.count()
            with self.assertRaises(BusinessError):self.v(kind,qty,5,**extra)
            self.assertEqual(before,list(StockLot.objects.values_list('quantity','value')));self.assertEqual(StockEntry.objects.count(),count)
        with self.assertRaises(BusinessError):reverse_voucher(self.u,self.receipt.pk,'Є резерв')
    def test_stale_revision_exact_retry_even_after_later_change_and_role_owner_scope(self):
        body={'action':'reserve','revision':1,'idempotencyKey':str(uuid.uuid4()),'expires_on':self.today,'lines':[{'line':self.order.lines.get().pk,'quantity':'1'}]}
        initial=mutate(self.u,self.order.pk,body);self.act('release',reservation=initial['order']['reservations'][0]['id'],quantity='1',reason='Не потрібно');count=AuditEvent.objects.count()
        self.assertEqual(mutate(self.u,self.order.pk,body),initial);self.assertEqual(AuditEvent.objects.count(),count)
        with self.assertRaises(BusinessError):mutate(self.u,self.order.pk,{**body,'lines':[{'line':self.order.lines.get().pk,'quantity':'2'}]})
        with self.assertRaises(BusinessError):mutate(self.u,self.order.pk,{**body,'idempotencyKey':str(uuid.uuid4())})
        cashier=User.objects.create(username='cashier');Profile.objects.create(user=cashier,role='cashier',store=self.store)
        with self.assertRaises(BusinessError):mutate(cashier,self.order.pk,{**body,'revision':order_json(self.order,self.u)['revision'],'idempotencyKey':str(uuid.uuid4())})
        # Fulfillment uses the source order, regardless of the selling employee.
        saved=save_voucher(cashier,{'kind':'sale','date':self.today,'store':self.store.pk,'warehouse':self.wh.pk,'party':self.customer.pk,'reference':self.order.pk,'lines':[{'product':'p','quantity':'1','price':'12'}]});post_voucher(cashier,saved.pk)
    def test_purchase_explicit_minimum_expected_date_and_closed_remaining(self):
        draft=save_voucher(self.u,{'kind':'purchase_order','date':self.today,'store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,'payload':{'minimum_order_amount':'100.00','expected_date':str(self.d+timedelta(days=2))},'lines':[{'product':'p','quantity':'2','price':'10'}]})
        with self.assertRaises(BusinessError):post_voucher(self.u,draft.pk)
        self.assertFalse(OrderControl.objects.filter(order=draft).exists());draft.refresh_from_db();self.assertEqual(draft.status,'draft')
        order=self.v('purchase_order',10,10,payload={'minimum_order_amount':'100.00','expected_date':str(self.d+timedelta(days=2))});data=order_json(order,self.u);self.assertEqual(data['minimum_order_amount'],'100.00');self.assertEqual(data['expected_date'],str(self.d+timedelta(days=2)))
        self.assertEqual(on_order(self.wh.pk,self.p.pk),10);self.act('close',order,reason='Постачальник скасував');self.assertEqual(on_order(self.wh.pk,self.p.pk),0)
        with self.assertRaises(BusinessError):self.v('receipt',1,10,reference=order.pk)
    def test_changed_source_revision_requires_explicit_refresh(self):
        version=order_json(self.order,self.u)['revision'];self.reserve('1')
        with self.assertRaises(BusinessError):self.fulfill(1,payload={'order_revision':version})
        self.fulfill(1,payload={'order_revision':order_json(self.order,self.u)['revision']})
    def concurrent(self,operations):
        barrier=Barrier(len(operations));outcomes=[]
        def run(fn):
            close_old_connections()
            try:
                barrier.wait(timeout=10);outcomes.append(('ok',fn(User.objects.get(pk=self.u.pk))))
            except Exception as error:outcomes.append(('error',error))
            finally:connections.close_all()
        threads=[Thread(target=run,args=(fn,)) for fn in operations]
        for thread in threads:thread.start()
        for thread in threads:thread.join(timeout=15);self.assertFalse(thread.is_alive())
        return outcomes
    def test_postgresql_concurrent_sale_and_hold_cannot_overbook_and_retry_writes_once(self):
        if connection.vendor!='postgresql':self.skipTest('Ledger concurrency requires PostgreSQL.')
        sale=save_voucher(self.u,{'kind':'sale','date':self.today,'store':self.store.pk,'warehouse':self.wh.pk,'party':self.customer.pk,'lines':[{'product':'p','quantity':'6','price':'12'}]})
        body={'action':'reserve','revision':1,'idempotencyKey':str(uuid.uuid4()),'expires_on':self.today,'lines':[{'line':self.order.lines.get().pk,'quantity':'6'}]}
        outcomes=self.concurrent([lambda user:mutate(user,self.order.pk,body),lambda user:post_voucher(user,sale.pk)])
        self.assertEqual([status for status,_ in outcomes].count('ok'),1);self.assertIsInstance(next(value for status,value in outcomes if status=='error'),BusinessError)
        for lot in StockLot.objects.all():self.assertGreaterEqual(lot.quantity,held_quantities([lot.pk]).get(lot.pk,0))
        if StockReservation.objects.exists():self.act('close',reason='Завершення перевірки')
        order=self.v('customer_order',1,12,party=self.customer.pk);body={**body,'revision':1,'idempotencyKey':str(uuid.uuid4()),'lines':[{'line':order.lines.get().pk,'quantity':'1'}]}
        before=AuditEvent.objects.count();outcomes=self.concurrent([lambda user:mutate(user,order.pk,body),lambda user:mutate(user,order.pk,body)])
        self.assertEqual([status for status,_ in outcomes],['ok','ok']);self.assertEqual(outcomes[0][1],outcomes[1][1]);self.assertEqual(OrderOperation.objects.filter(order=order).count(),1);self.assertEqual(AuditEvent.objects.count(),before+1)
    def test_order_api_csrf_roles_scope_readonly_snapshot_and_paged_history(self):
        import hashlib,time,json
        def login(user):
            token=f'order-test-{user.pk}-{uuid.uuid4()}';PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=user,csrf='order-csrf',expires=int(time.time())+3600);self.client.cookies['ts_session']=token
        def post(value,csrf='order-csrf'):
            return self.client.post(f'/api/erp/orders/{self.order.pk}',data=json.dumps(value),content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN=csrf)
        login(self.u);body={'action':'reserve','revision':1,'idempotencyKey':str(uuid.uuid4()),'expires_on':self.today,'lines':[{'line':self.order.lines.get().pk,'quantity':'1'}]}
        self.assertEqual(post(body,'wrong').status_code,403)
        before=(OrderControl.objects.count(),AuditEvent.objects.count(),OrderOperation.objects.count());url=f'/api/erp/orders/{self.order.pk}?purpose=reserve'
        data=self.client.get(url).json();self.assertEqual(data['limits'][0]['max_date'],str(self.d+timedelta(days=2)));self.assertEqual(data['limits'][0]['available'],'10.000');self.assertEqual(before,(OrderControl.objects.count(),AuditEvent.objects.count(),OrderOperation.objects.count()))
        if connection.vendor=='postgresql':
            from server.erp.orders import remaining_lines as original
            triggered=[]
            def changed(order):
                result=original(order)
                if triggered:return result
                triggered.append(True);thread=Thread(target=lambda:self.thread_reserve(body));thread.start();thread.join(timeout=15);self.assertFalse(thread.is_alive());return result
            with patch('server.erp.orders.remaining_lines',side_effect=changed):data=self.client.get(f'/api/erp/orders/{self.order.pk}').json()
            self.assertEqual(data['order']['revision'],1);self.assertEqual(data['order']['lines'][0]['reserved'],'0');self.assertEqual(order_json(self.order,self.u)['lines'][0]['reserved'],'1.000')
        else:self.assertEqual(post(body).status_code,200)
        self.assertEqual(post({**body,'idempotencyKey':str(uuid.uuid4())}).status_code,409)
        cashier=User.objects.create(username='api-cashier');Profile.objects.create(user=cashier,role='cashier',store=self.store);login(cashier)
        self.assertFalse(self.client.get(f'/api/erp/orders/{self.order.pk}').json()['order']['canManage']);self.assertEqual(post({**body,'revision':2}).status_code,400)
        foreign=Store.objects.create(name='Foreign');manager=User.objects.create(username='foreign-manager');Profile.objects.create(user=manager,role='manager',store=foreign);login(manager);self.assertEqual(self.client.get(url).status_code,403)
        login(self.u);line=self.order.lines.get();lot=StockLot.objects.first()
        StockReservation.objects.bulk_create([StockReservation(order_line=line,lot=lot,owner=self.u,expires_on=self.d,quantity=1,released=1) for _ in range(55)])
        data=self.client.get(f'/api/erp/orders/{self.order.pk}?page=2').json()['order'];self.assertEqual(data['history']['total'],56);self.assertEqual(len(data['reservations']),6);self.assertEqual(data['lines'][0]['reserved'],'1.000')
    def thread_reserve(self,body):
        close_old_connections()
        try:mutate(User.objects.get(pk=self.u.pk),self.order.pk,body)
        finally:connections.close_all()
    def test_owned_and_free_quantity_same_lot_keep_single_original_cost_rounding(self):
        p=Document.objects.create(path='products/penny',data={'name':'Копійчаний','unit':'шт'});receipt=self.v('receipt',lines=[{'product':'penny','quantity':'3','price':'0.0167'}]);order=self.v('customer_order',party=self.customer.pk,lines=[{'product':'penny','quantity':'2','price':'1'}])
        self.act('reserve',order,expires_on=self.today,lines=[{'line':order.lines.get().pk,'quantity':'1'}]);sold=self.v('sale',party=self.customer.pk,reference=order.pk,lines=[{'product':'penny','reference_line':order.lines.get().pk,'quantity':'2','price':'1'}])
        self.assertEqual(sold.cost,Decimal('.03'));self.assertEqual(sold.stock_entries.count(),1);self.assertEqual(StockLot.objects.get(product=p).value,Decimal('.02'));self.assertEqual(ReservationUse.objects.get(line__voucher=sold).quantity,1)
    def test_production_foreign_hold_and_return_dependency_reversal_preserve_history(self):
        out=Document.objects.create(path='products/out',data={'name':'Готовий','unit':'шт','recipe':[{'product':'p','quantity':'5'}]});self.reserve()
        with self.assertRaises(BusinessError):self.v('production',lines=[{'product':'out','quantity':'1'}])
        self.assertFalse(StockLot.objects.filter(product=out).exists());sold=self.fulfill(2);returned=self.v('customer_return',1,999,party=self.customer.pk,reference=sold.pk)
        with self.assertRaises(BusinessError):reverse_voucher(self.u,sold.pk,'Спочатку повернення')
        self.assertEqual(order_json(self.order,self.u)['lines'][0]['reserved'],'4.000');reverse_voucher(self.u,returned.pk,'Помилка');reverse_voucher(self.u,sold.pk,'Помилка');self.assertEqual(order_json(self.order,self.u)['lines'][0]['reserved'],'6.000')
        with patch('server.erp.reservations.kyiv_day',return_value=self.d+timedelta(days=3)):
            self.v('writeoff',5,lines=[{'product':'p','quantity':'5','lot':'EARLY'}])
        self.assertEqual(StockLot.objects.get(code='EARLY').quantity,0);self.assertEqual(StockReservation.objects.get(lot__code='EARLY').used,0)
    def test_whitelisted_order_audit_has_quantities_units_actor_request_and_no_ui_history(self):
        from server.erp.business_audit import snapshot
        value={'state':'approved','revision':1,'password':'secret','lines':[{'line':1,'name':'Кава','unit':'шт','quantity':'1','fulfilled':'0','remaining':'1','reserved':'0','session':'secret'}],'reservations':[{'password':'secret'}],'canManage':True}
        safe=snapshot('order',value);self.assertNotIn('password',safe);self.assertNotIn('reservations',safe);self.assertNotIn('canManage',safe);self.assertNotIn('session',safe['order_lines'][0]);self.assertEqual(safe['order_lines'][0]['unit'],'шт')
        self.reserve('1');event=AuditEvent.objects.filter(action='order_reserve').latest('pk');self.assertEqual(event.user,self.u);self.assertEqual(event.detail['before']['order_lines'][0]['reserved'],'0');self.assertEqual(event.detail['after']['order_lines'][0]['reserved'],'1.000');uuid.UUID(event.detail['request_id']);self.assertEqual(event.detail['expires_on'],str(self.d+timedelta(days=2)))
        row=StockReservation.objects.first();self.act('release',reservation=row.pk,quantity='0.500',reason='Попит змінився');event=AuditEvent.objects.filter(action='order_release').latest('pk');self.assertEqual(event.detail['before']['reservation']['released'],'0.000');self.assertEqual(event.detail['after']['reservation']['released'],'0.500');self.assertEqual(event.detail['after']['reservation']['unit'],'шт');self.assertEqual(event.detail['reason'],'Попит змінився')
