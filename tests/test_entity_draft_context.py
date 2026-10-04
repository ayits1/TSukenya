"""Entity reload access is read-only and independent of invalid newer input."""
import json
import time
from django.test import Client, TransactionTestCase
from django.db import connection
from django.test.utils import CaptureQueriesContext
from server.erp.models import AuditEvent, Employee, PortalSession, Profile, User
from server.erp.entity_receipts import recovery_context
from server.erp.services import BusinessError
from tests import test_entity_create_receipts as receipt_tests

class EntityDraftContextTests(TransactionTestCase):
    setUp = receipt_tests.EntityCreateReceiptTests.setUp
    save = receipt_tests.EntityCreateReceiptTests.save
    def test_scope_fresh_actor_and_readonly(self):
        row = self.save()['original']
        with CaptureQueriesContext(connection) as queries:
            result = recovery_context(self.user,'employees',{'id':row['id'],'store':str(self.store.pk)})
        self.assertEqual(result['storeId'],self.store.pk)
        self.assertTrue(result['exists'])
        self.assertFalse(any('shift_rate' in q['sql'] or 'bonus_percent' in q['sql'] for q in queries))
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        if connection.vendor=='postgresql':
            self.assertTrue(any('REPEATABLE READ' in q['sql'] and 'READ ONLY' in q['sql'] for q in queries))
        with self.assertRaises(BusinessError):recovery_context(self.user,'employees',{'store':str(self.foreign.pk)})
        Profile.objects.filter(user=self.user).update(role='cashier')
        with self.assertRaises(BusinessError):recovery_context(self.user,'employees',{'id':row['id']})
        Profile.objects.filter(user=self.user).update(role='owner')
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        with self.assertRaises(BusinessError):recovery_context(self.user,'employees',{})

    def test_all_five_resources_and_shared_parties(self):
        for resource in ('stores','warehouses','accounts','employees','parties'):
            value=recovery_context(self.user,resource,{})
            self.assertEqual(value['type'],resource)
            self.assertEqual(value['canCreate'],resource!='stores')
        for role in ('manager','accountant'):
            Profile.objects.filter(user=self.user).update(role=role)
            self.assertEqual(recovery_context(self.user,'parties',{})['role'],role)
            with self.assertRaises(BusinessError):recovery_context(self.user,'accounts',{})
        Profile.objects.filter(user=self.user).update(role='owner',store=None)
        self.assertTrue(recovery_context(self.user,'stores',{})['canCreate'])
        for params in ({'id':'0'},{'store':'no'},{'raw':'private'}):
            with self.assertRaises(BusinessError):recovery_context(self.user,'employees',params)

    def test_http_first_validation_proof_and_rollback(self):
        client=Client();PortalSession.objects.create(token_hash='a'*64,user=self.user,csrf='local-csrf',expires=int(time.time())+3600)
        client.cookies['ts_session']='a'*64
        # Real auth cookie stores a token whose SHA256 equals token_hash.
        import hashlib
        token='entity-draft-context-session';PortalSession.objects.all().update(token_hash=hashlib.sha256(token.encode()).hexdigest());client.cookies['ts_session']=token
        before=(Employee.objects.count(),AuditEvent.objects.count())
        bad={**self.body,'shift_rate':'not-a-rate'}
        response=client.post('/api/erp/entities/employees',json.dumps(bad),content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='local-csrf')
        self.assertEqual(response.status_code,400,response.content)
        self.assertEqual(response.json()['request_key'],self.key)
        self.assertTrue(response.json()['write_rejected'])
        self.assertEqual((Employee.objects.count(),AuditEvent.objects.count()),before)
        good=client.post('/api/erp/entities/employees',json.dumps(self.body),content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='local-csrf')
        self.assertEqual(good.status_code,200,good.content)
        replay=client.post('/api/erp/entities/employees',json.dumps({**self.body,'name':'changed'}),content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='local-csrf')
        self.assertEqual(replay.status_code,409,replay.content)
        self.assertNotIn('write_rejected',replay.json())

    def test_postcommit_error_never_claims_no_write(self):
        from unittest.mock import patch
        from django.db import transaction
        from django.core.exceptions import ValidationError
        from server.erp.views import entity_save
        import hashlib
        token='entity-postcommit-session'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=self.user,csrf='local-csrf',expires=int(time.time())+3600)
        client=Client();client.cookies['ts_session']=token
        def fail():raise ValidationError('Synthetic post-commit response failure')
        def saved_then_callback(user,resource,value):
            result=entity_save(user,resource,value)
            transaction.on_commit(fail)
            return result
        with patch('server.erp.views.entity_save',side_effect=saved_then_callback):
            result=client.post('/api/erp/entities/employees',json.dumps(self.body),content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='local-csrf')
        self.assertNotIn('write_rejected',result.json())
        self.assertEqual(Employee.objects.count(),1)
        self.assertEqual(AuditEvent.objects.count(),1)
