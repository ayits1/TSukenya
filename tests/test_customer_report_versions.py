"""Only new resource/audience/read boundaries; existing accounting evidence reused."""
import hashlib
import time
from django.contrib.auth.models import User
from django.db import connection, transaction
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from server.erp.models import Profile, PortalSession, Store, Warehouse, CashAccount, Counterparty, Voucher, CashEntry, Employee, TradingVersion
from tests.test_erp import AccountingFixture


class CustomerReportVersionsTests(TransactionTestCase):
    def setUp(self):
        AccountingFixture.setUp(self)
        self.foreign=Store.objects.create(name='Foreign')
        self.customer=Counterparty.objects.create(kind='customer',name='Synthetic contact')
        self.session=PortalSession.objects.create(token_hash=hashlib.sha256(b'new-version-session').hexdigest(),user=self.u,csrf='new-version-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='new-version-session'
        self.role('manager',self.store)

    def role(self,role,store):
        Profile.objects.filter(user=self.u).update(role=role,store=store)
        self.u.refresh_from_db()

    def get(self,resources,etag=None,store=None):
        query={'resources':resources}
        if store:query['store']=store.pk
        return self.client.get('/api/v1/trading/versions',query,**({'HTTP_IF_NONE_MATCH':etag} if etag else {}))

    def token(self,resources,store=None):
        value=self.get(resources,store=store);self.assertEqual(value.status_code,200,value.content);return value['ETag']

    def voucher(self,**kwargs):
        return Voucher.objects.create(created_by=self.u,date=self.today,store=self.store,status='posted',**kwargs)

    def test_304_cheap_no_dml_source_scan_and_fresh_privacy(self):
        resources='customers_contacts,customers_metrics,customers_debts,reports_period,reports_balances,reports_abc'
        token=self.token(resources)
        with CaptureQueriesContext(connection) as captured:result=self.get(resources,token)
        self.assertEqual(result.status_code,304)
        sql=' '.join(q['sql'].lower() for q in captured)
        self.assertNotRegex(sql,r'\b(insert|update|delete)\b')
        for table in ('erp_voucher','erp_voucherline','erp_cashentry','erp_stockentry','erp_counterparty','erp_document'):
            self.assertNotIn(table,sql)
        reads=[q for q in captured if q['sql'].lstrip().upper().startswith('SELECT')]
        self.assertLessEqual(len(reads),5)
        self.assertEqual(self.get('reports_salary').status_code,403)
        self.assertEqual(self.get(resources,store=self.foreign).status_code,403)
        self.role('cashier',self.store)
        self.assertEqual(self.get('customers_debts').status_code,403)
        self.assertEqual(self.get('reports_abc').status_code,403)
        self.assertEqual(self.get('customers_contacts,customers_metrics').status_code,200)
        User.objects.filter(pk=self.u.pk).update(is_active=False)
        self.assertEqual(self.get('customers_contacts').status_code,401)

    def test_direct_bulk_rollback_old_new_store_and_contacts(self):
        resources='customers_metrics,reports_period,reports_abc'
        token=self.token(resources)
        foreign=Voucher.objects.create(kind='sale',store=self.foreign,date=self.today,created_by=self.u,status='posted',total=12)
        self.assertEqual(self.get(resources,token).status_code,304)
        own=self.voucher(kind='sale',party=self.customer,total=12)
        changed=self.token(resources);self.assertNotEqual(changed,token)
        with transaction.atomic():
            Voucher.objects.filter(pk=own.pk).update(total=13)
            transaction.set_rollback(True)
        self.assertEqual(self.get(resources,changed).status_code,304)
        Voucher.objects.filter(pk=own.pk).update(total=12)
        self.assertEqual(self.get(resources,changed).status_code,304)
        self.role('owner',None)
        a=self.token(resources,self.store);b=self.token(resources,self.foreign)
        Voucher.objects.filter(pk=own.pk).update(store=self.foreign)
        self.assertEqual(self.get(resources,a,self.store).status_code,200)
        self.assertEqual(self.get(resources,b,self.foreign).status_code,200)
        contacts=self.token('customers_contacts',self.store)
        supplier=Counterparty.objects.create(kind='supplier',name='Private supplier contact')
        Counterparty.objects.filter(pk=supplier.pk).update(notes='Changed')
        self.assertEqual(self.get('customers_contacts',contacts,self.store).status_code,304)
        Counterparty.objects.filter(pk=self.customer.pk).update(phone='123')
        self.assertEqual(self.get('customers_contacts',contacts,self.store).status_code,200)

    def test_payroll_private_independence_public_aggregate_and_network_scope(self):
        customer=self.token('customers_contacts,customers_metrics,customers_debts')
        report=self.token('reports_period,reports_balances,reports_abc')
        worker=Employee.objects.create(name='Allowed cashier caption',store=self.store,shift_rate=10)
        payroll=self.voucher(kind='payroll',employee=worker,total=10,note='private')
        self.assertEqual(self.get('customers_contacts,customers_metrics,customers_debts',customer).status_code,304)
        report=self.token('reports_period,reports_balances,reports_abc')
        Voucher.objects.filter(pk=payroll.pk).update(note='new private',payload={'salary':'private'},employee=None)
        Employee.objects.filter(pk=worker.pk).update(shift_rate=20)
        self.assertEqual(self.get('reports_period,reports_balances,reports_abc',report).status_code,304)
        Voucher.objects.filter(pk=payroll.pk).update(total=11)
        self.assertEqual(self.get('reports_period,reports_balances,reports_abc',report).status_code,200)
        period=self.token('reports_period')
        self.voucher(kind='expense',total=12,payload={'expense_scope':'network','category':'Network'})
        self.assertEqual(self.get('reports_period',period).status_code,304,'selected-store report excludes network expenses')
        self.role('owner',None)
        network=self.token('reports_period')
        Voucher.objects.filter(kind='expense').update(total=13)
        self.assertEqual(self.get('reports_period',network).status_code,200)

    def test_selected_dependencies_and_sqlite_postgres_projection_parity(self):
        from server.erp.models import VoucherLine, StockLot, StockEntry, PaymentAllocation
        from django.utils import timezone
        sale=self.voucher(kind='sale',party=self.customer,total=20)
        token=self.token('reports_period,reports_abc')
        line=VoucherLine.objects.create(voucher=sale,product=self.p,name='Historical name',unit='шт',quantity=1,price=20,amount=20,cost=5)
        self.assertEqual(self.get('reports_period,reports_abc',token).status_code,200)
        token=self.token('reports_period,reports_abc')
        VoucherLine.objects.filter(pk=line.pk).update(cost=6)
        self.assertEqual(self.get('reports_period,reports_abc',token).status_code,200)
        token=self.token('reports_balances')
        lot=StockLot.objects.create(warehouse=self.wh,product=self.p,code='Batch',quantity=1,value=6)
        StockEntry.objects.create(voucher=sale,lot=lot,quantity=-1,value=-6)
        self.assertEqual(self.get('reports_balances',token).status_code,200)
        token=self.token('reports_balances')
        CashEntry.objects.create(voucher=sale,account=self.bank,amount=20)
        self.assertEqual(self.get('reports_balances',token).status_code,200)
        token=self.token('customers_debts,reports_balances')
        payment=self.voucher(kind='payment',party=self.customer,total=3)
        PaymentAllocation.objects.create(payment=payment,settlement=payment,source=sale,amount=3)
        self.assertEqual(self.get('customers_debts,reports_balances',token).status_code,200)
        token=self.token('reports_period,reports_balances,reports_abc,customers_metrics,customers_debts')
        Voucher.objects.filter(pk=sale.pk).update(status='reversed',reversed_at=timezone.now())
        self.assertEqual(self.get('reports_period,reports_balances,reports_abc,customers_metrics,customers_debts',token).status_code,200)
        token=self.token('reports_balances,reports_abc')
        from server.erp.models import Document
        Document.objects.filter(pk=self.p.pk).update(data={'name':'Changed current caption','unit':'кг','hidden':True})
        self.assertEqual(self.get('reports_balances,reports_abc',token).status_code,200)
        expense=self.voucher(kind='expense',total=5,payload=[])
        token=self.token('reports_period')
        Voucher.objects.filter(pk=expense.pk).update(payload={})
        self.assertEqual(self.get('reports_period',token).status_code,200,'invalid root vs valid metadata changes error/read boundary')

    def test_snapshot_counter_commit_and_migration_reinstall(self):
        from server.erp.historical_reports import read_snapshot
        from server.erp.trading_versions import values
        from server.erp.migration_helpers import customer_report_0029_sql as sql
        from django.utils import timezone
        self.voucher(kind='sale',party=self.customer,total=20)
        day=timezone.localdate()
        if connection.vendor=='postgresql':
            from threading import Thread
            from django.db import connections, close_old_connections
            errors=[]
            def writer():
                try:
                    close_old_connections()
                    Voucher.objects.filter(kind='sale').update(total=21)
                except Exception as e:errors.append(e)
                finally:connections.close_all()
            with read_snapshot():
                before=values(self.u,['reports_period'],self.store.pk,day)
                thread=Thread(target=writer);thread.start();thread.join(5)
                self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
                self.assertEqual(values(self.u,['reports_period'],self.store.pk,day),before)
            self.assertNotEqual(values(self.u,['reports_period'],self.store.pk,day),before)
        # Actual namespace reverse/install, preserving existing 0024 triggers/counters.
        token=self.token('reports_abc')
        uninstall=sql.uninstall_pg if connection.vendor=='postgresql' else sql.uninstall_sqlite
        install=sql.install_pg if connection.vendor=='postgresql' else sql.install_sqlite
        try:
            uninstall(connection)
            Voucher.objects.filter(kind='sale').update(status='reversed')
            self.assertEqual(self.get('reports_abc',token).status_code,304)
        finally:install(connection)
        Voucher.objects.filter(kind='sale').update(status='posted')
        self.assertEqual(self.get('reports_abc',token).status_code,200)
        with connection.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'tsukenya_trading_%'" if connection.vendor=='postgresql' else "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'tsukenya_trading_%'")
            self.assertGreater(cursor.fetchone()[0],0)

    def test_posting_write_amplification_fixed_audiences(self):
        from server.erp.services import save_voucher, post_voucher
        self.role('owner',None)
        samples=[]
        def selected():return dict(TradingVersion.objects.filter(key__startswith='reports_').values_list('key','revision'))
        for count in (5,10):
            before=selected();started=time.monotonic()
            draft=save_voucher(self.u,{'kind':'receipt','store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,'date':self.today,'lines':[{'product':'p','quantity':'1','price':'5','lot':f'fixture-{count}-{i}'} for i in range(count)]})
            post_voucher(self.u,draft.pk)
            after=selected();delta=sum(v-before.get(k,0) for k,v in after.items())
            samples.append((count,len(after),delta,round(time.monotonic()-started,4)))
        self.assertEqual(samples[0][1],samples[1][1],'counter cardinality depends on audience, not document or line ID')
        self.assertGreater(samples[0][2],0);self.assertLessEqual(samples[1][2],samples[0][2]*2)
        self.assertTrue(all(':owner:' in k or ':manager:' in k or ':accountant:' in k for k in selected()))
        print('New report counters posting lines/key-count/revision-increments/seconds:',samples)

    def test_target_store_movement_chronology_and_frozen_scalar_sql(self):
        from server.erp.models import StockLot, StockEntry
        from django.utils import timezone
        from server.erp.migration_helpers import customer_report_0029_sql as sql
        foreign=Voucher.objects.create(kind='transfer',status='posted',date=self.today,store=self.foreign,created_by=self.u)
        lot=StockLot.objects.create(warehouse=self.wh,product=self.p,code='Target physical lot',quantity=1,value=5)
        token=self.token('reports_period,reports_balances')
        StockEntry.objects.create(voucher=foreign,lot=lot,quantity=1,value=5)
        CashEntry.objects.create(voucher=foreign,account=self.bank,amount=2)
        self.assertEqual(self.get('reports_period,reports_balances',token).status_code,200)
        token=self.token('reports_period,reports_balances')
        Voucher.objects.filter(pk=foreign.pk).update(status='reversed',reversed_at=timezone.now())
        self.assertEqual(self.get('reports_period,reports_balances',token).status_code,200,'target movement uses source reversal chronology even when source store is foreign')
        token=self.token('reports_period')
        CashAccount.objects.filter(pk=self.bank.pk).update(store=self.foreign)
        self.assertEqual(self.get('reports_period',token).status_code,200,'cash-net account routing uses both old and new stores')
        for vendor in ('postgresql','sqlite'):
            expression=sql.row_sql('voucher','OLD',vendor)
            self.assertNotIn('to_jsonb(OLD)',expression)
            self.assertNotIn("'payload',OLD.payload",expression)
            self.assertNotIn('SELECT *',sql.pg_related('prior','lot'))
        import inspect
        source=inspect.getsource(sql)
        self.assertNotIn('from ..catalog',source);self.assertNotIn('trading_version_spec',source)

    def test_employee_historical_caption_reverse_routes_after_transfer(self):
        from server.erp.models import CashShift, WorkShift
        from django.utils import timezone
        c=Store.objects.create(name='Unrelated C')
        worker=Employee.objects.create(name='Historical cashier A',store=self.store)
        shift=CashShift.objects.create(store=self.store,account=self.cash,employee=worker,opened_by=self.u,opening_cash=0,closed_at=timezone.now(),expected_cash=0,counted_cash=0)
        payroll=self.voucher(kind='payroll',employee=worker,total=10)
        WorkShift.objects.create(employee=worker,store=self.store,cash_shift=shift,date=self.today,payroll=payroll,shift_rate=10,bonus_percent=0,bonus_basis='store')
        self.role('owner',None)
        Employee.objects.filter(pk=worker.pk).update(store=self.foreign)
        a=self.token('reports_period,reports_salary',self.store)
        unrelated=self.token('reports_period,reports_salary',c)
        Employee.objects.filter(pk=worker.pk).update(name='Current caption in B')
        self.assertEqual(self.get('reports_period,reports_salary',a,self.store).status_code,200)
        self.assertEqual(self.get('reports_period,reports_salary',unrelated,c).status_code,304)
        # Manager must not observe an unrelated private payroll-only employee rename.
        unshifted=Employee.objects.create(name='Salary-only private',store=self.foreign)
        self.voucher(kind='payroll',employee=unshifted,total=1)
        self.role('manager',self.store)
        period=self.token('reports_period')
        Employee.objects.filter(pk=unshifted.pk).update(name='New private caption')
        self.assertEqual(self.get('reports_period',period).status_code,304)
