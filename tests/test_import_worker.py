"""Isolated supervised-worker lifecycle and read-only technical liveness."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import timedelta
from io import StringIO
from pathlib import Path
from unittest.mock import patch
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection, connections
from django.test import TestCase, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from tests.test_catalog_import_jobs import ImportJobsFixture
from server.erp.models import Document, AuditEvent
from server.erp.import_models import CatalogImportRun
from server.erp.import_jobs import process_one
from server.erp.import_worker import ImportWorker
from server.erp.service_health import import_worker_status, heartbeat, IMPORT_SERVICE, STALE_SECONDS
from server.erp.service_models import ServiceHeartbeat


class WorkerHealthTests(ImportJobsFixture,TestCase):
    def setUp(self):self.setup_jobs()

    def test_no_worker_stale_fresh_stopped_and_delayed_pulse_never_revives(self):
        self.assertEqual(import_worker_status()['status'],'unavailable')
        older=uuid.uuid4();heartbeat(older,'unknown')
        ServiceHeartbeat.objects.filter(pk=older).update(seen_at=timezone.now()-timedelta(seconds=STALE_SECONDS))
        self.assertEqual(import_worker_status()['status'],'stale')
        live=uuid.uuid4();heartbeat(live,'a'*40)
        self.assertEqual(import_worker_status()['status'],'available')
        heartbeat(older,'unknown',stopped=True)
        self.assertEqual(import_worker_status()['status'],'available','stopping one worker does not hide another')
        heartbeat(live,'a'*40,stopped=True);before=ServiceHeartbeat.objects.get(pk=live).seen_at
        heartbeat(live,'a'*40)
        self.assertEqual(import_worker_status()['status'],'unavailable')
        self.assertEqual(ServiceHeartbeat.objects.get(pk=live).seen_at,before)
        self.assertTrue(ServiceHeartbeat.objects.get(pk=live).stopped)
        with self.assertRaises(CommandError):call_command('import_worker_health',stdout=StringIO())
        heartbeat(uuid.uuid4(),'unknown');call_command('import_worker_health',stdout=StringIO())

    def test_get_health_detail_and_history_are_read_only_private_and_batched(self):
        key=self.create([self.row(1)])
        heartbeat(uuid.uuid4(),'a'*40)
        before=list(ServiceHeartbeat.objects.values())
        health=self.client.get('/health').json()
        self.assertEqual(health['status'],'ok')
        self.assertEqual(set(health['imports']),{'status','lastSeen','staleAfterSeconds'})
        self.assertEqual(health['imports']['status'],'available')
        detail=self.get('runs/'+key).json();self.assertEqual(detail['worker'],health['imports'])
        for i in range(29):self.create([self.row(i+2)])
        with CaptureQueriesContext(connection) as queries:page=self.get('history').json()
        self.assertEqual(len(page['items']),30)
        self.assertEqual(sum('erp_serviceheartbeat' in q['sql'] for q in queries),1)
        self.assertTrue(all(item['worker']==detail['worker'] for item in page['items']))
        self.assertEqual(list(ServiceHeartbeat.objects.values()),before)
        self.user.profile.role='viewer';self.user.profile.save()
        self.assertEqual(self.get('runs/'+key).status_code,403)
        self.assertEqual(self.client.get('/health').status_code,200)
        self.assertNotIn('owner',json.dumps(health['imports']))
        self.assertNotIn('release',health['imports'])

    def test_future_heartbeat_is_not_a_live_worker_and_continuous_arguments_are_bounded(self):
        ident=uuid.uuid4();heartbeat(ident,'unknown')
        ServiceHeartbeat.objects.filter(pk=ident).update(seen_at=timezone.now()+timedelta(days=1))
        self.assertEqual(import_worker_status(),{'status':'unavailable','lastSeen':None,'staleAfterSeconds':45})
        for options in [{'run':str(uuid.uuid4())},{'once':True},{'max_steps':2},{'poll_seconds':0},{'poll_seconds':float('nan')},{'poll_seconds':float('inf')}]:
            with self.assertRaises(CommandError):call_command('process_catalog_imports',continuous=True,stdout=StringIO(),**options)
        with patch('server.erp.management.commands.process_catalog_imports.process_one',side_effect=[True,False]) as process:
            call_command('process_catalog_imports',max_steps=4,stdout=StringIO())
        self.assertEqual(process.call_count,2)
        self.assertEqual(ServiceHeartbeat.objects.count(),1,'bounded old CLI does not register supervised service')


class WorkerLifecycleTests(ImportJobsFixture,TransactionTestCase):
    def setUp(self):self.setup_jobs()

    def test_actual_sigterm_finishes_current_chunk_then_restart_retains_exact_plan_and_audit(self):
        if connection.vendor!='postgresql':self.skipTest('Real subprocess transactions require isolated PostgreSQL.')
        key=self.create([self.row(i,cost='10') for i in range(1,202)])
        detail=self.ready(key);self.approve(key);plan=detail['planRevision']
        with tempfile.TemporaryDirectory(prefix='tsukenya-worker-stop-') as temporary:
            marker=Path(temporary)/'entered';release=Path(temporary)/'release'
            script='''import os,time,uuid,django
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings');django.setup()
from server.erp import import_jobs
from server.erp.import_worker import ImportWorker
from pathlib import Path
original=import_jobs.apply_row
first=True
def delayed(*args,**kwargs):
 global first
 original(*args,**kwargs)
 if first:
  first=False;Path(os.environ['QA_ENTERED']).write_text('ready')
  deadline=time.monotonic()+20
  while not Path(os.environ['QA_RELEASE']).exists():
   if time.monotonic()>deadline:raise RuntimeError('synthetic gate timed out')
   time.sleep(.02)
import_jobs.apply_row=delayed
ImportWorker(identifier=uuid.UUID(os.environ['QA_RUN']),poll_seconds=.5).run()
'''
            env={**os.environ,'DB_NAME':connection.settings_dict['NAME'],'QA_RUN':key,'QA_ENTERED':str(marker),'QA_RELEASE':str(release)}
            child=subprocess.Popen([sys.executable,'-c',script],cwd=Path(__file__).resolve().parents[1],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                deadline=time.monotonic()+15
                while not marker.exists() and child.poll() is None and time.monotonic()<deadline:time.sleep(.02)
                self.assertTrue(marker.exists(),'child must enter actual apply transaction')
                child.send_signal(signal.SIGTERM);release.write_text('continue')
                out,error=child.communicate(timeout=20);self.assertEqual(child.returncode,0,error+out)
            finally:
                if child.poll() is None:child.kill();child.communicate(timeout=5)
        run=CatalogImportRun.objects.get(pk=key)
        self.assertEqual((run.status,run.counts['created'],run.counts['pending']),('queued',100,101))
        self.assertEqual(run.plan_revision,plan);self.assertIsNone(run.lease_token)
        self.assertTrue(ServiceHeartbeat.objects.get().stopped)
        self.assertEqual(import_worker_status()['status'],'unavailable')
        worker=ImportWorker(identifier=uuid.UUID(key),poll_seconds=.01)
        original=process_one
        def finish(identifier):
            result=original(identifier)
            if not result:worker.stop.set()
            return result
        with patch('server.erp.import_worker.process_one',side_effect=finish):worker.run()
        run.refresh_from_db();self.assertEqual((run.status,run.counts['created'],run.counts['pending']),('completed',201,0))
        self.assertEqual(run.plan_revision,plan)
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(),201)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),201)
        self.assertFalse(process_one(uuid.UUID(key)))

    def test_two_continuous_runners_and_cancel_role_revoke_preserve_boundaries(self):
        if connection.vendor!='postgresql':self.skipTest('Concurrent row locks require PostgreSQL.')
        key=self.create([self.row(i,cost='10') for i in range(1,202)])
        self.ready(key);self.approve(key)
        workers=[ImportWorker(identifier=uuid.UUID(key),poll_seconds=.01) for _ in range(2)]
        errors=[];barrier=threading.Barrier(2)
        def go(worker):
            try:barrier.wait(timeout=5);worker.run()
            except Exception as error:errors.append(type(error).__name__)
            finally:connections.close_all()
        threads=[threading.Thread(target=go,args=(worker,)) for worker in workers]
        for thread in threads:thread.start()
        try:
            deadline=time.monotonic()+15
            while time.monotonic()<deadline:
                if CatalogImportRun.objects.get(pk=key).status=='completed':break
                time.sleep(.02)
            self.assertEqual(CatalogImportRun.objects.get(pk=key).status,'completed')
        finally:
            for worker in workers:worker.stop.set()
            for thread in threads:thread.join(timeout=10)
        self.assertFalse(errors);self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(),201)
        self.assertEqual(AuditEvent.objects.filter(action='catalog_changed').count(),201)
        # A new author-revoked queue cannot be applied by the supervised runner.
        blocked=self.create([self.row(9999,cost='10')]);self.ready(blocked);self.approve(blocked)
        self.user.profile.role='viewer';self.user.profile.save()
        worker=ImportWorker(identifier=uuid.UUID(blocked),poll_seconds=.01)
        original=process_one
        def stop_after(identifier):
            result=original(identifier);worker.stop.set();return result
        with patch('server.erp.import_worker.process_one',side_effect=stop_after):worker.run()
        self.assertEqual(CatalogImportRun.objects.get(pk=blocked).status,'blocked')
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(),201)
        self.user.profile.role='owner';self.user.profile.save()
        cancelled=self.create([self.row(9998,cost='10')]);self.ready(cancelled);self.approve(cancelled)
        self.assertEqual(self.post('runs/'+cancelled+'/cancel',{}).status_code,200)
        worker=ImportWorker(identifier=uuid.UUID(cancelled),poll_seconds=.01)
        with patch('server.erp.import_worker.process_one',side_effect=stop_after):worker.run()
        self.assertEqual(CatalogImportRun.objects.get(pk=cancelled).status,'cancelled')
        self.assertEqual(Document.objects.filter(path__startswith='products/').count(),201)
