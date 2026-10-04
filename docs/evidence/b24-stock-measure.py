import hashlib, json, os, sys, time
from pathlib import Path
if (os.environ.get('DB_HOST'),os.environ.get('DB_PORT'),os.environ.get('DB_NAME')) != ('127.0.0.1','61144','tsukenya_bounded'):
    raise SystemExit('Only isolated local test_tsukenya_bounded is allowed')
root=Path(__file__).resolve().parents[2];sys.path.insert(0,str(root));os.environ['DJANGO_SETTINGS_MODULE']='server.settings'
import django
django.setup()
from django.contrib.auth.models import User
from django.db import connection
from django.core.serializers.json import DjangoJSONEncoder
from django.test.utils import setup_databases,teardown_databases,CaptureQueriesContext
from server.erp.models import Store,Profile,Warehouse,Employee,Counterparty,CashAccount,StockLot,Document,LedgerLock
from server.erp.reporting import state
from server.erp.stock_browsing import stock_page
from server.erp.assortment import assortment
db=setup_databases(verbosity=0,interactive=False)
try:
    user=User.objects.create(username='isolated-bounded-reader');store=Store.objects.create(name='Isolated');Profile.objects.create(user=user,role='owner',store=store)
    warehouse=Warehouse.objects.create(store=store,name='Isolated warehouse');LedgerLock.objects.get_or_create(pk=1)
    results=[]
    for count,directories in [(100,10),(1000,100)]:
        for i in range(Document.objects.filter(path__startswith='products/').count(),count):
            Document.objects.create(path=f'products/p{i:04}',data={'name':f'Тестовий товар {i:04}','unit':'шт','minStock':2,'cost':10,'markup':30})
            StockLot.objects.create(warehouse=warehouse,product_id=f'products/p{i:04}',code=f'lot-{i}',quantity=1,value=10)
            Counterparty.objects.create(name=f'Тестовий контакт {i:04}',kind='customer',notes='Лише синтетичні дані')
        for i in range(Employee.objects.count(),directories):
            Employee.objects.create(store=store,name=f'Тестовий працівник {i:03}',shift_rate=100)
            CashAccount.objects.create(store=store,name=f'Тестовий рахунок {i:03}',kind='bank')
        for name,fn in [('state',lambda:state(user)),('stock_page',lambda:stock_page(user,{})),('assortment',lambda:assortment(user,{'warehouse':str(warehouse.pk)}))]:
            start=time.perf_counter()
            with CaptureQueriesContext(connection) as queries: result=fn()
            results.append({'resource':name,'sku':count,'contacts':count,'employees_accounts':directories,
                'queries':len(queries),'raw_bytes':len(json.dumps(result,cls=DjangoJSONEncoder,ensure_ascii=False).encode()),
                'elapsed_ms_one_sample':round((time.perf_counter()-start)*1000,2),
                'counts':{key:len(value) for key,value in result.items() if isinstance(value,list)}})
    output={'baseline':'145057a','method':'Synthetic isolated PostgreSQL ORM service reads, one sample each; no auth/network/browser/capacity claims',
        'hashes':{file:hashlib.sha256((root/file).read_bytes()).hexdigest() for file in ['server/erp/reporting.py','server/erp/stock_browsing.py','server/erp/assortment.py','app/erp.js']},'results':results}
    Path('/tmp/tsukenya-bounded-read-after.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(output,ensure_ascii=False))
finally:teardown_databases(db,verbosity=0)
