"""Posting chronology for final linked-shift bonuses; no guessed legacy ordering."""
from datetime import datetime, time
from django.utils import timezone


def posted_after(returned, payroll, *, attempt_at=None):
    """True/False for known instants, None when either historic instant is unknown.

    attempt_at is supplied only by posting under the ledger lock. Reversal must
    compare the return's persisted posting, never the current reversal time.
    Equal instants do not establish an after relationship.
    """
    returned_at = returned.posted_at or attempt_at
    if returned_at is None or payroll.posted_at is None:
        return None
    return returned_at > payroll.posted_at


def is_late_return(returned, payroll):
    known = posted_after(returned, payroll)
    return known if known is not None else returned.date > payroll.date


def return_order(returned):
    # Unknown legacy instants retain deterministic calendar ordering. They do
    # not establish same-day chronology against a payroll.
    instant = returned.posted_at or timezone.make_aware(datetime.combine(returned.date, time.min))
    return instant, returned.pk
