"""Private complete report images. Callers hold fresh-actor READ ONLY RR.

A cache hit is never an authority or a permission grant. The SAME RR produces
its counter key and complete image. No source writes, partial or stale serving.
"""
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import time
from contextlib import contextmanager, nullcontext
from django.conf import settings
from django.db import connection, DatabaseError
from django.db.models.expressions import RawSQL
from .models import TradingVersion

SCHEMA = 'report-result-image-v1'
_CODE = hashlib.sha256(b''.join(Path(__file__).with_name(name).read_bytes() for name in (
    'report_result_cache.py', 'bounded_reports.py', 'abc_reports.py', 'report_children.py',
    'historical_reports.py', 'report_contributions.py', 'payroll_chronology.py',
    'settlements.py', 'settlement_reads.py', 'services.py', 'csv_format.py', 'browsing.py'))).hexdigest()
DEFAULTS = {'IMAGE_BYTES':128*1024*1024, 'TOTAL_BYTES':512*1024*1024,
            'FILES':32, 'TTL':300, 'LOCK_SECONDS':2, 'ACTION_SECONDS':120, 'STATEMENT_SECONDS':30}


class Unavailable(Exception):
    """Retryable technical read refusal, not a business validation failure."""


def limit(name):
    value = getattr(settings, 'REPORT_RESULT_CACHE_'+name, DEFAULTS[name])
    if (isinstance(value,bool) or not isinstance(value,(int,float)) or not 0<value<=DEFAULTS[name]
            or name in {'IMAGE_BYTES','TOTAL_BYTES','FILES'} and not isinstance(value,int)):
        raise Unavailable('Некоректна технічна межа кешу звітів.')
    return value


def check(deadline):
    if time.monotonic() >= deadline:
        raise Unavailable('Читання звіту перевищило технічний час. Повторіть запит.')


def lock(handle, operation, deadline):
    stop = min(deadline, time.monotonic()+limit('LOCK_SECONDS'))
    while True:
        try:fcntl.flock(handle, operation | fcntl.LOCK_NB);return
        except BlockingIOError:
            check(stop);time.sleep(.02)


def root():
    database=connection.settings_dict
    identity=[SCHEMA,database['ENGINE'],str(database['NAME']),database.get('HOST'),database.get('PORT')]
    namespace=hmac.new(settings.SECRET_KEY.encode(),json.dumps(identity).encode(),hashlib.sha256).hexdigest()[:24]
    path=Path(getattr(settings,'REPORT_RESULT_CACHE_DIR',tempfile.gettempdir()))/('tsukenya-reports-'+namespace)
    path.mkdir(mode=0o700,parents=True,exist_ok=True)
    info=path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o700:
        raise Unavailable('Приватний кеш звітів недоступний.')
    return path


def key(user, mode, params, stores, day):
    resources=['reports_abc'] if mode=='abc' else ['reports_'+mode]
    if mode!='abc' and user.profile.role in {'owner','accountant'}:resources.append('reports_salary')
    selected=params['store']
    keys=[]
    # Legacy foreign selection deliberately yields an empty report. It has no
    # source dependencies: never select a hidden foreign/global activity counter.
    for resource in resources if stores else []:
        prefix=resource+':'+user.profile.role+':'
        keys += [prefix+'global',prefix+('all' if selected is None else 'store:'+str(selected))]
    query=TradingVersion.objects.filter(pk__in=keys)
    query=query.annotate(origin=RawSQL('xmin::text',()))
    counters={k:(revision,origin) for k,revision,origin in query.values_list('key','revision','origin')}
    data=[SCHEMA,_CODE,user.pk,user.profile.role,user.profile.store_id,mode,params,
          [s.pk for s in stores],day.isoformat(),[(k,counters.get(k,(0,None))) for k in sorted(keys)]]
    return hmac.new(settings.SECRET_KEY.encode(),json.dumps(data,sort_keys=True,separators=(',',':')).encode(),hashlib.sha256).hexdigest()


def valid(path):
    age=time.time()-path.stat().st_mtime
    return 0<=age<limit('TTL')


def secure(handle):
    info=os.fstat(handle.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o600:
        raise Unavailable('Приватний образ звіту недоступний.')
    return info


@contextmanager
def attach(path, token, deadline):
    check(deadline)
    from .bounded_reports import Spool
    handle=os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb')
    try:
        lock(handle,fcntl.LOCK_SH,deadline)
        info=secure(handle)
        if info.st_ino!=path.stat().st_ino:raise FileNotFoundError(path)
        if info.st_size>limit('IMAGE_BYTES'):raise Unavailable('Образ звіту перевищує технічну межу.')
        with Spool(path=path,readonly=True,deadline=deadline) as spool:
            record=spool.db.execute('SELECT token,value FROM complete').fetchone()
            if record is None or record[0]!=token:raise sqlite3.DatabaseError('Incomplete result image')
            yield spool,json.loads(record[1])
    finally:handle.close()


def trim(directory, needed):
    """Under publish lock; reserve worst build size, never evict leased readers."""
    files=sorted(directory.glob('*.sqlite3'),key=lambda p:p.stat().st_mtime)
    total=sum(p.stat().st_size for p in files);count=len(files)
    for path in files:
        if count<limit('FILES') and total+needed<=limit('TOTAL_BYTES') and valid(path):continue
        with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as handle:
            secure(handle)
            try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:continue
            size=path.stat().st_size;path.unlink();total-=size;count-=1
    if count>=limit('FILES') or total+needed>limit('TOTAL_BYTES'):
        raise Unavailable('Кеш звітів зайнятий або досяг межі диска. Повторіть читання.')


def remove(path):
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as handle:
        secure(handle)
        try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise Unavailable('Попередній образ звіту ще читається. Повторіть запит.')
        path.unlink()


@contextmanager
def _image(user, mode, params, stores, day, populate, deadline=None):
    """populate(spool) uses existing accounting oracle; runs only on cache miss."""
    from .bounded_reports import Spool
    deadline=deadline if deadline is not None else time.monotonic()+limit('ACTION_SECONDS')
    check(deadline)
    # SQLite transactions/flush are not a durable PG counter identity guarantee.
    if connection.vendor!='postgresql' or getattr(settings,'REPORT_RESULT_CACHE_ENABLED',True) is False:
        with Spool(deadline=deadline) as spool:yield spool,populate(spool)
        return
    token=key(user,mode,params,stores,day);directory=root();final=directory/(token+'.sqlite3')
    hit=False
    try:
        if valid(final):
            # Don't catch an error thrown by the caller after yielding a valid image.
            with attach(final,token,deadline) as result:
                hit=True;yield result
            return
    except (FileNotFoundError,sqlite3.DatabaseError):
        if hit:raise
    publication=os.fdopen(os.open(directory/'publish.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600),'rb')
    with publication:
        secure(publication);lock(publication,fcntl.LOCK_EX,deadline)
        ready=final.exists() and valid(final)
        if final.exists() and not ready:remove(final)
        if not ready:
            # Only this namespace; same constant lock excludes other builders.
            for orphan in directory.glob('.build-*'):orphan.unlink()
            trim(directory,int(limit('IMAGE_BYTES')))
            fd,name=tempfile.mkstemp(prefix='.build-',dir=directory);os.close(fd);source=Path(name)
            try:
                with Spool(path=source,deadline=deadline,max_bytes=int(limit('IMAGE_BYTES'))) as spool:
                    data=populate(spool);check(deadline)
                    spool.db.execute('CREATE TABLE complete (token TEXT,value TEXT)')
                    spool.db.execute('INSERT INTO complete VALUES (?,?)',(token,json.dumps(data,ensure_ascii=False,separators=(',',':'))))
                    spool.db.commit()
                check(deadline)
                with open(source,'rb') as handle:os.fsync(handle.fileno())
                check(deadline)
                os.replace(source,final)
            except sqlite3.DatabaseError as exc:
                raise Unavailable('Похідний образ звіту перевищив технічну межу. Повторіть читання.') from exc
            finally:source.unlink(missing_ok=True)
    with attach(final,token,deadline) as result:yield result


@contextmanager
def image(user,mode,params,stores,day,populate,deadline=None):
    try:
        with _image(user,mode,params,stores,day,populate,deadline) as result:yield result
    except sqlite3.DatabaseError as exc:
        raise Unavailable('Похідний образ звіту недоступний або перевищив технічну межу. Повторіть читання.') from exc
    except OSError as exc:
        raise Unavailable('Приватний диск звітів недоступний. Повторіть читання.') from exc


@contextmanager
def read_limits():
    deadline=time.monotonic()+limit('ACTION_SECONDS')
    try:
        with statement_deadline() if connection.vendor=='postgresql' else nullcontext():
            yield deadline
    except DatabaseError as exc:
        if getattr(exc.__cause__,'sqlstate',None)=='57014':
            raise Unavailable('SQL читання звіту перевищило технічний час. Повторіть запит.') from exc
        raise


@contextmanager
def statement_deadline():
    """Read-only SQL setting, restored even for a caller-owned RR transaction."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT setting FROM pg_settings WHERE name='statement_timeout'");previous=cursor.fetchone()[0]
        milliseconds=max(1,int(limit('STATEMENT_SECONDS')*1000))
        if int(previous)>0:milliseconds=min(milliseconds,int(previous))
        cursor.execute("SELECT set_config('statement_timeout', %s, true)",(str(milliseconds),))
    failed=False
    try:yield
    except DatabaseError:
        failed=True;raise
    finally:
        # A failed SQL statement aborts its transaction: don't mask the original error.
        if not failed and not connection.needs_rollback:
            with connection.cursor() as cursor:cursor.execute("SELECT set_config('statement_timeout', %s, true)",(previous,))
