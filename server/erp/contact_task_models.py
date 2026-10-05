"""B26 operational contact tasks, independent of accounting and managed alerts."""
import uuid
from django.conf import settings
from django.db import models

class ContactTask(models.Model):
    id=models.UUIDField(primary_key=True,default=uuid.uuid4,editable=False)
    customer=models.ForeignKey('erp.Counterparty',on_delete=models.PROTECT)
    store=models.ForeignKey('erp.Store',on_delete=models.PROTECT)
    title=models.CharField(max_length=250)
    note=models.CharField(max_length=4000,blank=True)
    due_on=models.DateField(null=True)
    assignee=models.ForeignKey(settings.AUTH_USER_MODEL,null=True,on_delete=models.PROTECT,related_name='contact_assignments')
    status=models.CharField(max_length=16,default='todo')
    archived=models.BooleanField(default=False)
    revision=models.PositiveIntegerField(default=1)
    created_by=models.ForeignKey(settings.AUTH_USER_MODEL,on_delete=models.PROTECT,related_name='created_contact_tasks')
    created_at=models.DateTimeField(auto_now_add=True)
    updated_at=models.DateTimeField(auto_now=True)
    completed_at=models.DateTimeField(null=True)
    class Meta:
        constraints=[models.CheckConstraint(condition=models.Q(status__in=['todo','doing','done','cancelled']),name='contact_task_status_valid'),models.CheckConstraint(condition=models.Q(revision__gte=1),name='contact_task_revision_positive')]
        indexes=[models.Index(fields=['customer','store','status','due_on'],name='contact_customer_queue'),models.Index(fields=['store','status','due_on'],name='contact_store_queue'),models.Index(fields=['assignee','store','status'],name='contact_assigned_queue')]

class ContactTaskOperation(models.Model):
    key=models.UUIDField(primary_key=True)
    actor=models.ForeignKey(settings.AUTH_USER_MODEL,on_delete=models.PROTECT)
    task=models.ForeignKey(ContactTask,on_delete=models.PROTECT,related_name='operations')
    store_id_snapshot=models.PositiveBigIntegerField()
    customer_id_snapshot=models.PositiveBigIntegerField()
    action=models.CharField(max_length=16)
    fingerprint=models.CharField(max_length=64)
    original=models.JSONField()
    created_at=models.DateTimeField(auto_now_add=True)
    class Meta:
        indexes=[models.Index(fields=['task','created_at'],name='contact_task_history')]
