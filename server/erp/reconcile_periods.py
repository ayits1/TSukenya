"""Observed closed-period chronology, without guessing legacy timestamps or closure history."""
from bisect import bisect_left
from django.utils import timezone
from .models import AuditEvent, LedgerLock, Voucher
from .reconcile import issue
from .services import day, BusinessError


def check_periods():
    findings = []
    lock = LedgerLock.objects.filter(pk=1).first()
    closed = lock.closed_through if lock else None
    coverage = {'closed_through': closed.isoformat() if closed else None,
                'protected_drafts': Voucher.objects.filter(status='draft', date__lte=closed).count() if closed else 0,
                'unknown_operations': 0, 'invalid_period_events': 0, 'known_operations': 0}
    # A protected draft is operationally blocked, not proof that it was posted illegally.
    events = []
    for event in AuditEvent.objects.filter(action='period_changed', subject='ledger').order_by('at', 'pk'):
        data = event.detail
        try:
            value = day(data['date']) if isinstance(data, dict) and data.get('date') else None
            if not isinstance(data, dict) or 'date' not in data:
                raise ValueError
        except (ValueError, TypeError, BusinessError):
            # A malformed historical event makes that interval unknown; do not carry the last closure over it.
            value = False
            coverage['invalid_period_events'] += 1
        if isinstance(data, dict) and not str(data.get('reason') or '').strip():
            findings.append(issue('closed_period', f'audit/{event.pk}', 'Подія зміни періоду не містить обов’язкової причини.'))
        if events and events[-1][0] == event.at and events[-1][1] != value:
            events[-1] = (event.at, False)
            value = False
        events.append((event.at, value))
    times = [event[0] for event in events]
    if events and events[-1][1] is not False and events[-1][1] != closed:
        findings.append(issue('closed_period', 'ledger/1', 'Поточне закриття не відповідає останній відомій події зміни періоду.', events[-1][1], closed))
    if closed and closed >= timezone.localdate():
        findings.append(issue('closed_period', 'ledger/1', 'Закриття охоплює незавершений або майбутній день.', 'завершений день', closed))
    for voucher in Voucher.objects.order_by('pk').iterator(chunk_size=200):
        subject = f'voucher/{voucher.pk}'
        if voucher.status not in {'draft', 'posted', 'reversed'}:
            findings.append(issue('closed_period', subject, 'Невідомий обліковий статус документа.'))
        if voucher.status == 'draft' and (voucher.posted_at or voucher.reversed_at):
            findings.append(issue('closed_period', subject, 'Чернетка має час проведення або скасування.'))
        if voucher.status == 'posted' and voucher.reversed_at:
            findings.append(issue('closed_period', subject, 'Проведений документ має час скасування.'))
        if voucher.posted_at and voucher.reversed_at and voucher.reversed_at < voucher.posted_at:
            findings.append(issue('closed_period', subject, 'Скасування передує проведенню документа.'))
        operations = [('проведення', voucher.posted_at)] if voucher.status in {'posted', 'reversed'} else []
        if voucher.status == 'reversed': operations.append(('скасування', voucher.reversed_at))
        for label, at in operations:
            if at is None:
                coverage['unknown_operations'] += 1
                continue
            position = bisect_left(times, at)
            index = position - 1
            # Equal timestamps, absent history and malformed intervals cannot establish ordering.
            if index < 0 or position < len(times) and times[position] == at or events[index][1] is False:
                coverage['unknown_operations'] += 1
                continue
            coverage['known_operations'] += 1
            boundary = events[index][1]
            if boundary and voucher.date <= boundary:
                findings.append(issue('closed_period', subject, f'Відомий час {label} припадає на закритий для дати документа період.', f'дата після {boundary}', voucher.date))
    return findings, coverage
