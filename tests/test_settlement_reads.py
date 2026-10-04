"""Actual READ adapters: unchanged pure oracles, fanout bounds, fresh actor and RR."""
import json
import weakref
import os
from pathlib import Path
from contextlib import ExitStack
from datetime import timedelta, datetime
from decimal import Decimal
from threading import Thread
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.contrib.auth.models import User
from django.db import connection, close_old_connections
from django.db.models import JSONField
from django.test import TransactionTestCase
from django.utils import timezone

from server.erp.models import Store, Profile, Counterparty, Voucher, PaymentAllocation
from server.erp.services import obligation, BusinessError
from server.erp.browsing import legacy_references
from server.erp.financial_browsing import current_debts, legacy_debt_summary
from server.erp.party_finance import legacy_advances, statement_data
from server.erp import settlement_reads as reads


class SettlementReadTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create(username='isolated-owner');Profile.objects.create(user=self.user,role='owner')
        self.store=Store.objects.create(name='Own');self.foreign=Store.objects.create(name='Other')
        self.supplier=Counterparty.objects.create(name='Supplier',kind='supplier')
        self.customer=Counterparty.objects.create(name='Customer',kind='customer')
        self.today=timezone.localdate()

    def v(self,kind,total='100',**kw):
        return Voucher.objects.create(kind=kind,total=Decimal(total),status='posted',date=self.today,
            store=kw.pop('store',self.store),party=kw.pop('party',self.supplier),created_by=self.user,**kw)

    def test_manager_legacy_expense_scope_matches_permission_and_page_totals(self):
        from server.erp.services import expense_permission
        old=[self.v('expense',payload={}) for _ in range(35)]
        store=self.v('expense',payload={'expense_scope':'store'})
        null=self.v('expense',payload={'expense_scope':None})
        network=self.v('expense',payload={'expense_scope':'network'})
        foreign=self.v('expense',store=self.foreign,payload={})
        Profile.objects.filter(user=self.user).update(role='manager',store=self.store)
        manager=User.objects.select_related('profile').get(pk=self.user.pk)
        for row in (old[0],store,null):expense_permission(manager,row)
        with self.assertRaises(BusinessError):expense_permission(manager,network)
        first=reads.vouchers(self.user,{'kind':'expense'})
        second=reads.vouchers(self.user,{'kind':'expense','page':'2'})
        self.assertEqual((first['total'],first['pages'],len(first['items'])),(37,2,30))
        ids={row['id'] for row in first['items']+second['items']}
        self.assertEqual(ids,{row.pk for row in old+[store,null]})
        self.assertNotIn(network.pk,ids);self.assertNotIn(foreign.pk,ids)
        Profile.objects.filter(user=self.user).update(role='accountant',store=None)
        allowed=reads.vouchers(self.user,{'kind':'expense'})
        self.assertEqual(allowed['total'],39)
        self.assertIn(network.pk,{row['id'] for row in allowed['items']})

    def test_payment_refs_debts_advances_and_summary_equal_unchanged_oracles(self):
        sources=[self.v('receipt',payload={'due_date':(self.today+timedelta(days=i%14)).isoformat()}) for i in range(65)]
        customer=self.v('sale','200',party=self.customer,payload={'payments':[{'amount':'2.05'}]})
        returned=self.v('customer_return','10',party=self.customer,reference=customer,payload={'payments':[{'amount':'1.01'}]})
        self.v('payment','10.00',reference=sources[0])
        pay=self.v('payment','300.00')
        allocation=self.v('advance_allocation','5.00',reference=pay)
        PaymentAllocation.objects.create(settlement=allocation,payment=pay,source=sources[1],amount=Decimal('5'))
        self.v('payment_refund','1.50',reference=pay)
        query={'purpose':'payment','page':'99'}
        self.assertEqual(reads.references(self.user,query),legacy_references(self.user,query))
        expected,totals=current_debts(self.user,{})
        actual=reads.debts(self.user,{'page':'3'})
        self.assertEqual(actual['items'],expected[60:90]);self.assertEqual(actual['debt_totals'],totals)
        self.assertEqual(reads.advances(self.user,{}),legacy_advances(self.user,{}))
        summary=reads.summary(self.user);original=legacy_debt_summary(self.user)
        self.assertEqual(summary['payments'],original['payments'][:5]);self.assertEqual(summary['payments_count'],len(original['payments']))
        for key in ('overdue','payments_total','today','days'):self.assertEqual(summary[key],original[key])

    def test_statement_scalar_formula_running_saldo_reversal_and_cutoff(self):
        previous=self.today.replace(day=1)-timedelta(days=2)
        source=self.v('receipt','100',payload={'due_date':(previous-timedelta(days=1)).isoformat()})
        Voucher.objects.filter(pk=source.pk).update(date=previous)
        pay=self.v('payment','40')
        allocation=self.v('advance_allocation','15',reference=pay)
        PaymentAllocation.objects.create(settlement=allocation,payment=pay,source=source,amount=Decimal('15'))
        returned=self.v('supplier_return','10',reference=source,payload={'payments':[{'amount':'2.50'}]})
        Voucher.objects.filter(pk=returned.pk).update(status='reversed',reversed_at=datetime.combine(self.today,datetime.min.time(),tzinfo=ZoneInfo('Europe/Kyiv')))
        for _ in range(35):self.v('advance_allocation','0')
        query={'party':str(self.supplier.pk),'from':self.today.replace(day=1).isoformat(),'to':self.today.isoformat(),'page':'2'}
        original=statement_data(self.user,query);actual=reads.statement(self.user,query)
        for key in ('party','party_name','direction','from','to','basis','opening_balance','closing_balance','debit','credit','debt_total','advance_total','age','reconciliation','total','page','pages'):
            self.assertEqual(actual[key],original[key],key)
        self.assertEqual(actual['items'],[{k:v for k,v in row.items() if k!='allocations'} for row in original['items']])
        self.assertFalse({'debts','advances','allocations'}&set(actual))

    def test_fanout501_uses_no_whole_payload_or_allocation_models_and_page30(self):
        source=self.v('sale','2000',party=self.customer,payload={'payments':[{'amount':'0.01'}]*501})
        payments=[self.v('payment','0.01',party=self.customer,reference=source) for _ in range(501)]
        PaymentAllocation.objects.bulk_create([PaymentAllocation(settlement=v,payment=v,source=source,amount=Decimal('.01')) for v in payments])
        expected=obligation(source)
        original=Voucher.from_db
        metrics={'headers':0,'live_headers':0,'cursor_rows':0,'json_rows':0}; live=weakref.WeakSet()
        def header(cls,*args):
            self.assertNotIn('payload',args[1]);metrics['headers']+=1;item=original(*args);live.add(item);
            metrics['live_headers']=max(metrics['live_headers'],len(live))
            return item
        decoder=JSONField.from_db_value
        def json_value(field,*args):
            value=decoder(field,*args)
            if isinstance(value,dict):self.assertNotIn('payments',value)
            return value
        cursor_factory=connection.chunked_cursor
        class CursorProbe:
            def __init__(self,cursor):self.cursor=cursor;self.json=False
            def __getattr__(self,name):return getattr(self.cursor,name)
            def __enter__(self):self.cursor.__enter__();return self
            def __exit__(self,*args):return self.cursor.__exit__(*args)
            def execute(self,sql,*args):self.json='jsonb_array_elements' in sql or 'json_each' in sql;return self.cursor.execute(sql,*args)
            def fetchmany(self,*args):
                rows=self.cursor.fetchmany(*args);metrics['cursor_rows']=max(metrics['cursor_rows'],len(rows))
                if self.json:metrics['json_rows']+=len(rows)
                return rows
        with ExitStack() as stack:
            stack.enter_context(patch.object(connection,'chunked_cursor',side_effect=lambda:CursorProbe(cursor_factory())))
            stack.enter_context(patch.object(Voucher,'from_db',classmethod(header)))
            stack.enter_context(patch.object(PaymentAllocation,'from_db',side_effect=AssertionError('Allocation model materialized')))
            stack.enter_context(patch.object(JSONField,'from_db_value',json_value))
            stack.enter_context(patch('server.erp.settlements.context',side_effect=AssertionError('unbounded context')))
            stack.enter_context(patch('server.erp.settlements.prefetched_sources',side_effect=AssertionError('child prefetch')))
            data=reads.references(self.user,{'purpose':'payment'})
            self.assertEqual(Decimal(data['items'][0]['outstanding']),expected)
            result=reads.statement(self.user,{'party':str(self.customer.pk)})
            self.assertEqual(len(result['items']),30);self.assertEqual(result['total'],502)
            self.assertEqual(Decimal(result['debt_total']),expected)
            self.assertEqual(reads.vouchers(self.user,{'kind':'sale'})['items'][0]['outstanding'],str(expected))
            # Exercise a parent traversal larger than CHUNK as well as 501 children.
            self.assertEqual(reads.advances(self.user,{})['items'],[])
        self.assertLessEqual(metrics['live_headers'],402)
        self.assertLessEqual(metrics['cursor_rows'],200);self.assertGreaterEqual(metrics['json_rows'],501)
        if directory:=os.environ.get('SETTLEMENT_READ_PROOF_DIR'):
            target=Path(directory);target.mkdir(parents=True,exist_ok=True)
            (target/(connection.vendor+'-fanout.json')).write_text(json.dumps(metrics,indent=2))

    def test_fresh_cached_actor_store_and_deactivation_no_read_writes(self):
        own=self.v('receipt');other=self.v('receipt',store=self.foreign)
        self.user.profile.role;Profile.objects.filter(user=self.user).update(role='manager',store=self.store)
        before=(Voucher.objects.count(),PaymentAllocation.objects.count())
        self.assertEqual([x['voucher'] for x in reads.debts(self.user,{})['items']],[own.pk])
        self.assertEqual(reads.statement(self.user,{'party':str(self.supplier.pk),'store':str(self.foreign.pk)})['items'],[])
        Profile.objects.filter(user=self.user).update(role='cashier')
        for reader,query in ((reads.debts,{}),(reads.advances,{}),(reads.statement,{'party':str(self.supplier.pk)})):
            with self.assertRaises(BusinessError):reader(self.user,query)
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        with self.assertRaises(BusinessError):reads.references(self.user,{'purpose':'payment'})
        self.assertEqual(before,(Voucher.objects.count(),PaymentAllocation.objects.count()))

    def test_rr_concurrent_payment_cannot_mix_count_page_and_totals(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL RR interleaving')
        source=self.v('receipt');errors=[]
        original=reads.selected_page
        def writer():
            close_old_connections()
            try:self.v('payment','25',reference=source)
            except BaseException as error:errors.append(error)
            finally:close_old_connections()
        def interleaved(*args,**kw):
            thread=Thread(target=writer);thread.start();thread.join(10);self.assertFalse(thread.is_alive());self.assertFalse(errors)
            return original(*args,**kw)
        with patch.object(reads,'selected_page',interleaved):result=reads.debts(self.user,{})
        self.assertEqual(result['items'][0]['amount'],'100.00');self.assertEqual(result['debt_totals']['owed_by_us'],'100.00')
        self.assertEqual(reads.debts(self.user,{})['items'][0]['amount'],'75.00')

    def test_http_statement_projection_and_old_endpoint_retired(self):
        import hashlib,time
        from server.erp.models import PortalSession
        PortalSession.objects.create(user=self.user,token_hash=hashlib.sha256(b'isolated-settlement').hexdigest(),csrf='isolated',expires=int(time.time())+600)
        self.client.cookies['ts_session']='isolated-settlement';self.v('receipt')
        result=self.client.get('/api/v1/trading/settlements/statement',{'party':self.supplier.pk})
        self.assertEqual(result.status_code,200,result.content);self.assertEqual(result.json()['contract'],'trading-settlement-statement-v1')
        self.assertEqual(self.client.get('/api/erp/party-statement').status_code,410)

    def test_false_deadline_scalars_and_empty_containers_preserve_oracle(self):
        for due in ('',None,False,0,[],{}):self.v('receipt',payload={'due_date':due})
        expected,_=current_debts(self.user,{})
        self.assertEqual(reads.debts(self.user,{})['items'],expected)
        actual=reads.statement(self.user,{'party':str(self.supplier.pk)})
        old=statement_data(self.user,{'party':str(self.supplier.pk)})
        self.assertEqual(actual['age'],old['age'])
        self.v('receipt',payload={'due_date':['invalid']})
        with self.assertRaises(BusinessError):reads.debts(self.user,{})

    def test_malformed_historical_child_refuses_same_as_oracle(self):
        # A historical embedded refund may have more than two digits; do not change the oracle.
        receipt=self.v('receipt','0.01',payload={'due_date':self.today.isoformat()})
        self.v('supplier_return','0.01',reference=receipt,payload={'payments':[{'amount':'0.001'}]})
        with self.assertRaises(BusinessError):legacy_debt_summary(self.user)
        with self.assertRaises(BusinessError):reads.summary(self.user)
        invalid=self.v('receipt',payload=[])
        with self.assertRaises(BusinessError):reads.debts(self.user,{'q':str(invalid.pk)})

    def test_negative_historical_debt_is_not_clamped_or_hidden(self):
        source=self.v('sale','10',party=self.customer)
        self.v('payment','20',party=self.customer,reference=source)
        expected,totals=current_debts(self.user,{})
        actual=reads.debts(self.user,{})
        self.assertEqual(actual['items'],expected);self.assertEqual(actual['debt_totals'],totals)
        self.assertEqual(actual['items'][0]['amount'],'-10.00')
        self.assertEqual(reads.references(self.user,{'purpose':'payment'})['items'],[])
        self.assertEqual(reads.statement(self.user,{'party':str(self.customer.pk)})['reconciliation'],statement_data(self.user,{'party':str(self.customer.pk)})['reconciliation'])

    def test_spool_cleanup_on_invalid_child_and_strict_inherited_snapshot(self):
        from django.db import transaction
        import tempfile
        self.v('sale','10',party=self.customer,payload={'payments':[{'amount':{'nested':['large']*501}}]})
        paths=[];original=tempfile.TemporaryDirectory
        def directory(*args,**kwargs):
            result=original(*args,**kwargs);paths.append(result.name);return result
        with patch('server.erp.bounded_reports.tempfile.TemporaryDirectory',side_effect=directory),self.assertRaises(BusinessError):reads.debts(self.user,{})
        self.assertTrue(paths);self.assertTrue(all(not Path(p).exists() for p in paths))
        if connection.vendor=='postgresql':
            with transaction.atomic(),self.assertRaisesMessage(BusinessError,'REPEATABLE READ та READ ONLY'):reads.debts(self.user,{})
