"""Internal read invalidation register, maintained by transactional DB triggers."""
from django.db import models


class StateVersion(models.Model):
    key = models.CharField(max_length=160, primary_key=True)
    revision = models.PositiveBigIntegerField(default=1)
