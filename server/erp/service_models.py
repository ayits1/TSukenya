"""Technical service liveness; no import, user or business activity identifiers."""
import uuid
from django.db import models


class ServiceHeartbeat(models.Model):
    instance=models.UUIDField(primary_key=True,default=uuid.uuid4,editable=False)
    service=models.CharField(max_length=40)
    seen_at=models.DateTimeField()
    stopped=models.BooleanField(default=False)
    release=models.CharField(max_length=40,blank=True)

    class Meta:
        indexes=[models.Index(fields=['service','-seen_at'],name='service_heartbeat_seen')]
