"""Exact user-intent receipts for managed automatic task actions."""
from django.conf import settings
from django.db import models

class AlertTaskAction(models.Model):
    id = models.UUIDField(primary_key=True, editable=False)
    task = models.ForeignKey('erp.Document', on_delete=models.PROTECT)
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    fingerprint = models.CharField(max_length=64)
    applied_revision = models.CharField(max_length=32)
    cycle = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)
