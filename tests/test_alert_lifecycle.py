"""B19 alert lifecycle: done does not hide an active condition, recurrence opens a new cycle, run status is visible. Isolated data only."""
import json
from io import StringIO
from unittest import mock
from django.core.management import call_command
from django.core.management.base import CommandError
from server.erp.alerts import run_alerts, sync_alerts
from server.erp.models import *
from server.erp.reporting import state
from tests.test_erp import AccountingFixture


class AlertLifecycleTests(AccountingFixture):
    def setUp(self):
        super().setUp()
        self.p.data['minStock'] = 2
        self.p.save()

    def low(self):
        docs = [d for d in Document.objects.filter(path__startswith='tasks/auto_') if d.data['_alertKey'].startswith(f'low:{self.wh.pk}:')]
        self.assertEqual(len(docs), 1)
        return docs[0]

    def set_status(self, doc, status):
        doc.data['status'] = status
        doc.save(update_fields=['data'])

    def test_done_on_active_condition_is_reopened_with_note(self):
        sync_alerts(self.u)
        doc = self.low()
        self.assertEqual(doc.data['_alertCycle'], 1)
        self.assertNotIn('_alertNote', doc.data)
        self.set_status(doc, 'done')
        result = sync_alerts(self.u)
        self.assertEqual(result['reopened'], 1)
        self.assertEqual(result['created'], 0)
        doc.refresh_from_db()
        self.assertEqual(doc.data['status'], 'todo')
        self.assertEqual(doc.data['_alertNote'], 'Умова досі діє')
        self.assertTrue(doc.data['_alertNoteAt'])
        self.assertEqual(doc.data['_alertCycle'], 1)
        # Work in progress is left alone and keeps the note until the condition ends.
        self.set_status(doc, 'doing')
        self.assertEqual(sync_alerts(self.u)['reopened'], 0)
        doc.refresh_from_db()
        self.assertEqual((doc.data['status'], doc.data['_alertNote']), ('doing', 'Умова досі діє'))
        self.assertEqual(sum(d.data['_alertKey'] == doc.data['_alertKey'] for d in Document.objects.filter(path__startswith='tasks/auto_')), 1)

    def test_resolved_condition_that_recurs_starts_new_cycle_without_duplicate(self):
        sync_alerts(self.u)
        doc = self.low()
        path = doc.pk
        self.p.data['minStock'] = 0
        self.p.save()
        self.assertEqual(sync_alerts(self.u)['resolved'], 2)
        doc.refresh_from_db()
        self.assertEqual((doc.data['status'], doc.data['_alertActive'], doc.data['_alertNote']), ('done', False, 'Причину усунено'))
        before = Document.objects.filter(path__startswith='tasks/auto_').count()
        self.p.data['minStock'] = 2
        self.p.save()
        result = sync_alerts(self.u)
        self.assertEqual((result['created'], result['reopened']), (2, 0))
        doc = Document.objects.get(pk=path)
        self.assertEqual((doc.data['status'], doc.data['_alertActive'], doc.data['_alertCycle']), ('todo', True, 2))
        self.assertEqual(doc.data['_alertNote'], 'Умова виникла знову')
        self.assertEqual(Document.objects.filter(path__startswith='tasks/auto_').count(), before)
        self.assertEqual(sync_alerts(self.u)['created'], 0)

    def test_run_status_success_error_and_roles(self):
        self.assertTrue(state(self.u)['alerts_status']['stale'])
        run_alerts(self.u, 'scheduler')
        status = state(self.u)['alerts_status']
        self.assertEqual((status['ok']['source'], status['error'], status['stale']), ('scheduler', None, False))
        with mock.patch('server.erp.alerts.stock', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                run_alerts(self.u, 'scheduler')
        status = state(self.u)['alerts_status']
        self.assertEqual(status['error']['message'], 'boom')
        self.assertEqual(status['ok']['source'], 'scheduler')
        run_alerts(self.u, 'manual')
        status = state(self.u)['alerts_status']
        self.assertIsNone(status['error'])
        self.assertEqual(status['ok']['source'], 'manual')
        for role, visible in [('manager', True), ('accountant', False), ('warehouse', False), ('cashier', False)]:
            self.u.profile.role = role
            self.u.profile.save(update_fields=['role'])
            self.assertEqual('alerts_status' in state(self.u), visible, role)

    def test_store_scoped_run_does_not_claim_network_control(self):
        self.u.profile.role = 'manager'
        self.u.profile.store = self.store
        self.u.profile.save(update_fields=['role', 'store'])
        sync_alerts(self.u)
        self.assertFalse(Setting.objects.filter(key='alerts_last_ok').exists())
        with mock.patch('server.erp.alerts.stock', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                run_alerts(self.u)
        self.assertFalse(Setting.objects.filter(key='alerts_last_error').exists())

    def test_command_records_success_and_missing_owner(self):
        out = StringIO()
        with mock.patch.dict('os.environ', {'OWNER_USERNAME': 'owner'}):
            call_command('alerts', stdout=out)
        self.assertEqual(json.loads(Setting.objects.get(pk='alerts_last_ok').value)['source'], 'scheduler')
        self.assertIn("'reopened'", out.getvalue())
        with mock.patch.dict('os.environ', {'OWNER_USERNAME': 'nobody'}), self.assertRaises(CommandError):
            call_command('alerts', stdout=out)
        self.assertIn('Власника', json.loads(Setting.objects.get(pk='alerts_last_error').value)['message'])

    def test_manual_and_scheduled_runs_share_ledger_lock_and_do_not_duplicate(self):
        with mock.patch('server.erp.alerts.ledger_lock', wraps=__import__('server.erp.alerts', fromlist=['x']).ledger_lock) as lock:
            run_alerts(self.u, 'manual')
            run_alerts(self.u, 'scheduler')
        self.assertEqual(lock.call_count, 2)
        keys = [d.data['_alertKey'] for d in Document.objects.filter(path__startswith='tasks/auto_')]
        self.assertEqual(len(keys), len(set(keys)))
