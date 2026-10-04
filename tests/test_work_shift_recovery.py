"""Timesheet raw context / immutable CREATE binding, no salary recomputation."""
import uuid
import json
from unittest.mock import patch
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.core.exceptions import ValidationError
from django.db import transaction
from server.erp.models import AuditEvent, Employee, LedgerLock, Profile, Store, User, WorkShift, WorkShiftCreateReceipt
from server.erp.services import BusinessError, record_revision
from server.erp.work_shift_recovery import recovery_context, current, identity
from server.erp.views import work_shift_save
from tests.test_unit_and_drafts import TransactionApiFixture


class WorkShiftRecoveryTests(TransactionApiFixture):
    def setUp(self):
        super().setUp()
        self.store2=Store.objects.create(name='Foreign store')
        self.employee = Employee.objects.create(name='Табельний працівник',store=self.store,shift_rate=100,bonus_percent=0)
        self.body = {'employee':str(self.employee.pk),'date':self.today,'cash_shift':'','units':'1','shift_rate':'100','bonus_percent':'0','bonus_basis':'store','note':'Первісна примітка','idempotency_key':str(uuid.uuid4())}

    def test_fresh_actor_scope_readonly_and_closed_payroll_viewing(self):
        row = json.loads(work_shift_save(self.u,self.body).content)['id']
        LedgerLock.objects.filter(pk=1).update(closed_through=self.today)
        with CaptureQueriesContext(connection) as queries:
            result = recovery_context(self.u,{'id':str(row),'store':str(self.store.pk),'employee':str(self.employee.pk)})
        self.assertFalse(result['canEdit'])
        self.assertFalse(any('shift_rate' in q['sql'] or 'bonus_percent' in q['sql'] for q in queries))
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        if connection.vendor=='postgresql':self.assertTrue(any('REPEATABLE READ' in q['sql'] and 'READ ONLY' in q['sql'] for q in queries))
        self.assertEqual(current(self.u,{'id':str(row)})['items'][0]['shift_rate'],100)
        for fields in ({'role':'cashier'},{'role':'manager'},{'role':'owner','store_id':self.store2.pk}):
            Profile.objects.filter(user=self.u).update(**fields)
            with self.assertRaises(BusinessError):current(self.u,{'id':str(row)})
        Profile.objects.filter(user=self.u).update(role='accountant',store=self.store)
        self.assertEqual(recovery_context(self.u,{'employee':str(self.employee.pk)})['store'],self.store.pk)
        User.objects.filter(pk=self.u.pk).update(is_active=False)
        with self.assertRaises(BusinessError):identity(self.u,{'request':self.body})

    def test_identity_after_mutable_edit_has_no_revision_or_extra_audit(self):
        initial=json.loads(work_shift_save(self.u,self.body).content);row=WorkShift.objects.get(pk=initial['id'])
        self.assertEqual(initial['request_key'],self.body['idempotency_key']);self.assertEqual(initial['request'],self.body)
        work_shift_save(self.u,{**{k:v for k,v in self.body.items() if k!='idempotency_key'},'id':row.pk,'revision':record_revision(row),'shift_rate':'150'})
        before=(WorkShift.objects.count(),AuditEvent.objects.count(),WorkShiftCreateReceipt.objects.count())
        with CaptureQueriesContext(connection) as queries:
            found=identity(self.u,{'request':self.body})
        self.assertTrue(found['confirmed']);self.assertEqual(found['id'],row.pk);self.assertEqual(found['request']['shift_rate'],'100');self.assertNotIn('revision',found)
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries))
        self.assertEqual(json.loads(work_shift_save(self.u,self.body).content),initial)
        self.assertEqual((WorkShift.objects.count(),AuditEvent.objects.count(),WorkShiftCreateReceipt.objects.count()),before)
        self.assertEqual(self.call('post','/api/v1/trading/work-shifts/identity',{'request':{**self.body,'shift_rate':'200'}}).status_code,409)
        stranger=User.objects.create(username='other-owner',password='unused');Profile.objects.create(user=stranger,role='owner')
        from server.erp.services import Conflict
        with self.assertRaises(Conflict):identity(stranger,{'request':self.body})
        self.assertFalse(identity(self.u,{'request':{**self.body,'idempotency_key':str(uuid.uuid4())}})['confirmed'])

    def test_validation_proof_is_rollback_bound_and_postcommit_not_rejected(self):
        bad=self.call('post','/api/erp/work-shifts',{**self.body,'date':'1900-01-01','units':'100'})
        self.assertEqual(bad.status_code,400,bad.content);self.assertTrue(bad.json()['write_rejected']);self.assertEqual(bad.json()['request_key'],self.body['idempotency_key'])
        self.assertEqual((WorkShift.objects.count(),AuditEvent.objects.count()),(0,0))
        def callback():raise ValidationError('Synthetic postcommit response')
        def save(user,value):
            result=work_shift_save(user,value);transaction.on_commit(callback);return result
        with patch('server.erp.views.work_shift_save',side_effect=save):
            result=self.call('post','/api/erp/work-shifts',self.body)
        self.assertEqual(result.status_code,400);self.assertNotIn('write_rejected',result.json());self.assertEqual(WorkShift.objects.count(),1)
        Profile.objects.filter(user=self.u).update(role='cashier')
        forbidden=self.call('post','/api/erp/work-shifts',self.body)
        self.assertEqual(forbidden.status_code,403);self.assertNotIn('write_rejected',forbidden.json())
