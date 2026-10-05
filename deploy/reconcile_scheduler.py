"""One scoped reconciliation invocation; retain the UUID until receipt confirmation."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid


class PendingError(Exception):
    pass


def canonical_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('Invalid run ID')
    return value


def atomic_json(path, value):
    temporary = path.with_suffix('.partial')
    with temporary.open('w', encoding='utf-8') as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output, separators=(',', ':'))
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def invoke(root, run_id):
    # No gateway, worker restart, migration or PostgreSQL container operation.
    command = ['docker', 'compose', '--project-directory', str(root), '-p', 'tsukenya',
               'exec', '-T', 'web', 'python', 'manage.py', 'reconcile', '--record',
               '--source', 'scheduler', '--run-id', run_id, '--receipt-json']
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.DEVNULL,
                                timeout=1800, check=False)
        output.seek(0)
        body = output.read(4097)
    if len(body) > 4096:
        raise PendingError('Некоректне підтвердження; ID збережено для повтору.')
    try:
        receipt = json.loads(body)
        expected = {'contract', 'id', 'source', 'status', 'checksVersion', 'issues'}
        if (not isinstance(receipt, dict) or set(receipt) != expected
                or receipt['contract'] != 'reconciliation-receipt-v1'
                or receipt['id'] != run_id or receipt['source'] != 'scheduler'
                or receipt['status'] not in {'clean', 'discrepancies', 'failed'}
                or type(receipt['checksVersion']) is not int or receipt['checksVersion'] < 1
                or type(receipt['issues']) is not int or receipt['issues'] < 0
                or (receipt['status'] == 'clean' and receipt['issues'] != 0)
                or result.returncode != (0 if receipt['status'] == 'clean' else 1)):
            raise ValueError()
    except (ValueError, TypeError, UnicodeDecodeError):
        raise PendingError('Підтвердження не отримано; наступний запуск повторить той самий ID.') from None
    return receipt


def run(root, state, resume_failed=None, executor=invoke):
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    pending_path = state / 'pending.json'
    with (state / 'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # A live invocation already owns this scheduled slot.
        if pending_path.exists():
            try:
                pending = json.loads(pending_path.read_text())
                if set(pending) != {'id', 'status'} or pending['status'] not in {'pending', 'failed'}:
                    raise ValueError()
                canonical_id(pending['id'])
            except (ValueError, TypeError, KeyError):
                raise PendingError('Пошкоджений стан запуску; автоматичний новий ID заборонений.') from None
        else:
            pending = None
        if resume_failed is not None:
            if pending != {'id': resume_failed, 'status': 'failed'}:
                raise PendingError('ID не відповідає підтвердженому невдалому запуску.')
            pending = None
        if pending and pending['status'] == 'failed':
            raise PendingError('Попередня звірка не завершилась. Перегляньте журнал перед новою спробою.')
        if pending is None:
            pending = {'id': str(uuid.uuid4()), 'status': 'pending'}
            atomic_json(pending_path, pending)  # Must reach disk before docker starts.
        receipt = executor(root, pending['id'])
        atomic_json(state / 'last.json', receipt)
        if receipt['status'] == 'failed':
            atomic_json(pending_path, {'id': pending['id'], 'status': 'failed'})
        else:
            pending_path.unlink()
            sync_directory(state)
        print(f"Звірка {receipt['id']}: {receipt['status']}; результат у журналі застосунку.")
        return 0 if receipt['status'] == 'clean' else 1


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/opt/tsukenya'))
    parser.add_argument('--state', type=Path, default=Path('/opt/tsukenya/ops/reconcile'))
    parser.add_argument('--resume-failed', help='Explicitly permit a new scan after reviewing this failed UUID.')
    args = parser.parse_args()
    try:
        return run(args.root, args.state, args.resume_failed)
    except (PendingError, OSError, subprocess.TimeoutExpired):
        # Do not expose subprocess output, database credentials or business details.
        print('Звірку не підтверджено або заблоковано. Збережений ID не змінено; перевірте стан запуску.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
