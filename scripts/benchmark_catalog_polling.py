"""Opt-in local PostgreSQL HTTP-handler baseline with wholly synthetic data.

Creates and destroys test_tsukenya_b24; never uses an existing application database.
Not a capacity test: Django Client/threads omit network, proxies and multiprocess workers.
"""
import argparse
import hashlib
import json
import os
import platform
import subprocess
import statistics
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from threading import Barrier

parser = argparse.ArgumentParser()
parser.add_argument('--run-local-pg', action='store_true')
parser.add_argument('--output', required=True)
parser.add_argument('--history-tail', action='store_true', help='Only the paid-history list probe; reuse unchanged prior polling measurements')
args = parser.parse_args()
if not args.run_local_pg or (os.environ.get('DB_HOST'), os.environ.get('DB_PORT'), os.environ.get('DB_NAME')) != ('127.0.0.1', '61144', 'tsukenya_b24'):
    parser.error('Explicit isolated local PostgreSQL DB_HOST=127.0.0.1 DB_PORT=61144 DB_NAME=tsukenya_b24 required')
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'server.settings')
import django
django.setup()
from django.contrib.auth.models import User
from django.db import connection, connections
from django.test import Client
from django.test.utils import setup_databases, teardown_databases
from django.utils import timezone
from server.erp.models import (Document, LedgerLock, Store, Profile, PortalSession,
    Warehouse, CashAccount, CashShift, Voucher, VoucherLine, StockLot, StockEntry, CashEntry,
    Counterparty, PromotionCampaign, PromotionPrice)


def client_for(token):
    client = Client()
    client.cookies['ts_session'] = token
    return client


def read(client, path):
    metrics = {'queries': 0, 'sql_ms': 0.0, 'tables': Counter()}
    def trace(execute, sql, params, many, context):
        begin = time.perf_counter()
        try:
            return execute(sql, params, many, context)
        finally:
            metrics['queries'] += 1
            metrics['sql_ms'] += (time.perf_counter() - begin) * 1000
            # Table names only, no bound values/session hashes or customer data.
            import re
            for table in set(re.findall(r'(?:FROM|JOIN) "([a-z0-9_]+)"', sql)):
                metrics['tables'][table] += 1
    begin = time.perf_counter()
    with connection.execute_wrapper(trace):
        result = client.get(path)
    metrics['elapsed_ms'] = (time.perf_counter() - begin) * 1000
    assert result.status_code == 200, (path, result.status_code, result.content[:300])
    metrics['bytes'] = len(result.content)
    metrics['status'] = result.status_code
    metrics['etag'] = result.headers.get('ETag')
    metrics['last_modified'] = result.headers.get('Last-Modified')
    # Privacy sanity assertions on the actual endpoints, independent of timings.
    value = result.json()
    if path == '/api/state':
        assert all(not ({'cost', 'markup', 'gsBase'} & set(row['data'])) for row in value['data']['products'])
        assert all(set(row['data']['storeSalePrices']) == {str(store.pk)} for row in value['data']['products'])
    elif path.startswith('/api/v1/catalog/products'):
        assert all(row['cost'] is None and row['markup'] is None for row in value['items'])
    elif path == '/api/erp/state':
        assert [row['id'] for row in value['stores']] == [store.pk]
    return metrics


def summarize(rows):
    values = sorted(row['elapsed_ms'] for row in rows)
    return {'samples': len(rows), 'median_ms': round(statistics.median(values), 3),
            'p95_ms': round(values[min(len(values)-1, int(len(values)*.95))], 3),
            'sql_median_ms': round(statistics.median(row['sql_ms'] for row in rows), 3),
            'queries': sorted(set(row['queries'] for row in rows)),
            'bytes': sorted(set(row['bytes'] for row in rows)),
            'tables': dict(rows[0]['tables']), 'etag': rows[0]['etag'],
            'last_modified': rows[0]['last_modified']}


def baseline(stage):
    paths = ['/api/state', '/api/v1/catalog/products?limit=20',
             '/api/v1/catalog/products?limit=20&promotion=yes',
             '/api/v1/labels/workspace', '/api/erp/state', '/api/erp/stock',
             '/api/erp/vouchers?kind=sale&page=1']
    if args.history_tail:
        paths = ['/api/erp/vouchers?kind=sale&page=1']
    result = {}
    for path in paths:
        read(client_for(tokens[0]), path)  # Warm the DB/handler before samples.
        client = client_for(tokens[0])
        result[path] = summarize([read(client, path) for _ in range(5)])
    return {'stage': stage, 'sku': Document.objects.filter(path__startswith='products/').count(),
            'vouchers': Voucher.objects.count(), 'voucher_lines': VoucherLine.objects.count(),
            'cash_entries': CashEntry.objects.count(), 'stock_entries': StockEntry.objects.count(),
            'endpoints': result}


def add_products(start, end):
    result = Document.objects.bulk_create([Document(path=f'products/sku{i:04d}', data={
        'name': f'Синтетичний товар {i:04d} із довгою українською назвою',
        'type': f'Група {i%10}', 'category': f'Категорія {i%25}', 'pack': 'Пакет',
        'size': '100 г', 'unit': 'шт', 'barcode': f'999{i:010d}',
        'cost': 10, 'markup': 50, 'manualPrice': False, 'price': None,
        'promotion': False, 'priceAt': timezone.localdate().isoformat(), 'minStock': 2,
        'gsBase': {'name': f'Синтетичний товар {i:04d}', 'cost': '10', 'markup': '50', 'price': '15'},
        'gsRow': i+2}) for i in range(start, end)])
    StockLot.objects.bulk_create([StockLot(warehouse=warehouse, product=p, code='synthetic', quantity=20, value=200) for p in result])
    return result


old_config = setup_databases(verbosity=0, interactive=False, keepdb=False)
try:
    assert connection.settings_dict['NAME'] == 'test_tsukenya_b24'
    LedgerLock.objects.create(pk=1)
    store = Store.objects.create(name='Синтетичний магазин A')
    Store.objects.create(name='Чужий магазин B')
    warehouse = Warehouse.objects.create(store=store, name='Синтетичний склад')
    tokens, users, accounts, shifts = [], [], [], []
    for i in range(10):
        user = User.objects.create(username=f'synthetic-cashier-{i}')
        Profile.objects.create(user=user, role='cashier', store=store)
        token = f'synthetic-b24-session-{i}'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(), user=user,
            csrf='synthetic-only', expires=int(time.time())+3600)
        account = CashAccount.objects.create(store=store, name=f'Синтетична каса {i}', kind='cash')
        shift = CashShift.objects.create(store=store, account=account, opened_by=user, opening_cash=0)
        tokens.append(token); users.append(user); accounts.append(account); shifts.append(shift)
    Document.objects.create(path='settings/main', data={'defaultMarkup': 50, 'rounding': .5,
        'chainName': 'Синтетична мережа', 'storeNames': ['Спільний цінник'], 'staleDays': 30, 'budgetStores': 2})
    Document.objects.bulk_create([Document(path=f'tasks/manual{i}', data={'scope': 'operations',
        'store': store.pk, 'title': f'Синтетична задача {i}', 'status': 'todo'}) for i in range(50)])
    products = add_products(0, 50)
    campaign = PromotionCampaign.objects.create(name='Синтетична акція', starts_on=timezone.localdate()-timedelta(days=2),
        ends_on=timezone.localdate()+timedelta(days=3), scope='network', reason='QA', author=users[0], request_fingerprint='a'*64)
    PromotionPrice.objects.bulk_create([PromotionPrice(campaign=campaign, product=p, price=12) for p in products])
    stages = [] if args.history_tail else [baseline('50 SKU / no history')]
    products += add_products(50, 500)
    if not args.history_tail:stages.append(baseline('500 SKU / no history'))
    supplier = Counterparty.objects.create(name='Синтетичний постачальник', kind='supplier')
    receipt = Voucher.objects.create(kind='receipt', status='posted', store=store, warehouse=warehouse,
        date=timezone.localdate()-timedelta(days=90), party=supplier, total=100000, cost=100000,
        created_by=users[0], posted_at=timezone.now()-timedelta(days=90))
    lots = {lot.product_id: lot for lot in StockLot.objects.all()}
    receipt_lines = VoucherLine.objects.bulk_create([VoucherLine(voucher=receipt, product=p, name=p.data['name'], unit='шт',
        quantity=20, price=10, amount=200, cost=200, lot='synthetic') for p in products])
    StockEntry.objects.bulk_create([StockEntry(voucher=receipt, line=line, lot=lots[line.product_id], quantity=20, value=200) for line in receipt_lines])
    sales = Voucher.objects.bulk_create([Voucher(kind='sale', status='posted', store=store, warehouse=warehouse,
        account=accounts[i%10], payload={'payments':[{'account':accounts[i%10].pk,'amount':'15.00'}]}, date=timezone.localdate()-timedelta(days=60-i%60),
        total=15, cost=10, created_by=users[i%10], posted_at=timezone.now()-timedelta(days=60-i%60)) for i in range(5000)])
    lines = VoucherLine.objects.bulk_create([VoucherLine(voucher=v, product=products[i%500], name=products[i%500].data['name'],
        unit='шт', quantity=1, price=15, amount=15, cost=10, lot='synthetic') for i,v in enumerate(sales)])
    StockEntry.objects.bulk_create([StockEntry(voucher=l.voucher, line=l, lot=lots[l.product_id], quantity=-1, value=-10) for l in lines])
    CashEntry.objects.bulk_create([CashEntry(voucher=v, account=v.account, amount=15) for v in sales])
    StockLot.objects.update(quantity=10, value=100)
    stages.append(baseline('500 SKU / 5000 historical sales'))
    barrier = Barrier(10)
    def worker(index):
        try:
            client = client_for(tokens[index])
            read(client, '/api/state')
            result = []
            for _ in range(5):
                barrier.wait(timeout=60)
                result.append(read(client, '/api/state'))
            return result
        except BaseException:
            barrier.abort()
            raise
        finally:
            connections.close_all()
    concurrent = None
    if not args.history_tail:
        begin = time.perf_counter()
        with ThreadPoolExecutor(max_workers=10) as executor:
            parallel = [row for batch in executor.map(worker, range(10)) for row in batch]
        concurrent = summarize(parallel)
        concurrent['rounds'] = 5
        concurrent['cashiers'] = 10
        concurrent['wall_seconds_including_warmups'] = round(time.perf_counter()-begin, 3)
    output = {'baseline_commit': subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(), 'source_files_sha256': {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in ('server/erp/views.py','server/erp/reporting.py')}, 'python': platform.python_version(),
              'django': django.get_version(), 'database': 'PostgreSQL '+connection.pg_version.__str__(),
              'method': 'Django Client HTTP middleware+handler, persistent PG connections, no external network/proxy/browser; burst threads in one Python process',
              'stages': stages, 'ten_parallel_cashiers_state_poll': concurrent}
    Path(args.output).write_text(json.dumps(output, indent=2, ensure_ascii=False)+'\n')
    print(json.dumps(output, ensure_ascii=False, indent=2))
finally:
    connections.close_all()
    teardown_databases(old_config, verbosity=0)
