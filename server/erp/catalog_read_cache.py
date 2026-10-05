"""Private derived read indexes, never a revision baseline or permission grant.

Every caller has already entered a fresh actor/store READ ONLY RR snapshot. The
key and index are produced in that SAME snapshot. GET performs no database DML.
Only cache files may be written. POST never enters this module.
"""
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import tempfile
import time
from django.conf import settings
from django.db import connection
from django.db.models import Q, Subquery, OuterRef, Value, CharField
from django.db.models.functions import Cast, Concat, Coalesce
from django.db.models.expressions import RawSQL
from .models import StateVersion, PromotionCampaign

SCHEMA = 'catalogue-read-index-v1'
MAX_FILES = 32
MAX_BYTES = 512 * 1024 * 1024
MAX_WAIT = 2.0
MAX_AGE = 3600
_CODE = hashlib.sha256(b''.join(Path(__file__).with_name(name).read_bytes() for name in
    ('catalog_read_cache.py', 'catalog_selection.py', 'promotion_prices.py', 'catalog.py'))).hexdigest()


class CacheUnavailable(Exception):
    pass


def bounded_lock(handle, operation):
    started = time.monotonic()
    while True:
        try: fcntl.flock(handle, operation | fcntl.LOCK_NB); return
        except BlockingIOError:
            if time.monotonic() - started >= MAX_WAIT:
                raise CacheUnavailable('Перегляд каталогу готується. Повторіть читання.')
            time.sleep(.02)


def root():
    database = connection.settings_dict
    namespace = hmac.new(settings.SECRET_KEY.encode(), json.dumps([SCHEMA, database['ENGINE'],
        database['NAME'], database.get('HOST'), database.get('PORT')], default=str).encode(), hashlib.sha256).hexdigest()[:24]
    path = Path(getattr(settings, 'CATALOGUE_READ_CACHE_DIR', tempfile.gettempdir())) / ('tsukenya-read-' + namespace)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise CacheUnavailable('Небезпечний каталог derived cache; повторіть читання після перевірки сервера.')
    return path


def key(selection):
    """No public validator: hidden/private counter activity is not sent to users."""
    identity = [SCHEMA, _CODE, selection.user.profile.role, selection.user.profile.store_id,
        selection.visibility, selection.params.get('q', '').strip()[:250].split(), bool(selection.params.get('promotion'))]
    signer = hmac.new(settings.SECRET_KEY.encode(), digestmod=hashlib.sha256)
    def frame(value):
        encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, default=str).encode()
        signer.update(len(encoded).to_bytes(8, 'big')); signer.update(encoded)
    frame(identity)
    # catalog is atomic on all product create/edit/delete/direct/bulk writes.
    version = StateVersion.objects.filter(pk='catalog')
    if connection.vendor == 'postgresql':
        value = version.annotate(origin=RawSQL('xmin::text', ())).values_list('revision', 'origin').first()
    else: value = version.values_list('revision', flat=True).first()
    frame(['catalog', value or 0])
    if selection.params.get('promotion'):
        frame(['price', selection.store.pk if selection.store else None, selection.day, selection.config])
        area = Q(scope='network')
        if selection.store is not None: area |= Q(scope='stores', stores=selection.store.pk)
        current = PromotionCampaign.objects.filter(area, active=True, archived=False,
            starts_on__lte=selection.day, ends_on__gte=selection.day).annotate(
                state_key=Concat(Value('campaign:'), Cast('pk', CharField()))).annotate(
                state_revision=Coalesce(Subquery(StateVersion.objects.filter(pk=OuterRef('state_key')).values('revision')[:1]), Value(0)))
        # IDs with revision0 protect pre-counter campaigns/deletion, and current
        # membership selection protects transactions committing across midnight.
        for row in current.order_by('pk').values_list('pk', 'state_revision').distinct().iterator(chunk_size=200): frame(['campaign', *row])
    return signer.hexdigest()


def attach(selection, path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    handle = os.fdopen(descriptor, 'rb')
    database = None
    try:
        bounded_lock(handle, fcntl.LOCK_SH)
        # Eviction respects this shared lock. Reject a replaced inode before
        # opening SQLite by name; publication never overwrites a live key.
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise CacheUnavailable('Некоректний файл derived cache.')
        if info.st_ino != path.stat().st_ino: raise FileNotFoundError(path)
        database = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
        database.execute('PRAGMA cache_size=-2048'); database.execute('PRAGMA temp_store=FILE')
        database.execute('SELECT position,path,type,category,pack,type_label,category_label,pack_label,promoted FROM items LIMIT 0')
        database.execute('SELECT field,parent1,parent2,promoted,value,folded FROM facets LIMIT 0')
        selection.db = database
        selection._cache_handle = handle
        selection._cache_path = path
        return True
    except BaseException:
        if database is not None: database.close()
        handle.close()
        raise


def trim(directory, needed):
    """Called under the one publication lock; never remove locked reader files."""
    files = sorted(directory.glob('*.sqlite3'), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    count = len(files)
    for path in files:
        size = path.stat().st_size
        if count < MAX_FILES and total + needed <= MAX_BYTES and time.time() - path.stat().st_mtime < MAX_AGE: continue
        with open(path, 'rb') as handle:
            try: fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: continue
            path.unlink(); count -= 1; total -= size
    if count >= MAX_FILES or total + needed > MAX_BYTES:
        raise CacheUnavailable('Derived cache зайнятий або досяг ліміту диска. Повторіть читання.')


def load(selection, build):
    directory = root()
    token = key(selection)
    final = directory / (token + '.sqlite3')
    try:
        if final.exists() and 0 <= time.time() - final.stat().st_mtime < MAX_AGE: return attach(selection, final)
    except (FileNotFoundError, sqlite3.DatabaseError): pass
    # A single constant lock file prevents unbounded per-key lock proliferation.
    descriptor = os.open(directory / 'publish.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'rb') as lock:
        bounded_lock(lock, fcntl.LOCK_EX)
        if final.exists():
            if 0 <= time.time() - final.stat().st_mtime < MAX_AGE:
                try: return attach(selection, final)
                except sqlite3.DatabaseError: pass
            with open(final, 'rb') as expired:
                try: fcntl.flock(expired, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError: raise CacheUnavailable('Індекс каталогу ще читається. Повторіть запит.')
                final.unlink()
        # Only OUR private namespace is cleaned, with publication/build excluded
        # by this constant lock. Interrupted builds never become eligible reads.
        for orphan in directory.glob('.publish-*'): orphan.unlink()
        for orphan in directory.glob('.build-*'): shutil.rmtree(orphan)
        # Cold build's private database is bounded by Selection.MAX_DISK. Its
        # connection closes before copying; atomic publish uses this RR's key.
        # Reserve the worst-case single image BEFORE building. Journal/sort
        # scratch is disabled by the disposable builder's indexed-query design.
        from .catalog_selection import MAX_DISK
        trim(directory, MAX_DISK)
        build(directory)
        selection.db.close(); del selection.db
        source = Path(selection.directory.name) / 'selection.sqlite3'
        # Same filesystem, no second image/copy peak. The source is complete,
        # closed and fsynced; its containing private directory remains disposable.
        with open(source, 'rb') as handle: os.fsync(handle.fileno())
        os.replace(source, final)
        return attach(selection, final)
