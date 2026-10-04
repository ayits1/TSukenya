"""Fixed-cadence process liveness, independent of private import activity."""
from datetime import timedelta
from django.utils import timezone
from django.db.models import Max, Count, Q
from .service_models import ServiceHeartbeat

IMPORT_SERVICE='catalog_imports'
HEARTBEAT_SECONDS=10
STALE_SECONDS=45


def import_worker_status(*,at=None):
    """Read-only bounded aggregate; timestamps reveal liveness, never run progress."""
    now=at or timezone.now()
    valid=ServiceHeartbeat.objects.filter(service=IMPORT_SERVICE,seen_at__lte=now)
    facts=valid.aggregate(last=Max('seen_at'),fresh=Count('instance',filter=Q(stopped=False,seen_at__gt=now-timedelta(seconds=STALE_SECONDS))),live=Count('instance',filter=Q(stopped=False)))
    latest=facts['last'];fresh=facts['fresh']>0;stale=not fresh and facts['live']>0
    return {'status':'available' if fresh else 'stale' if stale else 'unavailable',
        'lastSeen':latest.isoformat() if latest else None,'staleAfterSeconds':STALE_SECONDS}


def heartbeat(instance,release,*,stopped=False):
    now=timezone.now()
    ServiceHeartbeat.objects.get_or_create(instance=instance,defaults={
        'service':IMPORT_SERVICE,'seen_at':now,'release':release,'stopped':stopped})
    query=ServiceHeartbeat.objects.filter(instance=instance,service=IMPORT_SERVICE)
    # A delayed background pulse cannot revive a confirmed stopped instance.
    if not stopped:query=query.filter(stopped=False)
    query.update(seen_at=now,release=release,stopped=stopped)


def prune_heartbeats():
    # Bounded technical cleanup only at runner startup; a crashed instance is
    # retained for a day so unavailable/stale remain distinguishable in the UI.
    old=list(ServiceHeartbeat.objects.filter(service=IMPORT_SERVICE,
        seen_at__lt=timezone.now()-timedelta(days=1)).order_by('seen_at').values_list('instance',flat=True)[:100])
    ServiceHeartbeat.objects.filter(instance__in=old).delete()
