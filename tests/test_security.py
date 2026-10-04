import os
from django.test import TransactionTestCase, override_settings
from django.contrib.auth.models import User
from django.utils import timezone
from server.auth import hash_password
from server.erp.models import *

class SecurityTests(TransactionTestCase):
    def setUp(self):
        self.u=User.objects.create(username=os.environ.get('OWNER_USERNAME','pavlo'));Profile.objects.create(user=self.u,role='owner');LedgerLock.objects.create(pk=1)
        Setting.objects.create(key='owner_password',value=hash_password('isolated-owner-password'))
        self.s=Store.objects.create(name='First');self.other=Store.objects.create(name='Second')
        self.employee=Employee.objects.create(name='Worker',store=self.s,shift_rate=500,bonus_percent=5)
    def login(self,username,password):
        return self.client.post('/api/login',{'username':username,'password':password},content_type='application/json',HTTP_ORIGIN='http://testserver')
    def test_session_and_csrf(self):
        self.assertEqual(self.client.get('/api/erp/state').status_code,401)
        self.assertEqual(self.login(self.u.username,'isolated-owner-password').status_code,200)
        state=self.client.get('/api/state').json()
        self.assertEqual(self.client.post('/api/erp/entities/parties',{'name':'N','kind':'supplier'},content_type='application/json').status_code,403)
        self.assertEqual(self.client.post('/api/erp/entities/parties',{'name':'N','kind':'supplier'},content_type='application/json',HTTP_ORIGIN='http://evil.example',HTTP_X_CSRF_TOKEN=state['csrf']).status_code,403)
        self.assertEqual(self.client.post('/api/erp/entities/parties',{'name':'N','kind':'supplier'},content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN=state['csrf']).status_code,200)
    def test_cashier_salary_and_store_are_restricted(self):
        u=User.objects.create(username='cashier');u.set_password('isolated-cashier-password');u.save();Profile.objects.create(user=u,role='cashier',store=self.s)
        self.login('cashier','isolated-cashier-password')
        state=self.client.get('/api/erp/state').json()
        self.assertEqual(len(state['stores']),1);self.assertNotIn('shift_rate',state['employees'][0]);self.assertNotIn('work_shifts',state)
        self.assertEqual(self.client.get('/api/erp/report').status_code,403)
        self.assertEqual(self.client.get('/api/erp/audit').status_code,403)
        self.assertEqual(self.client.get('/api/erp/vouchers?kind=payroll').json()['items'],[])
    def test_legacy_credentials_and_password_change_invalidate_sessions(self):
        self.login(self.u.username,'isolated-owner-password');csrf=self.client.get('/api/state').json()['csrf']
        result=self.client.post('/api/account/password',{'current':'isolated-owner-password','new':'new-isolated-owner-password'},content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN=csrf)
        self.assertEqual(result.status_code,200);self.assertEqual(PortalSession.objects.count(),0)
        self.assertEqual(self.login(self.u.username,'new-isolated-owner-password').status_code,200)
    def test_login_throttle(self):
        from unittest.mock import patch
        with patch('server.erp.views.time.sleep'):
            for _ in range(15):self.assertEqual(self.login('unknown','bad').status_code,401)
            self.assertEqual(self.login('unknown','bad').status_code,429)
    def attempt(self,password,ip,device=None,username=None):
        self.client.cookies.clear()
        if device:self.client.cookies['ts_device']=device
        return self.client.post('/api/login',{'username':username or self.u.username,'password':password},content_type='application/json',HTTP_ORIGIN='http://testserver',REMOTE_ADDR=ip)
    def test_device_cookie_keeps_owner_login_during_username_lockout(self):
        import hashlib
        from unittest.mock import patch
        from django.core import signing
        with patch('server.erp.views.time.sleep'):
            first=self.attempt('isolated-owner-password','198.51.100.7')
            self.assertEqual(first.status_code,200)
            device=first.cookies['ts_device']
            self.assertEqual((device['httponly'],device['samesite'],device['max-age']),(True,'Strict',180*86400))
            for i in range(14):self.assertEqual(self.attempt('wrong',f'203.0.113.{i}').status_code,401)
            # A success is not counted and does not erase other clients' failures.
            self.assertEqual(self.attempt('isolated-owner-password','198.51.100.9').status_code,200)
            self.assertEqual(LoginThrottle.objects.get(pk=hashlib.sha256(('user:'+self.u.username).encode()).hexdigest()).attempts,14)
            self.assertEqual(self.attempt('wrong','203.0.113.99').status_code,401)
            self.assertEqual(self.attempt('isolated-owner-password','198.51.100.7').status_code,429)
            forged=device.value[:-1]+('A' if device.value[-1]!='A' else 'B')
            for cookie in [forged,signing.dumps('someone-else',salt='tsukenya.login-device'),signing.dumps(self.u.username)]:
                self.assertEqual(self.attempt('isolated-owner-password','198.51.100.7',cookie).status_code,429)
            self.assertEqual(self.attempt('isolated-owner-password','198.51.100.7',device.value).status_code,200)
    def test_device_cookie_does_not_lift_the_ip_limit(self):
        from unittest.mock import patch
        with patch('server.erp.views.time.sleep'):
            device=self.attempt('isolated-owner-password','198.51.100.7').cookies['ts_device'].value
            for _ in range(15):self.assertEqual(self.attempt('wrong','198.51.100.7',device).status_code,401)
            self.assertEqual(self.attempt('isolated-owner-password','198.51.100.7',device).status_code,429)
            self.assertEqual(self.attempt('isolated-owner-password','198.51.100.8',device).status_code,200)
    def test_malformed_request_values_are_client_errors(self):
        self.client.raise_request_exception=False
        with self.assertLogs('server.erp.views','WARNING'):
            lone=self.client.post('/api/login','{"username":"\\ud800","password":"x"}',content_type='application/json',HTTP_ORIGIN='http://testserver')
        self.assertIn(lone.status_code,{400,401})
        self.login(self.u.username,'isolated-owner-password');csrf=self.client.get('/api/state').json()['csrf']
        post=lambda path,value:self.client.post(path,value,content_type='application/json',HTTP_ORIGIN='http://testserver',HTTP_X_CSRF_TOKEN=csrf)
        today=timezone.localdate().isoformat()
        self.assertEqual(post('/api/erp/vouchers',{'kind':['sale'],'store':self.s.pk}).status_code,400)
        supplier=Counterparty.objects.create(name='Supplier',kind='supplier');warehouse=Warehouse.objects.create(store=self.s,name='Stock')
        self.assertEqual(post('/api/erp/vouchers',{'kind':'receipt','store':self.s.pk,'warehouse':warehouse.pk,'party':supplier.pk,'date':today,'lines':['x']}).status_code,400)
        for ids in (['x'],[{}],[True],[0]):
            draft=post('/api/erp/vouchers',{'kind':'payroll','store':self.s.pk,'date':today,'employee':self.employee.pk,'payload':{'shift_ids':ids}})
            self.assertEqual(draft.status_code,201,draft.content)
            result=post(f"/api/erp/vouchers/{draft.json()['id']}/post",{})
            self.assertEqual((result.status_code,result.json()['error']),(400,'Некоректний перелік відпрацьованих змін.'))
