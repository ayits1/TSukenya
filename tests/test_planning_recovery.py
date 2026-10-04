import hashlib, json, time, uuid
from django.contrib.auth.models import User
from django.db import connection
from django.test import TransactionTestCase
from tests.test_erp import AccountingFixture
from server.erp.models import AuditEvent, BudgetLine, ExpenseCategory, ExpenseCategoryAlias, MonthlyBudget, PlanningCreateReceipt, PortalSession, Profile, Store
from server.erp.services import BusinessError, Conflict
from server.erp.monthly_budgets import save_category, save
from server.erp.planning_recovery import identity, current


class PlanningRecoveryTests(TransactionTestCase):
    def setUp(self):
        AccountingFixture.setUp(self)
        self.category = ExpenseCategory.objects.create(name='Synthetic category')
        self.other = User.objects.create(username='other-planning-owner'); Profile.objects.create(user=self.other, role='owner')
    def category_body(self): return {'id': str(uuid.uuid4()), 'name': ' Нова стаття ', 'active': True}
    def budget_body(self, **extra): return {'idempotency_key': str(uuid.uuid4()), 'month': '2026-01', 'store': self.store.pk, 'planned_revenue': '100', 'lines': [{'id': str(uuid.uuid4()), 'category': str(self.category.pk), 'mode': 'fixed_amount', 'amount': '10', 'rate': '0'}], **extra}
    def test_category_author_semantic_retry_changed_identity_and_tombstone(self):
        body = self.category_body(); first = save_category(self.u, body)
        normalized = {**body, 'name': body['name'].strip()}
        self.assertEqual(save_category(self.u, normalized), first)
        self.assertEqual(AuditEvent.objects.filter(action='budget_category_saved').count(), 1)
        with self.assertRaises(Conflict): save_category(self.other, body)
        for changed in ({**body, 'name': 'Інша'}, {**body, 'active': False}):
            with self.assertRaises(Conflict): identity(self.u, 'category', {'request': changed})
        save_category(self.u, {'name': 'Серверна назва', 'active': False, 'revision': 1}, first['id'])
        with self.assertRaises(Conflict) as error: save_category(self.u, body)
        self.assertEqual(error.exception.code, 'original_request_confirmed')
        proof = identity(self.u, 'category', {'request': body}); self.assertTrue(proof['confirmed']); self.assertEqual(proof['revision'], 2)
        latest = current(self.u, 'category', first['id']); self.assertEqual(latest['record']['name'], 'Серверна назва')
        ExpenseCategoryAlias.objects.filter(category_id=first['id']).delete(); ExpenseCategory.objects.get(pk=first['id']).delete()
        proof = identity(self.u, 'category', {'request': body}); self.assertEqual(proof['status'], 'deleted'); self.assertNotIn('revision', proof)
        with self.assertRaises(Conflict): save_category(self.u, body)
        self.assertFalse(ExpenseCategory.objects.filter(pk=first['id']).exists())
    def test_monthly_creator_decimal_projection_edit_scope_and_deleted(self):
        body = self.budget_body(); first = save(self.u, body)
        again = json.loads(json.dumps(body)); again['planned_revenue'] = '1e2'; again['lines'][0]['amount'] = '10.000'; again['lines'][0]['base'] = 'revenue'
        self.assertEqual(save(self.u, again), first)
        self.assertNotEqual(first['id'], body['idempotency_key'])
        with self.assertRaises(Conflict): save(self.other, body)
        changed = {**body, 'revision': 1, 'planned_revenue': '120'}; save(self.u, changed, first['id'])
        with self.assertRaises(Conflict): save(self.u, body)
        self.assertTrue(identity(self.u, 'monthly_budget', {'request': body})['confirmed'])
        scoped = User.objects.create(username='scope-planning'); foreign = Store.objects.create(name='Foreign'); Profile.objects.create(user=scoped, role='owner', store=foreign)
        with self.assertRaises(BusinessError): current(scoped, 'monthly_budget', first['id'])
        with self.assertRaises(BusinessError): identity(scoped, 'monthly_budget', {'request': body})
        MonthlyBudget.objects.get(pk=first['id']).delete()
        self.assertEqual(identity(self.u, 'monthly_budget', {'request': body})['status'], 'deleted')
        with self.assertRaises(Conflict): save(self.u, body)
    def test_legacy_unknown_permissions_readonly_and_no_invented_author(self):
        body = {'id': str(self.category.pk), 'name': self.category.name, 'active': True}
        self.assertEqual(identity(self.u, 'category', {'request': body})['status'], 'legacy_unknown')
        self.assertEqual(PlanningCreateReceipt.objects.count(), 0)
        self.other.profile.role = 'manager'; self.other.profile.save()
        self.assertFalse(current(self.other, 'category', self.category.pk.__str__())['permissions']['canEdit'])
        with self.assertRaises(BusinessError): identity(self.other, 'category', {'request': body})
        with self.assertRaises(BusinessError): save_category(self.u, {'id': str(uuid.uuid4()), 'name': 'X', 'aliases': []})
        with self.assertRaises(BusinessError): save_category(self.u, {'id': str(uuid.uuid4()), 'name': 'X', 'revision': 1}, str(self.category.pk))
    def test_http_strict_readonly_and_malformed_no_mutation(self):
        token='planning-qa'; PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), user=self.u, csrf='planning-csrf', expires=int(time.time())+3600); self.client.cookies['ts_session']=token
        body=self.category_body(); before=AuditEvent.objects.count()
        response=self.client.post('/api/erp/budget-categories', data=json.dumps(body), content_type='application/json', HTTP_ORIGIN='http://testserver', HTTP_X_CSRF_TOKEN='planning-csrf'); self.assertEqual(response.status_code,201,response.content)
        self.assertEqual(response.json()['request_key'],body['id'])
        query=self.client.get('/api/erp/budget-categories/'+body['id'], {'purpose':'recovery'}); self.assertEqual(query.status_code,200,query.content)
        result=self.client.post('/api/erp/budget-categories/identity',data=json.dumps({'request':body}),content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='planning-csrf');self.assertEqual(result.status_code,200,result.content)
        self.assertEqual(AuditEvent.objects.count(),before+1)
        self.assertEqual(PlanningCreateReceipt.objects.count(),1)
        self.u.is_active=False;self.u.save(update_fields=['is_active'])
        self.assertEqual(self.client.get('/api/erp/budget-categories/'+body['id']).status_code,401)

    def test_receipt_failure_rolls_back_target_and_audit(self):
        from unittest.mock import patch
        before=(ExpenseCategory.objects.count(),AuditEvent.objects.count())
        with patch('server.erp.planning_recovery.record',side_effect=RuntimeError('Synthetic receipt failure')):
            with self.assertRaises(RuntimeError):save_category(self.u,self.category_body())
        self.assertEqual((ExpenseCategory.objects.count(),AuditEvent.objects.count()),before)
        self.assertEqual(PlanningCreateReceipt.objects.count(),0)

    def test_postgresql_parallel_repeat_and_role_recheck_after_wait(self):
        if connection.vendor!='postgresql':self.skipTest('Requires PostgreSQL row locks')
        from threading import Thread, Barrier, Event
        from django.db import connections,close_old_connections,transaction
        from server.erp.services import ledger_lock
        body=self.category_body();gate=Barrier(2);results=[]
        def run():
            close_old_connections()
            try:
                user=User.objects.get(pk=self.u.pk);gate.wait(timeout=10);results.append(save_category(user,body))
            except Exception as e:results.append(e)
            finally:connections.close_all()
        workers=[Thread(target=run) for _ in range(2)]
        for thread in workers:thread.start()
        for thread in workers:thread.join(15);self.assertFalse(thread.is_alive())
        self.assertEqual(len(results),2);self.assertTrue(all(isinstance(r,dict) for r in results),results)
        self.assertEqual(results[0],results[1]);self.assertEqual(PlanningCreateReceipt.objects.count(),1)
        self.assertEqual(AuditEvent.objects.filter(action='budget_category_saved').count(),1)
        entered=Event();replay=[]
        cached=User.objects.get(pk=self.u.pk);cached.profile
        def wait_retry():
            close_old_connections();entered.set()
            try:replay.append(save_category(cached,body))
            except Exception as e:replay.append(e)
            finally:connections.close_all()
        with transaction.atomic():
            ledger_lock();thread=Thread(target=wait_retry);thread.start();self.assertTrue(entered.wait(5))
            time.sleep(.1);Profile.objects.filter(user=self.u).update(role='cashier')
        thread.join(15);self.assertFalse(thread.is_alive());self.assertIsInstance(replay[0],BusinessError)
        self.assertEqual(AuditEvent.objects.filter(action='budget_category_saved').count(),1)

    def test_postgresql_recovery_snapshot_is_readonly(self):
        if connection.vendor!='postgresql':self.skipTest('Requires PostgreSQL READ ONLY')
        from unittest.mock import patch
        from server.erp import planning_recovery
        body=self.category_body();save_category(self.u,body);original=planning_recovery.target_for;states=[]
        def inspect(receipt):
            with connection.cursor() as cursor:
                cursor.execute('SHOW transaction_isolation');states.append(cursor.fetchone()[0]);cursor.execute('SHOW transaction_read_only');states.append(cursor.fetchone()[0])
            return original(receipt)
        with patch('server.erp.planning_recovery.target_for',side_effect=inspect):self.assertTrue(identity(self.u,'category',{'request':body})['confirmed'])
        self.assertEqual(states,['repeatable read','on'])
