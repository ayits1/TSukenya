"""Monthly raw recovery context and scoped rollback proof, no accounting changes."""
import uuid
from unittest.mock import patch
from django.core.exceptions import ValidationError
from django.db import connection,transaction
from django.test.utils import CaptureQueriesContext
from server.erp.models import MonthlyBudget,AuditEvent,Profile,User,Store
from server.erp.planning_recovery import monthly_context
from server.erp.monthly_budgets import save
from server.erp.services import BusinessError
from tests.test_unit_and_drafts import TransactionApiFixture

class MonthlyDraftTests(TransactionApiFixture):
    def body(self):return {'month':'2026-10','store':None,'planned_revenue':'100.00','lines':[],'idempotency_key':str(uuid.uuid4())}
    def test_fresh_scoped_readonly_context_no_financial_columns(self):
        body=self.body();ack=save(self.u,body)
        with CaptureQueriesContext(connection) as queries:result=monthly_context(self.u,{'month':body['month'],'id':ack['id']})
        self.assertTrue(result['exists']);self.assertTrue(result['canEdit'])
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        self.assertFalse(any('planned_revenue' in q['sql'] or 'erp_budgetline' in q['sql'] for q in queries))
        if connection.vendor=='postgresql':self.assertTrue(any('REPEATABLE READ' in q['sql'] and 'READ ONLY' in q['sql'] for q in queries))
        Profile.objects.filter(user=self.u).update(store=self.store)
        self.assertEqual(monthly_context(self.u,{'month':body['month'],'store':str(self.store.pk)})['storeId'],self.store.pk)
        for params in [{'month':body['month']},{'month':body['month'],'store':str(Store.objects.create(name='Foreign').pk)},{'month':'2026-11','store':str(self.store.pk),'id':ack['id']}]:
            with self.assertRaises(BusinessError):monthly_context(self.u,params)
        Profile.objects.filter(user=self.u).update(role='manager')
        with self.assertRaises(BusinessError):monthly_context(self.u,{'month':body['month'],'store':str(self.store.pk)})
        Profile.objects.filter(user=self.u).update(role='owner');User.objects.filter(pk=self.u.pk).update(is_active=False)
        with self.assertRaises(BusinessError):monthly_context(self.u,{'month':body['month'],'store':str(self.store.pk)})

    def test_context_validation_and_bound_first_rollback_proof(self):
        for suffix in ['?month=invalid','?month=2026-10&unknown=1','?month=2026-10&id=invalid']:
            self.assertEqual(self.client.get('/api/erp/monthly-budgets/recovery-context'+suffix).status_code,400)
        before=(MonthlyBudget.objects.count(),AuditEvent.objects.count());body={**self.body(),'planned_revenue':'1.234'}
        bad=self.call('post','/api/erp/monthly-budgets',body);self.assertEqual(bad.status_code,400);self.assertEqual(bad.json()['request_key'],body['idempotency_key']);self.assertTrue(bad.json()['write_rejected']);self.assertEqual((MonthlyBudget.objects.count(),AuditEvent.objects.count()),before)
        ack=self.call('post','/api/erp/monthly-budgets',{**body,'planned_revenue':'1.23'});self.assertEqual(ack.status_code,201)
        Profile.objects.filter(user=self.u).update(role='accountant');denied=self.call('post','/api/erp/monthly-budgets',body);self.assertEqual(denied.status_code,403);self.assertNotIn('write_rejected',denied.json())

    def test_postcommit_error_and_receipt_conflict_not_no_write(self):
        body=self.body()
        def callback():raise ValidationError('Synthetic postcommit error')
        def wrapped(user,value):
            result=save(user,value);transaction.on_commit(callback);return result
        with patch('server.erp.monthly_budgets.save',side_effect=wrapped):result=self.call('post','/api/erp/monthly-budgets',body)
        self.assertEqual(result.status_code,400);self.assertNotIn('write_rejected',result.json());self.assertTrue(MonthlyBudget.objects.filter(create_key=body['idempotency_key']).exists())
        conflict=self.call('post','/api/erp/monthly-budgets',{**body,'planned_revenue':'200.00'});self.assertEqual(conflict.status_code,409);self.assertNotIn('write_rejected',conflict.json())
