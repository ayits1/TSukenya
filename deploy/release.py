"""Release one Git commit of TSukenya to /opt/tsukenya; run on the VPS as root.

Usage (archive made on a workstation with `git archive --format=tar.gz -o tsukenya-<sha>.tar.gz <sha>`):
    python3 deploy/release.py releases/tsukenya-<sha>.tar.gz            # release
    python3 deploy/release.py releases/tsukenya-<sha>.tar.gz --check    # validate and show the plan only

Scope is this project only: the code paths below in /opt/tsukenya and the `web` service of the
`tsukenya` Compose project, started with --no-deps. It never touches .env, .env.database, .private,
storage, the PostgreSQL container or volume, the shared Caddy gateway or any other project.
The commit SHA is written to server/RELEASE; /health reports it, so the running version is visible.
"""
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
import argparse
import fcntl
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path(os.environ.get('TSUKENYA_ROOT', '/opt/tsukenya'))
PROJECT = 'tsukenya'
COMPOSE = ['docker', 'compose', '-p', PROJECT, '-f', 'compose.production.yaml']
WEB = 'tsukenya-web-1'
PUBLIC_HEALTH = os.environ.get('TSUKENYA_PUBLIC_HEALTH', 'https://tsukernya.pp.ua/health')
# Everything the web image is built from. Replaced as a whole, so files deleted in Git disappear too.
CODE = ['app', 'server', 'frontend', 'tools', 'contracts', 'data', 'deploy', 'manage.py',
        'package.json', 'package-lock.json', '.npmrc', '.nvmrc', '.dockerignore']
# compose.production.yaml stays as on the server unless --with-compose: it holds the live service limits.
NEVER = {'.env', '.env.database', '.private', 'storage', 'backups', 'releases'}


def fail(message):
    print(f'ПОМИЛКА: {message}', file=sys.stderr)
    sys.exit(1)


def run(*command, **options):
    print('$', ' '.join(command))
    return subprocess.run(command, cwd=ROOT, check=True, **options)


def commit_of(archive):
    """SHA recorded by `git archive` (pax comment) or, for archives made by this script, server/RELEASE.

    A pre-release archive of code that predates server/RELEASE has no SHA; it can still be restored."""
    with tarfile.open(archive) as tar:
        sha = tar.pax_headers.get('comment', '')
        if not sha:
            try:
                sha = json.loads(tar.extractfile('server/RELEASE').read())['commit']
            except (KeyError, AttributeError, ValueError):
                sha = ''
    if not sha and archive.name.startswith('pre-'):
        return None
    if len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
        fail('В архіві немає SHA коміту. Створіть його командою git archive з конкретного коміту.')
    return sha


def unpack(archive, target, paths):
    """Extract only regular files and directories under the release paths; reject anything else."""
    with tarfile.open(archive) as tar:
        members = []
        for member in tar.getmembers():
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts:
                fail(f'Небезпечний шлях в архіві: {member.name}')
            if not name.parts or name.parts[0] in NEVER:
                if name.parts:
                    fail(f'Архів містить приватний шлях {member.name}; такий архів не розгортаємо.')
                continue
            if name.parts[0] not in paths:
                continue
            if not (member.isfile() or member.isdir()):
                fail(f'Архів містить посилання або спецфайл: {member.name}')
            members.append(member)
        try:
            tar.extractall(target, members=members, filter='data')
        except TypeError:  # Python without extraction filters; members are already restricted above.
            tar.extractall(target, members=members)
    missing = [p for p in ('app', 'server', 'frontend', 'manage.py', 'package.json') if not (target / p).exists()]
    if missing:
        fail('В архіві бракує ' + ', '.join(missing))


def health(command):
    output = subprocess.run(command, capture_output=True, text=True, timeout=20)
    if output.returncode:
        return None
    try:
        return json.loads(output.stdout)
    except ValueError:
        return None


def internal_health():
    probe = "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=3).read().decode())"
    return health(['docker', 'exec', WEB, 'python', '-c', probe])


def public_health():
    try:
        with urllib.request.urlopen(PUBLIC_HEALTH, timeout=10) as response:
            return json.loads(response.read())
    except (OSError, ValueError):
        return None


def main():
    parser = argparse.ArgumentParser(description='Розгортання одного коміту Цукерні.')
    parser.add_argument('archive', type=Path)
    parser.add_argument('--check', action='store_true', help='лише перевірити архів і показати план')
    parser.add_argument('--with-compose', action='store_true', help='також замінити compose.production.yaml')
    parser.add_argument('--skip-backup', action='store_true', help='лише для повторного запуску одразу після копії')
    parser.add_argument('--no-public-check', action='store_true')
    args = parser.parse_args()
    archive = args.archive.resolve()
    if not archive.is_file():
        fail(f'Архів не знайдено: {archive}')
    paths = CODE + (['compose.production.yaml'] if args.with_compose else [])
    sha = commit_of(archive)
    releases = ROOT / 'releases'
    releases.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    with open(releases / '.release.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail('Інший реліз уже виконується.')
        with tempfile.TemporaryDirectory(dir=releases, prefix='.unpack-') as temporary:
            staging = Path(temporary) / 'code'
            staging.mkdir()
            unpack(archive, staging, paths)
            if sha:
                (staging / 'server' / 'RELEASE').write_text(json.dumps({'commit': sha, 'released_at': stamp}) + '\n')
            before = internal_health()
            print(f'Коміт: {sha or "код до запису версії (відкат)"}\nЗараз працює: {(before or {}).get("release", "невідомо")}')
            print('Буде замінено: ' + ', '.join(p for p in paths if (staging / p).exists()))
            if args.check:
                run(*COMPOSE, 'config', '--quiet')
                print('Перевірка пройдена; змін не зроблено.')
                return
            if not args.skip_backup:
                backup = ROOT / 'backup.py' if (ROOT / 'backup.py').exists() else ROOT / 'deploy' / 'backup.py'
                run(sys.executable, str(backup))
            previous = releases / f'pre-{stamp}.tar.gz'
            with tarfile.open(previous, 'w:gz') as tar:
                for path in paths:
                    if (ROOT / path).exists():
                        tar.add(ROOT / path, arcname=path)
            os.chmod(previous, 0o600)
            print(f'Попередній код: {previous}')
            rollback = f'python3 {ROOT}/deploy/release.py {previous}'
            replaced = Path(temporary) / 'replaced'
            replaced.mkdir()
            try:
                for path in paths:
                    if (ROOT / path).exists():
                        shutil.move(str(ROOT / path), str(replaced / path))
                    if (staging / path).exists():
                        shutil.move(str(staging / path), str(ROOT / path))
            except OSError as error:
                fail(f'Заміну коду перервано ({error}); контейнер не перезапускався. Відновіть код: {rollback}')
            try:
                run(*COMPOSE, 'config', '--quiet', stdout=subprocess.DEVNULL)
                run(*COMPOSE, 'up', '-d', '--build', '--no-deps', 'web')
            except subprocess.CalledProcessError:
                fail(f'Збірка або запуск не вдалися; працює попередній контейнер. Відкат коду: {rollback}')
            for _ in range(60):
                state = internal_health()
                if state and (state.get('release') == sha if sha else state.get('status') == 'ok'):
                    break
                time.sleep(5)
            else:
                fail(f'/health не показав коміт {sha} за 5 хвилин. Логи: docker compose -p {PROJECT} -f compose.production.yaml logs --tail 100 web. Відкат коду (БД не відновлюється): {rollback}')
            print(f'Внутрішній /health: {state}')
            (releases / 'CURRENT').write_text(json.dumps({'commit': sha, 'released_at': stamp, 'previous': previous.name}) + '\n')
            if not args.no_public_check:
                public = public_health()
                if not public or (public.get('release') != sha if sha else public.get('status') != 'ok'):
                    fail(f'Застосунок працює, але {PUBLIC_HEALTH} відповідає {public}. Перевірте Caddy в /opt/edge.')
                print(f'Публічний /health: {public}')
            print(f'Готово: працює {sha}. Відкат коду за потреби: {rollback}')


if __name__ == '__main__':
    main()
