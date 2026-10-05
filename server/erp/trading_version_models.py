"""Private invalidation register. It is neither accounting data nor a read cache."""
from django.db import models


class TradingVersion(models.Model):
    key = models.CharField(max_length=160, primary_key=True)
    revision = models.PositiveBigIntegerField(default=1)
