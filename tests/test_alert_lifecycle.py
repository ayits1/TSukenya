"""B19 alert lifecycle: completed work keeps the active condition visible, recurrence opens a new cycle, run status is visible. Isolated data only."""
import json
from io import StringIO
from unittest import mock
from datetime import timedelta
from django.utils import timezone
from django.core.management import call_command
from django.core.management.base import CommandError
from server.erp.alerts import run_alerts, sync_alerts
from server.erp.models import *
from server.erp.reporting import state, alert_status, ALERT_PUBLIC_ERROR
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
        doc.data['_alertWorkState'] = 'completed' if status=='done' else 'accepted' if status=='doing' else 'open'
        doc.save(update_fields=['data'])

    def test_completed_work_keeps_active_condition_visible_without_cron_reopen(self):
        sync_alerts(self.u);doc=self.low();self.set_status(doc,'done')
        result=sync_alerts(self.u);doc.refresh_from_db()
        self.assertEqual(result['reopened'],0);self.assertEqual(result['created'],0)
        self.assertEqual(doc.data['status'],'done');self.assertTrue(doc.data['_alertActive'])
        self.assertEqual(doc.data['_alertWorkState'],'completed');self.assertEqual(doc.data['_alertCycle'],1)
        self.set_status(doc,'doing');self.assertEqual(sync_alerts(self.u)['reopened'],0)
        doc.refresh_from_db();self.assertEqual(doc.data['_alertWorkState'],'accepted')
        self.assertEqual(sum(d.data['_alertKey']==doc.data['_alertKey'] for d in Document.objects.filter(path__startswith='tasks/auto_')),1)

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
        self.assertEqual(status['error']['message'], ALERT_PUBLIC_ERROR)
        self.assertNotIn('boom', json.dumps(status))
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
        self.assertEqual(json.loads(Setting.objects.get(pk='alerts_last_error').value)['message'], ALERT_PUBLIC_ERROR)

    def test_manual_and_scheduled_runs_share_ledger_lock_and_do_not_duplicate(self):
        with mock.patch('server.erp.alerts.ledger_lock', wraps=__import__('server.erp.alerts', fromlist=['x']).ledger_lock) as lock:
            run_alerts(self.u, 'manual')
            run_alerts(self.u, 'scheduler')
        self.assertEqual(lock.call_count, 2)
        keys = [d.data['_alertKey'] for d in Document.objects.filter(path__startswith='tasks/auto_')]
        self.assertEqual(len(keys), len(set(keys)))

    def test_stale_after_three_missed_half_hour_runs(self):
        now=timezone.now()
        for minutes,stale in [(0,False),(89,False),(90,True),(120,True)]:
            Setting.objects.update_or_create(pk='alerts_last_ok',defaults={'value':json.dumps({'at':(now-timedelta(minutes=minutes)).isoformat(),'source':'scheduler'})})
            with mock.patch('server.erp.reporting.timezone.now',return_value=now):
                self.assertEqual(alert_status()['stale'],stale)

    def test_malformed_status_never_breaks_state(self):
        malformed=['not-json','null','[]','[1]','{}','{"source":"scheduler"}','{"at":1,"source":"manual"}',
                   '{"at":"bad","source":"scheduler"}','{"at":"2026-01-01T00:00:00","source":"scheduler"}',
                   json.dumps({'at':timezone.now().isoformat(),'source':[]}),
                   json.dumps({'at':(timezone.now()+timedelta(days=1)).isoformat(),'source':'manual'})]
        for value in malformed:
            with self.subTest(value=value):
                for key in ('alerts_last_ok','alerts_last_error'):
                    Setting.objects.update_or_create(pk=key,defaults={'value':value})
                self.assertEqual(state(self.u)['alerts_status'],{'ok':None,'error':None,'stale':True})

    def test_old_technical_errors_are_sanitized_and_date_offsets_compared_as_instants(self):
        Setting.objects.create(pk='alerts_last_ok',value=json.dumps({'at':'2026-01-01T12:00:00+03:00','source':'scheduler','active':True,'created':'unsafe'}))
        Setting.objects.create(pk='alerts_last_error',value=json.dumps({'at':'2026-01-01T10:00:00+00:00','source':'manual','message':'password=secret SQL customer data','reference':'untrusted-id'}))
        status=alert_status()
        self.assertIsNotNone(status['error'])
        self.assertEqual(status['error']['message'],ALERT_PUBLIC_ERROR)
        self.assertNotIn('secret',json.dumps(status))
        self.assertNotIn('reference',status['error'])
        self.assertNotIn('active',status['ok'])
        self.assertNotIn('created',status['ok'])

    def test_error_details_only_go_to_server_log_and_recording_failure_preserves_original(self):
        error=RuntimeError('private SQL text')
        with mock.patch('server.erp.alerts.stock',side_effect=error),self.assertLogs('server.erp.alerts',level='ERROR') as captured:
            with self.assertRaisesMessage(RuntimeError,'private SQL text'):run_alerts(self.u)
        public=alert_status()['error']
        self.assertEqual(public['message'],ALERT_PUBLIC_ERROR)
        self.assertEqual(len(public['reference']),12)
        self.assertIn(public['reference'],captured.output[0])
        self.assertIn('private SQL text',captured.output[0])
        self.assertNotIn('private SQL text',Setting.objects.get(pk='alerts_last_error').value)
        with mock.patch('server.erp.alerts.stock',side_effect=error),mock.patch('server.erp.alerts.record_alert_error',side_effect=RuntimeError('database unavailable')),self.assertLogs('server.erp.alerts',level='ERROR'):
            with self.assertRaisesMessage(RuntimeError,'private SQL text'):run_alerts(self.u)
