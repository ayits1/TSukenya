"""Opt-in isolated PostgreSQL HTTP detail/create/post/retry measurement.

Synthetic local data only. Creates a random QA test database, never reuses an existing
application DB. One Python process + Django Client threads; not a production SLA.
"""
import argparse
import hashlib
import json
import os
import platform
import re
import statistics
import subprocess
import sys
import threading
import time
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run-local-pg',action='store_true')
parser.add_argument('--output',required=True)
parser.add_argument('--detail-only',action='store_true',help='Reuse unchanged posting proof after a serializer-only patch.')
parser.add_argument('--samples',type=int,default=5)
parser.add_argument('--posting-lines',type=int,default=30)
args=parser.parse_args()
if not args.run_local_pg or (os.environ.get('DB_HOST'),os.environ.get('DB_PORT'),os.environ.get('DB_NAME'))!=('127.0.0.1','61144','tsukenya_b24_document_detail'):
    parser.error('Requires --run-local-pg and DB_HOST=127.0.0.1 DB_PORT=61144 DB_NAME=tsukenya_b24_document_detail; no arbitrary DB/server accepted')
if not 1<=args.samples<=20 or not 1<=args.posting_lines<=100:parser.error('samples1–20, posting-lines1–100')
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT));os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django
django.setup()
from django.contrib.auth.models import User
from django.db import connection,connections
from django.test import Client
from django.test.utils import setup_databases,teardown_databases
from django.utils import timezone
from server.erp.models import (Document,LedgerLock,Store,Profile,PortalSession,Warehouse,CashAccount,Counterparty,Voucher,VoucherLine,StockEntry,CashEntry,AuditEvent)
from server.erp import services,views

# A fresh random name avoids dropping any previous QA or application database.
qa_name='qa_tsukenya_b24_document_'+uuid.uuid4().hex[:12]
connection.settings_dict.setdefault('TEST',{})['NAME']=qa_name
old_config=setup_databases(verbosity=0,interactive=False,keepdb=False)
assert connection.settings_dict['NAME']==qa_name and connection.vendor=='postgresql'
local=threading.local();registry={};registry_lock=threading.Lock();observer_stop=threading.Event();observer_samples=[];observer_errors=[]
original_save,original_post=views.save_voucher,views.post_voucher


def service_probe(original):
    def measured(*values,**kwargs):
        started=time.perf_counter()
        try:return original(*values,**kwargs)
        finally:
            metrics=getattr(local,'metrics',None)
            if metrics is not None:metrics['service_ms']+=(time.perf_counter()-started)*1000
    return measured
views.save_voucher=service_probe(original_save);views.post_voucher=service_probe(original_post)


def client_for(index,role='owner'):
    c=Client();c.cookies['ts_session']=tokens[index] if role=='owner' else cashier_token;return c


def measure(client,method,path,body=None):
    metrics={'queries':0,'sql_ms':0.0,'service_ms':0.0,'ledger_select_ms':0.0,'ledger_selects':0,'tables':Counter(),'lock_wait_samples':0,'lock_wait_first':None,'lock_wait_last':None}
    connection.ensure_connection();pid=connection.connection.info.backend_pid
    local.metrics=metrics
    def trace(execute,sql,params,many,context):
        start=time.perf_counter()
        try:return execute(sql,params,many,context)
        finally:
            elapsed=(time.perf_counter()-start)*1000;metrics['queries']+=1;metrics['sql_ms']+=elapsed
            for table in set(re.findall(r'(?:FROM|JOIN|INTO|UPDATE) "([a-z0-9_]+)"',sql)):metrics['tables'][table]+=1
            if '"erp_ledgerlock"' in sql and 'FOR UPDATE' in sql:
                metrics['ledger_selects']+=1;metrics['ledger_select_ms']+=elapsed
    with registry_lock:registry[pid]=metrics
    started=time.perf_counter()
    try:
        with connection.execute_wrapper(trace):
            result=client.get(path) if method=='GET' else client.post(path,data=json.dumps(body),content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='synthetic-b24-only')
    finally:
        with registry_lock:registry.pop(pid,None)
        local.metrics=None
    metrics['elapsed_ms']=(time.perf_counter()-started)*1000
    assert result.status_code in {200,201},(method,path,result.status_code,result.content[:300])
    metrics['status']=result.status_code;metrics['bytes']=len(result.content);metrics['tables']=dict(metrics['tables'])
    metrics['outside_service_ms']=max(0,metrics['elapsed_ms']-metrics['service_ms'])
    metrics['service_less_ledger_select_ms']=max(0,metrics['service_ms']-metrics['ledger_select_ms'])
    first,last=metrics.pop('lock_wait_first'),metrics.pop('lock_wait_last')
    metrics['sampled_lock_span_ms']=(last-first)*1000 if first is not None else None
    metrics['dto_sha256']=hashlib.sha256(result.content).hexdigest()
    return result.json(),metrics


def observe_locks():
    try:
        conn=connections['default'];conn.ensure_connection()
        while not observer_stop.is_set():
            started=time.perf_counter()
            with conn.cursor() as cur:
                cur.execute('SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=%s AND pid<>pg_backend_pid()',[qa_name]);rows=cur.fetchall()
            at=time.perf_counter();locked=[]
            with registry_lock:
                for pid,typ,event in rows:
                    metric=registry.get(pid)
                    if typ=='Lock' and metric is not None:
                        metric['lock_wait_samples']+=1
                        if metric['lock_wait_first'] is None:metric['lock_wait_first']=at
                        metric['lock_wait_last']=at;locked.append({'pid':pid,'event':event})
            observer_samples.append({'at_ms':(at-observer_start)*1000,'sql_ms':(at-started)*1000,'waiting':locked})
            observer_stop.wait(.002)
    except BaseException as error:
        observer_errors.append(type(error).__name__)
    finally:connections.close_all()


def summary(rows):
    result={'samples':len(rows),'statuses':sorted(set(r['status'] for r in rows)),'queries':sorted(set(r['queries'] for r in rows)),'bytes':sorted(set(r['bytes'] for r in rows))}
    for key in ['elapsed_ms','sql_ms','service_ms','outside_service_ms','ledger_select_ms','service_less_ledger_select_ms']:
        values=sorted(r[key] for r in rows);result[key]={'median':round(statistics.median(values),3),'p95':round(values[min(len(values)-1,int(len(values)*.95))],3),'max':round(max(values),3)}
    result['observed_lock_wait_requests']=sum(r['lock_wait_samples']>0 for r in rows)
    result['lock_wait_samples']=sum(r['lock_wait_samples'] for r in rows)
    result['tables']=rows[0]['tables']
    return result


def body_for(kind,count,identity,*,reference=None):
    value={'kind':kind,'date':today,'store':store.pk,'warehouse':warehouse.pk,'idempotency_key':identity,'lines':[{'product':p.path.split('/',1)[1],'quantity':'10' if kind=='receipt' else '2','price':'10' if kind=='receipt' else '15','lot':identity[:8]+'-'+str(i) if kind=='receipt' else ''} for i,p in enumerate(products[:count])]}
    if kind=='receipt':value['party']=supplier.pk
    else:value.update(party=customer.pk,payload={'payments':[{'account':bank.pk,'amount':str(count*30)}]})
    if reference is not None:value['reference']=reference
    return value


def create_post(client,body):
    v,create=measure(client,'POST','/api/erp/vouchers',body)
    posted,post=measure(client,'POST',f"/api/erp/vouchers/{v['id']}/post",{'revision':v['revision']})
    assert posted['id']==v['id'] and posted['status']=='posted'
    return posted,create,post


try:
    LedgerLock.objects.create(pk=1);today=timezone.localdate().isoformat()
    store=Store.objects.create(name='QA B24 synthetic store');warehouse=Warehouse.objects.create(store=store,name='QA B24 synthetic warehouse')
    supplier=Counterparty.objects.create(name='QA B24 synthetic supplier',kind='supplier');customer=Counterparty.objects.create(name='QA B24 synthetic customer',kind='customer');bank=CashAccount.objects.create(store=store,name='QA B24 synthetic bank',kind='bank')
    tokens=[]
    for i in range(10):
        user=User.objects.create(username=f'qa-b24-owner-{i}');Profile.objects.create(user=user,role='owner',store=store)
        token=f'qa-b24-synthetic-{i}';PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=user,csrf='synthetic-b24-only',expires=int(time.time())+3600);tokens.append(token)
    cashier=User.objects.create(username='qa-b24-cashier');Profile.objects.create(user=cashier,role='cashier',store=store);cashier_token='qa-b24-synthetic-cashier';PortalSession.objects.create(token_hash=hashlib.sha256(cashier_token.encode()).hexdigest(),user=cashier,csrf='synthetic-b24-only',expires=int(time.time())+3600)
    Document.objects.create(path='settings/main',data={'defaultMarkup':50,'rounding':.5})
    products=Document.objects.bulk_create([Document(path=f'products/qa-b24-{i:03d}',data={'name':f'QA synthetic SKU {i:03d}','unit':'шт','cost':10,'markup':50,'manualPrice':False,'promotion':False}) for i in range(100)])
    details=[]
    # Use actual services for the seed, not hand-built posted financial facts.
    for count in [1,30,100]:
        owner=client_for(0);receipt,_,_=create_post(owner,body_for('receipt',count,str(uuid.uuid4())));sale,_,_=create_post(owner,body_for('sale',count,str(uuid.uuid4())))
        for kind,record,role in [('receipt',receipt,'owner'),('sale',sale,'owner'),('sale',sale,'cashier')]:
            client=client_for(0,role);path=f"/api/erp/vouchers/{record['id']}";initial,_=measure(client,'GET',path);samples=[]
            for _ in range(args.samples):
                value,metric=measure(client,'GET',path);assert value==initial;assert len(value['lines'])==count
                if role=='cashier':assert 'cost' not in value and all('cost' not in l for l in value['lines']) and all('value' not in m for m in value['movements'])
                samples.append(metric)
            details.append({'kind':kind,'role':role,'lines':count,'summary':summary(samples),'raw':samples})
    concurrency=[]
    if not args.detail_only:
        # First serialize route imports and warm a one-line write; exclude from statistics.
        create_post(client_for(0),body_for('receipt',1,str(uuid.uuid4())))
        for workers in [1,5,10]:
            barrier=threading.Barrier(workers);wave_finished=[[] for _ in range(args.samples)]
            observer_samples=[];observer_stop.clear();observer_start=time.perf_counter();observer=threading.Thread(target=observe_locks,daemon=True);observer.start()
            def worker(index):
                result=[]
                try:
                    client=client_for(index);connection.ensure_connection()
                    for wave in range(args.samples):
                        body=body_for('receipt',args.posting_lines,str(uuid.uuid4()));barrier.wait(timeout=120);wave_start=time.perf_counter()
                        posted,create,post=create_post(client,body)
                        audit_before=AuditEvent.objects.filter(subject=f"voucher/{posted['id']}").count()
                        again,create_retry=measure(client,'POST','/api/erp/vouchers',body)
                        retried,post_retry=measure(client,'POST',f"/api/erp/vouchers/{posted['id']}/post",{'revision':posted['revision']})
                        # Compare this document only: other unique worker documents may commit concurrently.
                        assert again['id']==retried['id']==posted['id'] and retried['posted_at']==posted['posted_at'] and again['lines']==retried['lines']==posted['lines']
                        assert VoucherLine.objects.filter(voucher_id=posted['id']).count()==args.posting_lines
                        assert StockEntry.objects.filter(voucher_id=posted['id']).count()==args.posting_lines
                        assert AuditEvent.objects.filter(subject=f"voucher/{posted['id']}").count()==audit_before==2
                        elapsed=time.perf_counter()-wave_start;wave_finished[wave].append(elapsed)
                        result.append({'worker':index,'wave':wave,'id':posted['id'],'cycle_ms':elapsed*1000,'create':create,'post':post,'create_retry':create_retry,'post_retry':post_retry})
                    return result
                except BaseException:barrier.abort();raise
                finally:connections.close_all()
            started=time.perf_counter()
            try:
                with ThreadPoolExecutor(max_workers=workers) as pool:cycles=[r for batch in pool.map(worker,range(workers)) for r in batch]
            finally:observer_stop.set();observer.join(timeout=10)
            assert not observer.is_alive() and not observer_errors, observer_errors
            wall=time.perf_counter()-started
            assert len({r['id'] for r in cycles})==workers*args.samples
            concurrency.append({'workers':workers,'waves':args.samples,'lines_per_document':args.posting_lines,'documents':len(cycles),'http_requests':len(cycles)*4,'wall_seconds_including_barrier_idle':wall,'documents_per_second':len(cycles)/wall,'http_requests_per_second':len(cycles)*4/wall,'wave_max_cycle_ms':[max(w)*1000 for w in wave_finished],'summary':{key:summary([r[key] for r in cycles]) for key in ['create','post','create_retry','post_retry']},'raw':cycles,'observer':{'poll_delay_seconds':.002,'note':'SQL ledger acquisition duration includes lock wait + normal query cost. pg_stat_activity samples prove observed server Lock states; sampled span is not exact wait duration. Sampler itself adds local load.','polls':len(observer_samples),'poll_sql_ms_total':sum(r['sql_ms'] for r in observer_samples),'poll_sql_ms_median':statistics.median(r['sql_ms'] for r in observer_samples),'waiting_samples_format':['at_ms','sql_ms','waiting'], 'waiting_samples':[[r['at_ms'],r['sql_ms'],r['waiting']] for r in observer_samples if r['waiting']]}})
    sources={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT/'server').rglob('*.py'))}
    sources['scripts/benchmark_voucher_posting.py']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    output={'git_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'accounting_baseline':'be48a4a','source_files_sha256':sources,'python':platform.python_version(),'django':django.get_version(),'postgres_version':connection.pg_version,'qa_database':qa_name,'method':'Real Django Client HTTP middleware/handlers in one process, persistent thread-local PG connections, no browser/Gunicorn/Caddy/external network. Actual seeded receipt/sale services. Shared server quiet window coordinated.','detail_samples':args.samples,'posting_lines':args.posting_lines,'detail':details,'concurrency':concurrency,'invariants':{'unique_created_documents':True,'exact_retry_no_extra_lines_movements_audit':True,'same_posted_at_and_line_dto':True,'cashier_redaction':True}}
    Path(args.output).write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'output':args.output,'details':[(r['kind'],r['role'],r['lines'],r['summary']['queries'],r['summary']['elapsed_ms']['median']) for r in details],'concurrency':[(r['workers'],round(r['documents_per_second'],2)) for r in concurrency]},ensure_ascii=False))
finally:
    views.save_voucher,views.post_voucher=original_save,original_post
    observer_stop.set();connections.close_all();teardown_databases(old_config,verbosity=0)
