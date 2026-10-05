"""Frozen 0030 selected task/caption routing. No mutable runtime imports."""
ROLES=('owner','manager','accountant')
TABLES={
 'operation':('erp_contacttaskoperation',('key','task_id','actor_id','action','created_at','original'),'task_id'),
 'task':('erp_contacttask',('id','customer_id','store_id','title','note','due_on','assignee_id','status','archived','revision','created_at','updated_at','completed_at'),None),
 'customer':('erp_counterparty',('id','name','active','kind'),'customer_id'),
 'store':('erp_store',('id','name','active'),'store_id'),
 'user':('auth_user',('id','username','is_active'),'assignee_id'),
 'profile':('erp_profile',('user_id','role','store_id'),'assignee_id'),
}
def stores(name,prefix):
    if name=='task':return f'SELECT {prefix}.store_id AS store_id'
    if name=='operation':return f'SELECT store_id FROM erp_contacttask WHERE id={prefix}.task_id'
    if name=='user':return f'SELECT store_id FROM erp_contacttask WHERE assignee_id={prefix}.id UNION SELECT t.store_id FROM erp_contacttaskoperation o JOIN erp_contacttask t ON t.id=o.task_id WHERE o.actor_id={prefix}.id'
    identifier='user_id' if name=='profile' else 'id'
    column=TABLES[name][2]
    return f'SELECT DISTINCT store_id FROM erp_contacttask WHERE {column}={prefix}.{identifier}'

def install(connection):
    with connection.cursor() as c:
        for name,(table,fields,_) in TABLES.items():
            if connection.vendor=='postgresql':
                compare='ROW('+','.join('OLD.'+f for f in fields)+') IS DISTINCT FROM ROW('+','.join('NEW.'+f for f in fields)+')'
                if name=='task':
                    selected="SELECT DISTINCT store_id FROM (SELECT OLD.store_id AS store_id WHERE TG_OP<>'INSERT' UNION SELECT NEW.store_id AS store_id WHERE TG_OP<>'DELETE') areas"
                elif name=='operation':
                    selected="SELECT DISTINCT store_id FROM erp_contacttask WHERE id IN (CASE WHEN TG_OP<>'INSERT' THEN OLD.task_id END, CASE WHEN TG_OP<>'DELETE' THEN NEW.task_id END)"
                elif name=='user':
                    selected="SELECT DISTINCT store_id FROM (SELECT store_id FROM erp_contacttask WHERE assignee_id IN (CASE WHEN TG_OP<>'INSERT' THEN OLD.id END, CASE WHEN TG_OP<>'DELETE' THEN NEW.id END) UNION SELECT t.store_id FROM erp_contacttaskoperation o JOIN erp_contacttask t ON t.id=o.task_id WHERE o.actor_id IN (CASE WHEN TG_OP<>'INSERT' THEN OLD.id END, CASE WHEN TG_OP<>'DELETE' THEN NEW.id END)) areas"
                else:
                    identifier='user_id' if name=='profile' else 'id'
                    selected=f"SELECT DISTINCT store_id FROM erp_contacttask WHERE {TABLES[name][2]} IN (CASE WHEN TG_OP<>'INSERT' THEN OLD.{identifier} END, CASE WHEN TG_OP<>'DELETE' THEN NEW.{identifier} END)"
                c.execute(f'''CREATE FUNCTION tsukenya_contact_{name}() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE area bigint; k text; BEGIN
                IF TG_OP='UPDATE' AND NOT ({compare}) THEN RETURN NULL; END IF;
                FOR area IN {selected} LOOP
                FOREACH k IN ARRAY ARRAY[{','.join("'customers_tasks:"+r+":store:'||area,'customers_tasks:"+r+":all'" for r in ROLES)}] LOOP
                INSERT INTO erp_tradingversion(key,revision) VALUES(k,1) ON CONFLICT(key) DO UPDATE SET revision=erp_tradingversion.revision+1;
                END LOOP; END LOOP; RETURN NULL; END $$;
                CREATE TRIGGER tsukenya_contact_{name} AFTER INSERT OR UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION tsukenya_contact_{name}();''')
            else:
                for op in ('INSERT','UPDATE','DELETE'):
                    compare=' OR '.join(f'OLD.{f} IS NOT NEW.{f}' for f in fields) if op=='UPDATE' else '1'
                    query=' UNION '.join(stores(name,p) for p in (('NEW',) if op=='INSERT' else ('OLD',) if op=='DELETE' else ('OLD','NEW')))
                    keys=' UNION '.join(x for r in ROLES for x in (f"SELECT 'customers_tasks:{r}:store:'||store_id AS key FROM areas",f"SELECT 'customers_tasks:{r}:all' AS key FROM areas"))
                    c.execute(f'''CREATE TRIGGER tsukenya_contact_{name}_{op.lower()} AFTER {op} ON {table} WHEN {compare} BEGIN
                    INSERT INTO erp_tradingversion(key,revision) SELECT key,1 FROM (WITH areas AS ({query}) {keys}) WHERE true
                    ON CONFLICT(key) DO UPDATE SET revision=revision+1; END''')

def uninstall(connection):
    with connection.cursor() as c:
        for name,(table,_,_) in TABLES.items():
            if connection.vendor=='postgresql':c.execute(f'DROP TRIGGER IF EXISTS tsukenya_contact_{name} ON {table}; DROP FUNCTION IF EXISTS tsukenya_contact_{name}()')
            else:
                for op in ('insert','update','delete'):c.execute(f'DROP TRIGGER IF EXISTS tsukenya_contact_{name}_{op}')
