"""B06 exact-ID latest reads and stale saves; isolated synthetic records."""
import hashlib
import time
from django.contrib.auth.models import User
from django.test import TransactionTestCase
from server.erp.models import AuditEvent, Counterparty, Employee, LedgerLock, PortalSession, Profile, Store
from server.erp.services import record_revision

class EntityRecoveryTests(TransactionTestCase):
    def setUp(self):
        LedgerLock.objects.create(pk=1)
        self.store=Store.objects.create(name='QA local')
        self.user=User.objects.create(username='entity-recovery-owner')
        Profile.objects.create(user=self.user,role='owner',store=self.store)
        PortalSession.objects.create(token_hash=hashlib.sha256(b'entity-recovery').hexdigest(),user=self.user,csrf='entity-recovery-csrf',expires=int(time.time())+3600)
        self.client.cookies['ts_session']='entity-recovery'
        self.headers={'HTTP_ORIGIN':'http://testserver','HTTP_X_CSRF_TOKEN':'entity-recovery-csrf'}
    def latest(self,resource,id):
        return self.client.post('/api/v1/trading/directories/details',{'ids':[{'type':resource,'id':str(id)}],'purpose':'manage'},content_type='application/json',**self.headers)
    def test_stale_save_then_read_is_not_a_write_and_only_explicit_save_preserves_server_field(self):
        p=Counterparty.objects.create(name='Original',phone='111',kind='customer',active=False)
        original=record_revision(p)
        p.phone='222';p.save()
        payload={'id':p.pk,'revision':original,'name':'Mine','phone':'111','email':'','notes':'','kind':'customer','active':False}
        stale=self.client.post('/api/erp/entities/parties',payload,content_type='application/json',**self.headers)
        self.assertEqual(stale.status_code,409)
        self.assertFalse(AuditEvent.objects.exists())
        fresh=self.latest('parties',p.pk)
        self.assertEqual(fresh.status_code,200)
        row=fresh.json()['items'][0]
        self.assertEqual((row['phone'],row['active']),('222',False))
        self.assertFalse(AuditEvent.objects.exists())
        saved=self.client.post('/api/erp/entities/parties',{**payload,'revision':row['revision'],'phone':row['phone']},content_type='application/json',**self.headers)
        self.assertEqual(saved.status_code,200)
        p.refresh_from_db();self.assertEqual((p.name,p.phone),('Mine','222'))
        self.assertEqual(AuditEvent.objects.count(),1)
    def test_inactive_employee_latest_has_complete_terms_and_current_permission_blocks_read(self):
        e=Employee.objects.create(name='Inactive',store=self.store,shift_rate='100.00',bonus_percent='2.345',bonus_basis='store',active=False)
        read=self.latest('employees',e.pk)
        self.assertEqual(read.status_code,200)
        row=read.json()['items'][0]
        self.assertEqual((row['shift_rate'],row['bonus_percent'],row['bonus_basis'],row['active']),('100.00','2.345','store',False))
        self.assertEqual(row['revision'],record_revision(e))
        self.user.profile.role='accountant';self.user.profile.save()
        self.assertEqual(self.latest('employees',e.pk).status_code,403)
        self.assertFalse(AuditEvent.objects.exists())
