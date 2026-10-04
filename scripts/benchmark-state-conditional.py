"""Opt-in synthetic local-PG handler probe; raw bodies are not network/capacity."""
import hashlib,json,os,statistics,sys,time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
if (os.environ.get('DB_HOST'),os.environ.get('DB_PORT'),os.environ.get('DB_NAME'))!=('127.0.0.1','61144','tsukenya_polling'):
    raise SystemExit('Only explicitly isolated local tsukenya_polling database is allowed')
sys.path.insert(0,str(Path(__file__).resolve().parents[1]));os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django
django.setup()
from django.contrib.auth.models import User
from django.db import connection,connections
from django.test import Client
from django.test.utils import setup_databases,teardown_databases
from server.erp.models import Store,Profile,PortalSession,Document
old=setup_databases(verbosity=0,interactive=False)
try:
    store=Store.objects.create(name='Synthetic polling store')
    Document.objects.create(path='settings/main',data={'defaultMarkup':30,'rounding':.5})
    Document.objects.bulk_create([Document(path=f'products/p{i}',data={'name':f'Synthetic {i}','cost':10,'markup':30}) for i in range(500)])
    clients=[]
    for i in range(10):
        user=User.objects.create(username=f'poll-cashier-{i}');Profile.objects.create(user=user,role='cashier',store=store)
        token=f'isolated-poll-{i}';PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),user=user,csrf=f'csrf-{i}',expires=int(time.time())+3600)
        client=Client();client.cookies['ts_session']=token;response=client.get('/api/state')
        assert response.status_code==200 and len(response.json()['data']['products'])==500
        clients.append((client,response['ETag']))
    barrier=Barrier(10)
    def reads(item):
        client,tag=item;rows=[]
        try:
            for _ in range(5):
                barrier.wait(timeout=15);sql=[]
                def trace(execute,statement,params,many,context):
                    sql.append(statement);return execute(statement,params,many,context)
                begin=time.perf_counter()
                with connection.execute_wrapper(trace):response=client.get('/api/state',HTTP_IF_NONE_MATCH=tag)
                elapsed=(time.perf_counter()-begin)*1000
                assert response.status_code==304 and not response.content and len(sql)<=4
                assert not any('erp_document' in s.lower() or 'erp_promotionprice' in s.lower() for s in sql)
                rows.append({'queries':len(sql),'raw_bytes':len(response.content),'elapsed_ms':elapsed})
        finally:connections['default'].close()
        return rows
    with ThreadPoolExecutor(max_workers=10) as pool:rows=[row for group in pool.map(reads,clients) for row in group]
    times=sorted(r['elapsed_ms'] for r in rows)
    result={'baseline':'9c04dad2b48ac59b1b544ec44e4857e273147de6','sku':500,'cashiers':10,'samples':50,'status':304,
        'queries':sorted(set(r['queries'] for r in rows)),'raw_body_bytes':sorted(set(r['raw_bytes'] for r in rows)),
        'median_ms':round(statistics.median(times),3),'p95_ms':round(times[int(len(times)*.95)],3),
        'method':'Django Client + 10 threads, 5 waves, isolated PostgreSQL; no product scan; not wire traffic or production capacity'}
    target=Path(__file__).resolve().parents[1]/'docs/b24-conditional.json';target.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False))
finally:teardown_databases(old,verbosity=0)
