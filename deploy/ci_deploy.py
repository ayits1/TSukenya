#!/usr/bin/env python3
"""SSH forced command for the GitHub Actions deploy key; installed on the VPS by setup_ci_deploy.sh.

The key in /root/.ssh/authorized_keys can only run this program. It accepts exactly one of:
    status              show the running commit and the last release
    check <sha>         read a `git archive` of <sha> from stdin and run release.py --check
    release <sha>       the same, then release it (backup, code swap, rebuild web, health)
Anything else is refused. It touches nothing outside /opt/tsukenya and the tsukenya web service,
because release.py does not; this program only receives the archive and calls it.
"""
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(os.environ.get('TSUKENYA_ROOT', '/opt/tsukenya'))
RELEASES = ROOT / 'releases'
LIMIT = 300 * 1024 * 1024
SHA = re.compile(r'[0-9a-f]{40}')


def log(line):
    RELEASES.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    with open(RELEASES / 'ci-deploy.log', 'a') as output:
        output.write(f'{stamp} {os.environ.get("SSH_CLIENT", "-").split(" ")[0]} {line}\n')


def refuse(message):
    log(f'refused: {message}')
    print(f'ПОМИЛКА: {message}', file=sys.stderr)
    sys.exit(2)


def status():
    current = RELEASES / 'CURRENT'
    print('Останній реліз:', current.read_text().strip() if current.exists() else 'ще не було релізу через скрипт')
    probe = "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=3).read().decode())"
    result = subprocess.run(['docker', 'exec', 'tsukenya-web-1', 'python', '-c', probe], capture_output=True, text=True, timeout=30)
    print('Працює зараз (/health):', result.stdout.strip() or result.stderr.strip())
    return result.returncode


def receive(sha):
    archive = RELEASES / f'tsukenya-{sha}.tar.gz'
    partial = archive.with_suffix('.partial')
    size = 0
    RELEASES.mkdir(mode=0o700, exist_ok=True)
    with open(partial, 'wb') as output:
        os.chmod(partial, 0o600)
        while chunk := sys.stdin.buffer.read(1024 * 1024):
            size += len(chunk)
            if size > LIMIT:
                partial.unlink()
                refuse('архів завеликий')
            output.write(chunk)
    try:
        with tarfile.open(partial) as tar:
            recorded = tar.pax_headers.get('comment', '')
    except tarfile.TarError:
        partial.unlink()
        refuse('отримано пошкоджений архів')
    if recorded != sha:
        partial.unlink()
        refuse(f'архів містить коміт {recorded or "без SHA"}, а запитано {sha}')
    partial.rename(archive)
    return archive


def main():
    words = os.environ.get('SSH_ORIGINAL_COMMAND', '').split()
    if words == ['status']:
        log('status')
        sys.exit(status())
    if len(words) != 2 or words[0] not in {'check', 'release'} or not SHA.fullmatch(words[1]):
        refuse('дозволено лише: status | check <sha> | release <sha>')
    mode, sha = words
    archive = receive(sha)
    log(f'{mode} {sha}')
    with tempfile.TemporaryDirectory() as temporary:
        # The release script of the same commit; it validates the archive again before any change.
        with tarfile.open(archive) as tar:
            member = tar.getmember('deploy/release.py')
            if not member.isfile():
                refuse('deploy/release.py в архіві не є файлом')
            script = Path(temporary) / 'release.py'
            script.write_bytes(tar.extractfile(member).read())
        command = [sys.executable, str(script), str(archive)] + (['--check'] if mode == 'check' else [])
        code = subprocess.run(command, env={**os.environ, 'TSUKENYA_ROOT': str(ROOT)}).returncode
    log(f'{mode} {sha} exit={code}')
    sys.exit(code)


if __name__ == '__main__':
    main()
