"""Recheck catalogue mutation access after acquiring the company posting lock."""
from .services import require


def revalidate_actor(user, roles, message, *, network_only=False):
    # Authentication may have cached this actor before a long ledger-lock wait.
    # Refresh both objects before writes or returning a durable retry receipt.
    user.refresh_from_db(fields=['is_active'])
    user.profile.refresh_from_db()
    require(user.is_active and user.profile.role in roles
            and (not network_only or user.profile.store_id is None), message)
