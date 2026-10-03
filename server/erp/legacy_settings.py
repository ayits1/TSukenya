"""Read-only settings DTO for the remaining legacy portal consumers."""
from copy import deepcopy

PUBLIC_SETTINGS = {'tag', 'chainName', 'storeNames', 'staleDays'}
PRICING_ROLES = {'manager', 'warehouse', 'accountant'}
PRICING_SETTINGS = {'defaultMarkup', 'rounding'}


def settings_for_role(data, role):
    if role == 'owner':
        return deepcopy(data)
    allowed = PUBLIC_SETTINGS | (PRICING_SETTINGS if role in PRICING_ROLES else set())
    return deepcopy({key: value for key, value in data.items() if key in allowed})
