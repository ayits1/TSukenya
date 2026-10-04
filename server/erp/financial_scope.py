"""Network-only legacy financial records have no per-store attribution."""
from .services import require


def network_owner(user):
    return user.profile.role == 'owner' and user.profile.store_id is None


def require_network_owner(user):
    require(network_owner(user), 'Мережеві фінансові дані доступні лише власнику без обмеження магазину.')
