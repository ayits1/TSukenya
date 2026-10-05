"""Actual durable projection/identity boundaries; no accounting algorithms changed."""
import hashlib
import time
from decimal import Decimal
from django.contrib.auth.models import User
from django.db import connection, transaction
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import (Profile,PortalSession,Store,Warehouse,CashAccount,Document,Voucher,
                               Employee,StockLot,CashEntry,TradingVersion,Assortment)
from tests.test_erp import AccountingFixture


class TradingVersionsTests(TransactionTestCase):
    v=AccountingFixture.v
    sale=AccountingFixture.sale

    def setUp(self):
        AccountingFixture.setUp(self)
        self.b=Store.objects.create(name='Foreign')
        self.bw=Warehouse.objects.create(store=self.b,name='Foreign warehouse')
        self.role('manager',self.store)
        self.session=PortalSession.objects.create(token_hash=hashlib.sha256(b'version-test-session').hexdigest(),user=self.u,
            csrf='version-test-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='version-test-session'

    def role(self, role, store):
        Profile.objects.filter(user=self.u).update(role=role,store=store)
        self.u.refresh_from_db()

    def get(self, resources='stock', token=None, store=None):
        params={'resources':resources}
        if store:params['store']=str(store.pk)
        return self.client.get('/api/v1/trading/versions',params,**({'HTTP_IF_NONE_MATCH':token} if token else {}))

    def token(self, resources='stock', store=None):
        result=self.get(resources,store=store);self.assertEqual(result.status_code,200,result.content);return result['ETag']

    def test_unchanged_read_is_scalar_cheap_strict_and_readonly(self):
        Document.objects.bulk_create([Document(path='products/large'+str(i),data={'name':'Synthetic '+str(i),'cost':10}) for i in range(500)])
        first=self.get('stock,directories');self.assertEqual(first.status_code,200)
        self.assertEqual(set(first.json()),{'contract','identity','day','versions'})
        with CaptureQueriesContext(connection) as queries: result=self.get('stock,directories',first['ETag'])
        self.assertEqual(result.status_code,304);self.assertEqual(result.content,b'')
        reads=[q['sql'] for q in queries if q['sql'].lstrip().upper().startswith('SELECT')]
        # Middleware authenticates once; domain itself adds <=4 SELECTs.
        self.assertLessEqual(len(reads),5)
        sql=' '.join(q['sql'].lower() for q in queries)
        self.assertNotRegex(sql,r'\b(insert|update|delete)\b')
        for table in ('erp_document','erp_voucher','erp_stocklot','erp_cashentry','erp_promotionprice'):
            self.assertNotIn(table,sql)
        print('Trading validator SQL:',len(queries),'SELECT:',len(reads),'domain SELECT:',len(reads)-1)
        encoded='W/'+first['ETag'][:-1]+'-gzip"'
        self.assertEqual(self.get('stock,directories',encoded).status_code,304)
        for params in ({'resources':'stock,stock'},{'resources':'unknown'},{'resources':'stock','bad':'x'},{'resources':'stock','store':'²'}):
            self.assertEqual(self.client.get('/api/v1/trading/versions',params).status_code,400)

    def test_direct_bulk_rollback_old_new_audiences_and_noop(self):
        own=self.token();foreign=self.token(store=self.b) if self.u.profile.store_id is None else None
        StockLot.objects.create(warehouse=self.bw,product=self.p,code='foreign',quantity=2,value=20)
        self.assertEqual(self.get(token=own).status_code,304)
        lot=StockLot.objects.create(warehouse=self.wh,product=self.p,code='own',quantity=3,value=30)
        changed=self.token();self.assertNotEqual(own,changed)
        StockLot.objects.filter(pk=lot.pk).update(quantity=3)
        self.assertEqual(self.get(token=changed).status_code,304)
        with transaction.atomic():
            StockLot.objects.filter(pk=lot.pk).update(quantity=4,value=40)
            transaction.set_rollback(True)
        self.assertEqual(self.get(token=changed).status_code,304)
        self.role('owner',None)
        a=self.token(store=self.store);b=self.token(store=self.b)
        StockLot.objects.filter(pk=lot.pk).update(warehouse=self.bw)
        self.assertEqual(self.get(token=a,store=self.store).status_code,200)
        self.assertEqual(self.get(token=b,store=self.b).status_code,200)
        version=TradingVersion.objects.get(pk='stock:owner:store:'+str(self.b.pk));version.delete()
        before=self.token(store=self.b)
        with connection.cursor() as cursor:cursor.execute('UPDATE erp_stocklot SET quantity=quantity+1 WHERE id=%s',[lot.pk])
        self.assertEqual(self.get(token=before,store=self.b).status_code,200)
        Assortment.objects.bulk_create([Assortment(warehouse=self.bw,product=self.p,sold=False)])
        self.assertEqual(self.get(token=before,store=self.b).status_code,200)

    def test_private_salary_cost_and_selected_finance_resource(self):
        self.role('cashier',self.store)
        self.p.data={'name':'Public','manualPrice':True,'price':20,'cost':10};self.p.save()
        lot=StockLot.objects.create(warehouse=self.wh,product=self.p,code='public',quantity=2,value=20)
        employee=Employee.objects.create(store=self.store,name='Visible name',shift_rate=10)
        from server.erp.models import CashShift
        shift=CashShift.objects.create(store=self.store,account=self.bank,opened_by=self.u,opening_cash=0)
        shift_before=self.token('sales_shifts')
        User.objects.filter(pk=self.u.pk).update(username='Changed public cashier')
        self.assertEqual(self.get('sales_shifts',shift_before).status_code,200)
        before=self.token('stock,directories,sales_documents')
        StockLot.objects.filter(pk=lot.pk).update(value=21)
        Employee.objects.filter(pk=employee.pk).update(shift_rate=999)
        self.p.data['cost']=999;self.p.save()
        voucher=Voucher.objects.create(kind='payroll',store=self.store,date=self.today,total=999,created_by=self.u)
        self.assertEqual(self.get('stock,directories,sales_documents',before).status_code,304)
        self.p.data={'name':'Public','manualPrice':False,'markup':0,'cost':'10.01'};self.p.save()
        rounded=self.token('stock,directories,sales_documents')
        self.p.data['cost']='10.02';self.p.save()
        self.assertEqual(self.get('stock,directories,sales_documents',rounded).status_code,304, 'unchanged public rounded price is not a cashier cost activity feed')
        self.assertEqual(self.get('staff_employees').status_code,403)
        self.assertEqual(self.get('finance_accounts').status_code,403)
        # public employee names still invalidate the shared directory.
        Employee.objects.filter(pk=employee.pk).update(name='New visible name')
        self.assertEqual(self.get('stock,directories,sales_documents',before).status_code,200)
        self.role('manager',self.store)
        accounts=self.token('finance_accounts');ledger=self.token('finance_ledger');documents=self.token('finance_documents')
        CashEntry.objects.create(voucher=voucher,account=self.bank,amount=Decimal('-9.99'))
        self.assertEqual(self.get('finance_accounts',accounts).status_code,200)
        self.assertEqual(self.get('finance_ledger',ledger).status_code,304)
        self.assertEqual(self.get('finance_documents',documents).status_code,304)
        Voucher.objects.filter(pk=voucher.pk).update(note='private salary note',revision=2)
        self.assertEqual(self.get('finance_ledger',ledger).status_code,304)
        self.assertEqual(self.get('finance_documents',documents).status_code,304)

    def test_fresh_identity_resource_scope_session_and_public_postings(self):
        self.role('owner',None)
        stock=self.token('stock');purchases=self.token('purchases_documents');finance=self.token('finance_debts')
        self.v('receipt',2,5)
        self.assertEqual(self.get('stock',stock).status_code,200)
        self.assertEqual(self.get('purchases_documents',purchases).status_code,200)
        self.assertEqual(self.get('finance_debts',finance).status_code,200)
        previous=self.token('stock')
        self.role('manager',self.store)
        current=self.get('stock',previous);self.assertEqual(current.status_code,200)
        self.assertEqual(current.json()['identity']['scopeStore'],self.store.pk)
        self.assertEqual(self.get('stock',store=self.b).status_code,403)
        self.session.delete()
        self.assertEqual(self.get('stock',current['ETag']).status_code,401)

    def test_target_account_reversal_and_foreign_campaign_privacy(self):
        from server.erp.models import PromotionCampaign, PromotionPrice
        from datetime import timedelta
        from server.erp.promotion_prices import kyiv_day
        today=kyiv_day()
        other_account=CashAccount.objects.create(store=self.b,name='Target',kind='cash')
        transfer=Voucher.objects.create(kind='cash_transfer',store=self.b,date=self.today,created_by=self.u)
        # Account scope, rather than the document's origin, governs this ledger row.
        CashEntry.objects.create(voucher=transfer,account=self.bank,amount=10)
        before=self.token('finance_ledger')
        from django.utils import timezone
        Voucher.objects.filter(pk=transfer.pk).update(reversed_at=timezone.now())
        self.assertEqual(self.get('finance_ledger',before).status_code,200)
        self.role('cashier',self.store)
        first=self.token('stock,directories')
        campaign=PromotionCampaign.objects.create(name='Invisible',scope='stores',starts_on=today,ends_on=today+timedelta(days=1),author=self.u)
        campaign.stores.add(self.b)
        self.assertEqual(self.get('stock,directories',first).status_code,304)
        campaign.stores.add(self.store)
        self.assertEqual(self.get('stock,directories',first).status_code,200)
        included=self.token('stock,directories')
        campaign.stores.remove(self.store)
        self.assertEqual(self.get('stock,directories',included).status_code,200)
        future=PromotionCampaign.objects.create(name='Future',scope='network',starts_on=today+timedelta(days=1),ends_on=today+timedelta(days=2),author=self.u)
        hidden=self.token('stock,directories')
        PromotionCampaign.objects.filter(pk=future.pk).update(name='Still future')
        self.assertEqual(self.get('stock,directories',hidden).status_code,304)

    def test_price_projection_parity_and_bounded_post_write_amplification(self):
        from server.erp.catalog import regular_price, sale_price, defaults
        import json
        if connection.vendor=='postgresql':
            config=defaults()
            for product in ({'cost':'10.01','markup':0},{'cost':'10.02','markup':0},{'cost':'10.01','markup':30},
                            {'manualPrice':True,'price':'19.99','cost':'999'},
                            {'cost':'1e1','promotion':True,'promotionPrice':'9,99'},
                            {'cost':10,'promotion':True,'promotionPrice':'1.234'},{'cost':0},
                            {'manualPrice':'false','price':'1.23','cost':10}):
                with connection.cursor() as cursor:
                    cursor.execute('SELECT tsukenya_trading_price(%s::jsonb)',[json.dumps(product)])
                    got=json.loads(cursor.fetchone()[0])
                self.assertEqual([Decimal(str(x)) for x in got],[regular_price(product,config),sale_price(product,config)])
        self.role('owner',None)
        from server.erp.services import save_voucher, post_voucher
        products=[Document.objects.create(path='products/line'+str(i),data={'name':'Line'+str(i),'cost':5}) for i in range(10)]
        for count in (5,10):
            started=time.monotonic();prior=dict(TradingVersion.objects.values_list('key','revision'))
            voucher=save_voucher(self.u,{'kind':'receipt','store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,
                'date':self.today,'lines':[{'product':p.pk.split('/')[1],'quantity':2,'price':5} for p in products[:count]]})
            post_voucher(self.u,voucher.pk)
            after=dict(TradingVersion.objects.values_list('key','revision'))
            changed={key:revision-prior.get(key,0) for key,revision in after.items() if revision!=prior.get(key,0)}
            self.assertLessEqual(len(changed),100)
            self.assertLessEqual(sum(changed.values()),100*count)
            print('Trading counter writes receipt lines',count,': keys',len(changed),'increments',sum(changed.values()),'seconds',round(time.monotonic()-started,4))

    def test_read_snapshot_and_fresh_cached_actor(self):
        from django.test import RequestFactory
        from server.erp import trading_versions
        request=RequestFactory().get('/api/v1/trading/versions',{'resources':'stock'})
        request.portal_session=self.session
        cached=self.u
        self.role('cashier',self.store)
        result=trading_versions.response(request,cached)
        self.assertEqual(result.status_code,200)
        self.assertEqual(__import__('json').loads(result.content)['identity']['role'],'cashier')
        User.objects.filter(pk=self.u.pk).update(is_active=False)
        self.assertEqual(trading_versions.response(request,cached).status_code,403)
        User.objects.filter(pk=self.u.pk).update(is_active=True)
        if connection.vendor!='postgresql':return
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from unittest.mock import patch
        from django.db import connections
        captured,release=Event(),Event()
        original=trading_versions.values
        lot=StockLot.objects.create(warehouse=self.wh,product=self.p,code='snapshot',quantity=1,value=1)
        old=self.token()
        def paused(*args):
            value=original(*args)
            with connection.cursor() as cursor:
                cursor.execute('SHOW transaction_isolation');self.assertEqual(cursor.fetchone()[0],'repeatable read')
                cursor.execute('SHOW transaction_read_only');self.assertEqual(cursor.fetchone()[0],'on')
            captured.set();self.assertTrue(release.wait(5));return value
        def read():
            try:return self.get()
            finally:connections.close_all()
        with patch.object(trading_versions,'values',side_effect=paused),ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(read)
            try:
                self.assertTrue(captured.wait(5))
                StockLot.objects.filter(pk=lot.pk).update(quantity=2,value=2)
            finally:release.set()
            result=future.result(5)
        self.assertEqual(result['ETag'],old,'the in-flight RR read keeps its original snapshot')
        self.assertNotEqual(self.token(),old)

    def test_migration_reverse_reinstall_and_absent_register(self):
        # Runtime wrapper/spec replacement cannot alter the historical installer.
        import importlib
        from unittest.mock import patch
        migration=importlib.import_module('server.erp.migrations.0024_trading_versions')
        with patch('server.erp.trading_version_spec.RESOURCES', {}), patch('server.erp.trading_version_sql.register_sqlite', side_effect=AssertionError('mutable runtime wrapper')):
            from server.erp.migration_helpers import trading_versions_0024_sql as frozen
            self.assertEqual(frozen.install_pg.__module__, 'server.erp.migration_helpers.trading_versions_0024_sql')
            self.assertIsNotNone(migration.install)

        import inspect
        from server.erp.migration_helpers.trading_versions_0024_sql import related, register_sqlite
        for route in ('voucher','lot','order_line','payment','source','settlement'):
            self.assertNotIn('to_jsonb',related('next',route))
            self.assertNotIn('payload',related('next',route))
        self.assertNotIn('SELECT *',inspect.getsource(register_sqlite))
        from django.db.migrations.executor import MigrationExecutor
        executor=MigrationExecutor(connection);final=executor.loader.graph.leaf_nodes('erp')
        try:
            executor.migrate([('erp','0023_operation_price_results')])
            # Legacy writes remain usable while the new register is absent.
            Document.objects.filter(pk=self.p.pk).update(data={'name':'After rollback','cost':10})
            executor=MigrationExecutor(connection);executor.migrate(final)
            before=self.token()
            StockLot.objects.create(warehouse=self.wh,product=self.p,code='after reinstall',quantity=1,value=1)
            self.assertEqual(self.get(token=before).status_code,200)
        finally:MigrationExecutor(connection).migrate(final)
