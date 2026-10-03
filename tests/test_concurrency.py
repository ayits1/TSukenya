from concurrent.futures import ThreadPoolExecutor
from django.db import connection, connections, close_old_connections
from django.test import TransactionTestCase
from django.contrib.auth.models import User
from django.utils import timezone
from server.erp.models import *
from server.erp.services import save_voucher, post_voucher, ledger_lock, BusinessError, Conflict

class PostgreSQLConcurrencyTests(TransactionTestCase):
    def test_two_sales_cannot_oversell_last_item(self):
        if connection.vendor!='postgresql':self.skipTest('Requires PostgreSQL row locks.')
        u=User.objects.create(username='concurrency');Profile.objects.create(user=u,role='owner');LedgerLock.objects.create(pk=1)
        store=Store.objects.create(name='Test');wh=Warehouse.objects.create(store=store,name='Stock');party=Counterparty.objects.create(name='Customer',kind='customer')
        p=Document.objects.create(path='products/p',data={'name':'Last item','unit':'шт'})
        date=timezone.localdate().isoformat()
        opening=save_voucher(u,{'kind':'opening','date':date,'store':store.pk,'warehouse':wh.pk,'lines':[{'product':'p','quantity':1,'price':5}]});post_voucher(u,opening.pk)
        docs=[save_voucher(u,{'kind':'sale','date':date,'store':store.pk,'warehouse':wh.pk,'party':party.pk,'lines':[{'product':'p','quantity':1,'price':10}]}).pk for _ in range(2)]
        def post(pk):
            close_old_connections()
            try:
                post_voucher(User.objects.get(pk=u.pk),pk);return 'posted'
            except BusinessError:return 'rejected'
            finally:connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:result=list(pool.map(post,docs))
        self.assertCountEqual(result,['posted','rejected'])
        self.assertEqual(StockLot.objects.get().quantity,0)
        self.assertEqual(Voucher.objects.filter(kind='sale',status='posted').count(),1)
    def test_parallel_retries_post_once(self):
        if connection.vendor!='postgresql':self.skipTest('Requires PostgreSQL row locks.')
        u=User.objects.create(username='retry');Profile.objects.create(user=u,role='owner');LedgerLock.objects.create(pk=1)
        s=Store.objects.create(name='Test');w=Warehouse.objects.create(store=s,name='Stock');Document.objects.create(path='products/p',data={'name':'P','unit':'шт'})
        v=save_voucher(u,{'kind':'opening','date':timezone.localdate().isoformat(),'store':s.pk,'warehouse':w.pk,'lines':[{'product':'p','quantity':5,'price':2}]})
        def post(_):
            close_old_connections()
            try:return post_voucher(User.objects.get(pk=u.pk),v.pk).pk
            finally:connections.close_all()
        with ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(post,range(4)))
        self.assertEqual(StockLot.objects.get().quantity,5)
        self.assertEqual(StockEntry.objects.count(),1)

    def test_observed_post_waits_for_draft_edit_and_refuses_newer_revision(self):
        if connection.vendor != 'postgresql':self.skipTest('Requires PostgreSQL row locks.')
        from threading import Event
        from django.db import transaction
        user=User.objects.create(username='observed-post');Profile.objects.create(user=user,role='owner');LedgerLock.objects.create(pk=1)
        store=Store.objects.create(name='Test');warehouse=Warehouse.objects.create(store=store,name='Stock')
        Document.objects.create(path='products/p',data={'name':'P','unit':'шт'})
        body={'kind':'opening','date':timezone.localdate().isoformat(),'store':store.pk,'warehouse':warehouse.pk,'lines':[{'product':'p','quantity':1,'price':2}]}
        draft=save_voucher(user,body)
        editing,posting=Event(),Event()
        def edit():
            close_old_connections()
            try:
                with transaction.atomic():
                    ledger_lock();editing.set()
                    if not posting.wait(5):raise AssertionError('Posting worker did not start')
                    return save_voucher(User.objects.get(pk=user.pk),{**body,'revision':1,'lines':[{'product':'p','quantity':7,'price':2}]},draft.pk).revision
            finally:connections.close_all()
        def post():
            close_old_connections()
            try:
                if not editing.wait(5):raise AssertionError('Editing worker did not acquire lock')
                posting.set()
                try:post_voucher(User.objects.get(pk=user.pk),draft.pk,expected_revision=1)
                except Conflict as error:return error.code
                return 'posted'
            finally:connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            saved,posted=pool.submit(edit),pool.submit(post)
            self.assertEqual(saved.result(timeout=10),2)
            self.assertEqual(posted.result(timeout=10),'revision_conflict')
        draft.refresh_from_db()
        self.assertEqual(draft.status,'draft');self.assertEqual(draft.lines.get().quantity,7)
        self.assertFalse(StockEntry.objects.exists());self.assertFalse(CashEntry.objects.exists())
