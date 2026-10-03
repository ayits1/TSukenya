import uuid
from datetime import timedelta
from decimal import Decimal
from django.test import TransactionTestCase
from django.db import close_old_connections, connection, connections
from threading import Barrier, Thread
from server.erp.models import *
from server.erp.services import *
from server.erp.reporting import voucher_json
from server.erp.reconcile import reconcile
from .test_erp import AccountingFixture


class MultilotTests(AccountingFixture):
    def save(self, kind='receipt', lines=None, **extra):
        return save_voucher(self.u, {'kind': kind, 'date': self.today, 'store': self.store.pk, 'warehouse': self.wh.pk, 'party': self.party.pk, 'lines': lines or self.rows(), **extra})

    def rows(self):
        return [{'product': 'p', 'quantity': '3', 'price': '1.1111', 'lot': 'LATE', 'expiry': (timezone.localdate()+timedelta(days=20)).isoformat()}, {'product': 'p', 'quantity': '2', 'price': '2', 'lot': 'EARLY', 'expiry': (timezone.localdate()+timedelta(days=10)).isoformat()}]

    def test_two_lots_one_debt_exact_extra_fefo_and_reverse(self):
        r = self.save(payload={'additional_cost': '.03'})
        post_voucher(self.u, r.pk)
        r.refresh_from_db()
        self.assertEqual(r.total, Decimal('7.36'))
        self.assertEqual(obligation(r), r.total)
        self.assertEqual(list(r.lines.values_list('cost', flat=True)), [Decimal('3.34'), Decimal('4.02')])
        self.assertEqual(sum(r.stock_entries.values_list('value', flat=True)), r.total)
        self.assertEqual(set(r.stock_entries.values_list('line_id', flat=True)), set(r.lines.values_list('id', flat=True)))
        s = self.sale(3, 10)
        entries = list(s.stock_entries.order_by('pk'))
        self.assertEqual([e.lot.code for e in entries], ['EARLY', 'LATE'])
        self.assertEqual([e.quantity for e in entries], [Decimal('-2'), Decimal('-1')])
        self.assertEqual(s.cost, Decimal('5.13'))
        self.assertEqual(reconcile()['issues'], 0)
        reverse_voucher(self.u, s.pk, 'QA')
        reverse_voucher(self.u, r.pk, 'QA')
        self.assertEqual(StockLot.objects.aggregate(q=Sum('quantity'), v=Sum('value')), {'q': 0, 'v': 0})
        self.assertEqual(reconcile()['issues'], 0)

    def test_exact_second_source_return_and_ambiguity_guard(self):
        r = self.save();post_voucher(self.u, r.pk)
        late, early = list(r.lines.all())
        with self.assertRaisesMessage(BusinessError, 'кілька партій'):
            self.save('supplier_return', [{'product':'p', 'quantity':1, 'price':999}], reference=r.pk)
        returned = self.save('supplier_return', [{'product':'p','quantity':1,'price':999,'reference_line':early.pk}], reference=r.pk)
        post_voucher(self.u, returned.pk)
        returned.refresh_from_db()
        self.assertEqual(returned.total, 2)
        self.assertEqual(returned.stock_entries.get().lot.code, 'EARLY')
        self.assertEqual(returned.lines.get().expiry, early.expiry)
        self.assertEqual(StockLot.objects.get(code='LATE').quantity, 3)
        self.assertEqual(voucher_json(r, True, user=self.u)['lines'][1]['remaining'], '1.000')
        with self.assertRaisesMessage(BusinessError, 'партії вихідного рядка'):
            self.save('supplier_return', [{'product':'p','quantity':1,'price':999,'reference_line':early.pk,'lot':'LATE'}], reference=r.pk)
        # Consumed EARLY cannot fall through to LATE even though enough total product stock remains.
        self.sale(1, 10)
        blocked=self.save('supplier_return', [{'product':'p','quantity':1,'price':2,'reference_line':early.pk}],reference=r.pk)
        before=StockEntry.objects.count()
        with self.assertRaisesMessage(BusinessError, 'недостатньо'):
            post_voucher(self.u,blocked.pk)
        self.assertEqual(StockEntry.objects.count(),before)
        self.assertEqual(StockLot.objects.get(code='LATE').quantity,3)

    def test_shared_physical_code_mixed_cost_return_uses_original_price_current_value(self):
        r1=self.save(lines=[{'product':'p','quantity':4,'price':2,'lot':'SHARED'}]);post_voucher(self.u,r1.pk)
        r2=self.save(lines=[{'product':'p','quantity':4,'price':4,'lot':'SHARED'}]);post_voucher(self.u,r2.pk)
        self.sale(2,10)
        original=r1.lines.get()
        ret=self.save('supplier_return',[{'product':'p','quantity':2,'price':999,'reference_line':original.pk}],reference=r1.pk)
        post_voucher(self.u,ret.pk);ret.refresh_from_db()
        self.assertEqual(ret.total,4)
        self.assertEqual(ret.cost,6)
        self.assertEqual(StockLot.objects.get(code='SHARED').quantity,4)
        self.assertEqual(StockLot.objects.get(code='SHARED').value,12)
        self.assertEqual(obligation(r1),4)
        self.assertEqual(obligation(r2),16)
        self.assertEqual(reconcile()['issues'],0)

    def test_split_order_quantity_guard_aggregates_current_rows_and_posted_receipts(self):
        order=self.v('purchase_order',4,1)
        origin=order.lines.get()
        rows=self.rows()
        for row in rows: row['reference_line']=origin.pk
        bad=self.save(lines=rows,reference=order.pk)
        with self.assertRaisesMessage(BusinessError,'перевищено кількість'):
            post_voucher(self.u,bad.pk)
        self.assertEqual(StockEntry.objects.count(),0)
        rows[0]['quantity']='2'
        r=self.save(lines=rows,reference=order.pk);post_voucher(self.u,r.pk)
        self.assertEqual(voucher_json(order,True,user=self.u)['lines'][0]['remaining'],'0.000')
        other=self.save(lines=[{'product':'p','quantity':'.001','price':1,'lot':'EXTRA'}],reference=order.pk)
        with self.assertRaises(BusinessError): post_voucher(self.u,other.pk)

    def test_draft_keys_pk_and_source_links_survive_update_retry_and_remove(self):
        rows=self.rows()
        for row in rows: row['line_key']=str(uuid.uuid4())
        r=self.save(lines=rows,idempotency_key='stable-b11')
        ids=list(r.lines.values_list('id',flat=True))
        retry=self.save(lines=rows,idempotency_key='stable-b11')
        self.assertEqual(retry.pk,r.pk)
        body={'kind':'receipt','date':self.today,'store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,'lines':list(reversed(rows)), 'revision':r.revision}
        r=save_voucher(self.u,body,r.pk)
        self.assertEqual(list(r.lines.values_list('id',flat=True)),ids)
        body['lines']=rows[1:];body['revision']=r.revision
        r=save_voucher(self.u,body,r.pk)
        self.assertEqual(r.lines.get().pk,ids[1])
        # Legacy update of an unambiguous SKU also retains line identity.
        old_key=r.lines.get().line_key
        body['lines']=[{k:v for k,v in rows[1].items() if k!='line_key'}];body['revision']=r.revision
        r=save_voucher(self.u,body,r.pk)
        self.assertEqual(r.lines.get().line_key,old_key)
        self.assertEqual(r.lines.get().pk,ids[1])

    def test_invalid_keys_references_lot_duplicates_and_roles_are_atomic(self):
        first=self.save(lines=[self.rows()[0]])
        key=str(first.lines.get().line_key)
        for rows, message in [([dict(self.rows()[0],line_key=key)],'іншому документу'),([dict(self.rows()[0],line_key='bad')],'ідентифікатор'),([self.rows()[0],self.rows()[0]],'різні партії'),([dict(self.rows()[0],lot='a'*81)],'80 символів'),([dict(self.rows()[0],reference_line=999)],'потребує')]:
            before=Voucher.objects.count()
            with self.assertRaisesMessage(BusinessError,message): self.save(lines=rows)
            self.assertEqual(Voucher.objects.count(),before)
        other=self.v('receipt',1,5)
        post_voucher(self.u,first.pk)
        with self.assertRaisesMessage(BusinessError,'відсутній'):
            self.save('supplier_return',[{'product':'p','quantity':1,'price':1,'reference_line':other.lines.get().pk}],reference=first.pk)
        for invalid in (0, False, True, -1, 1.0, '²', '9' * 30, 9223372036854775808, [], {}):
            before = Voucher.objects.count()
            with self.subTest(reference_line=invalid), self.assertRaisesMessage(BusinessError, 'Некоректний рядок'):
                self.save('supplier_return', [{'product':'p','quantity':1,'price':1,'reference_line':invalid}], reference=first.pk)
            self.assertEqual(Voucher.objects.count(), before)
        with self.assertRaisesMessage(BusinessError, 'термін придатності'):
            self.save(lines=[dict(self.rows()[0], expiry=[])])
        cashier=User.objects.create(username='cashier');Profile.objects.create(user=cashier,role='cashier',store=self.store)
        with self.assertRaisesMessage(BusinessError,'роль'):
            save_voucher(cashier,{'kind':'receipt','store':self.store.pk})

    def test_legacy_null_source_movement_and_auto_lot_are_unambiguous(self):
        r=self.v('receipt',3,5)
        r.stock_entries.update(line=None)
        row=voucher_json(r,True,user=self.u)['lines'][0]
        self.assertTrue(row['lot'].startswith('D'))
        returned=self.save('supplier_return',[{'product':'p','quantity':1,'price':0}],reference=r.pk)
        post_voucher(self.u,returned.pk)
        self.assertEqual(returned.stock_entries.get().lot.code,row['lot'])

    def test_current_production_and_reversal_keep_output_line_and_null_component(self):
        self.v('receipt',10,2)
        output=Document.objects.create(path='products/output',data={'name':'Output','unit':'шт','recipe':[{'product':'p','quantity':'2'}]})
        produced=self.save('production',[{'product':'output','quantity':2,'price':0}],party=None)
        post_voucher(self.u,produced.pk)
        line=produced.lines.get()
        self.assertEqual(produced.stock_entries.get(quantity__gt=0,is_reversal=False).line_id,line.pk)
        self.assertIsNone(produced.stock_entries.get(quantity__lt=0,is_reversal=False).line_id)
        reverse_voucher(self.u,produced.pk,'lineage QA')
        self.assertEqual(produced.stock_entries.get(quantity__lt=0,is_reversal=True).line_id,line.pk)
        self.assertIsNone(produced.stock_entries.get(quantity__gt=0,is_reversal=True).line_id)
        self.assertEqual(reconcile()['issues'],0)


class MultilotConcurrencyTests(TransactionTestCase):
    setUp = AccountingFixture.setUp
    v = AccountingFixture.v
    def test_competing_receipts_cannot_overfulfil_single_order_row(self):
        if connection.vendor!='postgresql': self.skipTest('PostgreSQL ledger locking')
        order=self.v('purchase_order',3,1)
        def draft(code):
            return save_voucher(self.u,{'kind':'receipt','store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,'date':self.today,'reference':order.pk,'lines':[{'product':'p','quantity':1,'price':1,'lot':code+'A'},{'product':'p','quantity':1,'price':1,'lot':code+'B'}]})
        docs=[draft('ONE'),draft('TWO')];barrier=Barrier(2);results=[]
        def worker(pk):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                post_voucher(User.objects.get(pk=self.u.pk),pk)
                results.append('posted')
            except BusinessError: results.append('blocked')
            finally: connections.close_all()
        threads=[Thread(target=worker,args=(v.pk,)) for v in docs]
        for t in threads:t.start()
        for t in threads:t.join(timeout=15)
        self.assertFalse(any(t.is_alive() for t in threads))
        self.assertCountEqual(results,['posted','blocked'])
        self.assertEqual(StockLot.objects.aggregate(q=Sum('quantity'))['q'],2)
        self.assertEqual(StockEntry.objects.count(),2)

    def test_competing_returns_cannot_overreturn_origin_with_shared_physical_stock(self):
        if connection.vendor!='postgresql': self.skipTest('PostgreSQL ledger locking')
        source=self.v('receipt',2,2,lines=[{'product':'p','quantity':2,'price':2,'lot':'SHARED'}])
        self.v('receipt',4,4,lines=[{'product':'p','quantity':4,'price':4,'lot':'SHARED'}])
        line=source.lines.get()
        def draft():
            return save_voucher(self.u,{'kind':'supplier_return','store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,'date':self.today,'reference':source.pk,'lines':[{'product':'p','quantity':'1.5','price':999,'reference_line':line.pk}]})
        docs=[draft(),draft()];barrier=Barrier(2);results=[]
        def worker(pk):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                post_voucher(User.objects.get(pk=self.u.pk),pk)
                results.append('posted')
            except BusinessError: results.append('blocked')
            finally: connections.close_all()
        threads=[Thread(target=worker,args=(v.pk,)) for v in docs]
        for thread in threads:thread.start()
        for thread in threads:thread.join(timeout=15)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertCountEqual(results,['posted','blocked'])
        self.assertEqual(StockLot.objects.get(code='SHARED').quantity,Decimal('4.5'))
        self.assertEqual(obligation(source),1)

class MultilotMigrationTests(TransactionTestCase):
    def test_backfill_preserves_line_references_and_leaves_production_components_unknown(self):
        from django.db.migrations.executor import MigrationExecutor
        executor=MigrationExecutor(connection)
        executor.migrate([('erp','0006_legacy_create_receipt')])
        try:
            apps=executor.loader.project_state([('erp','0006_legacy_create_receipt')]).apps
            user=apps.get_model('auth','User').objects.create(username='migration-owner')
            StoreOld=apps.get_model('erp','Store');store=StoreOld.objects.create(name='Migration')
            wh=apps.get_model('erp','Warehouse').objects.create(store=store,name='Stock')
            doc=apps.get_model('erp','Document');p=doc.objects.create(path='products/old',data={});ingredient=doc.objects.create(path='products/component',data={})
            vouchers=apps.get_model('erp','Voucher')
            r=vouchers.objects.create(kind='receipt',status='posted',date=timezone.localdate(),store=store,warehouse=wh,created_by=user,idempotency_key='migration-receipt')
            returned=vouchers.objects.create(kind='supplier_return',status='posted',date=timezone.localdate(),store=store,warehouse=wh,created_by=user,reference=r,idempotency_key='migration-return')
            Line=apps.get_model('erp','VoucherLine')
            line=Line.objects.create(voucher=r,product=p,name='Old',unit='шт',quantity=2,price=5,amount=10)
            ret=Line.objects.create(voucher=returned,product=p,name='Old',unit='шт',quantity=1,price=5,amount=5,reference_line=line)
            prod=vouchers.objects.create(kind='production',status='posted',date=timezone.localdate(),store=store,warehouse=wh,created_by=user,idempotency_key='migration-prod')
            output=Line.objects.create(voucher=prod,product=p,name='Old',unit='шт',quantity=1,price=0,amount=0)
            Lot=apps.get_model('erp','StockLot');lot=Lot.objects.create(warehouse=wh,product=p,code='old');component=Lot.objects.create(warehouse=wh,product=ingredient,code='component')
            Entry=apps.get_model('erp','StockEntry')
            source=Entry.objects.create(voucher=r,lot=lot,quantity=2,value=10)
            reversal=Entry.objects.create(voucher=r,lot=lot,quantity=-2,value=-10,is_reversal=True)
            produced=Entry.objects.create(voucher=prod,lot=lot,quantity=1,value=1)
            output_reversal=Entry.objects.create(voucher=prod,lot=lot,quantity=-1,value=-1,is_reversal=True)
            consumed=Entry.objects.create(voucher=prod,lot=component,quantity=-1,value=-1)
            component_reversal=Entry.objects.create(voucher=prod,lot=component,quantity=1,value=1,is_reversal=True)
            # Self-SKU component is also kept unknown; never invent a link to output just by SKU.
            self_consumed=Entry.objects.create(voucher=prod,lot=lot,quantity=-1,value=-1)
            self_component_reversal=Entry.objects.create(voucher=prod,lot=lot,quantity=1,value=1,is_reversal=True)
            executor=MigrationExecutor(connection);executor.migrate([('erp','0007_multilot_lines')])
            self.assertEqual(VoucherLine.objects.get(pk=ret.pk).reference_line_id,line.pk)
            self.assertEqual(StockEntry.objects.get(pk=source.pk).line_id,line.pk)
            self.assertEqual(StockEntry.objects.get(pk=reversal.pk).line_id,line.pk)
            self.assertEqual(StockEntry.objects.get(pk=produced.pk).line_id,output.pk)
            self.assertEqual(StockEntry.objects.get(pk=output_reversal.pk).line_id,output.pk)
            self.assertIsNone(StockEntry.objects.get(pk=consumed.pk).line_id)
            self.assertIsNone(StockEntry.objects.get(pk=self_consumed.pk).line_id)
            self.assertIsNone(StockEntry.objects.get(pk=component_reversal.pk).line_id)
            self.assertIsNone(StockEntry.objects.get(pk=self_component_reversal.pk).line_id)
            self.assertEqual(len(set(VoucherLine.objects.values_list('line_key',flat=True))),3)
        finally:
            MigrationExecutor(connection).migrate([('erp','0007_multilot_lines')])
