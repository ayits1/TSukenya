"""Runtime SQLite registration for the installed trading projection version.

Historical migration 0024 imports its frozen helper directly, not this wrapper.
"""
from .migration_helpers.trading_versions_0024_sql import register_sqlite
