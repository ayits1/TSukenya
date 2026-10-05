"""Runtime SQLite registration for the installed trading projection version.

Historical migration 0024 imports its frozen helper directly, not this wrapper.
"""
from types import SimpleNamespace
from .migration_helpers.trading_versions_0024_sql import register_sqlite as frozen_register


class PricingProjection:
    """Keep frozen routing/formulas, project its one internal defaults query.

    Other resources retain their original queries. No request text enters SQL;
    present keys and JSON types match the frozen pricing_config input exactly.
    """
    def __init__(self,raw):self.raw=raw
    def __getattr__(self,key):return getattr(self.raw,key)
    def execute(self,sql,*args):
        if sql=="SELECT data FROM erp_document WHERE path='settings/main'":
            expression="(SELECT coalesce(json_group_object(key,json(CASE WHEN type IN ('true','false','null') THEN type ELSE json_quote(value) END)),'{}') FROM json_each(data) WHERE key IN ('defaultMarkup','rounding'))"
            # The old callback treats non-object settings as empty. Preserve it;
            # malformed huge supported fields fail the transaction explicitly.
            sql=f"SELECT CASE WHEN json_type(data)='object' THEN CASE WHEN length(CAST(({expression}) AS BLOB))<=65536 THEN {expression} END ELSE '{{}}' END FROM erp_document WHERE path='settings/main'"
        return self.raw.execute(sql,*args)


def register_sqlite(connection):
    frozen_register(SimpleNamespace(connection=PricingProjection(connection.connection)))
