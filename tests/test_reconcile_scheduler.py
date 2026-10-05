"""Host-side state machine tests; no Docker or production connection."""
import fcntl
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('scheduler', Path(__file__).parents[1] / 'deploy/reconcile_scheduler.py')
scheduler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scheduler)


class ReconcileSchedulerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name) / 'state'
        self.root = Path('/opt/tsukenya')

    def receipt(self, key, status='clean'):
        return {'contract': 'reconciliation-receipt-v1', 'id': key, 'source': 'scheduler',
                'status': status, 'checksVersion': 1, 'issues': 1 if status == 'discrepancies' else 0}

    def test_lost_ack_retries_durable_exact_id(self):
        ids = []
        def lost(root, key):
            ids.append(key)
            self.assertEqual(json.loads((self.state / 'pending.json').read_text())['id'], key)
            raise scheduler.PendingError('lost')
        with self.assertRaises(scheduler.PendingError):
            scheduler.run(self.root, self.state, executor=lost)
        def confirmed(root, key):
            ids.append(key)
            return self.receipt(key)
        self.assertEqual(scheduler.run(self.root, self.state, executor=confirmed), 0)
        self.assertEqual(ids[0], ids[1])
        self.assertFalse((self.state / 'pending.json').exists())
        self.assertEqual(json.loads((self.state / 'last.json').read_text())['id'], ids[0])

    def test_failed_receipt_blocks_automatic_new_scan_and_requires_matching_id(self):
        failed = []
        def fail(root, key):
            failed.append(key)
            return self.receipt(key, 'failed')
        self.assertEqual(scheduler.run(self.root, self.state, executor=fail), 1)
        for resume in [None, 'wrong']:
            with self.assertRaises(scheduler.PendingError):
                scheduler.run(self.root, self.state, resume, executor=lambda *_: self.fail('unexpected scan'))
        ids = []
        def success(root, key):
            ids.append(key)
            return self.receipt(key)
        scheduler.run(self.root, self.state, failed[0], executor=success)
        self.assertNotEqual(ids[0], failed[0])

    def test_corrupt_state_never_invents_new_id(self):
        self.state.mkdir()
        (self.state / 'pending.json').write_text('{"id":"not-a-uuid","status":"pending"}')
        with self.assertRaises(scheduler.PendingError):
            scheduler.run(self.root, self.state, executor=lambda *_: self.fail('unexpected scan'))

    def test_live_lock_skips_second_invocation(self):
        self.state.mkdir()
        with (self.state / 'lock').open('a') as first:
            fcntl.flock(first, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(scheduler.run(self.root, self.state, executor=lambda *_: self.fail('unexpected scan')), 0)

    def test_lost_confirmation_after_last_write_reuses_original_uuid(self):
        ids = []
        def success(root, key):
            ids.append(key)
            return self.receipt(key)
        real = scheduler.atomic_json
        def failure(path, value):
            if path.name == 'last.json':
                raise OSError('disk full')
            real(path, value)
        with patch.object(scheduler, 'atomic_json', failure), self.assertRaises(OSError):
            scheduler.run(self.root, self.state, executor=success)
        scheduler.run(self.root, self.state, executor=success)
        self.assertEqual(ids[0], ids[1])

    def test_invoke_accepts_only_exact_compact_receipt_and_scoped_command(self):
        key = '1b90d95e-8b54-4b3a-b922-4c829fe4307e'
        def completed(command, **kwargs):
            self.assertEqual(command[:7], ['docker', 'compose', '--project-directory', '/opt/tsukenya', '-p', 'tsukenya', 'exec'])
            self.assertIn('--receipt-json', command)
            self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
            kwargs['stdout'].write(json.dumps(self.receipt(key)).encode())
            return subprocess.CompletedProcess(command, 0)
        with patch.object(scheduler.subprocess, 'run', completed):
            self.assertEqual(scheduler.invoke(self.root, key), self.receipt(key))
        for body in [b'not-json', json.dumps(self.receipt('other')).encode(), b'x' * 4097]:
            def bad(command, **kwargs):
                kwargs['stdout'].write(body)
                return subprocess.CompletedProcess(command, 0)
            with patch.object(scheduler.subprocess, 'run', bad), self.assertRaises(scheduler.PendingError):
                scheduler.invoke(self.root, key)

