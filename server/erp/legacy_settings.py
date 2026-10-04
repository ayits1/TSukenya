"""Read-only settings DTO for the remaining legacy portal consumers."""
from copy import deepcopy

PUBLIC_SETTINGS = {'tag', 'chainName', 'storeNames', 'staleDays'}
PRICING_ROLES = {'manager', 'warehouse', 'accountant'}
PRICING_SETTINGS = {'defaultMarkup', 'rounding'}
CATALOG_SYNC_SETTINGS = {'gsId', 'gsTitle', 'gsUrl', 'gsSheetName'}
SCOPED_OWNER_SETTINGS = PUBLIC_SETTINGS | PRICING_SETTINGS | CATALOG_SYNC_SETTINGS


def settings_for_role(data, role, store_id=None):
    if role == 'owner' and store_id is None:
        return deepcopy(data)
    allowed = SCOPED_OWNER_SETTINGS if role == 'owner' else PUBLIC_SETTINGS | (PRICING_SETTINGS if role in PRICING_ROLES else set())
    return deepcopy({key: value for key, value in data.items() if key in allowed})


def authorize_settings_write(user, method, incoming=None):
    """Validate the submitted keys before merging any hidden network fields."""
    from .services import require
    if user.profile.role == 'owner' and user.profile.store_id is not None:
        require(method != 'DELETE', 'Недостатньо прав для видалення спільних налаштувань з мережевими фінансовими даними.')
        require(set(incoming or {}) <= SCOPED_OWNER_SETTINGS,
                'Недостатньо прав для зміни мережевих або приватних налаштувань.')
