"""Current CRM debt reads stay bounded by source batch, never by child fanout."""
import json
import os
import threading
import weakref
from contextlib import ExitStack, contextmanager
from datetime import timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from django.db import connection, connections
from django.db.models import JSONField
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from server.erp import customers, report_children as children
from server.erp.models import PaymentAllocation, Profile, Store, User, Voucher
from server.erp.services import BusinessError, obligation
from server.erp.settlements import current_source_obligations
from tests import test_erp


class CustomerSettlementReadTests(TransactionTestCase):
    def setUp(self):
        test_erp.AccountingFixture.setUp(self)

    def voucher(self, kind='sale', **terms):
        return Voucher.objects.create(kind=kind, status=terms.pop('status', 'posted'),
                                      date=terms.pop('date', self.today), store=terms.pop('store', self.store),
                                      party=terms.pop('party', self.customer), created_by=self.u,
                                      total=Decimal(terms.pop('total', '100')), **terms)

    def facts(self, user=None, **params):
        return customers.profile(user or self.u, self.customer.pk, params)

    def record(self, **values):
        if directory := os.environ.get('CRM_SETTLEMENT_PROOF_DIR'):
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            with (target / (connection.vendor + '.jsonl')).open('a') as file:
                file.write(json.dumps({'test': self._testMethodName, **values}, default=str) + '\n')

    @contextmanager
    def bounded_materialization(self):
        metrics = {'voucher_peak': 0, 'allocation_peak': 0, 'whole_payload_children': 0,
                   'fetched_rows': 0, 'json_rows': 0}
        live = {'voucher': 0, 'allocation': 0}
        with ExitStack() as stack:
            for model, name in ((Voucher, 'voucher'), (PaymentAllocation, 'allocation')):
                original = model.from_db
                def observe(cls, *args, _original=original, _name=name):
                    item = _original(*args)
                    live[_name] += 1
                    metrics[_name + '_peak'] = max(metrics[_name + '_peak'], live[_name])
                    def released():
                        live[_name] -= 1
                    weakref.finalize(item, released)
                    return item
                stack.enter_context(patch.object(model, 'from_db', classmethod(observe)))
            original_json = JSONField.from_db_value
            def decoded(field, value, expression, conn):
                result = original_json(field, value, expression, conn)
                if isinstance(result, dict) and isinstance(result.get('payments'), list):
                    metrics['whole_payload_children'] = max(metrics['whole_payload_children'], len(result['payments']))
                return result
            stack.enter_context(patch.object(JSONField, 'from_db_value', decoded))
            original_refresh = Voucher.refresh_from_db
            def refresh(voucher, *args, **kwargs):
                if 'payload' in (kwargs.get('fields') or []):
                    raise AssertionError('Current CRM fetched a deferred whole payload')
                return original_refresh(voucher, *args, **kwargs)
            stack.enter_context(patch.object(Voucher, 'refresh_from_db', refresh))
            factory = connection.chunked_cursor
            class CursorProbe:
                def __init__(self, cursor):
                    self.cursor, self.json = cursor, False
                def __getattr__(self, name):
                    return getattr(self.cursor, name)
                def __enter__(self):
                    self.cursor.__enter__()
                    return self
                def __exit__(self, *args):
                    return self.cursor.__exit__(*args)
                def execute(self, sql, *args):
                    self.json = 'jsonb_array_elements' in sql or 'json_each' in sql
                    return self.cursor.execute(sql, *args)
                def fetchmany(self, *args):
                    rows = self.cursor.fetchmany(*args)
                    metrics['fetched_rows'] = max(metrics['fetched_rows'], len(rows))
                    if self.json:
                        metrics['json_rows'] += len(rows)
                    return rows
            stack.enter_context(patch.object(connection, 'chunked_cursor', side_effect=lambda: CursorProbe(factory())))
            yield metrics

    def test_one_source_501_payments_205_returns_and_allocations_matches_posting_oracle(self):
        sale = self.voucher(total='10000', payload={'payments': [{'amount': '0.01'}] * 501,
                                                 'due_date': (timezone.localdate() - timedelta(days=1)).isoformat()})
        Voucher.objects.bulk_create([Voucher(kind='customer_return', status='posted', date=self.today,
                                           store=self.store, created_by=self.u, reference=sale, total='1',
                                           payload={'payments': [{'amount': '0.01'}] * 3}) for _ in range(205)])
        legacy = self.voucher('payment', reference=sale, total='2')
        mapped = self.voucher('payment', reference=sale, total='3')
        PaymentAllocation.objects.create(settlement=mapped, payment=mapped, source=sale, amount='3')
        advance = self.voucher('payment', total='1000')
        events = Voucher.objects.bulk_create([Voucher(kind='advance_allocation', status='posted', date=self.today,
                                                     store=self.store, created_by=self.u, reference=advance, total='1') for _ in range(205)])
        PaymentAllocation.objects.bulk_create([PaymentAllocation(settlement=event, payment=advance, source=sale, amount='1') for event in events])
        expected = obligation(sale)
        before = (Voucher.objects.count(), PaymentAllocation.objects.count())
        with self.bounded_materialization() as metrics:
            result = self.facts()
        self.assertEqual(result['debt']['outstanding'], str(expected))
        self.assertEqual(result['debt']['overdue'], str(expected))
        self.assertEqual(result['debt']['documents'], 1)
        self.assertEqual(metrics['whole_payload_children'], 0)
        self.assertEqual(metrics['allocation_peak'], 0)
        self.assertLessEqual(metrics['voucher_peak'], children.CHUNK + 2)
        self.assertLessEqual(metrics['fetched_rows'], children.CHUNK)
        self.assertEqual(metrics['json_rows'], 501 + 205 * 3)
        self.assertEqual((Voucher.objects.count(), PaymentAllocation.objects.count()), before)
        self.record(metrics=metrics, expected=expected, legacy=legacy.pk, no_writes=True)

    def test_current_cutoff_legacy_mapping_reversals_and_negative_parity(self):
        tomorrow = timezone.localdate() + timedelta(days=1)
        sale = self.voucher(total='10', payload={'payments': [{'amount': '1.01'}, {'amount': 0.1}]})
        other = self.voucher('debt_opening', total='1')
        receipt = self.voucher('receipt', party=self.party, total='7')
        self.voucher('customer_return', reference=sale, total='2', payload={'payments': [{'amount': '0.10'}]})
        self.voucher('supplier_return', reference=sale, total='1', payload={'payments': [{'amount': '0.01'}]})
        self.voucher('payment', reference=sale, total='3', date=tomorrow)  # Current reads have no child date cutoff.
        mapped = self.voucher('payment', reference=sale, total='4')
        PaymentAllocation.objects.create(settlement=mapped, payment=mapped, source=sale, amount='2')
        cross = self.voucher('payment', reference=sale, total='6')
        PaymentAllocation.objects.create(settlement=cross, payment=cross, source=other, amount='0.50')
        funding = self.voucher('payment', total='8', status='reversed')
        event = self.voucher('advance_allocation', reference=funding, total='8')
        PaymentAllocation.objects.create(settlement=event, payment=funding, source=sale, amount='8')
        inactive = self.voucher('advance_allocation', reference=mapped, total='1', status='reversed')
        PaymentAllocation.objects.create(settlement=inactive, payment=mapped, source=sale, amount='1')
        self.voucher('customer_return', reference=sale, total='99', status='reversed')
        self.voucher('payment', reference=receipt, total='2')
        sources = [sale, other, receipt]
        expected = {source.pk: obligation(source) for source in sources}
        with self.bounded_materialization() as metrics:
            actual = {source.pk: amount for source, amount in current_source_obligations(Voucher.objects.filter(pk__in=expected))}
        self.assertEqual(actual, expected)
        self.assertLess(actual[sale.pk], 0)
        self.assertEqual(actual[other.pk], Decimal('0.50'))
        self.assertEqual(actual[receipt.pk], Decimal('5.00'))
        self.assertEqual(self.facts()['debt']['outstanding'], '0.50')
        self.assertEqual(metrics['whole_payload_children'], 0)
        Voucher.objects.filter(pk=sale.pk).update(payload={'payments': [{'amount': '0.001'}]})
        sale.refresh_from_db()
        with self.assertRaisesMessage(BusinessError, 'забагато знаків після коми'):
            obligation(sale)
        with self.assertRaisesMessage(BusinessError, 'забагато знаків після коми'):
            self.facts()
        self.record(expected=expected, actual=actual, metrics=metrics, malformed_precision_rejected=True)

    def test_due_truthiness_and_malformed_nested_values_preserve_unknown_count(self):
        for value in [None, '', False, 0, [], {}]:
            self.voucher(total='1', payload={'due_date': value})
        for value in [True, 1, 'invalid', ['nested'] * 501, {'large': [1] * 501}, '2026-02-30']:
            self.voucher(total='1', payload={'due_date': value})
        self.voucher(total='1')
        self.voucher(total='1', payload={'due_date': self.today})
        self.voucher(total='1', payload={'due_date': (timezone.localdate() - timedelta(days=1)).isoformat()})
        with self.bounded_materialization() as metrics:
            result = self.facts()['debt']
        self.assertEqual(result, {'outstanding': '15.00', 'overdue': '1.00', 'documents': 15,
                                 'overdueDocuments': 1, 'unknownDueDocuments': 6})
        self.assertEqual(metrics['whole_payload_children'], 0)
        self.record(debt=result, metrics=metrics)

    def test_source_batches_and_queries_are_independent_of_child_fanout(self):
        sale = self.voucher(total='1000')
        def query_count():
            with CaptureQueriesContext(connection) as queries:
                result = self.facts()
            reads = [q['sql'] for q in queries if q['sql'].lstrip().upper().startswith(('SELECT', 'DECLARE'))]
            self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for q in queries))
            if connection.vendor == 'postgresql':
                self.assertTrue(any('REPEATABLE READ, READ ONLY' in q['sql'] for q in queries))
            return len(reads), result
        baseline, _ = query_count()
        Voucher.objects.bulk_create([Voucher(kind='customer_return', status='posted', date=self.today,
                                           store=self.store, created_by=self.u, reference=sale, total='1', payload={}) for _ in range(205)])
        expanded, result = query_count()
        self.assertEqual(expanded, baseline)
        self.assertLessEqual(expanded, 12)
        self.assertEqual(result['debt']['outstanding'], '795.00')
        Voucher.objects.bulk_create([Voucher(kind='sale', status='posted', date=self.today, store=self.store,
                                           created_by=self.u, party=self.customer, total='1', payload={}) for _ in range(202)])
        batch_sizes = []
        original = children.obligations
        def counted(batch, cutoff):
            batch_sizes.append(len(batch))
            self.assertIsNone(cutoff)
            return original(batch, cutoff)
        with patch.object(children, 'obligations', side_effect=counted), self.bounded_materialization() as metrics:
            result = self.facts()
        self.assertEqual(batch_sizes, [200, 3])
        self.assertEqual(result['debt']['outstanding'], '997.00')
        self.assertLessEqual(metrics['voucher_peak'], children.CHUNK * 2 + 2)
        self.assertEqual(metrics['whole_payload_children'], 0)
        self.record(one_source_reads=baseline, fanout_reads=expanded, batches=batch_sizes, metrics=metrics)

    def test_fresh_role_store_and_disabled_actor_precede_private_reads(self):
        self.voucher(total='10')
        foreign = Store.objects.create(name='Foreign')
        self.voucher(total='999', store=foreign)
        self.assertEqual(self.u.profile.role, 'owner')  # Prime the stale relation cache.
        Profile.objects.filter(user=self.u).update(role='cashier', store=self.store)
        with patch('server.erp.customers.current_source_obligations', side_effect=AssertionError('Cashier must not read debt')):
            result = self.facts()
            contacts = customers.list_customers(self.u, {})
        self.assertIsNone(result['debt'])
        self.assertEqual(result['purchases']['gross'], '10.00')
        self.assertFalse(result['canEdit'])
        self.assertFalse(contacts['canEdit'])
        Profile.objects.filter(user=self.u).update(role='manager', store=foreign)
        self.assertEqual(self.facts()['purchases']['gross'], '999.00')
        with self.assertRaisesMessage(BusinessError, 'Магазин недоступний.'):
            self.facts(store=str(self.store.pk))
        Profile.objects.filter(user=self.u).update(role='warehouse')
        for reader in [lambda: self.facts(), lambda: customers.list_customers(self.u, {})]:
            with self.assertRaisesMessage(BusinessError, 'Недостатньо прав'):
                reader()
        User.objects.filter(pk=self.u.pk).update(is_active=False)
        with self.assertRaisesMessage(BusinessError, 'Обліковий запис вимкнено'):
            self.facts()
        self.record(fresh_role_store=True, cashier_debt_reader_calls=0, disabled_rejected=True)

    def test_postgresql_snapshot_keeps_one_current_read_during_new_payment(self):
        if connection.vendor != 'postgresql':
            self.skipTest('PostgreSQL repeatable-read concurrency contract')
        sale = self.voucher(total='100')
        inserted, failures = [], []
        def write_payment():
            try:
                child = Voucher.objects.create(kind='payment', status='posted', date=self.today,
                                               store_id=self.store.pk, created_by_id=self.u.pk,
                                               party_id=self.customer.pk, reference_id=sale.pk, total='50')
                inserted.append(child.pk)
            except BaseException as error:
                failures.append(error)
            finally:
                connections.close_all()
        def after_purchase_total(execute, sql, params, many, context):
            result = execute(sql, params, many, context)
            if not inserted and 'COUNT(' in sql and 'SUM(' in sql and 'erp_voucher' in sql:
                worker = threading.Thread(target=write_payment)
                worker.start()
                worker.join(10)
                self.assertFalse(worker.is_alive(), 'Concurrent fixture write completed')
                self.assertEqual(failures, [])
            return result
        with connection.execute_wrapper(after_purchase_total):
            first = self.facts()
        self.assertEqual(len(inserted), 1)
        self.assertEqual(first['debt']['outstanding'], '100.00')
        self.assertEqual(self.facts()['debt']['outstanding'], '50.00')
        self.record(first='100.00', next='50.00', concurrent_payment=inserted[0], repeatable_read=True)
