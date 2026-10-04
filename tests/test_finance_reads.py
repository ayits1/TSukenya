"""Versioned actual finance read contract: old formula parity and bounded scalar headers."""
from datetime import datetime, timedelta
from decimal import Decimal
from threading import Thread
from unittest.mock import patch
from zoneinfo import ZoneInfo
from django.contrib.auth.models import User
from django.db import connection, close_old_connections
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from server.erp.models import Profile, Store, CashAccount, Counterparty, Voucher, CashEntry, PaymentAllocation
from server.erp.services import BusinessError
from server.erp.financial_browsing import ledger as legacy_ledger, current_debts
from server.erp.party_finance import legacy_advances
from server.erp import finance_reads as reads

class FinanceReadsTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create(username='finance-owner');Profile.objects.create(user=self.user,role='owner')
        self.store=Store.objects.create(name='Крамниця');self.other=Store.objects.create(name='Інший приватний магазин')
        self.account=CashAccount.objects.create(store=self.store,name='Каса',kind='cash')
        self.party=Counterparty.objects.create(name='Постачальник',kind='supplier');self.today=timezone.localdate()
    def v(self,kind='receipt',total='100.00',**kw):
        return Voucher.objects.create(kind=kind,total=Decimal(total),store=kw.pop('store',self.store),date=self.today,party=kw.pop('party',self.party),status='posted',created_by=self.user,**kw)
    def test_whole_debts_and_advances_reuse_old_money_oracles(self):
        sources=[self.v(payload={'due_date':(self.today+timedelta(days=i%5)).isoformat()}) for i in range(65)]
        pay=self.v('payment','250.98');alloc=self.v('advance_allocation','5.99',reference=pay)
        PaymentAllocation.objects.create(settlement=alloc,payment=pay,source=sources[0],amount='5.99')
        self.v('payment_refund','1.01',reference=pay)
        raw=reads.read(self.user,'debts',{'page':'3'});old,totals=current_debts(self.user,{})
        self.assertEqual(len(raw['items']),5);self.assertEqual(raw['total'],65)
        self.assertEqual([x['id'] for x in raw['items']],[x['voucher'] for x in old[60:]])
        self.assertEqual(raw['totals'],{'owedToUs':totals['owed_to_us'],'owedByUs':totals['owed_by_us']})
        advances=reads.read(self.user,'advances',{});old=legacy_advances(self.user,{})
        self.assertEqual(advances['totals'],old['totals']);self.assertEqual(advances['items'][0]['unallocated'],'243.98')
        filtered=reads.read(self.user,'debts',{'due_from':self.today.isoformat(),'due_to':self.today.isoformat()})
        _,expected=current_debts(self.user,{'due_from':self.today.isoformat(),'due_to':self.today.isoformat()});self.assertEqual(filtered['totals']['owedByUs'],expected['owed_by_us'])
    def test_scalar_ledger_parity_kyiv_reversal_page30_large_cents_no_payload(self):
        large='99999999999999.99' if connection.vendor=='postgresql' else '99999999.99'
        doc=self.v('expense',large,note='Історична примітка',payload={'private':['x']*2000})
        reversed=self.v('cash_transfer',note='Скасований переказ',reversed_at=datetime(2026,10,5,22,30,tzinfo=ZoneInfo('UTC')))
        CashEntry.objects.bulk_create([CashEntry(voucher=doc,account=self.account,amount=Decimal(large)) for _ in range(35)])
        CashEntry.objects.create(voucher=reversed,account=self.account,amount='-12.98',is_reversal=True)
        old=legacy_ledger(self.user,{})
        def forbidden(*args,**kw):raise AssertionError('Finance workspace must not construct Voucher/Allocation models')
        with patch.object(Voucher,'from_db',forbidden),patch.object(PaymentAllocation,'from_db',forbidden),CaptureQueriesContext(connection) as queries:
            new=reads.read(self.user,'ledger',{})
        self.assertEqual(new['total'],36);self.assertEqual(len(new['items']),30)
        self.assertEqual(new['items'][0]['date'],'2026-10-06');self.assertEqual(new['items'][1]['amount'],large)
        self.assertEqual([x['amount'] for x in new['items']],[x['amount'] for x in old['entries']])
        self.assertFalse(any('"payload"' in x['sql'].split(' FROM ')[0] for x in queries))
        self.assertEqual(reads.read(self.user,'ledger',{'page':'2'})['items'][0]['id'],old['entries'][-1]['id']-1)
        Voucher.objects.filter(pk=doc.pk).update(note='x'*250000)
        with CaptureQueriesContext(connection) as oversized:
            with self.assertRaisesRegex(BusinessError,'4000'):reads.read(self.user,'ledger',{})
        row_sql=next(x['sql'] for x in oversized if 'selected_note' in x['sql'])
        self.assertIn('CASE WHEN',row_sql);self.assertIn('4000',row_sql);self.assertIn('ELSE NULL',row_sql)
    def test_accounts_documents_scalar_scoped_current_actor_policy(self):
        CashAccount.objects.create(store=self.other,name='Секретна каса',kind='bank')
        for i in range(35):self.v('expense',note=str(i))
        self.v('cash_difference',store=self.other);self.v('expense',payload={'expense_scope':'network'})
        self.user.profile.role='owner';self.user.profile.store_id=None
        Profile.objects.filter(user=self.user).update(role='manager',store=self.store)
        accounts=reads.read(self.user,'accounts',{});self.assertEqual(accounts['total'],1);self.assertIsNone(accounts['items'][0]['revision']);self.assertEqual(accounts['policy']['store'],self.store.pk)
        with patch.object(Voucher,'from_db',side_effect=AssertionError('no document models')):
            documents=reads.read(self.user,'documents',{})
        self.assertEqual(documents['total'],35);self.assertEqual(len(documents['items']),30);self.assertNotIn('cash_opening',documents['policy']['createKinds'])
        Profile.objects.filter(user=self.user).update(role='cashier')
        with self.assertRaisesRegex(BusinessError,'прав'):reads.read(self.user,'accounts',{})
        Profile.objects.filter(user=self.user).update(role='owner',store=None)
        owner=reads.read(self.user,'accounts',{});self.assertRegex(owner['items'][0]['revision'],r'^[a-f0-9]{32}$')
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        with self.assertRaisesRegex(BusinessError,'доступ'):reads.read(self.user,'ledger',{})
    def test_parameters_fail_closed_and_no_mutations(self):
        for resource,params in [('ledger',{'scope':'1'}),('documents',{'kind':'sale'}),('accounts',{'q':'x'*251}),('debts',{'due_from':'2026-02-30'}),('documents',{'status':'unknown'}),('ledger',{'account':'-1'})]:
            with self.subTest(resource=resource,params=params),self.assertRaises(BusinessError):reads.read(self.user,resource,params)
        with CaptureQueriesContext(connection) as queries:reads.read(self.user,'accounts',{})
        self.assertFalse(any(x['sql'].lstrip().split()[0] in {'INSERT','UPDATE','DELETE'} for x in queries))
    def test_pg_snapshot_count_and_items_are_one_readonly_snapshot(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL snapshot')
        for _ in range(30):self.v('expense')
        failures=[];original=reads.page
        def between(query,params):
            result=original(query,params)
            def writer():
                close_old_connections()
                try:Voucher.objects.create(kind='expense',total=1,store_id=self.store.pk,date=self.today,status='posted',created_by_id=self.user.pk)
                except Exception as e:failures.append(e)
                finally:close_old_connections()
            t=Thread(target=writer);t.start();t.join(10);self.assertFalse(t.is_alive());self.assertEqual(failures,[])
            with connection.cursor() as c:
                c.execute('SHOW transaction_read_only');self.assertEqual(c.fetchone()[0],'on')
                c.execute('SHOW transaction_isolation');self.assertEqual(c.fetchone()[0],'repeatable read')
            return result
        with patch.object(reads,'page',between):raw=reads.read(self.user,'documents',{})
        self.assertEqual(raw['total'],30);self.assertEqual(len(raw['items']),30)
        self.assertEqual(reads.read(self.user,'documents',{})['total'],31)
