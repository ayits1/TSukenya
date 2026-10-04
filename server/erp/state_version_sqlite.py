"""SQLite QA implementation of the PostgreSQL transactional invalidation map.

A deterministic key callback only reads related rows; trigger SQL owns all writes.
Registered on every SQLite connection, including connections opened by test workers.
"""
import json
from datetime import datetime
from zoneinfo import ZoneInfo
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
    def related(query, values):
        return raw.execute(query, values).fetchall()
    def campaign_keys(c):
        today = datetime.now(ZoneInfo('Europe/Kyiv')).date().isoformat()
        if not c or not c['active'] or c['archived'] or not c['starts_on'] <= today <= c['ends_on']: return []
        if c['scope']=='network': return ['promotion_network']
        return ['promotion:'+str(row[0]) for row in related('SELECT store_id FROM erp_promotioncampaign_stores WHERE promotioncampaign_id=?',(c['id'],))]
    def campaign(identifier):
        rows=related('SELECT id,scope,active,archived,CAST(starts_on AS TEXT),CAST(ends_on AS TEXT) FROM erp_promotioncampaign WHERE id=?',(identifier,))
        return dict(zip(('id','scope','active','archived','starts_on','ends_on'),rows[0])) if rows else None
    def keys(table, old, new):
        old=json.loads(old) if old else None; new=json.loads(new) if new else None
        if old==new:return '[]'
        if table=='document' and old and new and old['path']==new['path'] and spelling(json.loads(old['data']))==spelling(json.loads(new['data'])):return '[]'
        result=[]; rows=[r for r in (old,new) if r is not None]
        if table=='document':
            prior=json.loads(old['data']) if old and old['path']=='settings/main' else {}
            next_=json.loads(new['data']) if new and new['path']=='settings/main' else {}
            for names,key in ((PUBLIC,'labels'),(PRICING,'pricing'),(SYNC,'owner_sync')):
                if spelling({k:v for k,v in prior.items() if k in names})!=spelling({k:v for k,v in next_.items() if k in names}): result.append(key)
            allowed=set(PUBLIC+PRICING+SYNC)
            if spelling({k:v for k,v in prior.items() if k not in allowed})!=spelling({k:v for k,v in next_.items() if k not in allowed}):result.append('private_settings')
            for row in rows:
                path=row['path']; data=json.loads(row['data'])
                if path.startswith('products/'):result.append('catalog')
                elif path.startswith('catalog_refs/'):result.append('references')
                elif path.startswith('tasks/'):result+=task_keys(data)
                elif path.startswith('ideas/'):
                    result.append('owner_ideas')
                    if data.get('scope')=='operations':result.append('ops_ideas')
                elif path.startswith('expenses/'):result.append('expenses')
                elif path=='project/state':result.append('project_state')
        elif table=='store':
            if old and new and all(old[k]==new[k] for k in ('id','name','active')):return '[]'
            result=['stores_all']+['store:'+str(r['id']) for r in rows]
        elif table=='promotioncampaign':
            for row in rows:result+=campaign_keys(row)
        elif table=='promotionprice':
            for row in rows:result+=campaign_keys(campaign(row['campaign_id']))
        elif table=='promotioncampaign_stores':
            for row in rows:
                c=campaign(row['promotioncampaign_id'])
                if c and c['scope']=='stores' and campaign_keys(c):result.append('promotion:'+str(row['store_id']))
                # Deleted final M2M row must still invalidate its old store.
                elif c and c['scope']=='stores' and c['active'] and not c['archived'] and c['starts_on']<=datetime.now(ZoneInfo('Europe/Kyiv')).date().isoformat()<=c['ends_on']:result.append('promotion:'+str(row['store_id']))
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
                # BEFORE DELETE preserves campaign's attached stores before cascades.
                timing='BEFORE' if table=='promotioncampaign' and op=='DELETE' else 'AFTER'
                cursor.execute(f'''CREATE TRIGGER tsukenya_state_{table}_{op.lower()} {timing} {op} ON erp_{table} BEGIN
                    INSERT INTO erp_stateversion(key,revision) SELECT value,1 FROM json_each(tsukenya_state_keys('{table}',{old},{new})) WHERE true
                    ON CONFLICT(key) DO UPDATE SET revision=revision+1;
                END''')


def uninstall(connection):
    with connection.cursor() as cursor:
        for table in TABLES:
            for op in ('insert','update','delete'):cursor.execute(f'DROP TRIGGER IF EXISTS tsukenya_state_{table}_{op}')
