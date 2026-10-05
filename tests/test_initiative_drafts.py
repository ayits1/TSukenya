"""Targeted B06 initiative grants and immutable receipts; no new posting rules."""
import re
import threading
import uuid
from contextlib import contextmanager
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core.exceptions import PermissionDenied
from django.db import connection, connections
from django.test.utils import CaptureQueriesContext

from server.erp import initiative_drafts as drafts, initiatives
from server.erp.historical_reports import read_snapshot
from server.erp.models import AuditEvent, CashEntry, Document, IdeaProject, Profile, ProjectOperation, ProjectTask, StockEntry, Store, Voucher
from server.erp.services import Conflict
from tests.test_unit_and_drafts import TransactionApiFixture


class InitiativeDraftTests(TransactionApiFixture):
    context_path = '/api/erp/initiatives/recovery-context'
    identity_path = '/api/erp/initiatives/operation-identity'

    def setUp(self):
        super().setUp()
        self.idea = Document.objects.create(path='ideas/source', data={
            'title': 'Кава із собою', 'text': '  Початковий задум  ', 'reaction': 'yes',
            'privateFixture': 'not-in-recovery-context',
        })
        self.requests = []

    def create(self, **extra):
        request = {'action': 'create', 'idempotencyKey': str(uuid.uuid4()), 'idea': 'source',
                   'ideaRevision': initiatives.token(self.idea), 'title': '  Пілот  ',
                   'store': self.store.pk, 'plannedBudget': '12.50', **extra}
        result = initiatives.mutate(self.u, request)
        self.requests.append((None, request, result))
        return IdeaProject.objects.get(pk=result['project']['id'])

    def act(self, project, action, **extra):
        project.refresh_from_db()
        request = {'action': action, 'idempotencyKey': str(uuid.uuid4()),
                   'revision': project.revision, **extra}
        result = initiatives.mutate(self.u, request, str(project.pk))
        self.requests.append((str(project.pk), request, result))
        return result

    def context(self, project=None, action='edit', **extra):
        return self.client.get(self.context_path, {'action': action,
                               **({'project': str(project.pk)} if project else
                                  {'idea': 'source', 'store': str(self.store.pk)}), **extra})

    def identity(self, record):
        route, request, _ = record
        return self.call('post', self.identity_path, {'project': route, 'request': request})

    def test_context_whole_action_eligibility_and_current_exact_terms(self):
        initial = self.context(action='create')
        self.assertEqual(initial.status_code, 200, initial.content)
        self.assertTrue(initial.json()['canWrite'])
        self.assertNotIn('privateFixture', str(initial.json()))
        project = self.create(metric='Частка', metricUnit='%', targetValue='12.0001')
        self.assertFalse(self.context(action='create').json()['canWrite'])
        for action, expected in [('edit', True), ('start', True), ('cancel', True),
                                 ('task_create', True), ('complete', False), ('result_edit', False)]:
            result = self.context(project, action)
            self.assertEqual(result.status_code, 200, result.content)
            self.assertEqual(result.json()['canWrite'], expected)
            self.assertEqual(result.json()['project']['plannedBudget'], '12.50')
            self.assertEqual(result.json()['project']['targetValue'], '12.0001')
            self.assertNotIn('tasks', result.json()['project'])
            self.assertNotIn('actualExpenses', result.json()['project'])
        task = Document.objects.create(path='tasks/legacy', data={'title': ' Старий план ', 'status': 'doing'})
        result = self.context(project, 'task_link', task='legacy').json()
        self.assertTrue(result['canWrite'])
        self.assertEqual(result['source']['revision'], initiatives.token(task))
        self.act(project, 'task_link', task='legacy', taskRevision=initiatives.token(task))
        self.assertFalse(self.context(project, 'task_link', task='legacy').json()['canWrite'])
        self.assertTrue(self.context(project, 'task_update', task='legacy').json()['canWrite'])
        self.act(project, 'start')
        self.assertTrue(self.context(project, 'complete').json()['canWrite'])
        self.act(project, 'complete', resultSummary='Факт', factValue='-1.0001', resultDate=self.today)
        for action in ['edit', 'start', 'cancel', 'task_create', 'complete']:
            self.assertFalse(self.context(project, action).json()['canWrite'])
        self.assertTrue(self.context(project, 'result_edit').json()['canWrite'])
        self.cash_start()
        expense = self.v('expense', amount='7.15', account=self.cash.pk, payload={'category': 'Реклама'})
        self.assertTrue(self.context(project, 'expense_attach', voucher=str(expense.pk)).json()['canWrite'])
        self.act(project, 'expense_attach', voucher=expense.pk, voucherRevision=expense.revision)
        self.assertTrue(self.context(project, 'expense_detach', voucher=str(expense.pk)).json()['canWrite'])

    def test_all_eleven_immutable_receipts_confirm_without_replaying_or_historical_payload(self):
        project = self.create()
        self.act(project, 'edit', title='Наступна назва')
        self.act(project, 'task_create', title='Нова задача', phase='Пілот', stage=3)
        task = ProjectTask.objects.get(project=project).document
        self.act(project, 'task_update', task=task.pk.split('/')[1],
                 taskRevision=initiatives.token(task), status='done')
        old = Document.objects.create(path='tasks/old', data={'title': 'Старий план'})
        self.act(project, 'task_link', task='old', taskRevision=initiatives.token(old), phase='  Етап  ')
        self.cash_start()
        expense = self.v('expense', amount='20.05', account=self.cash.pk,
                         payload={'category': 'Пілот', 'privateFixture': ['secret'] * 500})
        self.act(project, 'expense_attach', voucher=expense.pk, voucherRevision=expense.revision)
        self.act(project, 'expense_detach', voucher=expense.pk, reason='  Уточнення  ')
        self.act(project, 'start')
        self.act(project, 'complete', resultSummary='Результат', resultDate=self.today)
        self.act(project, 'result_edit', resultSummary='Уточнений факт', resultDate=self.today, reason='  Пояснення  ')
        self.idea = Document.objects.create(path='ideas/second', data={'reaction': 'yes', 'title': 'Другий'})
        second = self.create(idea='second')
        self.act(second, 'cancel', reason='Передумови змінилися')
        self.assertEqual({r['action'] for _, r, _ in self.requests}, set(drafts.EXTRAS))
        before = (ProjectOperation.objects.count(), AuditEvent.objects.count(),
                  Voucher.objects.count(), CashEntry.objects.count(), StockEntry.objects.count())
        with patch.object(ProjectOperation, 'from_db', side_effect=AssertionError('whole receipt payload')):
            with patch('server.erp.initiatives.ledger_lock', side_effect=AssertionError('readonly must not lock')):
                with CaptureQueriesContext(connection) as queries:
                    for route, request, original in self.requests:
                        response = self.identity((route, request, original))
                        self.assertEqual(response.status_code, 200, response.content)
                        self.assertEqual(response.json(), {
                            'contract': 'initiative-operation-identity-v1', 'confirmed': True,
                            'key': request['idempotencyKey'], 'action': request['action'],
                            'routeProject': route, 'observedRevision': request.get('revision'),
                            'observedIdeaRevision': request.get('ideaRevision'),
                            'project': original['project']['id'],
                            'appliedRevision': original['project']['revision'],
                        })
        self.assertEqual(before, (ProjectOperation.objects.count(), AuditEvent.objects.count(),
                                 Voucher.objects.count(), CashEntry.objects.count(), StockEntry.objects.count()))
        sql = [q['sql'].lstrip().upper() for q in queries]
        self.assertFalse(any(q.startswith(('INSERT', 'UPDATE', 'DELETE')) or 'FOR UPDATE' in q for q in sql))
        if connection.vendor == 'postgresql':
            self.assertTrue(any('REPEATABLE READ, READ ONLY' in q for q in sql))

    def test_identity_exact_raw_creator_route_absence_and_canonical_keys(self):
        project = self.create()
        record = self.requests[0]
        for change in [{'title': 'Пілот'}, {'plannedBudget': '12.5'}, {'reason': ''}]:
            self.assertEqual(self.identity((None, {**record[1], **change}, None)).status_code, 409)
        self.assertEqual(self.identity((None, {**record[1], 'idempotencyKey': record[1]['idempotencyKey'].upper()}, None)).status_code, 400)
        other = User.objects.create(username='other-owner')
        Profile.objects.create(user=other, role='owner')
        with self.assertRaises(Conflict):
            drafts.operation_identity(other, {'project': None, 'request': record[1]})
        unknown = {'action': 'start', 'idempotencyKey': str(uuid.uuid4()), 'revision': project.revision}
        result = self.identity((str(project.pk), unknown, None))
        self.assertEqual(result.status_code, 200)
        self.assertFalse(result.json()['confirmed'])
        self.assertNotIn('appliedRevision', result.json())
        with patch.object(ProjectOperation.objects, 'filter', side_effect=AssertionError('receipt before grant')):
            result = self.identity((str(uuid.uuid4()), unknown, None))
        self.assertEqual(result.status_code, 403)
        self.assertEqual(self.identity((str(project.pk), record[1], None)).status_code, 400)

    def test_missing_secondary_retains_primary_foreign_scope_denies_and_expense_is_scalar(self):
        project = self.create()
        missing = self.context(project, 'task_link', task='gone')
        self.assertEqual(missing.status_code, 200)
        self.assertFalse(missing.json()['canWrite'])
        self.assertIsNone(missing.json()['source'])
        self.assertEqual(missing.json()['project']['id'], str(project.pk))
        self.cash_start()
        expense = self.v('expense', amount='10', account=self.cash.pk, payload={
            'category': 'Поточна стаття', 'privateFixture': ['never materialize'] * 501})
        with patch.object(Voucher, 'from_db', side_effect=AssertionError('whole voucher payload')):
            with CaptureQueriesContext(connection) as queries:
                response = self.context(project, 'expense_attach', voucher=str(expense.pk))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertNotIn('privateFixture', str(response.json()))
        self.assertEqual(response.json()['source']['category'], 'Поточна стаття')
        # SQLite JSON_EXTRACT("erp_voucher"."payload", path) contains the
        # same substring as a whole-column SELECT. Reject only a raw SELECT
        # projection, while retaining the from_db materialization guard above.
        raw_payload = r'(?:SELECT\s+(?:DISTINCT\s+)?|,\s*)"erp_voucher"\."payload"\s*(?:,|FROM\b|AS\b)'
        self.assertFalse(any(re.search(raw_payload, q['sql'], re.I) for q in queries))
        other = Store.objects.create(name='Інший')
        Voucher.objects.filter(pk=expense.pk).update(store=other)
        self.assertEqual(self.context(project, 'expense_attach', voucher=str(expense.pk)).status_code, 403)
        Profile.objects.filter(user=self.u).update(store=other)
        self.assertEqual(self.context(project).status_code, 403)
        self.assertEqual(self.identity(self.requests[0]).status_code, 403)

    def test_fresh_actor_on_new_and_existing_reads_and_strict_http_query(self):
        project = self.create()
        for query in ['action=edit&project='+str(project.pk)+'&raw=private',
                      'action=edit&action=start&project='+str(project.pk),
                      'action=create&idea=source&store=00']:
            self.assertEqual(self.client.get(self.context_path+'?'+query).status_code, 400)
        @contextmanager
        def revoked_snapshot():
            Profile.objects.filter(user=self.u).update(role='cashier')
            with read_snapshot():
                yield
        with patch('server.erp.initiative_drafts.read_snapshot', side_effect=revoked_snapshot):
            self.assertEqual(self.identity(self.requests[0]).status_code, 403)
        for read in [lambda: initiatives.detail(self.u, str(project.pk), {}),
                     lambda: initiatives.list_projects(self.u, {}),
                     lambda: initiatives.options(self.u, {}),
                     lambda: initiatives.idea_info(self.u, 'source'),
                     lambda: initiatives.candidates(self.u, str(project.pk), {'purpose': 'tasks'}),
                     lambda: initiatives.source_detail(self.u, str(project.pk), {'task': 'missing'})]:
            with self.assertRaises(PermissionDenied):
                read()
        Profile.objects.filter(user=self.u).update(role='owner')
        Store.objects.filter(pk=self.store.pk).update(active=False)
        self.assertEqual(self.context(action='create').status_code, 200)
        User.objects.filter(pk=self.u.pk).update(is_active=False)
        with self.assertRaises(PermissionDenied):
            drafts.recovery_context(self.u, {'action': 'edit', 'project': str(project.pk)})

    def test_context_exact_selection_survives_absent_sources_and_separates_actor_scope(self):
        create = self.context(action='create').json()
        self.assertEqual(create['selection'], {'project': None, 'idea': 'source', 'task': None,
                                             'voucher': None, 'store': self.store.pk})
        self.assertIsNone(create['storeId'])
        project = self.create()
        for action, source in [('task_link', {'task': 'missing'}),
                               ('expense_attach', {'voucher': '999999'})]:
            response = self.context(project, action, **source)
            self.assertEqual(response.status_code, 200, response.content)
            self.assertEqual(response.json()['selection'], {
                'project': str(project.pk), 'idea': None, 'store': None,
                'task': source.get('task'),
                'voucher': int(source['voucher']) if 'voucher' in source else None,
            })
            self.assertIsNone(response.json()['source'])
            self.assertFalse(response.json()['canWrite'])

    def test_postgresql_fresh_actor_and_project_use_one_readonly_snapshot(self):
        if connection.vendor != 'postgresql':
            self.skipTest('PostgreSQL snapshot proof')
        project = self.create()
        changed, errors = [], []
        def writer():
            try:
                IdeaProject.objects.filter(pk=project.pk).update(title='Наступна назва', revision=2)
                changed.append(True)
            except BaseException as error:
                errors.append(error)
            finally:
                connections.close_all()
        def interleave(execute, sql, params, many, context):
            result = execute(sql, params, many, context)
            if not changed and 'auth_user' in sql and sql.lstrip().upper().startswith('SELECT'):
                thread = threading.Thread(target=writer)
                thread.start();thread.join(10)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
            return result
        with connection.execute_wrapper(interleave):
            first = drafts.recovery_context(self.u, {'action': 'edit', 'project': str(project.pk)})
        self.assertEqual(changed, [True])
        self.assertEqual(first['project']['revision'], 1)
        self.assertEqual(drafts.recovery_context(self.u, {'action': 'edit', 'project': str(project.pk)})['project']['revision'], 2)
