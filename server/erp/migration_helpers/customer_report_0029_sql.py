"""Frozen 0029 additive invalidation. Selected columns only, no business writes.

No mutable runtime projection/formula imports. Existing0024 triggers coexist.
"""
import json
from .customer_report_0029_spec import RULES, RESOURCES, TABLES, DB_TABLES, ROUTES, PAYLOAD, DATA


def condition(row, name, vendor):
    def v(key):return f"{row}->>'{key}'" if vendor=='postgresql' else f"json_extract({row},'$.{key}')"
    def among(key, values):return v(key)+' IN ('+','.join("'"+x+"'" for x in values)+')'
    effective=among('status',('posted','reversed'))
    if name=='always':return 'TRUE'
    if name=='customer':return v('kind')+"='customer'"
    if name=='product':return v('path')+" LIKE 'products/%'"
    if name=='effective':return effective
    if name=='customer_metric':return among('kind',('sale','customer_return'))+' AND '+v('status')+"='posted'"
    if name=='debt':return among('kind',('sale','receipt','debt_opening','payment','advance_allocation','payment_refund','customer_return','supplier_return'))+' AND '+effective
    if name in ('payroll','salary','sale'):
        kinds=('payroll',) if name=='payroll' else ('payroll','payroll_payment') if name=='salary' else ('sale','customer_return')
        return among('kind',kinds)+' AND '+effective
    if name=='period_payload':return among('kind',('expense','cash_difference'))+' AND '+effective+" AND NOT ("+v('kind')+"='expense' AND COALESCE("+v('expense_scope')+",'store')='network')"
    if name in ('period_store','period_network'):
        network=v('expense_scope')+"='network'"
        # expense_scope projected as original scalar text, independently of fields comparison.
        base=among('kind',('sale','customer_return','expense','writeoff','supplier_return','inventory','cash_difference'))+' AND '+effective
        return base+(' AND '+v('kind')+"='expense' AND "+network if name=='period_network' else " AND NOT ("+v('kind')+"='expense' AND COALESCE("+v('expense_scope')+",'store')='network')")
    if name in ('parent_sale','parent_product'):
        kinds=('sale','customer_return') if name=='parent_sale' else ('sale','customer_return','writeoff','inventory')
        cast='::bigint' if vendor=='postgresql' else ''
        return f"EXISTS(SELECT 1 FROM erp_voucher p WHERE p.id=({v('voucher_id')}){cast} AND p.kind IN ("+','.join("'"+x+"'" for x in kinds)+") AND p.status IN ('posted','reversed'))"
    raise ValueError(name)


def pg_related(row, route):
    hops,column=ROUTES[route]
    if not hops:return f"{row}->>'{column}'"
    value=f"{row}->>'{hops[0][0]}'"
    for i,(_,table) in enumerate(hops):
        selected=hops[i+1][0] if i+1<len(hops) else column
        value=f"(SELECT link.{selected} FROM erp_{table} link WHERE link.id=({value})::bigint)"
    return f'({value})::text'


def field_sql(prefix, field, vendor):
    if field=='payload_type':return f'jsonb_typeof({prefix}.payload)' if vendor=='postgresql' else f'json_type({prefix}.payload)'
    if field in PAYLOAD or field in DATA:
        column='payload' if field in PAYLOAD else 'data'; key=field if field in PAYLOAD else DATA[field]
        if vendor=='postgresql':
            return f"jsonb_build_array({prefix}.{column} ? '{key}',{prefix}.{column}->'{key}')"
        return f"json_array(json_type({prefix}.{column},'$.{key}') IS NOT NULL,{prefix}.{column} -> '$.{key}')"
    return f'{prefix}.{field}'


def row_sql(table,prefix,vendor):
    fields=set(f for r in RULES if r['table']==table for f in r['fields'])
    # Routing/condition fields are not silently added to the observable projection.
    fields.update({'id'} if table!='document' else {'path'})
    if table=='voucher':fields.update({'kind','status','store_id'})
    args=[]
    for field in sorted(fields):
        if field=='expense_scope':
            expr=f"{prefix}.payload->>'expense_scope'" if vendor=='postgresql' else f"json_extract({prefix}.payload,'$.expense_scope')"
        else:expr=field_sql(prefix,field,vendor)
        args.extend(("'"+field+"'",expr))
    function='jsonb_build_object' if vendor=='postgresql' else 'json_object'
    return function+'('+','.join(args)+')'


def reverse_route(name, identifier, vendor):
    """Only scalar stores of actual relational caption users, not a global key."""
    queries={
        'opened_shifts':"SELECT DISTINCT store_id FROM erp_cashshift WHERE opened_by_id={id}",
        'employee_shifts':"SELECT DISTINCT store_id FROM erp_cashshift WHERE employee_id={id} AND closed_at IS NOT NULL",
        'employee_payroll':"SELECT DISTINCT store_id FROM erp_voucher WHERE employee_id={id} AND kind IN ('payroll','payroll_payment') AND status IN ('posted','reversed')",
        'employee_work_shifts':"SELECT DISTINCT store_id FROM erp_workshift WHERE employee_id={id} AND payroll_id IS NOT NULL",
        'voucher_accounts':"SELECT DISTINCT a.store_id FROM erp_cashentry e JOIN erp_cashaccount a ON a.id=e.account_id WHERE e.voucher_id={id}",
        'voucher_lots':"SELECT DISTINCT w.store_id FROM erp_stockentry e JOIN erp_stocklot l ON l.id=e.lot_id JOIN erp_warehouse w ON w.id=l.warehouse_id WHERE e.voucher_id={id}",
    }
    query=queries[name].format(id=identifier)
    return "SELECT store_id::text FROM ("+query+") selected_stores" if vendor=='postgresql' else query


REVERSE_ROUTES={'opened_shifts','employee_shifts','employee_payroll','employee_work_shifts','voucher_accounts','voucher_lots'}


def install_pg(connection):
    with connection.cursor() as cursor:
        cursor.execute('''CREATE FUNCTION tsukenya_crmreport_bump(keys text[]) RETURNS void LANGUAGE plpgsql AS $$ DECLARE k text; BEGIN
        FOR k IN SELECT DISTINCT v FROM unnest(keys) v WHERE v IS NOT NULL ORDER BY v LOOP
        INSERT INTO erp_tradingversion(key,revision) VALUES(k,1) ON CONFLICT(key) DO UPDATE SET revision=erp_tradingversion.revision+1; END LOOP; END $$;''')
        for table in TABLES:
            body=[]
            for rule in (r for r in RULES if r['table']==table):
                projection=lambda row:'jsonb_build_array('+','.join(f"{row}->'{f}'" for f in rule['fields'])+')'
                body.append(f"IF {projection('prior')} IS DISTINCT FROM {projection('next')} THEN")
                for row in ('prior','next'):
                    body.append(f"IF {row} IS NOT NULL AND ({condition(row,rule['condition'],'postgresql')}) THEN")
                    for resource in rule['resources']:
                        for role in RESOURCES[resource]:
                            prefix=resource+':'+role+':'
                            for route in rule['routes']:
                                if route=='global':body.append(f"keys:=array_append(keys,'{prefix}global');")
                                elif route=='network':body.append(f"keys:=array_append(keys,'{prefix}all');")
                                elif route in REVERSE_ROUTES:
                                    query=reverse_route(route,f"({row}->>'id')::bigint",'postgresql')
                                    body.append(f"FOR area IN {query} LOOP keys:=array_append(keys,'{prefix}store:'||area); keys:=array_append(keys,'{prefix}all'); END LOOP;")
                                else:body.append(f"area:={pg_related(row,route)}; IF area IS NOT NULL THEN keys:=array_append(keys,'{prefix}store:'||area);keys:=array_append(keys,'{prefix}all'); END IF;")
                    body.append('END IF;')
                body.append('END IF;')
            cursor.execute(f'''CREATE FUNCTION tsukenya_crmreport_{table}() RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE prior jsonb; next jsonb; keys text[]:=ARRAY[]::text[]; area text;
            BEGIN IF TG_OP<>'INSERT' THEN prior:={row_sql(table,'OLD','postgresql')}; END IF;
            IF TG_OP<>'DELETE' THEN next:={row_sql(table,'NEW','postgresql')}; END IF;
            {' '.join(body)} PERFORM tsukenya_crmreport_bump(keys); RETURN NULL; END $$;
            CREATE TRIGGER tsukenya_crmreport_{table} AFTER INSERT OR UPDATE OR DELETE ON {DB_TABLES[table]}
            FOR EACH ROW EXECUTE FUNCTION tsukenya_crmreport_{table}();''')


def uninstall_pg(connection):
    with connection.cursor() as cursor:
        for table in TABLES:
            cursor.execute(f'DROP TRIGGER IF EXISTS tsukenya_crmreport_{table} ON {DB_TABLES[table]}; DROP FUNCTION IF EXISTS tsukenya_crmreport_{table}()')
        cursor.execute('DROP FUNCTION IF EXISTS tsukenya_crmreport_bump(text[])')


def register_sqlite(connection):
    raw=connection.connection
    def route(row,name):
        hops,column=ROUTES[name]
        value=row
        for i,(field,table) in enumerate(hops):
            if value.get(field) is None:return None
            selected=hops[i+1][0] if i+1<len(hops) else column
            result=raw.execute(f'SELECT {selected} FROM erp_{table} WHERE id=?',(value[field],)).fetchone()
            if result is None:return None
            value={selected:result[0]}
        return value.get(column)
    def keys(table,old,new):
        prior=json.loads(old) if old else None;next_=json.loads(new) if new else None;result=set()
        for rule in (r for r in RULES if r['table']==table):
            if prior is not None and next_ is not None and [prior.get(f) for f in rule['fields']]==[next_.get(f) for f in rule['fields']]:continue
            for row in (prior,next_):
                if row is None:continue
                # Parameterized row JSON, fixed frozen SQL condition; no interpolation of values.
                if not raw.execute('SELECT (?1 IS NOT NULL) AND ('+condition('?1',rule['condition'],'sqlite')+')',(json.dumps(row),)).fetchone()[0]:continue
                for resource in rule['resources']:
                    for role in RESOURCES[resource]:
                        prefix=resource+':'+role+':'
                        for name in rule['routes']:
                            if name=='global':result.add(prefix+'global');continue
                            if name=='network':result.add(prefix+'all');continue
                            if name in REVERSE_ROUTES:
                                query=reverse_route(name,'?','sqlite')
                                stores=(v[0] for v in raw.execute(query,(row['id'],)))
                            else:stores=[route(row,name)]
                            for store in stores:
                                if store is not None:result.update((prefix+'store:'+str(store),prefix+'all'))
        return json.dumps(sorted(result))
    raw.create_function('tsukenya_crmreport_keys',3,keys)


def install_sqlite(connection):
    register_sqlite(connection)
    with connection.cursor() as cursor:
        for table in TABLES:
            for op in ('INSERT','UPDATE','DELETE'):
                old=row_sql(table,'OLD','sqlite') if op!='INSERT' else 'NULL';new=row_sql(table,'NEW','sqlite') if op!='DELETE' else 'NULL'
                cursor.execute(f'''CREATE TRIGGER tsukenya_crmreport_{table}_{op.lower()} AFTER {op} ON {DB_TABLES[table]} BEGIN
                INSERT INTO erp_tradingversion(key,revision) SELECT value,1 FROM json_each(tsukenya_crmreport_keys('{table}',{old},{new})) WHERE true
                ON CONFLICT(key) DO UPDATE SET revision=revision+1; END''')


def uninstall_sqlite(connection):
    with connection.cursor() as cursor:
        for table in TABLES:
            for op in ('insert','update','delete'):cursor.execute(f'DROP TRIGGER IF EXISTS tsukenya_crmreport_{table}_{op}')
