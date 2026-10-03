"""deploy/release.py end to end in a temporary /opt/tsukenya with a fake docker; no server is touched."""
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from unittest import TestCase

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy' / 'release.py'
SHA = 'a' * 40
FAKE_DOCKER = r'''#!/bin/sh
# compose ... up: the "container" starts serving whatever server/RELEASE the code now holds.
echo "$*" >> "$FAKE/calls"
case "$*" in
  *" up "*) [ -f "$FAKE/stuck" ] || cp "$TSUKENYA_ROOT/server/RELEASE" "$FAKE/running" 2>/dev/null || rm -f "$FAKE/running"; exit 0;;
  *"exec tsukenya-web-1"*)
    if [ -f "$FAKE/running" ]; then python3 -c "import json,sys;print(json.dumps({'status':'ok','release':json.load(open(sys.argv[1]))['commit']}))" "$FAKE/running";
    else echo '{"status": "ok", "release": "unknown"}'; fi;;
esac
'''


def archive(path, files, sha=SHA):
    with tarfile.open(path, 'w:gz', format=tarfile.PAX_FORMAT, pax_headers={'comment': sha} if sha else {}) as tar:
        for name, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))


CODE = {'app/index.html': 'new', 'server/start.sh': 'new', 'frontend/package.json': '{}', 'manage.py': 'new',
        'package.json': '{}', 'deploy/release.py': 'copy'}


class ReleaseScriptTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.root, self.fake, bin_dir = base / 'opt', base / 'fake', base / 'bin'
        for d in (self.root, self.fake, bin_dir):
            d.mkdir()
        docker = bin_dir / 'docker'
        docker.write_text(FAKE_DOCKER)
        docker.chmod(0o755)
        for name, content in {'app/index.html': 'old', 'app/stale.js': 'old', 'server/start.sh': 'old', 'frontend/package.json': '{}',
                              'manage.py': 'old', 'package.json': '{}', '.env': 'SECRET=1', 'storage/db': 'data',
                              'compose.production.yaml': 'server compose', 'backup.py': f'open({str(self.fake / "backup")!r},"w").write("done")'}.items():
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_text(content)
        self.env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'TSUKENYA_ROOT': str(self.root), 'FAKE': str(self.fake)}

    def tearDown(self):
        self.tmp.cleanup()

    def release(self, path, *flags):
        return subprocess.run([sys.executable, str(SCRIPT), str(path), '--no-public-check', *flags], env=self.env, capture_output=True, text=True, timeout=120)

    def text(self, name):
        return (self.root / name).read_text()

    def test_check_changes_nothing(self):
        path = self.root / 'releases-in.tar.gz'
        archive(path, CODE)
        result = self.release(path, '--check')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(SHA, result.stdout)
        self.assertEqual((self.text('app/index.html'), self.text('app/stale.js')), ('old', 'old'))
        self.assertFalse((self.fake / 'backup').exists())

    def test_release_replaces_code_only_and_reports_the_commit(self):
        path = self.root / 'in.tar.gz'
        archive(path, {**CODE, '.env.example': 'ignored', 'docs/x.md': 'ignored'})
        result = self.release(path)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(self.text('app/index.html'), 'new')
        self.assertFalse((self.root / 'app/stale.js').exists(), 'files deleted in Git disappear')
        self.assertEqual((self.text('.env'), self.text('storage/db'), self.text('compose.production.yaml')), ('SECRET=1', 'data', 'server compose'))
        self.assertFalse((self.root / 'docs').exists())
        self.assertEqual(json.loads(self.text('server/RELEASE'))['commit'], SHA)
        self.assertEqual(json.loads(self.text('releases/CURRENT'))['commit'], SHA)
        self.assertEqual((self.fake / 'backup').read_text(), 'done')
        calls = (self.fake / 'calls').read_text()
        self.assertIn('compose -p tsukenya -f compose.production.yaml up -d --build --no-deps web', calls)
        # The automatic pre-release archive restores the previous code, which predates server/RELEASE.
        previous = next((self.root / 'releases').glob('pre-*.tar.gz'))
        restored = self.release(previous, '--skip-backup')
        self.assertEqual(restored.returncode, 0, restored.stderr + restored.stdout)
        self.assertEqual((self.text('app/index.html'), self.text('app/stale.js')), ('old', 'old'))
        self.assertFalse((self.root / 'server/RELEASE').exists())

    def test_unsafe_or_unversioned_archives_are_refused_before_any_change(self):
        cases = {'private': ({**CODE, '.env': 'x'}, SHA, 'приватний шлях'), 'traversal': ({**CODE, 'app/../../etc/x': 'x'}, SHA, 'Небезпечний шлях'),
                 'no sha': (CODE, None, 'немає SHA'), 'incomplete': ({'app/index.html': 'new'}, SHA, 'бракує')}
        for label, (files, sha, message) in cases.items():
            with self.subTest(label):
                path = self.root / f'{label}.tar.gz'
                archive(path, files, sha)
                result = self.release(path)
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)
                self.assertEqual(self.text('app/index.html'), 'old')
                self.assertFalse((self.fake / 'backup').exists())

    def test_unhealthy_release_stops_with_rollback_command(self):
        (self.fake / 'stuck').write_text('')
        path = self.root / 'in.tar.gz'
        archive(path, CODE)
        script = SCRIPT.read_text().replace('range(60)', 'range(1)').replace('time.sleep(5)', 'time.sleep(0)')
        patched = Path(self.tmp.name) / 'release.py'
        patched.write_text(script)
        result = subprocess.run([sys.executable, str(patched), str(path), '--no-public-check'], env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn('не показав коміт', result.stderr)
        self.assertIn('deploy/release.py', result.stderr)
        self.assertFalse((self.root / 'releases/CURRENT').exists())


from django.test import TestCase as DjangoTestCase


class HealthReleaseTests(DjangoTestCase):
    def test_health_reports_the_released_commit(self):
        from server.erp import views
        from server.erp.models import LedgerLock
        LedgerLock.objects.create(pk=1)
        self.assertEqual(self.client.get('/health').json()['release'], views.release_commit())
        marker = views.ROOT / 'server' / 'RELEASE'
        self.assertFalse(marker.exists(), 'a working copy carries no release marker')
        self.assertEqual(views.release_commit(), 'unknown')
        try:
            marker.write_text(json.dumps({'commit': SHA, 'released_at': '20261003T000000Z'}))
            self.assertEqual(views.release_commit(), SHA)
        finally:
            marker.unlink(missing_ok=True)
