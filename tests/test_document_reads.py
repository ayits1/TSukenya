"""Read-only bounded document view: fanout, exact oracle, current access, and RR."""
import hashlib
import json
import time
import uuid
from datetime import date, timedelta
from decimal import Decimal
from threading import Thread
from unittest.mock import patch
from django.contrib.auth.models import User
from django.db import connection, close_old_connections
from django.http import QueryDict
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import (Profile, Store, Warehouse, Counterparty, CashAccount, Document, Voucher,
    VoucherLine, StockLot, StockEntry, CashEntry, PaymentAllocation, StockReservation, OrderControl, PortalSession)
from server.erp.services import BusinessError, obligation
from server.erp.settlements import unused
from server.erp.reporting import voucher_json
from server.erp import document_reads as reads


class DocumentReadTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create_user(username='detail-owner')
        Profile.objects.create(user=self.user,role='owner')
        self.store=Store.objects.create(name='Магазин')
        self.warehouse=Warehouse.objects.create(name='Склад',store=self.store)
        self.party=Counterparty.objects.create(name='Покупець',kind='customer')
        self.account=CashAccount.objects.create(name='Каса',store=self.store)
        self.product=Document.objects.create(path='products/p',data={'name':'Назва','recipe':[{'private':'x'*1000}]*501})
        self.today=date.today()
    def voucher(self,kind='sale',**kwargs):
        return Voucher.objects.create(kind=kind,status='posted',store=self.store,warehouse=self.warehouse,party=self.party,date=self.today,created_by=self.user,total=Decimal('1000.00'),**kwargs)
    def line(self,v,**kwargs):
        return VoucherLine.objects.create(voucher=v,product=self.product,name='Товар',unit='шт',quantity='1',price='2.0001',amount='2.00',cost='1.00',**kwargs)
    def read(self,v,section=None,page=1,limit=30,user=None):
        return reads.read(user or self.user,v.pk,{'section':section,'page':str(page),'limit':str(limit)} if section else {},page=bool(section))
    def without_payload(self):
        original=Voucher.from_db
        def from_db(db,field_names,values):
            self.assertNotIn('payload',field_names)
            return original(db,field_names,values)
        return patch.object(Voucher,'from_db',side_effect=from_db)
    def login(self,user):
        token=str(uuid.uuid4());PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=user,csrf='test',expires=int(time.time())+3600);self.client.cookies['ts_session']=token

    def test_stock_fanout_fullcounts_tail_and_lineage_without_payload(self):
        v=self.voucher('receipt');line=self.line(v)
        lots=StockLot.objects.bulk_create([StockLot(warehouse=self.warehouse,product=self.product,code=str(i),quantity=1,value=1) for i in range(501)])
        StockEntry.objects.bulk_create([StockEntry(voucher=v,lot=lot,line=line,quantity=1,value=1) for lot in lots])
        with self.without_payload(),CaptureQueriesContext(connection) as sql:
            first=self.read(v,'stock_movements');last=self.read(v,'stock_movements',999)
            body=self.read(v,'lines')
        self.assertEqual(first['page']['total'],501);self.assertEqual(len(first['page']['items']),30)
        self.assertEqual(last['page']['page'],17);self.assertEqual(len(last['page']['items']),21)
        self.assertEqual(last['page']['items'][-1]['lot'],'500')
        self.assertFalse(body['page']['items'][0]['originKnown'])
        self.assertTrue(any('LIMIT 30' in q['sql'] for q in sql))
        # Unique annotated origin is preserved; negative/reversal rows do not make it ambiguous.
        StockEntry.objects.filter(voucher=v).exclude(lot=lots[0]).delete()
        StockEntry.objects.create(voucher=v,lot=lots[0],line=line,quantity=-1,value=-1,is_reversal=True)
        with self.without_payload():row=self.read(v,'lines')['page']['items'][0]
        self.assertTrue(row['originKnown']);self.assertEqual(row['lot'],'0')
        old=voucher_json(v,True,user=self.user)['lines'][0]
        self.assertEqual(row['remaining'],old['remaining']);self.assertEqual(row['remainingAmount'],old['remaining_amount'])

    def test_all_relational_sections_and_historical_lines_are_complete(self):
        order=self.voucher('customer_order');OrderControl.objects.create(order=order)
        VoucherLine.objects.bulk_create([VoucherLine(voucher=order,product=self.product,name=f'Рядок {i}',unit='шт',quantity=1,price=1,amount=1) for i in range(501)])
        first_line=order.lines.first();lot=StockLot.objects.create(warehouse=self.warehouse,product=self.product,code='lot',quantity=1000,value=1000)
        StockReservation.objects.bulk_create([StockReservation(order_line=first_line,lot=lot,owner=self.user,expires_on=self.today,quantity=1,released=1) for _ in range(55)])
        seen=[]
        with self.without_payload():
            for page in range(1,18):seen.extend(r['id'] for r in self.read(order,'order_lines',page)['page']['items'])
            tail=self.read(order,'reservations',999,10)
        self.assertEqual(len(seen),501);self.assertEqual(len(set(seen)),501)
        self.assertEqual(tail['page']['total'],55);self.assertEqual(len(tail['page']['items']),5)
        self.assertIn('sale',tail['document']['actions'])
        payment=self.voucher('payment')
        PaymentAllocation.objects.bulk_create([PaymentAllocation(settlement=payment,payment=payment,source=self.voucher(),amount=1) for _ in range(35)])
        CashEntry.objects.bulk_create([CashEntry(voucher=payment,account=self.account,amount=1) for _ in range(35)])
        with self.without_payload():
            allocations=self.read(payment,'allocations',2);cash=self.read(payment,'cash_movements',2)
        self.assertEqual(len(allocations['page']['items']),5);self.assertEqual(cash['page']['total'],35)
        self.assertEqual(Decimal(allocations['document']['unallocated']),unused(payment))

    def test_json_salary_and_production_pages_preserve_exact_scalars(self):
        payroll=self.voucher('payroll',payload={'calculation':[{'id':i+1,'date':str(self.today),'cash_shift':None,'rate':'600.01','units':'1.25','percent':'2.125','basis_amount':'999.99','accrued':'771.26','ignored':{'huge':['x']*200}} for i in range(501)]})
        production=self.voucher('production',payload={'production':{'source':'version','terms':{'version':1,'outputQuantity':'1.000','unit':'шт','components':[{'private':'x'}]*501},'plannedOutput':'1.000','actualOutput':'1.000','components':[{'product':'p','name':f'Сировина {i}','unit':'кг','expectedQuantity':'0.001','quantity':'0.002','lot':''} for i in range(501)]}})
        with self.without_payload():
            salary=self.read(payroll,'payroll_calculation',17);components=self.read(production,'production_components',51,10)
        self.assertEqual(salary['page']['total'],501);self.assertEqual(salary['page']['items'][-1]['workShift'],501)
        self.assertEqual(salary['page']['items'][0]['baseAmount'],'750.01')
        self.assertEqual(salary['page']['items'][0]['percent'],'2.125')
        self.assertEqual(components['page']['items'][0]['name'],'Сировина 500')
        payroll.payload['calculation'][0]['rate']={'bad':'value'};payroll.save(update_fields=['payload'])
        with self.assertRaises(BusinessError):self.read(payroll,'payroll_calculation')
        # Unused selected rows are not silently discarded from full count.
        self.assertEqual(self.read(payroll)['sections'][-1]['total'],501)

    def test_outstanding_uses_full_children_and_not_visible_page(self):
        source=self.voucher(payload={'payments':[{'amount':'0.01','ignored':['x']*100} for _ in range(501)]})
        self.line(source)
        Voucher.objects.bulk_create([Voucher(kind='customer_return',status='posted',store=self.store,date=self.today,created_by=self.user,reference=source,total='0.02',payload={'payments':[{'amount':'0.01'}]}) for _ in range(205)])
        expected=obligation(source)
        with self.without_payload():first=self.read(source,'lines',1,10);empty=self.read(source,'cash_movements',1,30)
        self.assertEqual(Decimal(first['document']['outstanding']),expected)
        self.assertEqual(empty['document']['outstanding'],first['document']['outstanding'])
        self.assertEqual(empty['page']['items'],[]);self.assertEqual(empty['page']['pages'],1)

    def test_fresh_role_scope_masks_http_and_exact_params(self):
        v=self.voucher();self.line(v)
        Profile.objects.filter(user=self.user).update(role='cashier',store=self.store)
        value=self.read(v,'lines')
        self.assertEqual(value['context']['role'],'cashier');self.assertIsNone(value['document']['cost']);self.assertIsNone(value['page']['items'][0]['cost'])
        forbidden=self.voucher('payroll')
        with self.assertRaises(BusinessError):self.read(forbidden)
        Profile.objects.filter(user=self.user).update(role='manager',store=self.store)
        expense=self.voucher('expense',payload={'expense_scope':'network','private':['x']*501})
        with self.without_payload(),self.assertRaises(BusinessError):self.read(expense)
        for invalid in ({'section':'lines','limit':'31'}, {'section':'lines','page':'0'}, {'section':'unknown'}, QueryDict('section=lines&page=1&page=2')):
            with self.assertRaises(BusinessError):reads.read(self.user,v.pk,invalid,page=True)
        self.login(self.user)
        self.assertEqual(self.client.get(f'/api/v1/trading/documents/{v.pk}/rows?section=payroll_calculation').status_code,400)
        self.assertEqual(self.client.get(f'/api/v1/trading/documents/{v.pk}').status_code,200)
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        with self.assertRaises(BusinessError):self.read(v)

    def test_scalar_bound_falsy_history_minimum_fallback_and_http_denial(self):
        v=self.voucher('payroll',payload={'calculation':None})
        for value in (None,False,0,''):
            v.payload={'calculation':value};v.save(update_fields=['payload'])
            self.assertEqual(self.read(v,'payroll_calculation')['page']['items'],[])
        order=self.voucher('purchase_order',payload={'minimum_order_amount':'12.34'})
        OrderControl.objects.create(order=order)
        self.assertEqual(self.read(order)['document']['order']['minimumAmount'],'12.34')
        for payload in ({'fiscal_ref':'x'*100000}, {'production':{'terms':{'outputQuantity':'1'},'varianceReason':'x'*100000}}):
            bad=self.voucher('production',payload=payload)
            with self.assertRaises(BusinessError),CaptureQueriesContext(connection) as sql:self.read(bad)
            self.assertTrue(any('LENGTH(' in q['sql'] for q in sql))
        bad=self.voucher('production',payload={'production':{'components':[{'product':'p','name':'x'*100000,'unit':'шт','expectedQuantity':'1','quantity':'1','lot':''}]}})
        with self.assertRaises(BusinessError):self.read(bad,'production_components')
        huge=self.voucher(note='x'*100000)
        with self.assertRaises(BusinessError):self.read(huge)
        Profile.objects.filter(user=self.user).update(role='manager',store=self.store);self.login(self.user)
        foreign=Store.objects.create(name='Чужий');v=self.voucher();Voucher.objects.filter(pk=v.pk).update(store=foreign)
        expense=self.voucher('expense',payload={'expense_scope':'network'})
        for path in (f'/api/v1/trading/documents/{v.pk}', f'/api/v1/trading/documents/{expense.pk}', f'/api/erp/vouchers/{v.pk}',f'/api/erp/vouchers/{expense.pk}'):
            self.assertEqual(self.client.get(path).status_code,403,path)
        self.assertEqual(self.client.get(f'/api/v1/trading/documents/{order.pk}/rows?section=payroll_calculation').status_code,400)

    def test_postgres_snapshot_sees_one_current_state(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL READ ONLY RR concurrency')
        v=self.voucher();self.line(v);triggered=[];errors=[];original=reads.counts
        def counts(document,user):
            if not triggered:
                triggered.append(True)
                with connection.cursor() as cursor:
                    cursor.execute('SHOW transaction_read_only');self.assertEqual(cursor.fetchone()[0],'on')
                def writer():
                    close_old_connections()
                    try:CashEntry.objects.create(voucher_id=v.pk,account_id=self.account.pk,amount='3.25')
                    except Exception as error:errors.append(error)
                    finally:close_old_connections()
                thread=Thread(target=writer);thread.start();thread.join(10);self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
            return original(document,user)
        with patch.object(reads,'counts',side_effect=counts):first=self.read(v,'cash_movements')
        self.assertEqual(first['page']['total'],0);self.assertEqual(self.read(v,'cash_movements')['page']['total'],1)
