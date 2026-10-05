"""Standalone action receipts: accounting services unchanged, exact acknowledgements survive DELETE."""
import re
import uuid
import threading
from unittest.mock import patch
from django.db import connection, connections, transaction
from django.test.utils import CaptureQueriesContext
from server.erp.models import (Voucher, VoucherActionReceipt, AuditEvent, StockEntry, StockLot, CashEntry, User, Profile, LedgerLock, Store)
from server.erp.services import save_voucher, BusinessError, cash_balance
from server.erp.voucher_actions import execute, identity, context
from tests.test_unit_and_drafts import TransactionApiFixture


class VoucherActionTests(TransactionApiFixture):
    def draft(self, kind='receipt', **extra):
        value={'kind':kind,'date':self.today,'store':self.store.pk,'warehouse':self.wh.pk,
            'party':self.party.pk,'lines':[{'product':'p','quantity':'10','price':'5'}]}
        value.update(extra)
        return save_voucher(self.u,value)
    def terms(self,v,action='post',**extra):
        return {'key':str(uuid.uuid4()),'id':v.pk,'kind':v.kind,'store':v.store_id,
            'expenseScope':v.payload.get('expense_scope','store') if v.kind=='expense' else 'store',
            'action':action,'revision':v.revision,'reason':'Original reason' if action=='reverse' else '',**extra}
    def path(self,suffix):return '/api/v1/trading/voucher-actions/'+suffix

    def test_exact_post_reverse_money_stock_and_replay_before_mutable_state(self):
        v=self.draft();terms=self.terms(v)
        ack,status=execute(self.u,terms);self.assertEqual(status,200);self.assertEqual(ack['request'],terms)
        self.assertEqual(ack['outcome'],'posted');self.assertEqual(StockLot.objects.get().quantity,10)
        self.assertEqual(StockLot.objects.get().value,50);self.assertEqual(StockEntry.objects.count(),1)
        reversal=self.terms(v,'reverse');r,status=execute(self.u,reversal);self.assertEqual(status,200)
        self.assertEqual(StockLot.objects.get().quantity,0);self.assertEqual(StockLot.objects.get().value,0)
        counts=(AuditEvent.objects.count(),StockEntry.objects.count(),VoucherActionReceipt.objects.count())
        LedgerLock.objects.filter(pk=1).update(closed_through=self.today)
        self.assertEqual(execute(self.u,terms),(ack,200));self.assertEqual(execute(self.u,reversal),(r,200))
        self.assertEqual((AuditEvent.objects.count(),StockEntry.objects.count(),VoucherActionReceipt.objects.count()),counts)
        LedgerLock.objects.filter(pk=1).update(closed_through=None)
        v2=self.draft('cash_opening',account=self.cash.pk,amount='100.02',lines=[])
        execute(self.u,self.terms(v2));self.assertEqual(str(cash_balance(self.cash)),'100.02')
        execute(self.u,self.terms(v2,'reverse'));self.assertEqual(cash_balance(self.cash),0)
        self.assertEqual(CashEntry.objects.filter(voucher=v2).count(),2)

    def test_delete_tombstone_creator_exact_terms_and_readonly_identity(self):
        v=self.draft();terms=self.terms(v,'delete');ack,status=execute(self.u,terms)
        self.assertFalse(Voucher.objects.filter(pk=v.pk).exists());self.assertEqual(status,200)
        self.assertEqual(execute(self.u,terms),(ack,200));self.assertEqual(VoucherActionReceipt.objects.get().outcome,'deleted')
        with CaptureQueriesContext(connection) as queries:
            result=identity(self.u,{'request':terms})
        self.assertTrue(result['confirmed']);self.assertEqual(result['request'],terms)
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        if connection.vendor=='postgresql':self.assertTrue(any('REPEATABLE READ' in q['sql'] and 'READ ONLY' in q['sql'] for q in queries))
        self.assertFalse(context(self.u,{k:str(terms[k]) for k in ('id','kind','store','expenseScope','action')})['exists'])
        changed={**terms,'revision':2};self.assertEqual(self.call('post',self.path('identity'),{'request':changed}).status_code,409)
        stranger=User.objects.create(username='other');Profile.objects.create(user=stranger,role='owner')
        with self.assertRaises(BusinessError):identity(stranger,{'request':terms})
        self.assertFalse(identity(self.u,{'request':{**terms,'key':str(uuid.uuid4())}})['confirmed'])
        self.assertEqual(AuditEvent.objects.filter(action='draft_deleted').count(),1)

    def test_fresh_actor_scope_network_expense_and_replay_privacy(self):
        expense=self.draft('expense',amount='1',account=self.cash.pk,payload={'expense_scope':'network'},lines=[])
        terms=self.terms(expense,'delete');execute(self.u,terms)
        Profile.objects.filter(user=self.u).update(role='manager')
        for suffix,value in [('execute',terms),('identity',{'request':terms})]:
            r=self.call('post',self.path(suffix),value);self.assertEqual(r.status_code,403,r.content);self.assertNotIn('write_rejected',r.json())
        Profile.objects.filter(user=self.u).update(role='accountant');self.assertTrue(identity(self.u,{'request':terms})['confirmed'])
        other=Store.objects.create(name='Other scoped');Profile.objects.filter(user=self.u).update(store=other)
        with self.assertRaises(BusinessError):identity(self.u,{'request':terms})
        Profile.objects.filter(user=self.u).update(store=None,role='owner');User.objects.filter(pk=self.u.pk).update(is_active=False)
        with self.assertRaises(BusinessError):execute(self.u,terms)

    def test_first_rollback_bound_proof_revision_conflict_and_postcommit_no_proof(self):
        v=self.draft();terms=self.terms(v,'reverse',reason='')
        # Wrong status is a definite first revision rejection, never absence of an older key.
        r=self.call('post',self.path('execute'),terms);self.assertEqual(r.status_code,409);self.assertTrue(r.json()['write_rejected'])
        terms=self.terms(v);bad={**terms,'revision':2};r=self.call('post',self.path('execute'),bad)
        self.assertEqual(r.status_code,409);self.assertEqual(r.json()['request'],bad);self.assertEqual(VoucherActionReceipt.objects.count(),0)
        execute(self.u,terms);reverse=self.terms(v,'reverse',reason='')
        r=self.call('post',self.path('execute'),reverse);self.assertEqual(r.status_code,400);self.assertTrue(r.json()['write_rejected'])
        from server.erp.services import post_voucher
        v2=self.draft();term2=self.terms(v2)
        def fail_after_commit(user,pk,**kwargs):
            result=post_voucher(user,pk,**kwargs)
            def fail():raise BusinessError('Synthetic postcommit failure')
            transaction.on_commit(fail);return result
        with patch('server.erp.voucher_actions.post_voucher',side_effect=fail_after_commit):
            response=self.call('post',self.path('execute'),term2)
        self.assertEqual(response.status_code,400);self.assertNotIn('write_rejected',response.json())
        self.assertTrue(identity(self.u,{'request':term2})['confirmed'])
        for value in ({**terms,'id':False},{**terms,'revision':[]},{**terms,'reason':{}},{**terms,'action':[]}):
            r=self.call('post',self.path('execute'),value);self.assertEqual(r.status_code,400);self.assertNotIn('write_rejected',r.json())

    def test_postgres_same_uuid_parallel_receipt_one_movement_and_audit(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL real ledger lock')
        v=self.draft();terms=self.terms(v);barrier=threading.Barrier(2);results=[];failures=[]
        def worker():
            try:
                user=User.objects.get(pk=self.u.pk);barrier.wait(timeout=10);results.append(execute(user,terms))
            except BaseException as exc:failures.append(exc)
            finally:connections.close_all()
        threads=[threading.Thread(target=worker) for _ in range(2)]
        for t in threads:t.start()
        for t in threads:t.join(timeout=20)
        self.assertFalse(any(t.is_alive() for t in threads));self.assertEqual(failures,[]);self.assertEqual(len(results),2)
        self.assertEqual(results[0],results[1]);self.assertEqual(StockEntry.objects.filter(voucher=v).count(),1)
        self.assertEqual(AuditEvent.objects.filter(action='posted',subject=f'voucher/{v.pk}').count(),1)
        self.assertEqual(VoucherActionReceipt.objects.count(),1)

    def test_http_scalar_context_rejects_duplicate_and_wrong_identity_before_projection(self):
        from urllib.parse import urlencode
        v=self.draft();terms=self.terms(v)
        q={k:str(terms[k]) for k in ('id','kind','store','expenseScope','action')}
        for bad in (urlencode(q)+'&id='+str(v.pk),urlencode({**q,'kind':'unknown'}),urlencode({**q,'expenseScope':'network'})):
            with CaptureQueriesContext(connection) as queries:
                result=self.client.get(self.path('context')+'?'+bad)
            self.assertEqual(result.status_code,400,result.content)
            self.assertFalse(any('FROM "erp_voucher"' in query['sql'] for query in queries))
        with CaptureQueriesContext(connection) as queries:
            result=self.client.get(self.path('context')+'?'+urlencode(q))
        self.assertEqual(result.status_code,200,result.content);self.assertTrue(result.json()['canExecute'])
        voucher_sql=[query['sql'] for query in queries if 'FROM "erp_voucher"' in query['sql']]
        self.assertEqual(len(voucher_sql),1)
        if connection.vendor=='postgresql':self.assertIn('->',voucher_sql[0])
        # JSON_EXTRACT/JSON_TYPE payload arguments are scalar reads, not raw
        # payload projections. Reject SELECT of the whole column on both DBs.
        raw_payload=r'(?:SELECT\s+(?:DISTINCT\s+)?|,\s*)"erp_voucher"\."payload"\s*(?:,|FROM\b|AS\b)'
        self.assertIsNone(re.search(raw_payload,voucher_sql[0],re.I))
        LedgerLock.objects.filter(pk=1).update(closed_through=self.today)
        self.assertFalse(self.client.get(self.path('context')+'?'+urlencode(q)).json()['canExecute'])
        # Existing DELETE permits draft removal in a closed period; retain that policy.
        self.assertTrue(self.client.get(self.path('context')+'?'+urlencode({**q,'action':'delete'})).json()['canExecute'])
