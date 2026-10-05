"""0028 upgrade: scalar Document envelopes for existing SQLite invalidation.

PostgreSQL already evaluates its projections in SQL. SQLite must not transport
arbitrary product/recipe JSON into either Python invalidation callback. Other
families keep the installed 0015/0024 rules unchanged. Old envelopes remain
supported by state_version_sqlite.register during rolling QA migration.
"""
from django.db import connection as default_connection
from .migration_helpers.trading_versions_0024_sql import PUBLIC_PRODUCT

PRODUCT_FIELDS = (*PUBLIC_PRODUCT, 'cost','markup','price','manualPrice','promotion','promotionPrice')


def scalar_json(prefix, fields):
    # Frozen identifiers only. json_each retains absent-vs-null and string/number
    # types, unlike a projection that adds missing markup:null to the old price.
    allowed=','.join("'"+field+"'" for field in dict.fromkeys(fields))
    return f'''(SELECT coalesce(json_group_object(key,json(CASE WHEN type IN ('true','false','null')
              THEN type ELSE json_quote(value) END)),'{{}}') FROM json_each({prefix}.data) WHERE key IN ({allowed}))'''


def install(connection=default_connection):
    if connection.vendor!='sqlite':return
    from .trading_version_sql import register_sqlite
    register_sqlite(connection)
    table='erp_document'
    with connection.cursor() as cursor:
        columns=[c.name for c in connection.introspection.get_table_description(cursor,table)]
        for op in ('INSERT','UPDATE','DELETE'):
            changed='1' if op!='UPDATE' else '(OLD.path IS NOT NEW.path OR CAST(OLD.data AS TEXT) IS NOT CAST(NEW.data AS TEXT))'
            def envelope(prefix, trading):
                args=[]
                for field in columns:
                    value=f'{prefix}.{field}'
                    if field=='data':
                        projected=scalar_json(prefix,PRODUCT_FIELDS) if trading else 'NULL'
                        value=f"CASE WHEN {prefix}.path LIKE 'products/%' THEN {projected} WHEN {prefix}.path LIKE 'catalog_refs/%' THEN NULL ELSE {value} END"
                        value=f"(CAST({value} AS TEXT) || '')"
                    args.extend(("'"+field+"'",value))
                if not trading:args.extend(("'__dataChanged'",changed))
                return 'json_object('+','.join(args)+')'
            for name,trading,target,function in (('state',False,'erp_stateversion','tsukenya_state_keys'),('trading',True,'erp_tradingversion','tsukenya_trading_keys')):
                cursor.execute(f'DROP TRIGGER IF EXISTS tsukenya_{name}_document_{op.lower()}')
                old=envelope('OLD',trading) if op!='INSERT' else 'NULL'
                new=envelope('NEW',trading) if op!='DELETE' else 'NULL'
                cursor.execute(f'''CREATE TRIGGER tsukenya_{name}_document_{op.lower()} AFTER {op} ON {table} BEGIN
                    INSERT INTO {target}(key,revision) SELECT value,1 FROM json_each({function}('document',{old},{new})) WHERE true
                    ON CONFLICT(key) DO UPDATE SET revision=revision+1; END''')


def restore(connection):
    if connection.vendor!='sqlite':return
    with connection.cursor() as cursor:
        columns=[c.name for c in connection.introspection.get_table_description(cursor,'erp_document')]
        def envelope(prefix):return 'json_object('+','.join("'%s',%s.%s"%(field,prefix,field) for field in columns)+')'
        for op in ('INSERT','UPDATE','DELETE'):
            old=envelope('OLD') if op!='INSERT' else 'NULL';new=envelope('NEW') if op!='DELETE' else 'NULL'
            for name,target,function in (('state','erp_stateversion','tsukenya_state_keys'),('trading','erp_tradingversion','tsukenya_trading_keys')):
                cursor.execute(f'DROP TRIGGER IF EXISTS tsukenya_{name}_document_{op.lower()}')
                cursor.execute(f'''CREATE TRIGGER tsukenya_{name}_document_{op.lower()} AFTER {op} ON erp_document BEGIN
                    INSERT INTO {target}(key,revision) SELECT value,1 FROM json_each({function}('document',{old},{new})) WHERE true
                    ON CONFLICT(key) DO UPDATE SET revision=revision+1; END''')
