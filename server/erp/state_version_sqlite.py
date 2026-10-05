"""SQLite QA implementation of the PostgreSQL transactional invalidation map.

A deterministic key callback only reads related rows; trigger SQL owns all writes.
Registered on every SQLite connection, including connections opened by test workers.
"""
import json
from .state_version_sql import PUBLIC, PRICING, SYNC, TABLES


def task_keys(data, owners_only=False):
    store = data.get('store')
    area = 'network' if store is None else str(store) if type(store) is int and store > 0 else 'invalid'
    if str(data.get('_alertKey', '')).startswith('due:'):
        return ['owner_due:'+area] + (['finance_due:'+area] if not owners_only and data.get('scope')=='operations' and area!='invalid' else [])
    return ['owner_tasks'] + (['ops_tasks' if area=='network' else 'ops_tasks:'+area] if not owners_only and data.get('scope')=='operations' and area!='invalid' else [])


def register(connection):
    raw = connection.connection
    def spelling(value):return json.dumps(value,sort_keys=True,separators=(',',':'))
    # Only numeric leaves enter Python; historical JSON graphs stay in SQL.
    raw.create_function('tsukenya_real_spelling',1,spelling,deterministic=True)
    def related(query, values):
        return raw.execute(query, values).fetchall()
    def keys(table, old, new):
        old=json.loads(old) if old else None; new=json.loads(new) if new else None
        # Scalar catalogue envelopes deliberately omit data; their SQL flag
        # distinguishes real writes from true no-ops even when paths match.
        scalar_catalogue = table=='document' and any(r and r.get('__dataChanged') for r in (old,new))
        if old==new and not scalar_catalogue:return '[]'
        # Catalogue invalidation needs only the path and SQL semantic equality.
        # The trigger envelope contains a transport string; do not decode its
        # arbitrarily large nested recipe/unknown object graph. Object-key reordering
        # is a no-op; numeric types and signed zero remain significant.
        catalogue = lambda row: row and (row['path'].startswith('products/') or row['path'].startswith('catalog_refs/'))
        if table=='document' and old and new and old['path']==new['path']:
            if catalogue(old):
                if '__dataChanged' in new:
                    if not new['__dataChanged']: return '[]'
                elif old['data']==new['data']: return '[]'
            elif spelling(json.loads(old['data']))==spelling(json.loads(new['data'])):return '[]'
        result=[]; rows=[r for r in (old,new) if r is not None]
        if table=='document':
            prior=json.loads(old['data']) if old and old['path']=='settings/main' else {}
            next_=json.loads(new['data']) if new and new['path']=='settings/main' else {}
            for names,key in ((PUBLIC,'labels'),(PRICING,'pricing'),(SYNC,'owner_sync')):
                if spelling({k:v for k,v in prior.items() if k in names})!=spelling({k:v for k,v in next_.items() if k in names}): result.append(key)
            allowed=set(PUBLIC+PRICING+SYNC)
            if spelling({k:v for k,v in prior.items() if k not in allowed})!=spelling({k:v for k,v in next_.items() if k not in allowed}):result.append('private_settings')
            for row in rows:
                path=row['path']
                if path.startswith('products/'):
                    result.append('catalog');continue
                if path.startswith('catalog_refs/'):
                    result.append('references');continue
                data=json.loads(row['data'])
                if path.startswith('tasks/'):result+=task_keys(data)
                elif path.startswith('ideas/'):
                    result.append('owner_ideas')
                    if data.get('scope')=='operations':result.append('ops_ideas')
                elif path.startswith('expenses/'):result.append('expenses')
                elif path=='project/state':result.append('project_state')
        elif table=='store':
            if old and new and all(old[k]==new[k] for k in ('id','name','active')):return '[]'
            result=['stores_all']+['store:'+str(r['id']) for r in rows]
        elif table=='promotioncampaign':
            result+=['campaign:'+str(row['id']) for row in rows]
        elif table=='promotionprice':
            result+=['campaign:'+str(row['campaign_id']) for row in rows]
        elif table=='promotioncampaign_stores':
            result+=['campaign:'+str(row['promotioncampaign_id']) for row in rows]
        elif table=='ideaproject':
            if old and new and all(old[k]==new[k] for k in ('id','idea_id','store_id')):return '[]'
            result=['idea_links','task_links']
            for row in rows:
                if row['store_id'] is not None:result+=['idea_links:'+str(row['store_id']),'task_links:'+str(row['store_id'])]
        elif table=='projecttask':
            if old and new and all(old[k]==new[k] for k in ('document_id','project_id')):return '[]'
            result=['task_links']
            for row in rows:
                if not old or not new or old['document_id']!=new['document_id']:
                    task=related('SELECT data FROM erp_document WHERE path=?',(row['document_id'],))
                    if task:result+=task_keys(json.loads(task[0][0]),True)
                project=related('SELECT store_id FROM erp_ideaproject WHERE id=?',(row['project_id'],))
                if project and project[0][0] is not None:result.append('task_links:'+str(project[0][0]))
        return json.dumps(sorted(set(result)))
    raw.create_function('tsukenya_state_keys',3,keys)


def install(connection):
    register(connection)
    with connection.cursor() as cursor:
        for table in TABLES:
            columns=[column.name for column in connection.introspection.get_table_description(cursor,'erp_'+table)]
            for op in ('INSERT','UPDATE','DELETE'):
                def row(prefix):
                    return "json_object("+','.join("'%s',%s.%s"%(c,prefix,c) for c in columns)+")"
                old=row('OLD') if op!='INSERT' else 'NULL'
                new=row('NEW') if op!='DELETE' else 'NULL'
                timing='AFTER'
                cursor.execute(f'''CREATE TRIGGER tsukenya_state_{table}_{op.lower()} {timing} {op} ON erp_{table} BEGIN
                    INSERT INTO erp_stateversion(key,revision) SELECT value,1 FROM json_each(tsukenya_state_keys('{table}',{old},{new})) WHERE true
                    ON CONFLICT(key) DO UPDATE SET revision=revision+1;
                END''')


def uninstall(connection):
    with connection.cursor() as cursor:
        for table in TABLES:
            for op in ('insert','update','delete'):cursor.execute(f'DROP TRIGGER IF EXISTS tsukenya_state_{table}_{op}')
