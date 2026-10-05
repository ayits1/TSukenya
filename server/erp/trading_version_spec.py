"""Current resource map points to the accepted schema version.

A projection change requires a NEW migration/helper version, never editing 0024.
"""
from .migration_helpers.trading_versions_0024_spec import RESOURCES, RULES, TABLES, DB_TABLES, ROUTES, ROLES, COST, SALARY, FINANCE, STOCK_KINDS, PURCHASE_KINDS, SALE_KINDS, FINANCE_KINDS
