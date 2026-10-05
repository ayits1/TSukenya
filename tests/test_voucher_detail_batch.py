"""Bounded detail reads preserve the former DTO and authoritative lineage rules."""
import hashlib
import json
import uuid
import time
from copy import deepcopy
from decimal import Decimal
from datetime import timedelta
from django.db import connection
from django.db.models import Sum
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from tests.test_erp import AccountingFixture
from server.erp.models import Document, PortalSession, StockEntry, Store, Voucher, VoucherLine, AuditEvent
from server.erp.reporting import voucher_json
from server.erp.services import ZERO, money, obligation, reverse_voucher, receipt_source

# Frozen pre-batch serializer: independently exercises the former per-row SQL and
# the authoritative receipt_source. It is an intentional DTO parity oracle.
def legacy_voucher_json(v, detail=False, *, user, settlements=None, allocations=None):
    result = {'id':v.pk,'number':f'{v.pk:06d}','kind':v.kind,'status':v.status,'date':v.date.isoformat(),'store':v.store_id,'warehouse':v.warehouse_id,'target':v.target_id,'party':v.party_id,'employee':v.employee_id,'account':v.account_id,'shift':v.shift_id,'reference':v.reference_id,'total':str(v.total),'cost':str(v.cost),'note':v.note,'created_by':v.created_by.username,'created_at':v.created_at.isoformat(),'posted_at':v.posted_at.isoformat() if v.posted_at else None,'revision':v.revision}
    if v.kind in {'receipt','sale','debt_opening'} and v.status=='posted':
        result['outstanding'] = str(obligation(v, settlements=settlements, allocations=allocations))
    if detail:
        result['payload']=deepcopy(v.payload)
        if v.kind in {'customer_order','purchase_order'}:
            from server.erp.orders import order_json
            result['order']=order_json(v,user)
        if v.kind in {'payment','advance_allocation'}:
            result['allocations']=[{'source':r.source_id,'number':f'{r.source_id:06d}','amount':str(r.amount)} for r in v.allocation_entries.all()]
        if v.kind=='payment' and v.status=='posted':
            from server.erp.settlements import unused
            result['unallocated']=str(unused(v))
        result['lines']=[{'id':l.pk,'line_key':str(l.line_key),'reference_line':l.reference_line_id,'product':l.product_id.split('/',1)[1],'name':l.name,'unit':l.unit,'quantity':str(l.quantity),'price':str(l.price),'amount':str(l.amount),'cost':str(l.cost),'lot':l.lot,'expiry':l.expiry.isoformat() if l.expiry else ''} for l in v.lines.all()]
        for row in result['lines']:
            l = v.lines.get(pk=row['id'])
            if v.kind == 'receipt' and v.status == 'posted':
                from server.erp.services import receipt_source
                source = receipt_source(l, strict=False)
                row['origin_known'] = source is not None
                if source:
                    row['lot'] = source.lot.code
                    row['expiry'] = source.lot.expiry.isoformat() if source.lot.expiry else ''
            next_kind={'purchase_order':'receipt','customer_order':'sale','sale':'customer_return','receipt':'supplier_return'}.get(v.kind)
            if next_kind:
                used=VoucherLine.objects.filter(reference_line=l,voucher__kind=next_kind,voucher__status='posted').aggregate(n=Sum('quantity'))['n'] or ZERO
                row['remaining']=str(l.quantity-used)
                returned_amount=VoucherLine.objects.filter(reference_line=l,voucher__kind=next_kind,voucher__status='posted').aggregate(n=Sum('amount'))['n'] or ZERO
                row['remaining_amount']=str(money(l.amount-returned_amount))
        result['movements']=[{'warehouse':e.lot.warehouse_id,'product':e.lot.product_id.split('/',1)[1],'lot':e.lot.code,'line':e.line_id,'quantity':str(e.quantity),'value':str(e.value),'reversal':e.is_reversal} for e in v.stock_entries.select_related('lot')]
        result['cash_movements']=[{'account':e.account_id,'amount':str(e.amount),'reversal':e.is_reversal} for e in v.cash_entries.all()]
    if user.profile.role == 'cashier':
        result.pop('cost', None)
        for discount in result.get('payload', {}).get('discounts', []):
            discount.pop('below_cost', None)
        for line in result.get('lines', []):
            line.pop('cost', None)
        for movement in result.get('movements', []):
            movement.pop('value', None)
    return result


class VoucherDetailBatchTests(TransactionTestCase):
    v = AccountingFixture.v
    sale = AccountingFixture.sale
    cash_start = AccountingFixture.cash_start

    def setUp(self):
        # HTTP snapshot reads must begin outside the fixture write transaction.
        from tests.catalog_index_fixture import clear_flushed_catalogue_tombstones
        clear_flushed_catalogue_tombstones()
        AccountingFixture.setUp(self)
        token='isolated-b24-detail'
        PortalSession.objects.create(token_hash=hashlib.sha256(token.encode()).hexdigest(),
            user=self.u,csrf='b24-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']=token

    def read(self, record):
        with CaptureQueriesContext(connection) as queries:
            response=self.client.get(f'/api/erp/vouchers/{record.pk}')
        self.assertEqual(response.status_code,200,response.content)
        actual=response.json()
        expected=legacy_voucher_json(Voucher.objects.get(pk=record.pk),True,user=self.u)
        self.assertEqual(actual,expected)
        return actual,len(queries)

    def test_one_thirty_and_hundred_actual_posted_rows_have_bounded_queries(self):
        products=[self.p]+[Document.objects.create(path=f'products/detail-{i}',data={'name':f'QA {i}','unit':'шт'}) for i in range(99)]
        counts={kind:[] for kind in ['receipt','sale']}
        for count in [1,30,100]:
            received=self.v('receipt',lines=[{'product':p.pk.split('/',1)[1],'quantity':'10','price':'5'} for p in products[:count]])
            sold=self.v('sale',party=self.customer.pk,lines=[{'product':p.pk.split('/',1)[1],'quantity':'1','price':'10'} for p in products[:count]],payload={'payments':[{'account':self.bank.pk,'amount':str(count*10)}]})
            for kind,record in [('receipt',received),('sale',sold)]:
                body,queries=self.read(record);counts[kind].append(queries)
                self.assertEqual(len(body['lines']),count)
                self.assertLessEqual(queries,14)
        self.assertEqual(len(set(counts['receipt'])),1)
        self.assertEqual(len(set(counts['sale'])),1)

    def test_partial_returns_and_reversal_preserve_each_line_quantity_and_amount(self):
        receipt=self.v('receipt',lines=[{'product':'p','quantity':'10','price':'5','lot':'a'},{'product':'p','quantity':'6','price':'7','lot':'b'}])
        lines=list(receipt.lines.all())
        returned=self.v('supplier_return',reference=receipt.pk,lines=[{'product':'p','quantity':'2','price':'5','reference_line':lines[0].pk}])
        body,_=self.read(receipt)
        self.assertEqual([(Decimal(r['remaining']),Decimal(r['remaining_amount'])) for r in body['lines']],[(8,40),(6,42)])
        reverse_voucher(self.u,returned.pk,'Ізольована перевірка B24')
        self.read(receipt)
        sale=self.sale(3)
        customer_return=self.v('customer_return',reference=sale.pk,party=self.customer.pk,qty=1,price=10,payload={'payments':[{'account':self.bank.pk,'amount':'10'}]})
        body,_=self.read(sale);self.assertEqual(Decimal(body['lines'][0]['remaining']),2)
        reverse_voucher(self.u,customer_return.pk,'Ізольована перевірка B24')
        self.read(sale)

    def test_order_fulfilment_totals_preserve_posted_only_references(self):
        order=self.v('purchase_order',qty=10)
        receipt=self.v('receipt',qty=4,reference=order.pk)
        body,_=self.read(order);self.assertEqual(Decimal(body['lines'][0]['remaining']),6)
        reverse_voucher(self.u,receipt.pk,'Ізольована перевірка B24');self.read(order)
        self.v('receipt',qty=10)
        customer_order=self.v('customer_order',qty=3,price=10,party=self.customer.pk)
        self.v('sale',qty=1,price=10,party=self.customer.pk,reference=customer_order.pk,payload={'payments':[{'account':self.bank.pk,'amount':'10'}]})
        body,_=self.read(customer_order);self.assertEqual(Decimal(body['lines'][0]['remaining']),2)

    def test_legacy_origin_ambiguity_and_negative_reversal_exclusions(self):
        expiry=timezone.localdate()+timedelta(days=3)
        receipt=self.v('receipt',lines=[{'product':'p','quantity':'10','price':'5','lot':'origin','expiry':expiry.isoformat()}])
        line=receipt.lines.get();source=receipt.stock_entries.get()
        # Historic line metadata can differ; the received movement is authoritative.
        VoucherLine.objects.filter(pk=line.pk).update(lot='outdated',expiry=None)
        StockEntry.objects.filter(pk=source.pk).update(line=None)
        StockEntry.objects.create(voucher=receipt,lot=source.lot,line=line,quantity=-1,value=-5)
        StockEntry.objects.create(voucher=receipt,lot=source.lot,line=line,quantity=1,value=5,is_reversal=True)
        body,_=self.read(receipt);self.assertTrue(body['lines'][0]['origin_known'])
        self.assertEqual((body['lines'][0]['lot'],body['lines'][0]['expiry']),('origin',expiry.isoformat()))
        # Two unannotated positive candidates are unknown, never guessed.
        extra=StockEntry.objects.create(voucher=receipt,lot=source.lot,quantity=1,value=5)
        body,_=self.read(receipt);self.assertFalse(body['lines'][0]['origin_known'])
        extra.delete()
        # Duplicate product rows also prevent the legacy fallback.
        VoucherLine.objects.create(voucher=receipt,product=self.p,name='QA duplicate',unit='шт',quantity=1,price=5,amount=5)
        body,_=self.read(receipt);self.assertTrue(all(not r['origin_known'] for r in body['lines']))
        # An annotated candidate wins even with repeated SKU, as in B11.
        StockEntry.objects.filter(pk=source.pk).update(line=line)
        body,_=self.read(receipt);self.assertTrue(body['lines'][0]['origin_known'])
        StockEntry.objects.create(voucher=receipt,lot=source.lot,line=line,quantity=1,value=5)
        body,_=self.read(receipt);self.assertFalse(body['lines'][0]['origin_known'])

    def test_cashier_redaction_and_foreign_direct_detail_scope(self):
        self.v('receipt',qty=10);sale=self.sale(2)
        self.u.profile.role='cashier';self.u.profile.store=self.store;self.u.profile.save()
        body,count=self.read(sale);self.assertLessEqual(count,14)
        self.assertNotIn('cost',body)
        self.assertTrue(all('cost' not in r for r in body['lines']))
        self.assertTrue(all('value' not in r for r in body['movements']))
        foreign=Store.objects.create(name='Foreign QA')
        hidden=Voucher.objects.create(kind='sale',store=foreign,date=self.today,created_by=self.u)
        response=self.client.get(f'/api/erp/vouchers/{hidden.pk}')
        self.assertEqual(response.status_code,403)
        # Fresh permission is checked again; no cached auth from the previous read.
        self.u.profile.role='viewer';self.u.profile.save()
        response=self.client.get(f'/api/erp/vouchers/{sale.pk}')
        self.assertEqual(response.status_code,403)

    def test_http_create_post_exact_retries_keep_dto_and_ledger(self):
        body={'kind':'receipt','store':self.store.pk,'warehouse':self.wh.pk,
            'party':self.party.pk,'date':self.today,'idempotency_key':str(uuid.uuid4()),
            'lines':[{'product':'p','quantity':'10','price':'5','lot':'retry-origin'}]}
        def send(path,value):
            response=self.client.post(path,data=json.dumps(value),content_type='application/json',
                HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN='b24-csrf')
            self.assertIn(response.status_code,[200,201],response.content)
            return response.json()
        created=send('/api/erp/vouchers',body)
        self.assertEqual(created['request_key'],body['idempotency_key'])
        posted=send(f"/api/erp/vouchers/{created['id']}/post",{'revision':created['revision']})
        created_retry=send('/api/erp/vouchers',body)
        posted_retry=send(f"/api/erp/vouchers/{created['id']}/post",{'revision':posted['revision']})
        # Create acknowledgements bind the original request; posting DTOs do not.
        self.assertEqual(created_retry,{**posted,'request_key':body['idempotency_key']})
        self.assertEqual(posted_retry,posted)
        record=Voucher.objects.get(pk=posted['id']);self.read(record)
        self.assertEqual(record.lines.count(),1)
        self.assertEqual(record.stock_entries.count(),1)
        self.assertEqual(AuditEvent.objects.filter(subject=f'voucher/{record.pk}').count(),2)
