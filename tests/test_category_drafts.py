"""Category reload context/proven no-write boundary; isolated committed fixtures."""
import uuid
from unittest.mock import patch
from django.core.exceptions import ValidationError
from django.db import connection,transaction
from django.test.utils import CaptureQueriesContext
from server.erp.models import ExpenseCategory,AuditEvent,Profile,User
from server.erp.planning_recovery import category_context
from server.erp.monthly_budgets import save_category
from server.erp.services import BusinessError
from tests.test_unit_and_drafts import TransactionApiFixture

class CategoryDraftTests(TransactionApiFixture):
    def test_fresh_context_readonly_scope_no_private_captions(self):
        row=ExpenseCategory.objects.create(name='Synthetic private category')
        with CaptureQueriesContext(connection) as q: result=category_context(self.u,{'id':str(row.pk)})
        self.assertTrue(result['exists']);self.assertTrue(result['canEdit'])
        self.assertFalse(any(x['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for x in q))
        self.assertFalse(any('"name"' in x['sql'] or 'semantic_key' in x['sql'] for x in q))
        if connection.vendor=='postgresql':self.assertTrue(any('REPEATABLE READ' in x['sql'] and 'READ ONLY' in x['sql'] for x in q))
        for role in ['manager','accountant']:
            Profile.objects.filter(user=self.u).update(role=role,store=self.store)
            read=category_context(self.u,{'id':str(row.pk)});self.assertFalse(read['canEdit']);self.assertEqual(read['storeId'],self.store.pk)
        Profile.objects.filter(user=self.u).update(role='cashier')
        with self.assertRaises(BusinessError):category_context(self.u,{})
        Profile.objects.filter(user=self.u).update(role='owner');User.objects.filter(pk=self.u.pk).update(is_active=False)
        with self.assertRaises(BusinessError):category_context(self.u,{})

    def test_context_http_invalid_unknown_and_create_rollback_proof(self):
        self.assertEqual(self.client.get('/api/erp/budget-categories/recovery-context?unknown=1').status_code,400)
        self.assertEqual(self.client.get('/api/erp/budget-categories/recovery-context?id=invalid').status_code,400)
        before=(ExpenseCategory.objects.count(),AuditEvent.objects.count())
        body={'id':str(uuid.uuid4()),'name':'','active':True}
        result=self.call('post','/api/erp/budget-categories',body)
        self.assertEqual(result.status_code,400);self.assertTrue(result.json()['write_rejected']);self.assertEqual(result.json()['request_key'],body['id'])
        self.assertEqual((ExpenseCategory.objects.count(),AuditEvent.objects.count()),before)
        ack=self.call('post','/api/erp/budget-categories',{**body,'name':'Valid'})
        self.assertEqual(ack.status_code,201);self.assertEqual(ack.json()['request_key'],body['id'])
        Profile.objects.filter(user=self.u).update(role='manager')
        forbidden=self.call('post','/api/erp/budget-categories',body);self.assertEqual(forbidden.status_code,403);self.assertNotIn('write_rejected',forbidden.json())

    def test_failure_after_commit_and_receipt_conflict_never_get_rejection_proof(self):
        body={'id':str(uuid.uuid4()),'name':'Committed category','active':True}
        def callback():raise ValidationError('Synthetic postcommit ACK error')
        def save(user,value):
            result=save_category(user,value);transaction.on_commit(callback);return result
        with patch('server.erp.monthly_budgets.save_category',side_effect=save):result=self.call('post','/api/erp/budget-categories',body)
        self.assertEqual(result.status_code,400);self.assertNotIn('write_rejected',result.json());self.assertTrue(ExpenseCategory.objects.filter(pk=body['id']).exists())
        conflict=self.call('post','/api/erp/budget-categories',{**body,'name':'Other'})
        self.assertEqual(conflict.status_code,409);self.assertNotIn('write_rejected',conflict.json())
