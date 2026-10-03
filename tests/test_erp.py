from decimal import Decimal
from django.test import TestCase, TransactionTestCase, Client
from django.contrib.auth.models import User
from django.utils import timezone
from server.erp.models import *
from server.erp.services import *
from server.erp.reporting import report

class AccountingFixture(TestCase):
    def setUp(self):
        self.u=User.objects.create(username='owner');Profile.objects.create(user=self.u,role='owner');LedgerLock.objects.create(pk=1)
        self.store=Store.objects.create(name='Test');self.wh=Warehouse.objects.create(store=self.store,name='Stock');self.other=Warehouse.objects.create(store=self.store,name='Other')
        self.cash=CashAccount.objects.create(store=self.store,name='Cash',kind='cash');self.bank=CashAccount.objects.create(store=self.store,name='Bank',kind='bank')
        self.party=Counterparty.objects.create(name='Supplier',kind='supplier');self.customer=Counterparty.objects.create(name='Customer',kind='customer')
        self.p=Document.objects.create(path='products/p',data={'name':'Product','unit':'шт'})
        self.today=timezone.localdate().isoformat()
    def v(self,kind,qty=10,price=5,**kwargs):
        payload=kwargs.pop('payload',{})
        d={'kind':kind,'store':self.store.pk,'warehouse':self.wh.pk,'date':self.today,'lines':[{'product':'p','quantity':qty,'price':price}], 'payload':payload}
        if kind in {'receipt','purchase_order','supplier_return'}:d['party']=self.party.pk
        d.update(kwargs)
        v=save_voucher(self.u,d);return post_voucher(self.u,v.pk)
    def cash_start(self):self.v('cash_opening',amount=1000,account=self.cash.pk)
    def sale(self,qty,price=10,**kwargs):
        return self.v('sale',qty,price,party=self.customer.pk,payload={'payments':[{'account':self.bank.pk,'amount':str(money(Decimal(str(qty))*Decimal(str(price))))}]},**kwargs)

class AccountingTests(AccountingFixture):
    def test_purchase_sale_finance_and_idempotency(self):
        r=self.v('receipt',10,5)
        s=self.sale(3)
        post_voucher(self.u,s.pk)
        self.assertEqual(StockLot.objects.aggregate(n=Sum('quantity'))['n'],7)
        self.assertEqual(StockLot.objects.aggregate(n=Sum('value'))['n'],35)
        self.assertEqual(cash_balance(self.bank),30)
        self.assertEqual(obligation(r),50)
        rep=report(self.u,{})
        self.assertEqual(Decimal(rep['revenue']),30);self.assertEqual(Decimal(rep['cogs']),15);self.assertEqual(Decimal(rep['profit']),15)
    def test_shortage_rolls_back_all_lines_and_cash(self):
        self.v('receipt',1,5)
        with self.assertRaises(BusinessError):self.sale(2)
        self.assertEqual(StockLot.objects.get().quantity,1);self.assertEqual(CashEntry.objects.count(),0)
    def test_partial_receipt_and_return_quantity_limits(self):
        order=self.v('purchase_order',10,5)
        self.v('receipt',6,5,reference=order.pk)
        self.v('receipt',4,5,reference=order.pk)
        with self.assertRaises(BusinessError):self.v('receipt',1,5,reference=order.pk)
        s=self.sale(3)
        refund=self.v('customer_return',2,999,reference=s.pk,party=self.customer.pk,payload={'payments':[{'account':self.bank.pk,'amount':'20'}]})
        self.assertEqual(refund.total,20);self.assertEqual(refund.cost,10);self.assertEqual(obligation(s),0)
        with self.assertRaises(BusinessError):self.v('customer_return',2,10,reference=s.pk,party=self.customer.pk)
    def test_payment_and_supplier_paid_return(self):
        self.cash_start();r=self.v('receipt',10,5)
        payment=self.v('payment',amount=50,account=self.cash.pk,reference=r.pk)
        self.assertEqual(obligation(r),0)
        returned=self.v('supplier_return',2,5,reference=r.pk,payload={'payments':[{'account':self.cash.pk,'amount':'10'}]})
        self.assertEqual(obligation(r),0);self.assertEqual(cash_balance(self.cash),960)
        with self.assertRaises(BusinessError):reverse_voucher(self.u,r.pk,'test')
    def test_fifo_expiry_and_average_cost_rounding(self):
        tomorrow=(timezone.localdate()+__import__('datetime').timedelta(days=1)).isoformat()
        r=save_voucher(self.u,{'kind':'receipt','date':self.today,'store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,'lines':[{'product':'p','quantity':3,'price':'0.3333','lot':'a','expiry':tomorrow}]});post_voucher(self.u,r.pk)
        self.sale(1,1);self.sale(1,1);self.sale(1,1)
        self.assertEqual(StockLot.objects.get().value,0);self.assertEqual(StockLot.objects.get().quantity,0)
        self.assertEqual(Voucher.objects.filter(kind='sale').aggregate(n=Sum('cost'))['n'],Decimal('1'))
    def test_reversal_preserves_audit_and_ledger(self):
        r=self.v('receipt',10,5);s=self.sale(2)
        with self.assertRaises(BusinessError):reverse_voucher(self.u,r.pk,'wrong order')
        reverse_voucher(self.u,s.pk,'mistake');reverse_voucher(self.u,r.pk,'mistake');reverse_voucher(self.u,r.pk,'retry')
        self.assertEqual(StockLot.objects.get().quantity,0);self.assertEqual(cash_balance(self.bank),0)
        self.assertEqual(StockEntry.objects.count(),4);self.assertEqual(AuditEvent.objects.filter(action='reversed').count(),2)
    def test_transfer_inventory_and_writeoff(self):
        self.v('receipt',10,5)
        self.v('transfer',3,target=self.other.pk)
        self.assertEqual(StockLot.objects.filter(warehouse=self.wh).get().quantity,7)
        self.v('inventory',6,5)
        self.v('writeoff',1)
        self.assertEqual(StockLot.objects.filter(warehouse=self.wh).aggregate(n=Sum('quantity'))['n'],5)
        self.assertEqual(Decimal(report(self.u,{})['profit']),-10)
    def test_recipe_production_consumes_and_costs(self):
        self.v('receipt',10,5)
        out=Document.objects.create(path='products/out',data={'name':'Ready','unit':'шт','recipe':[{'product':'p','quantity':'2'}]})
        v=save_voucher(self.u,{'kind':'production','store':self.store.pk,'warehouse':self.wh.pk,'date':self.today,'lines':[{'product':'out','quantity':2}]});post_voucher(self.u,v.pk)
        self.assertEqual(StockLot.objects.get(product=out).value,20)
        self.assertEqual(StockLot.objects.get(product=self.p).quantity,6)
    def test_payroll_shift_rate_plus_revenue_percent_and_advance(self):
        self.cash_start();self.v('receipt',10,5)
        employee=Employee.objects.create(name='Worker',store=self.store,shift_rate=300,bonus_percent=5)
        shift=CashShift.objects.create(store=self.store,account=self.cash,employee=employee,opened_by=self.u,opening_cash=1000)
        self.v('sale',10,10,employee=employee.pk,shift=shift.pk,payload={'payments':[{'account':self.cash.pk,'amount':'100'}]})
        shift.closed_at=timezone.now();shift.save()
        ws=WorkShift.objects.create(employee=employee,store=self.store,date=self.today,cash_shift=shift,units=1,shift_rate=300,bonus_percent=5,bonus_basis='store')
        v=self.v('payroll',employee=employee.pk,payload={'shift_ids':[ws.pk]})
        self.assertEqual(v.total,305);self.v('payroll_payment',employee=employee.pk,account=self.cash.pk,amount=100)
        self.assertEqual(payroll_debt(employee),205)
        employee.shift_rate=500;employee.bonus_percent=10;employee.save();v.refresh_from_db();self.assertEqual(v.payload['calculation'][0]['rate'],'300.00')
        with self.assertRaises(BusinessError):self.v('payroll',employee=employee.pk,payload={'shift_ids':[ws.pk]})
    def test_closed_period_and_scope(self):
        lock=LedgerLock.objects.get(pk=1);lock.closed_through=timezone.localdate();lock.save()
        with self.assertRaises(BusinessError):self.v('receipt')
        lock.closed_through=None;lock.save();self.u.profile.role='cashier';self.u.profile.save()
        with self.assertRaises(BusinessError):self.v('receipt')
    def test_fractional_money_and_nan_rejected(self):
        for x in ['NaN','Infinity','-1','1.001']:
            with self.assertRaises(BusinessError):dec(x)
    def test_document_draft_idempotency(self):
        d={'kind':'receipt','date':self.today,'store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,'idempotency_key':'same-key','lines':[{'product':'p','quantity':1,'price':5}]}
        a=save_voucher(self.u,d);b=save_voucher(self.u,d);self.assertEqual(a.pk,b.pk);self.assertEqual(a.lines.count(),1)

class AdditionalAccountingTests(AccountingFixture):
    def test_opening_debt_and_cash_transfer(self):
        self.cash_start()
        d=self.v('debt_opening',amount=80,party=self.party.pk)
        self.v('payment',amount=30,account=self.cash.pk,reference=d.pk)
        self.assertEqual(obligation(d),50)
        self.v('cash_transfer',amount=100,account=self.cash.pk,payload={'target_account':self.bank.pk})
        self.assertEqual(cash_balance(self.cash),870);self.assertEqual(cash_balance(self.bank),100)
        self.assertEqual(Decimal(report(self.u,{})['profit']),0)
    def test_full_partial_returns_clear_rounding_pennies(self):
        self.v('receipt',3,'0.3333')
        s=self.sale(3,'0.3333')
        for refund in ['0.33','0.33','0.34']:
            self.v('customer_return',1,1,reference=s.pk,party=self.customer.pk,payload={'payments':[{'account':self.bank.pk,'amount':refund}]})
        self.assertEqual(obligation(s),0);self.assertEqual(cash_balance(self.bank),0)
        self.assertEqual(Decimal(report(self.u,{})['revenue']),0)
        self.assertEqual(Decimal(report(self.u,{})['cogs']),0)
    def test_return_does_not_extend_expiry(self):
        expiry=(timezone.localdate()+__import__('datetime').timedelta(days=1)).isoformat()
        r=save_voucher(self.u,{'kind':'receipt','date':self.today,'store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,'lines':[{'product':'p','quantity':2,'price':5,'expiry':expiry}]});post_voucher(self.u,r.pk)
        s=self.sale(1)
        self.v('customer_return',1,10,reference=s.pk,party=self.customer.pk,payload={'payments':[{'account':self.bank.pk,'amount':10}]})
        self.assertEqual(StockLot.objects.filter(code__startswith='RETURN').get().expiry.isoformat(),expiry)
    def test_alerts_are_deduplicated_and_resolve(self):
        from server.erp.alerts import sync_alerts
        self.p.data['minStock']=2;self.p.save()
        a=sync_alerts(self.u);b=sync_alerts(self.u)
        self.assertEqual(a['created'],2);self.assertEqual(b['created'],0)
        self.assertIn('Product',Document.objects.filter(path__startswith='tasks/auto_').first().data['title'])
        self.v('receipt',3,5);c=sync_alerts(self.u)
        self.assertEqual(c['resolved'],1)

class PayrollAndCashControlTests(AccountingFixture):
    def setUp(self):
        super().setUp();self.cash_start();self.v('receipt',10,5)
        self.morning=Employee.objects.create(name='Morning',store=self.store,shift_rate=300,bonus_percent=5)
        self.yesterday=(timezone.localdate()-__import__('datetime').timedelta(days=1)).isoformat()
    def till(self,employee=None,opened_by=None):
        return CashShift.objects.create(store=self.store,account=self.cash,employee=employee,opened_by=opened_by or self.u,opening_cash=cash_balance(self.cash))
    def close(self,shift):shift.closed_at=timezone.now();shift.save()
    def cash_sale(self,shift,qty=1,price=10):
        return self.v('sale',qty,price,shift=shift.pk,payload={'payments':[{'account':self.cash.pk,'amount':str(money(Decimal(qty)*Decimal(price)))}]})
    def cash_return(self,sale,shift,qty=1,price=10):
        return self.v('customer_return',qty,price,reference=sale.pk,shift=shift.pk,payload={'payments':[{'account':self.cash.pk,'amount':str(money(Decimal(qty)*Decimal(price)))}]})
    def accrue(self,employee,cash_shift=None,percent=5):
        ws=WorkShift.objects.create(employee=employee,store=self.store,date=self.today,cash_shift=cash_shift,shift_rate=300,bonus_percent=percent,bonus_basis='store')
        return self.v('payroll',employee=employee.pk,payload={'shift_ids':[ws.pk]})
    def save_work(self,employee,day,cash_shift,percent,rate='0',**extra):
        from server.erp.views import work_shift_save
        import json
        return json.loads(work_shift_save(self.u,{'employee':employee.pk,'date':day,'cash_shift':cash_shift.pk,'bonus_percent':percent,'shift_rate':rate,**extra}).content)['id']

    def test_accrued_cash_shift_does_not_freeze_the_next_shift(self):
        morning=self.till(self.morning);morning_sale=self.cash_sale(morning);self.close(morning)
        self.accrue(self.morning,morning)
        evening=self.till()
        sale=self.cash_sale(evening)
        returned=self.cash_return(sale,evening)
        reverse_voucher(self.u,returned.pk,'test');reverse_voucher(self.u,sale.pk,'test')
        # Returning goods of the accrued cash shift still changes its percent basis.
        with self.assertRaisesMessage(BusinessError,'Зарплату за цей день уже нараховано'):self.cash_return(morning_sale,evening)
    def test_linked_return_before_accrual_cannot_be_reversed(self):
        shift=self.till(self.morning)
        sale=self.v('sale',2,10,shift=shift.pk,party=self.customer.pk,payload={'payments':[{'account':self.bank.pk,'amount':'20'}]})
        returned=self.v('customer_return',1,10,reference=sale.pk,party=self.customer.pk,payload={'payments':[{'account':self.bank.pk,'amount':'10'}]})
        self.close(shift);self.assertEqual(self.accrue(self.morning,shift).total,Decimal('300.50'))
        with self.assertRaisesMessage(BusinessError,'Спочатку скасуйте нарахування зарплати'):reverse_voucher(self.u,returned.pk,'test')
        with self.assertRaisesMessage(BusinessError,'Зарплату за цей день уже нараховано'):
            self.v('customer_return',1,10,reference=sale.pk,party=self.customer.pk,payload={'payments':[{'account':self.bank.pk,'amount':'10'}]})
    def test_legacy_percent_without_cash_shift_still_locks_the_store_day(self):
        seller=Employee.objects.create(name='Seller',store=self.store,shift_rate=300)
        shift=self.till();sale=self.cash_sale(shift)
        self.accrue(seller,percent=5)
        with self.assertRaisesMessage(BusinessError,'Зарплату за цей день уже нараховано'):self.cash_sale(shift)
        with self.assertRaisesMessage(BusinessError,'Спочатку скасуйте нарахування зарплати'):reverse_voucher(self.u,sale.pk,'test')

    def test_rate_only_accrual_does_not_freeze_trading(self):
        porter=Employee.objects.create(name='Porter',store=self.store,shift_rate=300)
        shift=self.till();self.cash_sale(shift)
        self.accrue(porter,percent=0)
        later=self.cash_sale(shift)
        self.assertEqual(reverse_voucher(self.u,later.pk,'test').status,'reversed')

    def test_cash_shift_percent_counts_once_per_employee(self):
        worker=Employee.objects.create(name='A',store=self.store,shift_rate=0,bonus_percent=10)
        partner=Employee.objects.create(name='B',store=self.store,shift_rate=0,bonus_percent=10)
        shift=self.till(worker);CashShift.objects.filter(pk=shift.pk).update(opened_at=timezone.now()-__import__('datetime').timedelta(days=1));shift.refresh_from_db()
        self.cash_sale(shift,10,100);self.close(shift)
        first=self.save_work(worker,self.yesterday,shift,'10')
        with self.assertRaisesMessage(BusinessError,f'уже враховано в табелі за {self.yesterday}. Для цього дня залиште лише ставку'):
            self.save_work(worker,self.today,shift,'10')
        second=self.save_work(worker,self.today,shift,'0','300')
        self.save_work(worker,self.yesterday,shift,'10',id=first)
        other=self.save_work(partner,self.today,shift,'10')
        self.assertEqual(self.v('payroll',employee=worker.pk,payload={'shift_ids':[first,second]}).total,Decimal('400.00'))
        self.assertEqual(self.v('payroll',employee=partner.pk,payload={'shift_ids':[other]}).total,Decimal('100.00'))
    def test_payroll_rejects_existing_duplicate_percent_days(self):
        worker=Employee.objects.create(name='A',store=self.store,shift_rate=0,bonus_percent=10)
        shift=self.till(worker);self.cash_sale(shift,10,100);self.close(shift)
        days=[WorkShift.objects.create(employee=worker,store=self.store,date=d,cash_shift=shift,shift_rate=0,bonus_percent=10,bonus_basis='store') for d in [self.yesterday,self.today]]
        with self.assertRaisesMessage(BusinessError,'уже враховано в іншому дні цього працівника'):self.v('payroll',employee=worker.pk,payload={'shift_ids':[x.pk for x in days]})
        self.assertEqual(self.v('payroll',employee=worker.pk,payload={'shift_ids':[days[0].pk]}).total,Decimal('100.00'))
        with self.assertRaisesMessage(BusinessError,'уже враховано в іншому дні цього працівника'):self.v('payroll',employee=worker.pk,payload={'shift_ids':[days[1].pk]})
        WorkShift.objects.filter(pk=days[1].pk).update(bonus_percent=0,shift_rate=300)
        self.assertEqual(self.v('payroll',employee=worker.pk,payload={'shift_ids':[days[1].pk]}).total,Decimal('300.00'))

    def test_cash_refund_needs_the_cashiers_open_till(self):
        cashier=User.objects.create(username='cashier');Profile.objects.create(user=cashier,role='cashier',store=self.store)
        shift=self.till();sale=self.cash_sale(shift,2,100);self.close(shift)
        body={'kind':'customer_return','store':self.store.pk,'warehouse':self.wh.pk,'date':self.today,'reference':sale.pk,'lines':[{'product':'p','quantity':1,'price':100}],'payload':{'payments':[{'account':self.cash.pk,'amount':'100'}]}}
        with self.assertRaisesMessage(BusinessError,'Для повернення готівки виберіть відкриту касову зміну'):post_voucher(cashier,save_voucher(cashier,body).pk)
        foreign=self.till()
        with self.assertRaisesMessage(BusinessError,'Касова зміна відкрита іншим касиром.'):post_voucher(cashier,save_voucher(cashier,{**body,'shift':foreign.pk}).pk)
        self.close(foreign);own=self.till(opened_by=cashier)
        refund=post_voucher(cashier,save_voucher(cashier,{**body,'shift':own.pk}).pk)
        self.assertEqual(refund.cash_entries.get().amount,Decimal('-100.00'))
        other=Store.objects.create(name='Other');alien=CashShift.objects.create(store=other,account=CashAccount.objects.create(store=other,name='Other cash'),opened_by=self.u,opening_cash=0)
        with self.assertRaisesMessage(BusinessError,'Касова зміна належить іншому магазину.'):save_voucher(self.u,{**body,'shift':alien.pk})

    def test_receipt_extra_cost_shares_are_never_negative(self):
        for i in range(7):Document.objects.create(path=f'products/q{i}',data={'name':f'Q{i}','unit':'шт'})
        def receipt(prices,extra):
            v=save_voucher(self.u,{'kind':'receipt','store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,'date':self.today,'lines':[{'product':f'q{i}','quantity':1,'price':p} for i,p in enumerate(prices)],'payload':{'additional_cost':extra}})
            v=post_voucher(self.u,v.pk);return v,[l.cost-l.amount for l in v.lines.order_by('pk')]
        equal,shares=receipt([1]*7,'0.05')
        self.assertEqual((equal.cost,sum(shares)),(Decimal('7.05'),Decimal('0.05')));self.assertTrue(all(x>=0 for x in shares))
        zero,shares=receipt([1]*6+[0],'0.05')
        self.assertEqual((zero.cost,shares[-1]),(Decimal('6.05'),Decimal('0')))
        self.assertEqual(receipt([1,2],'0.05')[1],[Decimal('0.01'),Decimal('0.04')])
        self.assertEqual(receipt([3,1],'1')[1],[Decimal('0.75'),Decimal('0.25')])
