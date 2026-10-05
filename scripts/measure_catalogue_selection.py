"""Opt-in synthetic local PG capacity proof; never a production SLA.

Each invocation creates/drops only its fresh random QA DB. Sequential 1k/10k;
100k requires a passing 10k artifact and explicit opt-in. No browser/worker.
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
import time
import tracemalloc
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run-local-pg', action='store_true')
parser.add_argument('--rows', type=int, choices=(1000, 10000, 100000), required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--allow-100k', action='store_true')
parser.add_argument('--prior-10k')
parser.add_argument('--full-record-only', action='store_true')
args = parser.parse_args()
if not args.run_local_pg or (os.environ.get('DB_HOST'), os.environ.get('DB_PORT'), os.environ.get('DB_NAME')) != ('127.0.0.1', '61144', 'tsukenya_b24_catalogue_capacity'):
    parser.error('Only opt-in disposable PostgreSQL on127.0.0.1:61144 / tsukenya_b24_catalogue_capacity accepted.')
if args.rows == 100000:
    prior = json.loads(Path(args.prior_10k).read_text()) if args.prior_10k else {}
    if not args.allow_100k or prior.get('rows') != 10000 or prior.get('status') != 'pass' or prior.get('sourceTree') != 'bounded-catalogue-stage1':
        parser.error('100k requires --allow-100k and this implementation\'s passing --prior-10k artifact.')
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root)); os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'server.settings')
import django
django.setup()
from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import setup_databases, teardown_databases
from decimal import Decimal
from server.erp.models import Document, LedgerLock, Profile, PromotionCampaign, PromotionPrice
from server.erp.catalog import defaults
from server.erp.catalog_pricing import plan
from server.erp.catalog_selection import Selection, scalar_rows, FIELDS
from server.erp.catalog_scoped_references import scoped_records
from server.erp.catalog_snapshot import snapshot, bounded_documents, MAX_CANDIDATE_BYTES
from server.erp.historical_reports import read_snapshot
from server.erp.promotion_prices import PriceResolver, kyiv_day

result = {'sourceTree': 'bounded-catalogue-stage1', 'rows': args.rows, 'status': 'running',
          'limits': {'processSeconds': 360, 'processPeakRSSMiB': 384, 'qaDatabaseMiB': 1024, 'selectionDiskMiB': 256}, 'measurements': []}
result['sourceDigest'] = hashlib.sha256(b''.join((root/path).read_bytes() for path in ['server/erp/catalog_selection.py','server/erp/catalog_snapshot.py','server/erp/catalog_scoped_references.py','server/erp/catalog_pricing.py','server/erp/promotion_prices.py'])).hexdigest()
qa_name = 'qa_tsukenya_catalogue_' + uuid.uuid4().hex[:12]
connection.settings_dict.setdefault('TEST', {})['NAME'] = qa_name
configuration = None
started = time.monotonic()


def rss():
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / (1024 * 1024 if sys.platform == 'darwin' else 1024)


def check_budget():
    assert time.monotonic() - started < 360, '360sec process budget exceeded'
    assert rss() <= 384, '384MiB process peak RSS budget exceeded'
    with connection.cursor() as cursor:
        cursor.execute('SELECT pg_database_size(current_database())'); size = cursor.fetchone()[0]
    assert size <= 1024 * 1024 * 1024, '1GiB disposable DB budget exceeded'
    return size


def measure(name, callback):
    gc.collect(); queries = []; tracemalloc.start(); start = time.monotonic()
    def trace(execute, sql, params, many, context):
        sql_started = time.monotonic()
        try: return execute(sql, params, many, context)
        finally: queries.append({'sql': sql, 'ms': round((time.monotonic() - sql_started)*1000, 3)})
    try:
        with connection.execute_wrapper(trace), read_snapshot(): value = callback()
        peak = tracemalloc.get_traced_memory()[1]
    finally: tracemalloc.stop()
    assert not any(q['sql'].lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for q in queries), 'Measured read made a business write'
    item = {'name': name, 'ms': round((time.monotonic()-start)*1000,3), 'queries':len(queries), 'selects':sum(q['sql'].lstrip().upper().startswith('SELECT') for q in queries),
            'sqlMs':round(sum(q['ms'] for q in queries),3), 'pythonPeakMiB':round(peak/1048576,3), 'processPeakRSSMiB':round(rss(),3), 'value':value}
    result['measurements'].append(item); check_budget()
    return item


def selection():
    with Selection(user, {'promotion':'yes'}) as selected:
        count = selected.count(); identifiers = selected.ids(50)
        size = sum(p.stat().st_size for p in Path(selected.directory.name).iterdir())
        directory = selected.directory.name
    assert not Path(directory).exists()
    assert count == args.rows and len(identifiers) == 50
    return {'total':count,'items':len(identifiers),'tempDiskBytes':size,'closedAndRemoved':True}


def facets():
    with Selection(user, {'promotion':'yes'}) as selected:
        first=selected.facet('category','',1); last=selected.facet('category','',999)
        assert first['total'] == 65 and len(last['items'])==5 and last['page']==3
        return {'total':first['total'],'lastPage':last['page'],'lastItems':len(last['items'])}


def overlaps():
    resolver=PriceResolver(defaults(),product_paths=['products/sku-000000'])
    candidate=resolver.candidates['products/sku-000000']; assert len(candidate)==1
    expected=min((p.price,str(p.campaign_id)) for p in PromotionPrice.objects.filter(product_id='products/sku-000000') if p.price>0)
    assert candidate[0][:2] == expected
    return {'campaignRows':1050,'retainedCandidates':len(candidate),'winner':str(candidate[0][0])}


try:
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('360sec isolated process deadline')))
    signal.alarm(360)
    configuration=setup_databases(verbosity=0, interactive=False, keepdb=False)
    assert connection.settings_dict['NAME']==qa_name and connection.vendor=='postgresql'
    user=User.objects.create(username='synthetic-capacity-owner');Profile.objects.create(user=user,role='owner');LedgerLock.objects.create(pk=1)
    Document.objects.create(path='settings/main', data={'defaultMarkup':30,'rounding':.5})
    for begin in range(0,args.rows,200):
        Document.objects.bulk_create([Document(path=f'products/sku-{n:06}',data={'name':f'Товар {n:06}','type':'Група','category':f'Категорія {n%65:03}','pack':'Пакет','unit':'шт','cost':'10','markup':30,'promotion':True,'promotionPrice':'9','recipe':[{'unselectedPayload':'x'*1000}]}) for n in range(begin,min(begin+200,args.rows))])
        if begin%2000==0:check_budget()
    if not args.full_record_only:
        measure('promotion-selection',selection);measure('all-facet-universe',facets)
        measure('scoped-references',lambda:{'retained':len(scoped_records(({'type':'Група','category':'Категорія 000','pack':'Пакет','unit':'шт'},)))})
        measure('one-product-pricing-preview',lambda:{'candidates':plan({'kind':'markup','markup':'31','ids':['sku-000000'],'resetManualPrices':False,'updateDefault':False},user)[0]['summary']['candidates']})
    with read_snapshot():
        sql,parameters=scalar_rows(Document.objects.filter(path__startswith='products/'),FIELDS,ordering=('data__type','data__category','data__name','path')).query.sql_with_params()
        with connection.cursor() as cursor:
            cursor.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql,parameters);result['scalarPlan']=cursor.fetchone()[0]
    day=kyiv_day()
    for begin in range(0,0 if args.full_record_only else 1050,100):
        campaigns=[PromotionCampaign(id=uuid.UUID(int=n+1),name=f'Кампанія {n}',starts_on=day,ends_on=day,scope='network',author=user,request_fingerprint='synthetic') for n in range(begin,min(begin+100,1050))]
        PromotionCampaign.objects.bulk_create(campaigns)
        PromotionPrice.objects.bulk_create([PromotionPrice(campaign=c,product_id='products/sku-000000',price=Decimal('8')+Decimal(n%50)/100) for n,c in enumerate(campaigns,begin)])
    if not args.full_record_only: measure('overlap-campaign-minimum',overlaps)
    # 200 nearly-limit scalar inputs, separate from ordinary SKU size. No full
    # payload projection, and explicit >64KiB refusal has a permanent unit test.
    seed_batch = 1 if args.full_record_only else 25
    for begin in range(0,200,seed_batch):
        Document.objects.bulk_create([Document(path=f'products/near-limit-{n:03}',data=({'name':f'large-{n}','type':'Large','cost':'10','privateUnprojectedLegacy':'я'*64000} if args.full_record_only else {'name':'large-'+('я'*24000),'type':'Large','cost':'10','promotion':True,'promotionPrice':'9'})) for n in range(begin,begin+seed_batch)])
    def large_batch():
        with Selection(user, {'q':'large-'}) as selected:
            selected.build(); assert selected.db.execute('SELECT COUNT(*) FROM items').fetchone()[0]==200
            return {'rows':200,'encodedNameBytesPerRow':len(('large-'+'я'*24000).encode()),'tempDiskBytes':sum(p.stat().st_size for p in Path(selected.directory.name).iterdir())}
    if args.full_record_only:
        query=Document.objects.filter(path__startswith='products/').order_by('path')
        measure('full-snapshot-200-unprojected-128k-records',lambda:{'snapshotLength':len(snapshot(query,defaults())), 'fullJSONBytesPerLargeRow':128000,'batch':50})
        measure('full-candidates-100-unprojected-128k-records',lambda:{'retained':len(list(bounded_documents(query.filter(path__startswith='products/near-limit-'),limit=100,total_limit=MAX_CANDIDATE_BYTES)))})
        from server.erp.services import BusinessError
        try:list(bounded_documents(query.filter(path__startswith='products/near-limit-'),total_limit=MAX_CANDIDATE_BYTES))
        except BusinessError:result['candidateByteBudgetRefused']=True
        else:raise AssertionError('200x128KB candidate budget must refuse without silent truncation')
    else:measure('200-near-scalar-limit',large_batch)
    result.update(status='pass',qaDatabaseBytes=check_budget(),elapsedSeconds=round(time.monotonic()-started,3),processPeakRSSMiB=round(rss(),3))
except BaseException as error:
    result.update(status='failed',error={'type':type(error).__name__,'message':str(error)[:500]})
    raise
finally:
    signal.alarm(0)
    if configuration is not None:teardown_databases(configuration,verbosity=0)
    result['qaDatabaseRemoved']=configuration is not None
    Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({key:result[key] for key in ('status','rows','elapsedSeconds','processPeakRSSMiB','qaDatabaseRemoved')}))
