"""Durable identity only; planning receipts store no financial or text snapshots."""
from django.conf import settings
from django.db import models
from .budget_models import ExpenseCategory, MonthlyBudget
from .models import Store


class PlanningCreateReceipt(models.Model):
    key = models.CharField(max_length=100, primary_key=True)
    resource = models.CharField(max_length=20, choices=[('category', 'Стаття'), ('monthly_budget', 'Місячний бюджет')])
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    target_uuid = models.UUIDField(editable=False)
    month = models.DateField(null=True, editable=False)
    store = models.ForeignKey(Store, null=True, on_delete=models.PROTECT)
    category = models.ForeignKey(ExpenseCategory, null=True, on_delete=models.SET_NULL)
    budget = models.ForeignKey(MonthlyBudget, null=True, on_delete=models.SET_NULL)
    request_fingerprint = models.CharField(max_length=64, editable=False)
    created_fingerprint = models.CharField(max_length=64, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=(
            models.Q(resource='category', budget__isnull=True, month__isnull=True, store__isnull=True) |
            models.Q(resource='monthly_budget', category__isnull=True, month__isnull=False)
        ), name='planning_receipt_resource')]
