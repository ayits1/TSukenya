"""B12 immutable recipes, actual manufacturing, expiry and legacy frozen terms: isolated only."""
import uuid
from datetime import date, timedelta
from unittest.mock import patch
from django.db import transaction
from server.erp.models import Document, RecipeVersion, RecipeComponent, Voucher, StockLot, StockEntry, AuditEvent
from server.erp.catalog import revision
from server.erp.services import save_voucher, post_voucher, reverse_voucher, BusinessError, ledger_lock
from tests.test_unit_and_drafts import ApiFixture

class ProductionVersionTests(ApiFixture):
    def setUp(self):
        super().setUp()
        self.output=Document.objects.create(path='products/output',data={'name':'Кекс із довгою назвою','unit':'шт','recipe':[{'product':'p','quantity':'2'}]})
    def approve(self,**extra):
        latest=RecipeVersion.objects.filter(product=self.output).order_by('-version').first()
        body={'idempotencyKey':str(uuid.uuid4()),'product':'output','expectedVersion':str(latest.pk) if latest else None,'catalogRevision':revision(self.output),'outputQuantity':'10.000','components':[{'product':'p','quantity':'20.000'}],'expiryPolicy':'unspecified','shelfLifeDays':None,'reason':'Затверджено технологічну рецептуру',**extra}
        response=self.call('post','/api/erp/recipes/versions',body)
        self.assertEqual(response.status_code,201,response.content)
        return response.json(),body
    def production(self,version,actual='8.000',planned='10.000',**extra):
        payload={'recipeVersion':version['id'],'plannedOutput':planned,'varianceReason':'Пояснені технологічні втрати',**extra}
        return save_voucher(self.u,{'kind':'production','store':self.store.pk,'warehouse':self.wh.pk,'date':self.today,'lines':[{'product':'output','quantity':actual}],'payload':{'production':payload,'additional_cost':'0.00'}})
    def receive(self,expiry=None,quantity='30.000',price='2.00',lot='raw'):
        v=save_voucher(self.u,{'kind':'receipt','store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,'date':self.today,'lines':[{'product':'p','quantity':quantity,'price':price,'lot':lot,'expiry':expiry}]});return post_voucher(self.u,v.pk)
    def test_version_idempotency_stale_approval_units_and_delete_guard(self):
        version,body=self.approve();audit_count=AuditEvent.objects.count()
        repeated=self.call('post','/api/erp/recipes/versions',body);self.assertEqual(repeated.status_code,200);self.assertEqual(repeated.json(),version);self.assertEqual(AuditEvent.objects.count(),audit_count)
        changed={**body,'reason':'Інший зміст'};self.assertEqual(self.call('post','/api/erp/recipes/versions',changed).status_code,409)
        stale={**body,'idempotencyKey':str(uuid.uuid4())};self.assertEqual(self.call('post','/api/erp/recipes/versions',stale).status_code,409)
        next_version,_=self.approve(components=[{'product':'p','quantity':'21.000'}]);self.assertEqual(next_version['version'],2)
        from server.erp.recipes_versions import terms
        self.assertEqual(terms(RecipeVersion.objects.select_related('approved_by').prefetch_related('components').get(pk=version['id'])),version)
        self.assertEqual(self.call('patch','/api/docs/products/p',{'unit':'кг'},HTTP_IF_MATCH=self.product()['revision']).status_code,400)
        out=self.product('output');self.assertEqual(self.call('delete','/api/v1/catalog/products/output',{'revision':out['revision']}).status_code,400)
        self.assertEqual(RecipeComponent.objects.filter(recipe_id=version['id']).get().quantity,20)
    def test_actual_yield_material_variance_cost_lots_retry_and_reversal(self):
        self.receive(quantity='10',price='2',lot='early',expiry=(date.fromisoformat(self.today)+timedelta(days=1)).isoformat())
        self.receive(quantity='20',price='3',lot='later',expiry=(date.fromisoformat(self.today)+timedelta(days=3)).isoformat())
        version,_=self.approve()
        draft=self.production(version,actualComponents=[{'product':'p','quantity':'21.000'}])
        posted=post_voucher(self.u,draft.pk);self.assertEqual(posted.cost,53);self.assertEqual(posted.lines.get().cost,53)
        result=posted.payload['production']['result'];self.assertEqual(result['lossQuantity'],'2.000');self.assertEqual(result['totalCost'],'53.00');self.assertIsNone(result['expiry'])
        consumed=posted.payload['consumed'][0];self.assertEqual(consumed['quantity'],'21.000');self.assertEqual([r['code'] for r in consumed['lots']],['early','later'])
        self.assertFalse(posted.stock_entries.filter(quantity__lt=0).exclude(line=None).exists());self.assertEqual(posted.stock_entries.get(quantity__gt=0).line_id,posted.lines.get().pk)
        entries=posted.stock_entries.count();post_voucher(self.u,draft.pk);self.assertEqual(posted.stock_entries.count(),entries)
        reverse_voucher(self.u,draft.pk,'Помилка виробничого документа');self.assertEqual(StockLot.objects.get(product=self.output).quantity,0);self.assertEqual(sum(StockLot.objects.filter(product=self.p).values_list('quantity',flat=True)),30)
        event=AuditEvent.objects.get(action='production_posted');self.assertEqual(event.detail['after']['result']['totalCost'],'53.00');self.assertEqual(len(event.detail['consumed'][0]['lots']),2)
    def test_old_draft_uses_frozen_version_and_legacy_live_recipe_is_not_read_again(self):
        self.receive();version,_=self.approve();draft=self.production(version)
        self.approve(components=[{'product':'p','quantity':'24.000'}])
        self.output.data['recipe']=[{'product':'p','quantity':'9'}];self.output.save()
        posted=post_voucher(self.u,draft.pk);self.assertEqual(posted.payload['consumed'][0]['quantity'],'20.000');self.assertEqual(posted.recipe_version_id,uuid.UUID(version['id']))
        legacy=save_voucher(self.u,{'kind':'production','store':self.store.pk,'warehouse':self.wh.pk,'date':self.today,'lines':[{'product':'output','quantity':'1'}]})
        self.output.data['recipe']=[{'product':'p','quantity':'1'}];self.output.save()
        legacy=post_voucher(self.u,legacy.pk);self.assertEqual(legacy.payload['consumed'][0]['quantity'],'9.000');self.assertEqual(legacy.payload['production']['source'],'legacy')
    def test_expiry_policies_unknown_block_owner_override_and_no_extension(self):
        self.receive();version,_=self.approve(expiryPolicy='components_min')
        draft=self.production(version)
        with self.assertRaisesMessage(BusinessError,'Термін сировини невідомий'):post_voucher(self.u,draft.pk)
        self.assertEqual(StockEntry.objects.filter(voucher=draft).count(),0);self.assertEqual(StockLot.objects.get(product=self.p).quantity,30)
        approved=self.production(version,expiryOverride={'date':(date.fromisoformat(self.today)+timedelta(days=2)).isoformat(),'reason':'Ручне технологічне рішення власника'})
        posted=post_voucher(self.u,approved.pk);self.assertEqual(posted.payload['production']['result']['expirySource'],'owner_override')
        self.receive(quantity='30',lot='known',expiry=(date.fromisoformat(self.today)+timedelta(days=4)).isoformat())
        known=self.production(version,actualComponents=[{'product':'p','quantity':'20','lot':'known'}],expiryOverride={'date':(date.fromisoformat(self.today)+timedelta(days=5)).isoformat(),'reason':'Спроба продовжити'})
        with self.assertRaisesMessage(BusinessError,'не може продовжувати'):post_voucher(self.u,known.pk)
        shorter=self.production(version,actualComponents=[{'product':'p','quantity':'20','lot':'known'}],expiryOverride={'date':(date.fromisoformat(self.today)+timedelta(days=3)).isoformat(),'reason':'Скорочуємо строк'})
        self.assertEqual(post_voucher(self.u,shorter.pk).lines.get().expiry,date.fromisoformat(self.today)+timedelta(days=3))
    def test_shelf_policy_calendar_boundary_and_required_deviation_reason(self):
        self.receive(expiry=(date.fromisoformat(self.today)+timedelta(days=5)).isoformat());version,_=self.approve(expiryPolicy='minimum_with_shelf_life',shelfLifeDays=2)
        with self.assertRaisesMessage(BusinessError,'Поясніть відхилення'):self.production(version,varianceReason='')
        v=self.production(version,actual='10',varianceReason='')
        self.assertEqual(post_voucher(self.u,v.pk).lines.get().expiry,date.fromisoformat(self.today)+timedelta(days=2))
        with self.assertRaises(BusinessError):self.production(version,actual='0')
        with self.assertRaises(BusinessError):self.production(version,actualComponents=[{'product':'p','quantity':'1.0001'}])
    def test_permissions_malformed_policy_and_audit_atomicity(self):
        version,body=self.approve()
        for role in ['cashier','accountant','warehouse']:
            self.u.profile.role=role;self.u.profile.save();self.assertEqual(self.call('post','/api/erp/recipes/versions',{**body,'idempotencyKey':str(uuid.uuid4())}).status_code,403)
        self.u.profile.role='owner';self.u.profile.save()
        for policy in [[],{},'unknown']:
            malformed={**body,'idempotencyKey':str(uuid.uuid4()),'expectedVersion':version['id'],'expiryPolicy':policy};self.assertEqual(self.call('post','/api/erp/recipes/versions',malformed).status_code,400)
        with patch('server.erp.recipes_versions.audit',side_effect=BusinessError('audit unavailable')):
            response=self.call('post','/api/erp/recipes/versions',{**body,'idempotencyKey':str(uuid.uuid4()),'expectedVersion':version['id']});self.assertEqual(response.status_code,400)
        self.assertEqual(RecipeVersion.objects.count(),1)
    def test_legacy_draft_material_identity_and_unsupported_cost_are_explicit(self):
        draft=save_voucher(self.u,{'kind':'production','store':self.store.pk,'warehouse':self.wh.pk,'date':self.today,'lines':[{'product':'output','quantity':'1'}]})
        self.output.data['recipe']=[];self.output.save()
        self.assertEqual(self.call('patch','/api/docs/products/p',{'unit':'кг'},HTTP_IF_MATCH=self.product()['revision']).status_code,400)
        self.assertEqual(self.call('delete','/api/v1/catalog/products/p',{'revision':self.product()['revision']}).status_code,400)
        draft.payload['additional_cost']='3.00';draft.save()
        with self.assertRaisesMessage(BusinessError,'Додаткові виробничі витрати'):post_voucher(self.u,draft.pk)
        body={'kind':'production','store':self.store.pk,'warehouse':self.wh.pk,'date':self.today,'lines':[{'product':'output','quantity':'1'}],'revision':draft.revision,'payload':{}}
        with self.assertRaisesMessage(BusinessError,'Власник має явно'):save_voucher(self.u,body,draft.pk)
        self.u.profile.role='warehouse';self.u.profile.save()
        with self.assertRaisesMessage(BusinessError,'Власник має явно'):save_voucher(self.u,{**body,'payload':{'additional_cost':'0.00'}},draft.pk)
        self.u.profile.role='owner';self.u.profile.save()
        fixed=save_voucher(self.u,{**body,'payload':{'additional_cost':'0.00'}},draft.pk)
        self.assertEqual(fixed.payload['production']['components'][0]['quantity'],'2.000')
        self.assertEqual(fixed.payload['additional_cost'],'0.00')
    def test_unspecified_policy_manual_date_cannot_extend_known_material_expiry(self):
        self.receive(expiry=(date.fromisoformat(self.today)+timedelta(days=1)).isoformat());version,_=self.approve()
        draft=self.production(version,expiryOverride={'date':(date.fromisoformat(self.today)+timedelta(days=3)).isoformat(),'reason':'Ручна дата'})
        with self.assertRaisesMessage(BusinessError,'не може продовжувати'):post_voucher(self.u,draft.pk)
        self.assertEqual(StockEntry.objects.filter(voucher=draft).count(),0)

    def test_production_cannot_consume_other_order_reserved_material(self):
        from server.erp.orders import mutate,order_json
        from server.erp.models import StockReservation
        self.p.data.update({'salePrice':'10.00','cost':'2.00'});self.p.save()
        self.receive(expiry=(date.fromisoformat(self.today)+timedelta(days=2)).isoformat())
        order=save_voucher(self.u,{'kind':'customer_order','store':self.store.pk,'warehouse':self.wh.pk,'party':self.customer.pk,'date':self.today,'lines':[{'product':'p','quantity':'12','price':'10'}]});post_voucher(self.u,order.pk)
        mutate(self.u,order.pk,{'action':'reserve','revision':order_json(order,self.u)['revision'],'idempotencyKey':str(uuid.uuid4()),'expires_on':self.today,'lines':[{'line':order.lines.get().pk,'quantity':'12'}]})
        version,_=self.approve();draft=self.production(version)
        with self.assertRaisesMessage(BusinessError,'Резерви інших замовлень недоступні'):post_voucher(self.u,draft.pk)
        self.assertEqual(StockEntry.objects.filter(voucher=draft).count(),0)
        self.assertEqual(StockLot.objects.get(product=self.p).quantity,30)
        reservation=StockReservation.objects.get()
        mutate(self.u,order.pk,{'action':'release','revision':order_json(order,self.u)['revision'],'idempotencyKey':str(uuid.uuid4()),'reservation':reservation.pk,'quantity':'2','reason':'Явно звільнено для виробництва'})
        self.assertEqual(post_voucher(self.u,draft.pk).cost,40)
        reservation.refresh_from_db();self.assertEqual(reservation.used,0);self.assertEqual(reservation.released,2)
        self.assertEqual(StockLot.objects.get(product=self.p).quantity,10)

    def test_non_owner_cannot_silently_remove_saved_owner_expiry_decision(self):
        version,_=self.approve()
        draft=self.production(version,expiryOverride={'date':(date.fromisoformat(self.today)+timedelta(days=1)).isoformat(),'reason':'Технологічне рішення власника'})
        self.u.profile.role='warehouse';self.u.profile.save()
        body={'kind':'production','store':self.store.pk,'warehouse':self.wh.pk,'date':self.today,'revision':draft.revision,'lines':[{'product':'output','quantity':'8'}],'payload':{'production':{'recipeVersion':version['id'],'plannedOutput':'10','varianceReason':'Незмінне відхилення'}}}
        with self.assertRaisesMessage(BusinessError,'Власник має редагувати'):save_voucher(self.u,body,draft.pk)
        draft.refresh_from_db();self.assertEqual(draft.payload['production']['expiryOverride']['reason'],'Технологічне рішення власника')

from django.test import TransactionTestCase,RequestFactory
import json
from django.db import connection,connections,close_old_connections
from django.contrib.auth.models import User
from threading import Barrier,Thread
from tests.test_erp import AccountingFixture
from server.erp.recipes_versions import create_version

class ProductionConcurrencyTests(TransactionTestCase):
    def setUp(self):
        AccountingFixture.setUp(self)
        self.output=Document.objects.create(path='products/output',data={'name':'Кекс','unit':'шт'})
    def body(self):
        return {'idempotencyKey':str(uuid.uuid4()),'product':'output','expectedVersion':None,'catalogRevision':revision(self.output),'outputQuantity':'10.000','components':[{'product':'p','quantity':'20.000'}],'expiryPolicy':'unspecified','shelfLifeDays':None,'reason':'Норматив'}
    def concurrent(self,functions):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL ledger locking')
        barrier=Barrier(2);results=[]
        def worker(fn):
            close_old_connections()
            try:barrier.wait(timeout=10);results.append(fn(User.objects.get(pk=self.u.pk)))
            except BusinessError as error:results.append(getattr(error,'code','blocked'))
            except Exception as error:results.append(type(error).__name__+': '+str(error))
            finally:connections.close_all()
        threads=[Thread(target=worker,args=(fn,)) for fn in functions]
        for thread in threads:thread.start()
        for thread in threads:thread.join(timeout=15)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        return results
    def create(self,user,body):
        request=RequestFactory().post('/api/erp/recipes/versions',json.dumps(body),content_type='application/json')
        return create_version(request,user)
    def test_competing_approvals_and_exact_retry(self):
        one=self.body();two=self.body()
        results=self.concurrent([lambda user:self.create(user,one).status_code,lambda user:self.create(user,two).status_code])
        self.assertCountEqual(results,[201,'revision_conflict']);self.assertEqual(RecipeVersion.objects.count(),1)
        saved=RecipeVersion.objects.get();body=one if str(saved.pk)==one['idempotencyKey'] else two
        results=self.concurrent([lambda user:self.create(user,body).status_code,lambda user:self.create(user,body).status_code])
        self.assertEqual(results,[200,200]);self.assertEqual(AuditEvent.objects.filter(action='recipe_version_approved').count(),1)
    def test_same_production_posted_twice_consumes_once(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL ledger locking')
        receipt=save_voucher(self.u,{'kind':'receipt','store':self.store.pk,'warehouse':self.wh.pk,'party':self.party.pk,'date':self.today,'lines':[{'product':'p','quantity':'30','price':'2'}]});post_voucher(self.u,receipt.pk)
        version=json.loads(self.create(self.u,self.body()).content)
        draft=save_voucher(self.u,{'kind':'production','store':self.store.pk,'warehouse':self.wh.pk,'date':self.today,'lines':[{'product':'output','quantity':'10'}],'payload':{'production':{'recipeVersion':version['id'],'plannedOutput':'10'}}})
        self.assertEqual(self.concurrent([lambda user:post_voucher(user,draft.pk).status,lambda user:post_voucher(user,draft.pk).status]),['posted','posted'])
        self.assertEqual(StockLot.objects.get(product=self.p).quantity,10);self.assertEqual(StockLot.objects.get(product=self.output).quantity,10)
        self.assertEqual(StockEntry.objects.filter(voucher=draft).count(),2);self.assertEqual(AuditEvent.objects.filter(action='production_posted').count(),1)

class ProductionReadSnapshotTests(TransactionTestCase):
    # GET owns its transaction; Django TestCase's outer writable transaction is unsuitable.
    setUp=ProductionConcurrencyTests.setUp
    body=ProductionConcurrencyTests.body
    create=ProductionConcurrencyTests.create

    def test_version_detail_readonly_snapshot_and_permissions(self):
        from server.erp.recipes_versions import handle_versions
        saved=json.loads(self.create(self.u,self.body()).content)
        before=AuditEvent.objects.count()
        response=handle_versions(RequestFactory().get('/api/erp/recipes/versions/'+saved['id']),self.u)
        self.assertEqual(response.status_code,200)
        self.assertEqual(json.loads(response.content),saved)
        self.assertEqual(AuditEvent.objects.count(),before)
        self.u.profile.role='cashier';self.u.profile.save()
        with self.assertRaisesMessage(BusinessError,'Недостатньо прав'):
            handle_versions(RequestFactory().get('/api/erp/recipes/versions/'+saved['id']),self.u)

    def test_list_and_latest_share_snapshot_during_concurrent_approval(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL repeatable read')
        from server.erp.recipes_versions import handle_versions
        from server.erp.promotions import paginate
        first=json.loads(self.create(self.u,self.body()).content)
        next_body={**self.body(),'expectedVersion':first['id'],'reason':'Нові умови'}
        results=[]
        def writer():
            close_old_connections()
            try:results.append(self.create(User.objects.get(pk=self.u.pk),next_body).status_code)
            except Exception as error:results.append(str(error))
            finally:connections.close_all()
        def after_page(request,query):
            rows,page=paginate(request,query)
            with connection.cursor() as cursor:
                cursor.execute('SHOW transaction_isolation');self.assertEqual(cursor.fetchone()[0],'repeatable read')
                cursor.execute('SHOW transaction_read_only');self.assertEqual(cursor.fetchone()[0],'on')
            thread=Thread(target=writer);thread.start();thread.join(timeout=10)
            self.assertFalse(thread.is_alive());self.assertEqual(results,[201])
            return rows,page
        with patch('server.erp.promotions.paginate',side_effect=after_page):
            response=handle_versions(RequestFactory().get('/api/erp/recipes/versions',{'product':'output'}),self.u)
        data=json.loads(response.content)
        self.assertEqual(data['total'],1);self.assertEqual(data['latestVersion'],first['id'])
        self.assertEqual([item['id'] for item in data['items']],[first['id']])
        self.assertEqual(RecipeVersion.objects.count(),2)
        self.assertEqual(AuditEvent.objects.filter(action='recipe_version_approved').count(),2)

    def test_approval_rechecks_role_after_ledger_wait(self):
        actual=ledger_lock
        def changed_actor():
            result=actual()
            type(self.u.profile).objects.filter(user=self.u).update(role='warehouse')
            return result
        with patch('server.erp.recipes_versions.ledger_lock',side_effect=changed_actor):
            with self.assertRaisesMessage(BusinessError,'Немає доступу'):
                self.create(self.u,self.body())
        self.assertEqual(RecipeVersion.objects.count(),0)
        self.assertEqual(AuditEvent.objects.filter(action='recipe_version_approved').count(),0)
