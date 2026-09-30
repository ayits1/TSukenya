import os
from django.test import TestCase, override_settings
from django.contrib.auth.models import User
from django.utils import timezone
from server.auth import hash_password
from server.erp.models import *

class SecurityTests(TestCase):
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
