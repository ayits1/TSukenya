"""Owner planning records. No stock/cash postings are attached to these models."""
import uuid
from django.db import models
from .models import Store

class ExpenseCategory(models.Model):
    id=models.UUIDField(primary_key=True,default=uuid.uuid4,editable=False)
    name=models.CharField(max_length=160)
    semantic_key=models.CharField(max_length=40,null=True,blank=True,unique=True,editable=False)
    active=models.BooleanField(default=True)
    revision=models.PositiveIntegerField(default=1)

class ExpenseCategoryAlias(models.Model):
    category=models.ForeignKey(ExpenseCategory,on_delete=models.PROTECT,related_name='aliases')
    name=models.CharField(max_length=160,unique=True)

class MonthlyBudget(models.Model):
    id=models.UUIDField(primary_key=True,default=uuid.uuid4,editable=False)
    month=models.DateField()
    store=models.ForeignKey(Store,null=True,blank=True,on_delete=models.PROTECT)
    planned_revenue=models.DecimalField(max_digits=18,decimal_places=2,default=0)
    revision=models.PositiveIntegerField(default=1)
    create_key=models.CharField(max_length=100,null=True,unique=True)
    fingerprint=models.CharField(max_length=64,blank=True)
    class Meta:
        constraints=[models.UniqueConstraint(fields=['month','store'],condition=models.Q(store__isnull=False),name='monthly_budget_store'),models.UniqueConstraint(fields=['month'],condition=models.Q(store__isnull=True),name='monthly_budget_network'),models.CheckConstraint(condition=models.Q(planned_revenue__gte=0),name='budget_revenue_nonnegative')]

class BudgetLine(models.Model):
    id=models.UUIDField(primary_key=True,default=uuid.uuid4,editable=False)
    budget=models.ForeignKey(MonthlyBudget,on_delete=models.CASCADE,related_name='lines')
    category=models.ForeignKey(ExpenseCategory,on_delete=models.PROTECT)
    category_name=models.CharField(max_length=160)
    position=models.PositiveSmallIntegerField(default=0)
    mode=models.CharField(max_length=24,choices=[('fixed_amount','Постійна сума'),('variable_amount','Змінна сума'),('revenue_rate','Відсоток від виторгу')])
    amount=models.DecimalField(max_digits=18,decimal_places=2,default=0)
    rate=models.DecimalField(max_digits=7,decimal_places=3,default=0)
    base=models.CharField(max_length=20,default='revenue')
    class Meta:
        constraints=[models.CheckConstraint(condition=models.Q(amount__gte=0),name='budget_amount_nonnegative'),models.CheckConstraint(condition=models.Q(rate__gte=0,rate__lte=100),name='budget_rate_bounds')]
