"""Managed work does not hide the accounting condition; isolated task intents and SKU thresholds."""
import uuid
from datetime import date,timedelta
from unittest.mock import patch
from server.erp.models import Document,AlertTaskAction,AuditEvent,Store,Profile
from server.erp.managed_alerts import task_revision as record_revision
from server.erp.alerts import sync_alerts
from tests.test_unit_and_drafts import TransactionApiFixture

class ManagedAlertTests(TransactionApiFixture):
    def setUp(self):
        super().setUp();self.p.data['minStock']=2;self.p.save();sync_alerts(self.u)
        self.task=next(d for d in Document.objects.filter(path__startswith='tasks/auto_') if d.data['_alertKey']==f'low:{self.wh.pk}:p')
    def action(self,action='accept',key=None,**extra):
        self.task.refresh_from_db()
        value={'action':action,'revision':record_revision(self.task),'idempotencyKey':key or str(uuid.uuid4()),**extra}
        return self.call('post',f'/api/erp/alerts/tasks/{self.task.path.split("/",1)[1]}/actions',value),value
    def test_accepted_completed_and_manual_task_survive_unchanged_cron(self):
        response,_=self.action();self.assertEqual(response.status_code,200,response.content)
        self.task.refresh_from_db();self.assertEqual(self.task.data['_alertAcceptedBy'],'owner');self.assertEqual(self.task.data['status'],'doing')
        response,_=self.action('complete');self.assertEqual(response.status_code,200,response.content)
        self.task.refresh_from_db();revision=record_revision(self.task)
        manual=Document.objects.create(path='tasks/manual',data={'scope':'operations','status':'done','title':'Ручну роботу виконано','store':self.store.pk})
        self.assertEqual(sync_alerts(self.u)['reopened'],0);self.task.refresh_from_db();manual.refresh_from_db()
        self.assertEqual(self.task.data['status'],'done');self.assertTrue(self.task.data['_alertActive']);self.assertEqual(record_revision(self.task),revision);self.assertEqual(manual.data['status'],'done')
    def test_defer_explicit_date_then_single_wake_and_new_condition_cycle(self):
        until=(date.fromisoformat(self.today)+timedelta(days=2)).isoformat()
        response,_=self.action('defer',until=until,reason='Чекаємо поставку');self.assertEqual(response.status_code,200,response.content)
        self.task.refresh_from_db();revision=record_revision(self.task)
        self.assertEqual(sync_alerts(self.u)['reopened'],0);self.task.refresh_from_db();self.assertEqual(record_revision(self.task),revision)
        with patch('server.erp.managed_alerts.kyiv_day',return_value=date.fromisoformat(until)):
            self.assertEqual(sync_alerts(self.u)['reopened'],1);self.assertEqual(sync_alerts(self.u)['reopened'],0)
        self.assertEqual(AuditEvent.objects.filter(action='alert_defer_elapsed',subject=self.task.path).count(),1)
        self.p.data['minStock']=0;self.p.save();sync_alerts(self.u);self.task.refresh_from_db();self.assertFalse(self.task.data['_alertActive'])
        self.p.data['minStock']=2;self.p.save();sync_alerts(self.u);self.task.refresh_from_db();self.assertEqual(self.task.data['_alertCycle'],2);self.assertEqual(self.task.data['status'],'todo')
    def test_exact_retry_after_another_action_does_not_overwrite_and_wrong_author_conflicts(self):
        initial,body=self.action('accept');self.assertEqual(initial.status_code,200)
        self.action('defer',until=(date.fromisoformat(self.today)+timedelta(days=1)).isoformat(),reason='Нова дія')
        before=AuditEvent.objects.count();repeat=self.call('post',f'/api/erp/alerts/tasks/{self.task.path.split("/",1)[1]}/actions',body)
        self.assertEqual(repeat.status_code,200);self.assertTrue(repeat.json()['replayed']);self.assertEqual(repeat.json()['task']['data']['_alertWorkState'],'deferred');self.assertEqual(AuditEvent.objects.count(),before)
        changed=self.call('post',f'/api/erp/alerts/tasks/{self.task.path.split("/",1)[1]}/actions',{**body,'action':'complete'});self.assertEqual(changed.status_code,409)
        self.assertEqual(AlertTaskAction.objects.count(),2)
        from django.contrib.auth.models import User
        from server.erp.models import PortalSession
        other=User.objects.create(username='other-owner');Profile.objects.create(user=other,role='owner')
        session=PortalSession.objects.get(user=self.u);session.user=other;session.save()
        denied=self.call('post',f'/api/erp/alerts/tasks/{self.task.path.split("/",1)[1]}/actions',body)
        self.assertEqual(denied.status_code,409);self.assertEqual(denied.json()['code'],'idempotency_conflict')
        session.user=self.u;session.save();self.u.profile.role='cashier';self.u.profile.save()
        self.assertEqual(self.call('post',f'/api/erp/alerts/tasks/{self.task.path.split("/",1)[1]}/actions',body).status_code,403)
        self.u.profile.role='owner';self.u.profile.save()
        self.assertEqual(AuditEvent.objects.count(),before)
        malformed=self.call('post',f'/api/erp/alerts/tasks/{self.task.path.split("/",1)[1]}/actions',{**body,'idempotencyKey':str(uuid.uuid4())});self.assertEqual(malformed.status_code,409)
    def test_authorization_reload_after_ledger_wait_also_guards_exact_receipts(self):
        from django.contrib.auth.models import User
        from server.erp.services import ledger_lock
        other=Store.objects.create(name='Revoked scope')
        response,body=self.action('accept');self.assertEqual(response.status_code,200)
        before_data=dict(Document.objects.get(pk=self.task.pk).data);before_audit=AuditEvent.objects.count()
        for replay in [False,True]:
            for change in ['role','store','active']:
                with self.subTest(replay=replay,change=change):
                    def wait_then_revoke():
                        ledger_lock()
                        if change=='role':Profile.objects.filter(user=self.u).update(role='cashier')
                        elif change=='store':Profile.objects.filter(user=self.u).update(role='manager',store=other)
                        else:User.objects.filter(pk=self.u.pk).update(is_active=False)
                    request=body if replay else {**body,'action':'complete','revision':record_revision(Document.objects.get(pk=self.task.pk)),'idempotencyKey':str(uuid.uuid4())}
                    with patch('server.erp.managed_alerts.ledger_lock',side_effect=wait_then_revoke):
                        denied=self.call('post',f'/api/erp/alerts/tasks/{self.task.path.split("/",1)[1]}/actions',request)
                    self.assertEqual(denied.status_code,403,denied.content)
                    self.assertEqual(Document.objects.get(pk=self.task.pk).data,before_data)
                    self.assertEqual(AlertTaskAction.objects.count(),1);self.assertEqual(AuditEvent.objects.count(),before_audit)

    def test_roles_scope_malformed_and_generic_status_clear_defer(self):
        for role in ['warehouse','cashier','accountant']:
            self.u.profile.role=role;self.u.profile.save();response,_=self.action();self.assertEqual(response.status_code,403)
        self.u.profile.role='manager';self.u.profile.store=Store.objects.create(name='Other');self.u.profile.save();response,_=self.action();self.assertEqual(response.status_code,403)
        self.u.profile.role='owner';self.u.profile.store=None;self.u.profile.save()
        for extra in [{'until':self.today,'reason':'today'},{'until':'not-date','reason':'bad'},{'until':(date.fromisoformat(self.today)+timedelta(days=1)).isoformat(),'reason':''}]:
            response,_=self.action('defer',**extra);self.assertEqual(response.status_code,400)
        response,_=self.action('defer',until=(date.fromisoformat(self.today)+timedelta(days=1)).isoformat(),reason='Сировина');self.assertEqual(response.status_code,200)
        self.assertEqual(self.call('patch','/api/docs/'+self.task.path,{'status':'doing'},HTTP_IF_MATCH=record_revision(Document.objects.get(pk=self.task.path))).status_code,200)
        self.task.refresh_from_db();self.assertEqual(self.task.data['_alertWorkState'],'accepted');self.assertNotIn('_alertDeferredUntil',self.task.data)
        self.assertEqual(self.call('patch','/api/docs/'+self.task.path,{'_alertAcceptedBy':'forged'},HTTP_IF_MATCH=record_revision(Document.objects.get(pk=self.task.path))).status_code,400)
    def test_threshold_defaults_zero_expired_and_validation(self):
        from server.erp.models import StockLot
        from decimal import Decimal
        self.p.data.pop('minStock',None);self.p.save()
        lot=StockLot.objects.create(warehouse=self.wh,product=self.p,code='threshold',expiry=date.fromisoformat(self.today)+timedelta(days=4),quantity=1,value=Decimal('2'))
        sync_alerts(self.u);task=Document.objects.get(data___alertKey=f'expiry:{lot.pk}');self.assertTrue(task.data['_alertActive'])
        revision=self.product()['revision'];response=self.call('patch','/api/v1/catalog/products/p',{'revision':revision,'expiryAlertDays':0});self.assertEqual(response.status_code,200,response.content);sync_alerts(self.u);task.refresh_from_db();self.assertFalse(task.data['_alertActive'])
        lot.expiry=date.fromisoformat(self.today)-timedelta(days=1);lot.save();sync_alerts(self.u);task.refresh_from_db();self.assertTrue(task.data['_alertActive'])
        self.assertEqual(self.product()['expiryAlertDays'],0)
        for threshold in [True,-1,3651,'7',[],{}]:
            response=self.call('patch','/api/v1/catalog/products/p',{'revision':self.product()['revision'],'expiryAlertDays':threshold});self.assertEqual(response.status_code,400,response.content)
        self.assertEqual(self.call('patch','/api/v1/catalog/products/p',{'revision':self.product()['revision'],'expiryAlertDays':None}).status_code,200)
        self.assertIsNone(self.product()['expiryAlertDays'])
    def test_reprint_defer_wakes_once_and_only_actual_new_price_resets_work(self):
        from server.erp.promotion_history import observe_prices
        self.p.data.update({'manualPrice':True,'price':10});self.p.save();observe_prices(self.u,[self.p],'fixture','Baseline')
        self.p.data['price']=11;self.p.save();observe_prices(self.u,[self.p],'fixture','Actual transition')
        self.task=Document.objects.get(path__startswith='tasks/reprint_',data__store=self.store.pk)
        cycle=self.task.data['_alertCycle'];change=self.task.data['_priceChange']
        until=(date.fromisoformat(self.today)+timedelta(days=1)).isoformat();self.assertEqual(self.action('defer',until=until,reason='Наступна зміна')[0].status_code,200)
        with patch('server.erp.managed_alerts.kyiv_day',return_value=date.fromisoformat(until)):
            self.assertEqual(sync_alerts(self.u)['reopened'],1);self.assertEqual(sync_alerts(self.u)['reopened'],0)
        self.assertEqual(self.action('complete')[0].status_code,200);sync_alerts(self.u);self.task.refresh_from_db();self.assertEqual(self.task.data['status'],'done');self.assertEqual(self.task.data['_priceChange'],change)
        self.p.data['price']=12;self.p.save();observe_prices(self.u,[self.p],'fixture','Actual next transition')
        self.task.refresh_from_db();self.assertEqual(self.task.data['status'],'todo');self.assertEqual(self.task.data['_alertCycle'],cycle+1);self.assertNotEqual(self.task.data['_priceChange'],change);self.assertNotIn('_alertDeferredUntil',self.task.data)
    def test_task_revision_canonical_and_get_readonly(self):
        self.task.refresh_from_db();before=record_revision(self.task)
        self.task.data=dict(reversed(list(self.task.data.items())));self.assertEqual(record_revision(self.task),before)
        until=(date.fromisoformat(self.today)+timedelta(days=1)).isoformat();self.action('defer',until=until,reason='Явно')
        self.task.refresh_from_db();body=dict(self.task.data);audits=AuditEvent.objects.count()
        with patch('server.erp.managed_alerts.kyiv_day',return_value=date.fromisoformat(until)):
            response=self.client.get('/api/state');self.assertEqual(response.status_code,200)
        self.task.refresh_from_db();self.assertEqual(self.task.data,body);self.assertEqual(AuditEvent.objects.count(),audits)

from django.test import TransactionTestCase,RequestFactory
from django.db import connection,connections,close_old_connections
from django.contrib.auth.models import User
from tests.test_erp import AccountingFixture
from threading import Thread,Barrier
import json
from server.erp.managed_alerts import action
from server.erp.services import BusinessError

class ManagedAlertConcurrencyTests(TransactionTestCase):
    def setUp(self):
        AccountingFixture.setUp(self);self.p.data['minStock']=2;self.p.save();sync_alerts(self.u)
        self.task=next(d for d in Document.objects.filter(path__startswith='tasks/auto_') if d.data['_alertKey']==f'low:{self.wh.pk}:p')
    def run_actions(self,bodies):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL ledger lock')
        barrier=Barrier(2);results=[]
        def worker(body):
            close_old_connections()
            try:
                user=User.objects.get(pk=self.u.pk);request=RequestFactory().post('/',json.dumps(body),content_type='application/json');barrier.wait(timeout=10)
                results.append(action(request,user,self.task.path.split('/',1)[1]).status_code)
            except BusinessError as error:results.append(getattr(error,'code','blocked'))
            except Exception as error:results.append(type(error).__name__+': '+str(error))
            finally:connections.close_all()
        threads=[Thread(target=worker,args=(body,)) for body in bodies]
        for t in threads:t.start()
        for t in threads:t.join(timeout=15)
        self.assertFalse(any(t.is_alive() for t in threads));return results
    def test_same_intent_twice_is_one_action_and_changed_intents_do_not_race_overwrite(self):
        body={'action':'accept','revision':record_revision(self.task),'idempotencyKey':str(uuid.uuid4())}
        self.assertEqual(self.run_actions([body,body]),[200,200]);self.assertEqual(AlertTaskAction.objects.count(),1);self.assertEqual(AuditEvent.objects.filter(action='alert_task_action').count(),1)
        self.task.refresh_from_db();revision=record_revision(self.task)
        choices=[{'action':'complete','revision':revision,'idempotencyKey':str(uuid.uuid4())},{'action':'defer','revision':revision,'idempotencyKey':str(uuid.uuid4()),'until':(date.fromisoformat(self.today)+timedelta(days=1)).isoformat(),'reason':'Явно відкладено'}]
        self.assertCountEqual(self.run_actions(choices),[200,'revision_conflict']);self.assertEqual(AlertTaskAction.objects.count(),2)
