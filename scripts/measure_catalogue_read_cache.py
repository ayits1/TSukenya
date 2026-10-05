"""Sequential disposable 1k/10k PG old/cold/hit measurements; no 100k option.

This is opt-in local QA, not an API latency SLA or a production load command.
"""
import argparse
import gc
import hashlib
import json
import os
from pathlib import Path
import resource
import signal
import sys
import tempfile
import time
import tracemalloc
import uuid

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run-local-pg',action='store_true')
parser.add_argument('--rows',type=int,choices=(1000,10000),required=True)
parser.add_argument('--output',required=True)
parser.add_argument('--reuse-baseline')
args=parser.parse_args()
baseline=json.loads(Path(args.reuse_baseline).read_text()) if args.reuse_baseline else None
if baseline and (baseline.get('status')!='pass' or baseline.get('rows')!=args.rows):parser.error('Baseline must be a passing artifact of the same row count.')
if not args.run_local_pg or (os.environ.get('DB_HOST'),os.environ.get('DB_PORT'),os.environ.get('DB_NAME')) != ('127.0.0.1','61144','tsukenya_catalogue_cache_measure'):
    parser.error('Only explicitly opted-in disposable local PG61144 QA is supported.')
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root))
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django
django.setup()
from django.conf import settings
from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import setup_databases,teardown_databases
from decimal import Decimal
from server.erp.models import Document,Profile,PromotionCampaign,PromotionPrice
from server.erp.catalog_selection import Selection
from server.erp.historical_reports import read_snapshot
from server.erp.promotion_prices import kyiv_day

settings.CATALOGUE_READ_CACHE=True
cache=tempfile.TemporaryDirectory(prefix='tsukenya-cache-capacity-')
settings.CATALOGUE_READ_CACHE_DIR=cache.name
connection.settings_dict.setdefault('TEST',{})['NAME']='qa_catalogue_cache_'+uuid.uuid4().hex[:12]
configuration=None;started=time.monotonic();query_plans={}
result={'rows':args.rows,'status':'running','limits':{'seconds':180,'rssMiB':384,'databaseMiB':512,'publishedCacheMiB':512,'privateBuildMiB':256},'measurements':[]}
result['sourceDigest']=hashlib.sha256(b''.join((root/'server/erp'/p).read_bytes() for p in ('catalog_read_cache.py','catalog_selection.py','promotion_prices.py'))).hexdigest()


def rss():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/(1048576 if sys.platform=='darwin' else 1024)


def budget():
    assert time.monotonic()-started<180 and rss()<384
    with connection.cursor() as cursor:
        cursor.execute('SELECT pg_database_size(current_database())');size=cursor.fetchone()[0]
    assert size<512*1048576
    return size


def measure(name,callback):
    gc.collect();queries=[];tracemalloc.start();begin=time.monotonic()
    def trace(execute,sql,params,many,context):
        step=time.monotonic()
        try:return execute(sql,params,many,context)
        finally:queries.append({'sql':sql,'params':params,'ms':round((time.monotonic()-step)*1000,3)})
    try:
        with connection.execute_wrapper(trace),read_snapshot():value=callback()
        peak=tracemalloc.get_traced_memory()[1]
    finally:tracemalloc.stop()
    assert not any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries)
    selects=[q for q in queries if q['sql'].lstrip().upper().startswith('SELECT')]
    # Raw SQL is retained only from synthetic QA. No private source data.
    result['measurements'].append({'name':name,'ms':round((time.monotonic()-begin)*1000,3),'selects':len(selects),'queries':len(queries),'sqlMs':round(sum(q['ms'] for q in queries),3),'pythonPeakMiB':round(peak/1048576,3),'processPeakRSSMiB':round(rss(),3),'value':value,'sql':[{k:q[k] for k in ('sql','ms')} for q in selects]})
    for q in selects:
        if any(term in q['sql'].upper() for term in ('JSONB_BUILD_OBJECT','JSON_OBJECT')):query_plans[name]=(q['sql'],q['params'])
    budget()
    return value


def membership(cached):
    with Selection(user,{'promotion':'yes'},read_cache=cached) as selection:
        total=selection.count();ids=selection.ids(50)
        assert total==args.rows and len(ids)==50
        return {'total':total,'first':ids[0],'last':ids[-1]}


def facets(cached,page=1,q=''):
    with Selection(user,{'promotion':'yes','type':'Напої'},read_cache=cached) as selection:
        value=selection.facet('category',q,page)
        assert value['total']==(1 if q else 65)
        return value


try:
    signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(TimeoutError('180sec QA process budget')));signal.alarm(180)
    configuration=setup_databases(verbosity=0,interactive=False,keepdb=False)
    user=User.objects.create(username='synthetic-cache-owner');Profile.objects.create(user=user,role='owner')
    Document.objects.create(path='settings/main',data={'defaultMarkup':30,'rounding':.5})
    for begin in range(0,args.rows,200):
        Document.objects.bulk_create([Document(path=f'products/sku-{n:06}',data={'name':f'Товар {n:06}','type':'Напої','category':f'Категорія {n%65:03}','pack':'Пакет','cost':'10','markup':30,'promotion':False,'recipe':[{'unprojected':'x'*1000}]}) for n in range(begin,min(begin+200,args.rows))])
    today=kyiv_day()
    campaign=PromotionCampaign.objects.create(name='Синтетична',scope='network',starts_on=today,ends_on=today,author=user,request_fingerprint='synthetic')
    for begin in range(0,args.rows,200):
        PromotionPrice.objects.bulk_create([PromotionPrice(campaign=campaign,product_id=f'products/sku-{n:06}',price=Decimal('9.99')) for n in range(begin,min(begin+200,args.rows))])
    old=next(x['value'] for x in baseline['measurements'] if x['name']=='old-promotion-membership') if baseline else measure('old-promotion-membership',lambda:membership(False))
    cold=measure('cold-index-promotion-membership',lambda:membership(True));assert cold==old
    hit=measure('hit-promotion-membership',lambda:membership(True));assert hit==old
    oldfacets=next(x['value'] for x in baseline['measurements'] if x['name']=='old-facets') if baseline else measure('old-facets',lambda:facets(False))
    newfacets=measure('hit-facets',lambda:facets(True));assert oldfacets==newfacets
    measure('hit-facets-page3',lambda:facets(True,3));measure('hit-facets-search',lambda:facets(True,1,'064'))
    if baseline:result['reusedBaseline']=args.reuse_baseline
    result['queryPlans']={}
    with read_snapshot(),connection.cursor() as cursor:
        for name,(sql,params) in query_plans.items():
            cursor.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql,params);result['queryPlans'][name]=cursor.fetchone()[0]
    result.update(status='pass',elapsedSeconds=round(time.monotonic()-started,3),qaDatabaseBytes=budget(),processPeakRSSMiB=round(rss(),3),publishedCacheBytes=sum(p.stat().st_size for p in Path(cache.name).rglob('*.sqlite3')))
except BaseException as error:
    result.update(status='failed',error={'type':type(error).__name__,'message':str(error)[:300]});raise
finally:
    signal.alarm(0)
    if configuration is not None:teardown_databases(configuration,verbosity=0)
    cache.cleanup();result['qaDatabaseRemoved']=configuration is not None;result['cacheRemoved']=not Path(cache.name).exists()
    Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str))
print(json.dumps({k:result[k] for k in ('status','rows','elapsedSeconds','processPeakRSSMiB','qaDatabaseRemoved','cacheRemoved')}))
