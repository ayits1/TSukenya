"""B06 current-policy recovery reads and frozen create acknowledgement; disposable data only."""
import hashlib
import json
import time
from django.db import connection
from django.test import TransactionTestCase
from server.erp.models import Profile, PortalSession, Voucher, AuditEvent, LedgerLock, Store, Document
from server.erp.services import save_voucher
from tests.test_erp import AccountingFixture

class VoucherRecoveryTests(TransactionTestCase):
    def setUp(self):
        AccountingFixture.setUp(self)
        Document.objects.create(path='settings/main', data={'defaultMarkup':30,'rounding':'.5'})
        token='isolated-voucher-recovery'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=self.u,csrf='recovery-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']=token
        self.headers={'HTTP_ORIGIN':'http://testserver','HTTP_X_CSRF_TOKEN':'recovery-csrf'}
        self.body={'kind':'purchase_order','date':self.today,'store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,'idempotency_key':'frozen-first-voucher','note':'Original','lines':[{'product':'p','quantity':'2','price':'5'}]}
    def call(self,method,path,value=None):
        return getattr(self.client,method)(path,data=json.dumps(value or {}),content_type='application/json',**self.headers)
    def test_exact_original_after_edit_confirms_identity_without_write_or_revision_adoption(self):
        first=self.call('post','/api/erp/vouchers',self.body).json()
        newer=self.call('put',f'/api/erp/vouchers/{first["id"]}',{**self.body,'revision':first['revision'],'note':'Other editor'}).json()
        count=AuditEvent.objects.count()
        exact=self.call('post','/api/erp/vouchers',self.body)
        self.assertEqual(exact.status_code,409);self.assertTrue(exact.json()['original_request_confirmed']);self.assertEqual(exact.json()['id'],first['id']);self.assertEqual(exact.json()['revision'],newer['revision'])
        changed=self.call('post','/api/erp/vouchers',{**self.body,'note':'Changed retry'})
        self.assertEqual(changed.status_code,409);self.assertFalse(changed.json()['original_request_confirmed']);self.assertEqual(AuditEvent.objects.count(),count)
    def test_recovery_policy_current_scope_closed_store_and_no_writes(self):
        row=save_voucher(self.u,self.body);path=f'/api/erp/vouchers/{row.pk}?purpose=recovery';count=AuditEvent.objects.count()
        response=self.client.get(path);self.assertEqual(response.status_code,200,response.content);self.assertTrue(response.json()['editing']['canEdit'])
        LedgerLock.objects.filter(pk=1).update(closed_through=self.today)
        self.assertFalse(self.client.get(path).json()['editing']['canEdit'])
        LedgerLock.objects.filter(pk=1).update(closed_through=None);Store.objects.filter(pk=self.store.pk).update(active=False)
        self.assertFalse(self.client.get(path).json()['editing']['canEdit'])
        foreign=Store.objects.create(name='Foreign');Profile.objects.filter(user=self.u).update(store=foreign)
        self.assertIn(self.client.get(path).status_code,[400,403]);self.assertEqual(AuditEvent.objects.count(),count)
    def test_manager_can_edit_zero_cost_production_but_not_owner_expiry_decision(self):
        Document.objects.create(path='products/output',data={'name':'Output','unit':'шт','recipe':[{'product':'p','quantity':'1'}]})
        row=save_voucher(self.u,{'kind':'production','date':self.today,'store':self.store.pk,'warehouse':self.wh.pk,'lines':[{'product':'output','quantity':'1'}]})
        Profile.objects.filter(user=self.u).update(role='manager')
        path=f'/api/erp/vouchers/{row.pk}?purpose=recovery'
        first=self.client.get(path);self.assertEqual(first.status_code,200,first.content);self.assertTrue(first.json()['editing']['canEdit'])
        row.payload['production']['expiryOverride']={'date':self.today,'reason':'Owner decision'};row.save(update_fields=['payload'])
        self.assertFalse(self.client.get(path).json()['editing']['canEdit'])
    def test_recovery_read_is_real_readonly_rr_and_does_not_mix_policy_with_concurrent_write(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL snapshot')
        from unittest.mock import patch
        import threading
        from django.db import close_old_connections
        from server.erp import views
        row=save_voucher(self.u,self.body);path=f'/api/erp/vouchers/{row.pk}?purpose=recovery';original=views.voucher_json;result=[]
        def serializer(*args,**kwargs):
            with connection.cursor() as cursor:
                cursor.execute('SHOW transaction_isolation');result.append(cursor.fetchone()[0]);cursor.execute('SHOW transaction_read_only');result.append(cursor.fetchone()[0])
            dto=original(*args,**kwargs)
            def writer():
                close_old_connections();Voucher.objects.filter(pk=row.pk).update(note='Changed concurrently',revision=2);LedgerLock.objects.filter(pk=1).update(closed_through=self.today);close_old_connections()
            worker=threading.Thread(target=writer);worker.start();worker.join(5);self.assertFalse(worker.is_alive());return dto
        with patch.object(views,'voucher_json',side_effect=serializer):response=self.client.get(path)
        self.assertEqual(response.status_code,200,response.content);self.assertEqual(result,['repeatable read','on']);self.assertEqual(response.json()['note'],'Original');self.assertIsNone(response.json()['editing']['closedThrough']);self.assertTrue(response.json()['editing']['canEdit'])
        fresh=self.client.get(path).json();self.assertEqual(fresh['note'],'Changed concurrently');self.assertFalse(fresh['editing']['canEdit'])
