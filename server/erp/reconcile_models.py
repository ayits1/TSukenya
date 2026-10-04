"""Technical receipts only. No accounting movement or automatic correction."""
from django.db import models

class ReconciliationRun(models.Model):
    id = models.UUIDField(primary_key=True, editable=False)
    intent_hash = models.CharField(max_length=64)
    report_hash = models.CharField(max_length=64)
    source = models.CharField(max_length=12)
    status = models.CharField(max_length=20)
    checks_version = models.PositiveIntegerField(default=1)
    started_at = models.DateTimeField()
    finished_at = models.DateTimeField()
    recorded_at = models.DateTimeField(auto_now_add=True)
    summary = models.JSONField(default=dict)
    issue_count = models.PositiveIntegerField(default=0)
    error_code = models.CharField(max_length=40, blank=True)
    class Meta:
        indexes = [models.Index(fields=['-recorded_at'], name='reconcile_run_recorded')]

class ReconciliationFinding(models.Model):
    run = models.ForeignKey(ReconciliationRun, on_delete=models.CASCADE, related_name='findings')
    ordinal = models.PositiveIntegerField()
    check_name = models.CharField(max_length=40)
    subject = models.CharField(max_length=160)
    message = models.TextField()
    expected = models.TextField(null=True)
    actual = models.TextField(null=True)
    class Meta:
        constraints = [models.UniqueConstraint(fields=['run', 'ordinal'], name='reconcile_finding_ordinal')]
