"""Historical child fanout bounds are proved by live decoded/model objects, not write API limits."""
import csv
import io
import json
import os
import weakref
from pathlib import Path
from contextlib import ExitStack, contextmanager
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch
from django.db import connection
from django.db.models import JSONField
from django.test import TransactionTestCase
from django.utils import timezone
from server.erp import bounded_reports as reports, report_children as children
from server.erp.models import Voucher, VoucherLine, PaymentAllocation, WorkShift, CashShift, Employee, StockLot, StockEntry
from server.erp.services import obligation, BusinessError
from server.erp.settlements import context, advance_balances
from tests.test_erp import AccountingFixture


class ReportChildrenTests(TransactionTestCase):
    def setUp(self): AccountingFixture.setUp(self)

    def voucher(self,kind,**kwargs):
        return Voucher.objects.create(kind=kind,status='posted',date=kwargs.pop('date',timezone.localdate()),store=self.store,created_by=self.u,posted_at=kwargs.pop('posted_at',timezone.now()),**kwargs)

    @contextmanager
    def materialization(self):
        metrics={name:0 for name in ('lines','workers','payload_children','fetched_rows','json_rows')}; live={name:weakref.WeakSet() for name in ('lines','workers')}
        with ExitStack() as stack:
            for model,name in ((VoucherLine,'lines'),(WorkShift,'workers')):
                original=model.from_db
                def observe(cls,*args,_original=original,_name=name):
                    item=_original(*args);live[_name].add(item);metrics[_name]=max(metrics[_name],len(live[_name]));return item
                stack.enter_context(patch.object(model,'from_db',classmethod(observe)))
            original=JSONField.from_db_value
            def json_value(field,value,expression,conn):
                result=original(field,value,expression,conn)
                if isinstance(result,dict):
                    for key in ('differences','payments','recipe'):
                        if isinstance(result.get(key),list):
                            metrics['payload_children']=max(metrics['payload_children'],len(result[key]))
                return result
            stack.enter_context(patch.object(JSONField,'from_db_value',json_value))
            original_refresh=Voucher.refresh_from_db
            def refresh(voucher,*args,**kwargs):
                if 'payload' in (kwargs.get('fields') or []): raise AssertionError('deferred whole payload was fetched')
                return original_refresh(voucher,*args,**kwargs)
            stack.enter_context(patch.object(Voucher,'refresh_from_db',refresh))
            cursor_factory=connection.chunked_cursor
            class CursorProbe:
                def __init__(self,cursor):self.cursor=cursor;self.json=False
                def __getattr__(self,name):return getattr(self.cursor,name)
                def __enter__(self):self.cursor.__enter__();return self
                def __exit__(self,*args):return self.cursor.__exit__(*args)
                def execute(self,sql,*args):self.json='jsonb_array_elements' in sql or 'json_each' in sql;return self.cursor.execute(sql,*args)
                def fetchmany(self,*args):
                    rows=self.cursor.fetchmany(*args);metrics['fetched_rows']=max(metrics['fetched_rows'],len(rows))
                    if self.json:metrics['json_rows']+=len(rows)
                    return rows
            stack.enter_context(patch.object(connection,'chunked_cursor',side_effect=lambda:CursorProbe(cursor_factory())))
            yield metrics
            if directory:=os.environ.get('REPORT_CHILDREN_PROOF_DIR'):
                target=Path(directory);target.mkdir(parents=True,exist_ok=True)
                with (target/(connection.vendor+'.jsonl')).open('a') as file:
                    file.write(json.dumps({'test':self._testMethodName,**metrics})+'\n')

    def test_stock_caption_projection_ignores_recipe_and_preserves_missing_null(self):
        from server.erp.historical_reports import balances
        receipt=self.voucher('receipt',party=self.party,total=10)
        lot=StockLot.objects.create(product=self.p,warehouse=self.wh,code='Large recipe',quantity=2,value=10)
        StockEntry.objects.create(voucher=receipt,lot=lot,quantity=2,value=10)
        for caption in ({'name':'=Товар','unit':'кг'},{'name':None,'unit':None},{}):
            self.p.data={**caption,'recipe':[{'product':'p','quantity':'1'}]*501};self.p.save(update_fields=['data'])
            old=balances(self.u,{'as_of':self.today})
            with self.materialization() as materialized:
                result=reports.rows(self.u,{'mode':'balances','section':'stock','as_of':self.today})
                text=b''.join(reports.export_csv(self.u,{'mode':'balances','section':'stock'}).streaming_content).decode('utf-8-sig')
            self.assertEqual([{k:v for k,v in row.items() if k!='warehouse_name'} for row in result['items']],old['stock']);self.assertEqual(materialized['payload_children'],0)
            self.assertEqual(result['summary']['stock_value'],old['stock_value'])
            if caption.get('name'):self.assertIn('\t=Товар',text)
        self.p.data={'name':{'nested':[1]*501},'unit':'шт'};self.p.save(update_fields=['data'])
        with self.materialization() as materialized,self.assertRaises(BusinessError):reports.rows(self.u,{'mode':'balances','section':'stock'})
        self.assertEqual(materialized['payload_children'],0)

    def test_cutoff_reversals_mapped_suppression_and_negative_balances_match_oracle(self):
        from datetime import datetime,time
        from server.erp.historical_reports import KYIV
        cutoff=timezone.localdate()-timedelta(days=1)
        after=datetime.combine(cutoff+timedelta(days=1),time.min,tzinfo=KYIV)
        sale=self.voucher('sale',party=self.customer,total=3,date=cutoff,payload={'payments':[{'amount':'1.00','product':{'unused':[1]*501}}]})
        payment=self.voucher('payment',party=self.customer,reference=sale,total=9,date=cutoff)
        allocation=PaymentAllocation.objects.create(settlement=payment,payment=payment,source=sale,amount=9)
        advance=self.voucher('payment',party=self.customer,total=1,date=cutoff)
        self.voucher('payment_refund',reference=advance,total=2,date=cutoff)
        # On the boundary itself the original remains active through cutoff; one microsecond before does not.
        for instant in (after,after-timedelta(microseconds=1)):
            Voucher.objects.filter(pk=payment.pk).update(status='reversed',reversed_at=instant);payment.refresh_from_db()
            related,allocated=context([sale],cutoff)
            expected=obligation(sale,settlements=related[sale.pk],allocations=allocated[sale.pk])
            self.assertEqual(children.obligations([sale],cutoff)[sale.pk],expected)
            self.assertEqual(children.advances([payment,advance],cutoff),advance_balances([payment,advance],cutoff))
        self.assertEqual(children.advances([advance],cutoff)[advance.pk],Decimal('-1.00'))
        # An inactive mapped allocation still suppresses direct-reference fallback for advance balances.
        other=self.voucher('advance_allocation',reference=payment,date=cutoff,total=9)
        allocation.settlement=other;allocation.save(update_fields=['settlement'])
        Voucher.objects.filter(pk=payment.pk).update(status='posted',reversed_at=None);payment.refresh_from_db()
        Voucher.objects.filter(pk=other.pk).update(status='reversed',reversed_at=after-timedelta(microseconds=1))
        self.assertEqual(children.advances([payment],cutoff),advance_balances([payment],cutoff))
        related,allocated=context([sale],cutoff)
        expected=obligation(sale,settlements=related[sale.pk],allocations=allocated[sale.pk])
        self.assertEqual(children.obligations([sale],cutoff)[sale.pk],expected);self.assertLess(expected,0)

    def test_one_historical_voucher_501_lines_streams_exact_product_csv(self):
        from server.erp.historical_reports import period_documents
        sold=self.voucher('sale',total=Decimal('1002'),cost=Decimal('5.01'),payload={'payments':[{'amount':'0'}]*501,'unused':[1]*501})
        VoucherLine.objects.bulk_create([VoucherLine(voucher=sold,product=self.p,name='=Товар',unit='шт',quantity=1,price=2,amount=2,cost=Decimal('.01')) for _ in range(501)])
        with self.materialization() as old_materialized:
            old_materialized['legacy_prefetch']=True
            for parent in period_documents({self.store.pk},timezone.localdate(),timezone.localdate(),include_lines=True).iterator(chunk_size=children.CHUNK):
                self.assertEqual(len(parent.lines.all()),501)
        self.assertEqual(old_materialized['lines'],501)
        del parent  # Release the legacy oracle's cached children before measuring the new report.
        with self.materialization() as materialized:
            data=reports.rows(self.u,{'mode':'period','section':'products'});text=b''.join(reports.export_csv(self.u,{'mode':'period','section':'products'}).streaming_content).decode('utf-8-sig')
        self.assertEqual(data['summary']['revenue'],'1002.00');self.assertEqual(data['items'][0]['quantity'],'501.000');self.assertEqual(data['items'][0]['cogs'],'5.01')
        self.assertIn('\t=Товар',text);self.assertEqual(len(list(csv.reader(io.StringIO(text),delimiter=';'))),3)
        self.assertLessEqual(materialized['lines'],children.CHUNK+2);self.assertEqual(materialized['payload_children'],0);self.assertLessEqual(materialized['fetched_rows'],children.CHUNK)

    def test_inventory_json_501_differences_and_duplicate_line_multiplicity(self):
        from server.erp.historical_reports import period
        inventory=self.voucher('inventory',payload={'differences':[{'product':'products/p','value':'0.01'}]*501})
        VoucherLine.objects.bulk_create([VoucherLine(voucher=inventory,product=self.p,name='Product',unit='шт',quantity=0,price=0,amount=0,cost=0) for _ in range(2)])
        old=period(self.u,{'from':self.today,'to':self.today})
        with self.materialization() as materialized: data=reports.rows(self.u,{'mode':'period','from':self.today,'to':self.today,'section':'products'})
        self.assertEqual(data['summary']['inventory_adjustment'],old['inventory_adjustment']);self.assertEqual(data['items'],old['products'])
        self.assertEqual(data['summary']['inventory_adjustment'],'5.01');self.assertEqual(data['items'][0]['inventory'],'10.02');self.assertEqual(materialized['json_rows'],501);self.assertEqual(materialized['payload_children'],0);self.assertLessEqual(materialized['fetched_rows'],children.CHUNK)

    def test_one_source_many_returns_allocations_embedded_refunds_matches_old_oracle(self):
        sale=self.voucher('sale',party=self.customer,total=10000,payload={'payments':[{'amount':'0.01'}]*501})
        returned=[]
        for _ in range(205): returned.append(self.voucher('customer_return',reference=sale,total=1,payload={'payments':[{'amount':'0.01'}]*3}))
        legacy=self.voucher('payment',reference=sale,party=self.customer,total=2)
        mapped=self.voucher('payment',reference=sale,party=self.customer,total=3)
        PaymentAllocation.objects.create(settlement=mapped,payment=mapped,source=sale,amount=3)
        advance=self.voucher('payment',party=self.customer,total=1000)
        for _ in range(205):
            settlement=self.voucher('advance_allocation',reference=advance,total=1)
            PaymentAllocation.objects.create(settlement=settlement,payment=advance,source=sale,amount=1)
        for _ in range(205):self.voucher('payment_refund',reference=advance,total=1)
        related,allocated=context([sale],timezone.localdate());old=obligation(sale,settlements=related[sale.pk],allocations=allocated[sale.pk]);old_advance=advance_balances([advance],timezone.localdate())[advance.pk]
        with self.materialization() as materialized:
            result=children.obligations([sale],timezone.localdate());result_advance=children.advances([advance],timezone.localdate())
            page=reports.rows(self.u,{'mode':'balances','section':'debts'})
        self.assertEqual(result[sale.pk],old);self.assertEqual(result_advance[advance.pk],old_advance);self.assertEqual(old_advance,Decimal('590.00'))
        self.assertEqual(page['items'][0]['amount'],str(old));self.assertGreaterEqual(materialized['json_rows'],501+205*3);self.assertEqual(materialized['payload_children'],0);self.assertLessEqual(materialized['fetched_rows'],children.CHUNK)

    def test_json_scalar_precision_and_malformed_children_refuse_without_full_decode(self):
        from server.erp.historical_reports import period
        values=[1.0050000000000001,True,'1.005',9223372036854775808]
        inventory=self.voucher('inventory',payload={'differences':[{'product':'p','value':v} for v in values]})
        VoucherLine.objects.create(voucher=inventory,product=self.p,name='Product',unit='шт',quantity=0,price=0,amount=0,cost=0)
        self.voucher('cash_difference',payload={'difference':1.0050000000000001})
        old=period(self.u,{'from':self.today,'to':self.today})
        data=reports.summary(self.u,{'mode':'period','from':self.today,'to':self.today})
        self.assertEqual(data['inventory_adjustment'],old['inventory_adjustment']);self.assertEqual(data['cash_difference'],old['cash_difference'])
        for malformed in [None,{},[{'product':'p','value':{'large':[1]*501}}],[{'product':'p'}],['not an object']]:
            Voucher.objects.filter(pk=inventory.pk).update(payload={'differences':malformed})
            with self.materialization() as materialized, self.assertRaises(BusinessError): reports.summary(self.u,{'mode':'period'})
            self.assertEqual(materialized['payload_children'],0)
        with self.assertRaises(ValueError):list(children.json_children(Voucher.objects.all(),'unapproved; DROP TABLE'))

    def test_one_shift_205_workers_over_200_returns_keeps_bonus_chronology_and_privacy(self):
        from server.erp.reporting import cashier_differences
        from datetime import timedelta
        now=timezone.now();yesterday=timezone.localdate()-timedelta(days=1)
        till_employee=Employee.objects.create(store=self.store,name='Cashier')
        shift=CashShift.objects.create(store=self.store,account=self.cash,employee=till_employee,opened_by=self.u,opening_cash=0,closed_at=now,expected_cash=0,counted_cash=0)
        CashShift.objects.filter(pk=shift.pk).update(opened_at=now-timedelta(hours=2))
        sold=self.voucher('sale',shift=shift,employee=till_employee,total=100)
        for i in range(205):
            employee=Employee.objects.create(store=self.store,name=f'Worker{i}')
            payroll=self.voucher('payroll',date=yesterday,employee=employee,total=1,posted_at=now-timedelta(days=1))
            WorkShift.objects.create(employee=employee,date=yesterday,store=self.store,units=1,shift_rate=0,bonus_percent=Decimal('.333'),bonus_basis='store',basis_amount=Decimal('1.00'),cash_shift=shift,payroll=payroll)
        self.voucher('customer_return',date=yesterday,reference=sold,total=Decimal('.11'))
        for i in range(201):self.voucher('customer_return',reference=sold,total=Decimal('.01'))
        old=cashier_differences(self.u,timezone.localdate(),timezone.localdate())
        with self.materialization() as materialized:page=reports.rows(self.u,{'mode':'period','from':self.today,'to':self.today,'section':'cashiers'})
        self.assertEqual(page['items'],old);self.assertLessEqual(materialized['workers'],children.CHUNK+2);self.assertGreater(materialized['workers'],0)
        from django.contrib.auth.models import User
        from server.erp.models import Profile
        manager=User.objects.create(username='scoped-manager');Profile.objects.create(user=manager,role='manager',store=self.store)
        with self.materialization() as materialized:manager_page=reports.rows(manager,{'mode':'period','section':'cashiers'})
        self.assertEqual(materialized['workers'],0);self.assertTrue(all('late_return_bonus' not in row for row in manager_page['items']))

    def test_zero_period_cancellation_skips_malformed_inventory_children(self):
        from server.erp.historical_reports import period
        invalid=self.voucher('inventory',payload={'differences':{'unneeded':[1]*501}})
        Voucher.objects.filter(pk=invalid.pk).update(status='reversed',reversed_at=timezone.now())
        valid=self.voucher('inventory',payload={'differences':[{'product':'products/p','value':'1.02'}]})
        VoucherLine.objects.create(voucher=valid,product=self.p,name='Product',unit='шт',quantity=0,price=0,amount=0,cost=0)
        old=period(self.u,{'from':self.today,'to':self.today})
        with self.materialization() as materialized:
            result=reports.rows(self.u,{'mode':'period','from':self.today,'to':self.today,'section':'products'})
        self.assertEqual(result['summary']['inventory_adjustment'],old['inventory_adjustment'])
        self.assertEqual(result['summary']['inventory_adjustment'],'1.02')
        self.assertEqual(result['items'],old['products'])
        self.assertEqual(materialized['payload_children'],0)
        self.assertEqual(materialized['json_rows'],1)

    def test_legacy_reference_and_cross_source_allocation_preserve_distinct_suppression(self):
        first=self.voucher('sale',party=self.customer,total=10)
        second=self.voucher('sale',party=self.customer,total=10)
        payment=self.voucher('payment',party=self.customer,reference=first,total=5)
        # Historical direct-reference payment plus allocation to another source:
        # obligation mapping is per source, advance suppression is any mapping.
        PaymentAllocation.objects.create(settlement=payment,payment=payment,source=second,amount=2)
        related,allocated=context([first,second],timezone.localdate())
        old={source.pk:obligation(source,settlements=related[source.pk],allocations=allocated[source.pk]) for source in (first,second)}
        self.assertEqual(children.obligations([first,second],timezone.localdate()),old)
        self.assertEqual(old,{first.pk:Decimal('5.00'),second.pk:Decimal('8.00')})
        self.assertEqual(children.advances([payment],timezone.localdate()),advance_balances([payment],timezone.localdate()))
        self.assertEqual(children.advances([payment],timezone.localdate())[payment.pk],Decimal('3.00'))
        Voucher.objects.filter(pk=second.pk).update(status='reversed',reversed_at=timezone.now())
        self.assertEqual(children.advances([payment],timezone.localdate()),advance_balances([payment],timezone.localdate()))
        self.assertEqual(children.advances([payment],timezone.localdate())[payment.pk],Decimal('5.00'))
