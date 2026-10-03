"""Database selection: the production image refuses to run on SQLite; tests and local runs keep it."""
import os
import subprocess
import sys
from pathlib import Path
from unittest import TestCase

ROOT = Path(__file__).resolve().parents[1]
PROBE = "import django;django.setup();from django.db import connection;print(connection.vendor)"


class DatabaseSelectionTests(TestCase):
    def settings(self, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith('DB_') and k != 'TSUKENYA_REQUIRE_POSTGRES'}
        env.update(DJANGO_SETTINGS_MODULE='server.settings', ERP_DB_PATH=os.devnull, **extra)
        return subprocess.run([sys.executable, '-c', PROBE], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)

    def test_production_image_without_postgres_fails_fast(self):
        result = self.settings(TSUKENYA_REQUIRE_POSTGRES='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('лише з PostgreSQL', result.stderr)

    def test_local_and_test_runs_keep_sqlite(self):
        result = self.settings()
        self.assertEqual((result.returncode, result.stdout.strip()), (0, 'sqlite'), result.stderr)

    def test_production_image_selects_postgres_when_configured(self):
        result = self.settings(TSUKENYA_REQUIRE_POSTGRES='1', DB_HOST='127.0.0.1', DB_PASSWORD='x', DJANGO_SECRET_KEY='k' * 50)
        self.assertEqual((result.returncode, result.stdout.strip()), (0, 'postgresql'), result.stderr)

    def test_image_declares_the_requirement(self):
        self.assertIn('TSUKENYA_REQUIRE_POSTGRES=1', (ROOT / 'server' / 'Dockerfile').read_text())
