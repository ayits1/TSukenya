"""B20 additive initiatives; legacy ideas/tasks and accounting entries keep their identities."""
import uuid
from django.conf import settings
from django.db import models


class IdeaProject(models.Model):
    id=models.UUIDField(primary_key=True,default=uuid.uuid4,editable=False)
    idea=models.OneToOneField('erp.Document',on_delete=models.PROTECT,related_name='idea_project')
    store=models.ForeignKey('erp.Store',null=True,on_delete=models.PROTECT)
    title=models.CharField(max_length=250)
    problem=models.TextField(blank=True)
    hypothesis=models.TextField(blank=True)
    responsible=models.ForeignKey(settings.AUTH_USER_MODEL,null=True,on_delete=models.PROTECT,related_name='responsible_initiatives')
    state=models.CharField(max_length=16,default='planned')
    planned_budget=models.DecimalField(max_digits=18,decimal_places=2,null=True)
    metric=models.CharField(max_length=160,blank=True)
    metric_unit=models.CharField(max_length=80,blank=True)
    target_value=models.DecimalField(max_digits=18,decimal_places=4,null=True)
    fact_value=models.DecimalField(max_digits=18,decimal_places=4,null=True)
    result_summary=models.TextField(blank=True)
    result_date=models.DateField(null=True)
    cancel_reason=models.TextField(blank=True)
    revision=models.PositiveIntegerField(default=1)
    created_by=models.ForeignKey(settings.AUTH_USER_MODEL,on_delete=models.PROTECT,related_name='created_initiatives')
    created_at=models.DateTimeField(auto_now_add=True)
    updated_at=models.DateTimeField(auto_now=True)
    class Meta:
        constraints=[models.CheckConstraint(condition=models.Q(planned_budget__gte=0)|models.Q(planned_budget__isnull=True),name='initiative_budget_nonnegative'),models.CheckConstraint(condition=models.Q(state__in=['planned','active','completed','cancelled']),name='initiative_state_valid')]


class ProjectTask(models.Model):
    project=models.ForeignKey(IdeaProject,on_delete=models.PROTECT,related_name='task_links')
    document=models.OneToOneField('erp.Document',on_delete=models.PROTECT,related_name='initiative_task')
    phase=models.CharField(max_length=160,blank=True)
    created_at=models.DateTimeField(auto_now_add=True)


class ProjectExpense(models.Model):
    project=models.ForeignKey(IdeaProject,on_delete=models.PROTECT,related_name='expense_links')
    voucher=models.OneToOneField('erp.Voucher',on_delete=models.PROTECT,related_name='initiative_expense')
    created_at=models.DateTimeField(auto_now_add=True)


class ProjectOperation(models.Model):
    key=models.UUIDField(primary_key=True)
    project=models.ForeignKey(IdeaProject,on_delete=models.PROTECT)
    actor=models.ForeignKey(settings.AUTH_USER_MODEL,on_delete=models.PROTECT)
    fingerprint=models.CharField(max_length=64)
    result=models.JSONField()
    created_at=models.DateTimeField(auto_now_add=True)
