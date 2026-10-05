"""Transactional invalidation only; fixed schema identifiers, no dynamic input SQL."""
import json
from .trading_versions_0024_spec import RULES, TABLES, DB_TABLES, ROUTES, STOCK_KINDS, PURCHASE_KINDS, SALE_KINDS, FINANCE_KINDS

PUBLIC_PRODUCT = ('name','unit','barcode','hidden','minStock')


def array(values):
    return 'ARRAY[' + ','.join("'"+v+"'" for v in values) + ']::text[]'


def projection(row, rule):
    condition = rule['condition']
    if condition=='pricing_settings':return f"CASE WHEN {row}->>'path'='settings/main' THEN tsukenya_trading_projection({row}->'data',ARRAY['defaultMarkup','rounding']::text[]) END"
    if condition in {'public_product','cost_product'}:
        data = row+"->'data'"
        if condition=='cost_product': return f"CASE WHEN {row}->>'path' LIKE 'products/%' THEN jsonb_build_object('path',{row}->'path','cost',{data}->'cost') END"
        return f"CASE WHEN {row}->>'path' LIKE 'products/%' THEN jsonb_build_array({row}->'path',tsukenya_trading_projection({data},{array(PUBLIC_PRODUCT)}),tsukenya_trading_price({data})) END"
    if rule['fields'] is None:return row
    return f"tsukenya_trading_projection({row},{array(rule['fields'])})"


def related(row, route):
    hops, column = ROUTES[route]
    if column is None:return 'NULL'
    if not hops:return f"{row}->>'{column}'"
    value=f"{row}->>'{hops[0][0]}'"
    for index, (_, table) in enumerate(hops):
        selected=hops[index+1][0] if index+1<len(hops) else column
        value=f"(SELECT link.{selected} FROM erp_{table} link WHERE link.id=({value})::bigint)"
    return f"({value})::text"


def condition(row, rule, role):
    name = rule['condition']
    kinds = {'stock_kind':STOCK_KINDS,'purchase_kind':PURCHASE_KINDS,'sale_kind':SALE_KINDS,
             'finance_kind':FINANCE_KINDS,'debt_kind':('sale','receipt','debt_opening','payment','advance_allocation','payment_refund','customer_return','supplier_return'),
             'advance_kind':('payment','advance_allocation','payment_refund'), 'salary_kind':('payroll','payroll_payment'),
             'stock_or_order_kind':('purchase_order','customer_order')}
    if name in kinds:
        result=f"{row}->>'kind'=ANY({array(kinds[name])})"
        if name=='stock_or_order_kind':result+=f" AND {row}->>'status'='posted'"
        if role=='manager' and name=='finance_kind':result+=f" AND NOT ({row}->>'kind'='expense' AND COALESCE({row}->'payload'->>'expense_scope','store')='network')"
        # manager cannot create initial money/debt documents, and does not read their journal.
        if role=='manager' and name=='finance_kind':result+=f" AND {row}->>'kind' NOT IN ('cash_opening','debt_opening')"
        return f'({result})'
    if name in {'parent_purchase','parent_sale','ledger_entry'}:
        allowed=PURCHASE_KINDS if name=='parent_purchase' else SALE_KINDS if name=='parent_sale' else None
        query=f"SELECT kind FROM erp_voucher WHERE id=({row}->>'voucher_id')::bigint"
        return f"({query})=ANY({array(allowed)})" if allowed else (f"({query}) NOT IN ('payroll','payroll_payment')" if role=='manager' else 'TRUE')
    if name=='ledger_header':return f"{row}->>'kind' NOT IN ('payroll','payroll_payment')" if role=='manager' else 'TRUE'
    if name=='pricing_settings':return f"{row}->>'path'='settings/main'"
    if name=='public_setting':return f"{row}->>'key' IN ('fiscal_required','max_cashier_discount')"
    if name in {'public_product','cost_product'}:return f"{row}->>'path' LIKE 'products/%'"
    return 'TRUE'


def install_pg(connection):
    with connection.cursor() as cursor:
        cursor.execute(PRICE_SQL)
        cursor.execute('''CREATE FUNCTION tsukenya_trading_projection(r jsonb, fields text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
            SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(CASE WHEN jsonb_typeof(r)='object' THEN r ELSE '{}'::jsonb END) WHERE key=ANY(fields) $$;
            CREATE FUNCTION tsukenya_trading_bump(keys text[]) RETURNS void LANGUAGE plpgsql AS $$ DECLARE k text; BEGIN
                FOR k IN SELECT DISTINCT v FROM unnest(keys) v WHERE v IS NOT NULL ORDER BY v LOOP
                    INSERT INTO erp_tradingversion(key,revision) VALUES(k,1) ON CONFLICT(key) DO UPDATE SET revision=erp_tradingversion.revision+1;
                END LOOP; END $$;''')
        for table in TABLES:
            statements=[]
            for rule in (r for r in RULES if r['table']==table):
                statements.append(f"IF ({projection('prior',rule)}) IS DISTINCT FROM ({projection('next',rule)}) THEN")
                for role in rule['roles']:
                    for resource in rule['resources']:
                        from .trading_versions_0024_spec import RESOURCES
                        if role not in RESOURCES[resource]:continue
                        prefix=resource+':'+role+':'
                        for row in ('prior','next'):
                            statements.append(f"IF {row} IS NOT NULL AND {condition(row,rule,role)} THEN")
                            for route in rule['routes']:
                                if route=='global':statements.append(f"keys:=array_append(keys,'{prefix}global');")
                                elif route=='opened_shifts':
                                    statements.append(f"FOR area IN SELECT DISTINCT store_id::text FROM erp_cashshift WHERE opened_by_id=({row}->>'id')::bigint LOOP keys:=array_append(keys,'{prefix}store:'||area); keys:=array_append(keys,'{prefix}all'); END LOOP;")
                                elif route=='voucher_accounts':
                                    statements.append(f"FOR area IN SELECT DISTINCT a.store_id::text FROM erp_cashentry e JOIN erp_cashaccount a ON a.id=e.account_id WHERE e.voucher_id=({row}->>'id')::bigint LOOP keys:=array_append(keys,'{prefix}store:'||area); keys:=array_append(keys,'{prefix}all'); END LOOP;")
                                else:
                                    statements.append(f"area:={related(row,route)}; IF area IS NOT NULL THEN keys:=array_append(keys,'{prefix}store:'||area); keys:=array_append(keys,'{prefix}all'); END IF;")
                            statements.append('END IF;')
                statements.append('END IF;')
            body='\n'.join(statements)
            sql=f'''CREATE FUNCTION tsukenya_trading_{table}() RETURNS trigger LANGUAGE plpgsql AS $$
                DECLARE prior jsonb; next jsonb; keys text[]:=ARRAY[]::text[]; area text;
                BEGIN IF TG_OP<>'INSERT' THEN prior:=to_jsonb(OLD); END IF; IF TG_OP<>'DELETE' THEN next:=to_jsonb(NEW); END IF;
                {body} PERFORM tsukenya_trading_bump(keys); RETURN NULL; END $$;
                CREATE TRIGGER tsukenya_trading_{table} AFTER INSERT OR UPDATE OR DELETE ON {DB_TABLES[table]}
                FOR EACH ROW EXECUTE FUNCTION tsukenya_trading_{table}();'''
            cursor.execute(sql)


def uninstall_pg(connection):
    with connection.cursor() as cursor:
        for table in TABLES:
            cursor.execute(f'DROP TRIGGER IF EXISTS tsukenya_trading_{table} ON {DB_TABLES[table]}')
            cursor.execute(f'DROP FUNCTION IF EXISTS tsukenya_trading_{table}()')
        cursor.execute('DROP FUNCTION IF EXISTS tsukenya_trading_projection(jsonb,text[]); DROP FUNCTION IF EXISTS tsukenya_trading_bump(text[]); DROP FUNCTION IF EXISTS tsukenya_trading_price(jsonb); DROP FUNCTION IF EXISTS tsukenya_trading_decimal(jsonb)')


def register_sqlite(connection):
    raw=connection.connection
    from .trading_versions_0024_spec import RESOURCES
    def fetch(row, hops, columns=('store_id',)):
        for index, (field, table) in enumerate(hops):
            if not row or row.get(field) is None:return None
            selected=(hops[index+1][0],) if index+1<len(hops) else columns
            # Only frozen schema column names, never user input; no payload/whole-row read.
            result=raw.execute(f"SELECT {','.join(selected)} FROM erp_{table} WHERE id=?",(row[field],))
            values=result.fetchone()
            if values is None:return None
            row=dict(zip(selected,values))
        return row
    def applies(row, rule, role):
        name=rule['condition']
        kinds={'stock_kind':STOCK_KINDS,'purchase_kind':PURCHASE_KINDS,'sale_kind':SALE_KINDS,'finance_kind':FINANCE_KINDS,
               'debt_kind':('sale','receipt','debt_opening','payment','advance_allocation','payment_refund','customer_return','supplier_return'),
               'advance_kind':('payment','advance_allocation','payment_refund'),'salary_kind':('payroll','payroll_payment'),
               'stock_or_order_kind':('purchase_order','customer_order')}
        if name in kinds:
            if row.get('kind') not in kinds[name]:return False
            if name=='stock_or_order_kind' and row.get('status')!='posted':return False
            if role=='manager' and name=='finance_kind':
                if row['kind'] in {'cash_opening','debt_opening'}:return False
                if row['kind']=='expense' and json.loads(row['payload']).get('expense_scope')=='network':return False
        elif name in {'parent_sale','parent_purchase','ledger_entry'}:
            parent=fetch(row,(('voucher_id','voucher'),),('kind',))
            if not parent:return False
            if name=='parent_sale':return parent['kind'] in SALE_KINDS
            if name=='parent_purchase':return parent['kind'] in PURCHASE_KINDS
            return role!='manager' or parent['kind'] not in {'payroll','payroll_payment'}
        elif name=='ledger_header':return role!='manager' or row['kind'] not in {'payroll','payroll_payment'}
        elif name=='pricing_settings':return row['path']=='settings/main'
        elif name=='public_setting':return row['key'] in {'fiscal_required','max_cashier_discount'}
        elif name in {'public_product','cost_product'}:return row['path'].startswith('products/')
        return True
    def project(row, rule):
        if row is None:return None
        if rule['condition']=='pricing_settings':
            if row['path']!='settings/main':return None
            data=json.loads(row['data']);data=data if isinstance(data,dict) else {};return {k:v for k,v in data.items() if k in {'defaultMarkup','rounding'}}
        if rule['condition'] in {'public_product','cost_product'}:
            if not row['path'].startswith('products/'):return None
            data=json.loads(row['data']);data=data if isinstance(data,dict) else {}
            if rule['condition']=='cost_product':return [row['path'],data.get('cost')]
            from ..catalog import pricing_config, regular_price, sale_price
            settings_row=raw.execute("SELECT data FROM erp_document WHERE path='settings/main'").fetchone()
            settings_data=json.loads(settings_row[0]) if settings_row else {}
            config=pricing_config(settings_data if isinstance(settings_data,dict) else {})
            return [row['path'],{k:v for k,v in data.items() if k in PUBLIC_PRODUCT},[str(regular_price(data,config)),str(sale_price(data,config))]]
        return row if rule['fields'] is None else {k:v for k,v in row.items() if k in rule['fields']}
    def keys(table, old, new):
        prior=json.loads(old) if old else None; next_=json.loads(new) if new else None; result=set()
        for rule in (r for r in RULES if r['table']==table):
            if project(prior,rule)==project(next_,rule):continue
            for row in (prior,next_):
                if row is None:continue
                for role in rule['roles']:
                    if not applies(row,rule,role):continue
                    for resource in rule['resources']:
                        if role not in RESOURCES[resource]:continue
                        prefix=resource+':'+role+':'
                        for route in rule['routes']:
                            if route=='opened_shifts':
                                for (store,) in raw.execute('SELECT DISTINCT store_id FROM erp_cashshift WHERE opened_by_id=?',(row['id'],)):
                                    result.update((prefix+'store:'+str(store),prefix+'all'))
                                continue
                            if route=='voucher_accounts':
                                for (store,) in raw.execute('SELECT DISTINCT a.store_id FROM erp_cashentry e JOIN erp_cashaccount a ON a.id=e.account_id WHERE e.voucher_id=?',(row['id'],)):
                                    result.update((prefix+'store:'+str(store),prefix+'all'))
                                continue
                            hops,column=ROUTES[route]
                            if column is None:result.add(prefix+'global');continue
                            target=fetch(row,hops,(column,))
                            if target and target.get(column) is not None:
                                result.update((prefix+'store:'+str(target[column]),prefix+'all'))
        return json.dumps(sorted(result))
    raw.create_function('tsukenya_trading_keys',3,keys)


def install_sqlite(connection):
    register_sqlite(connection)
    with connection.cursor() as cursor:
        for table in TABLES:
            columns=[c.name for c in connection.introspection.get_table_description(cursor,DB_TABLES[table])]
            def row(prefix):return 'json_object('+','.join("'%s',%s.%s"%(c,prefix,c) for c in columns)+')'
            for op in ('INSERT','UPDATE','DELETE'):
                old=row('OLD') if op!='INSERT' else 'NULL'; new=row('NEW') if op!='DELETE' else 'NULL'
                cursor.execute(f'''CREATE TRIGGER tsukenya_trading_{table}_{op.lower()} AFTER {op} ON {DB_TABLES[table]} BEGIN
                    INSERT INTO erp_tradingversion(key,revision) SELECT value,1 FROM json_each(tsukenya_trading_keys('{table}',{old},{new})) WHERE true
                    ON CONFLICT(key) DO UPDATE SET revision=revision+1; END''')


def uninstall_sqlite(connection):
    with connection.cursor() as cursor:
        for table in TABLES:
            for op in ('insert','update','delete'):cursor.execute(f'DROP TRIGGER IF EXISTS tsukenya_trading_{table}_{op}')


PRICE_SQL = r"""
CREATE FUNCTION tsukenya_trading_decimal(v jsonb) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE text_value text := v#>>'{}'; BEGIN
  IF text_value IS NULL OR text_value !~ '^\s*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\s*$' THEN RETURN 0; END IF;
  RETURN text_value::numeric;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN 0;
END $$;
CREATE FUNCTION tsukenya_trading_price(d jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE config jsonb; step numeric; markup numeric; regular numeric; promo numeric; promo_text text; manual boolean;
BEGIN
  SELECT data INTO config FROM erp_document WHERE path='settings/main';
  config:=coalesce(config,'{}'::jsonb);
  step:=tsukenya_trading_decimal(coalesce(config->'rounding','0.5'::jsonb)); IF step<=0 THEN step:=0.5; END IF;
  markup:=tsukenya_trading_decimal(coalesce(d->'markup',config->'defaultMarkup','30'::jsonb));
  manual:=d->'manualPrice' IS NOT NULL AND d->'manualPrice' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb,'{}'::jsonb,'[]'::jsonb);
  regular:=round(CASE WHEN manual THEN tsukenya_trading_decimal(d->'price') ELSE ceil(tsukenya_trading_decimal(d->'cost')*(1+markup/100)/step)*step END,2);
  promo_text:=replace(d->>'promotionPrice',',','.');
  promo:=tsukenya_trading_decimal(to_jsonb(promo_text));
  IF NOT (d->'promotion' IS NOT NULL AND d->'promotion' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb,'{}'::jsonb,'[]'::jsonb)
          AND promo>0 AND promo<=99999999.99 AND promo=round(promo,2) AND promo<regular) THEN promo:=regular; END IF;
  RETURN jsonb_build_array(regular,promo);
END $$;
"""
