"""Migration-owned SQL for scoped legacy read invalidation, on both supported QA engines.

Triggers cover ORM saves, QuerySet/bulk writes, bootstrap and direct DB writes.
No monetary/ledger/audit tables participate. Old and new visibility are invalidated.
"""
PUBLIC = ('tag', 'chainName', 'storeNames', 'staleDays')
PRICING = ('defaultMarkup', 'rounding')
SYNC = ('gsId', 'gsTitle', 'gsUrl', 'gsSheetName')
TABLES = ('document', 'store', 'promotioncampaign', 'promotionprice', 'promotioncampaign_stores', 'ideaproject', 'projecttask')

PG = r'''
CREATE FUNCTION tsukenya_state_bump(keys text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  FOR k IN SELECT DISTINCT value FROM unnest(keys) value WHERE value IS NOT NULL ORDER BY value LOOP
    INSERT INTO erp_stateversion(key,revision) VALUES(k,1)
      ON CONFLICT(key) DO UPDATE SET revision=erp_stateversion.revision+1;
  END LOOP;
END $$;
CREATE FUNCTION tsukenya_state_projection(data jsonb, fields text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(coalesce(data,'{}'::jsonb)) WHERE key=ANY(fields)
$$;
CREATE FUNCTION tsukenya_state_task(data jsonb, owners_only boolean DEFAULT false) RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE keys text[] := ARRAY[]::text[]; area text; valid_store boolean; finance boolean;
BEGIN
  valid_store := jsonb_typeof(data->'store')='number' AND (data->>'store') ~ '^[1-9][0-9]*$';
  area := CASE WHEN data->'store' IS NULL OR data->'store'='null' THEN 'network' WHEN valid_store THEN data->>'store' ELSE 'invalid' END;
  finance := coalesce(data->>'_alertKey','') LIKE 'due:%';
  IF finance THEN
    keys := array_append(keys,'owner_due:'||area);
    IF NOT owners_only AND data->>'scope'='operations' AND area<>'invalid' THEN keys := array_append(keys,'finance_due:'||area); END IF;
  ELSE
    keys := array_append(keys,'owner_tasks');
    IF NOT owners_only AND data->>'scope'='operations' AND area<>'invalid' THEN
      keys := array_append(keys,CASE WHEN area='network' THEN 'ops_tasks' ELSE 'ops_tasks:'||area END);
    END IF;
  END IF;
  RETURN keys;
END $$;
CREATE FUNCTION tsukenya_state_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior jsonb := '{}'::jsonb; next jsonb := '{}'::jsonb; item record; keys text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP='UPDATE' AND OLD.path IS NOT DISTINCT FROM NEW.path AND OLD.data::text IS NOT DISTINCT FROM NEW.data::text THEN RETURN NULL; END IF;
  IF TG_OP<>'INSERT' AND OLD.path='settings/main' THEN prior:=OLD.data; END IF;
  IF TG_OP<>'DELETE' AND NEW.path='settings/main' THEN next:=NEW.data; END IF;
  IF tsukenya_state_projection(prior,ARRAY['tag','chainName','storeNames','staleDays'])::text IS DISTINCT FROM tsukenya_state_projection(next,ARRAY['tag','chainName','storeNames','staleDays'])::text THEN keys:=array_append(keys,'labels'); END IF;
  IF tsukenya_state_projection(prior,ARRAY['defaultMarkup','rounding'])::text IS DISTINCT FROM tsukenya_state_projection(next,ARRAY['defaultMarkup','rounding'])::text THEN keys:=array_append(keys,'pricing'); END IF;
  IF tsukenya_state_projection(prior,ARRAY['gsId','gsTitle','gsUrl','gsSheetName'])::text IS DISTINCT FROM tsukenya_state_projection(next,ARRAY['gsId','gsTitle','gsUrl','gsSheetName'])::text THEN keys:=array_append(keys,'owner_sync'); END IF;
  IF (prior-ARRAY['tag','chainName','storeNames','staleDays','defaultMarkup','rounding','gsId','gsTitle','gsUrl','gsSheetName'])::text IS DISTINCT FROM (next-ARRAY['tag','chainName','storeNames','staleDays','defaultMarkup','rounding','gsId','gsTitle','gsUrl','gsSheetName'])::text THEN keys:=array_append(keys,'private_settings'); END IF;
  FOR item IN SELECT p,d FROM (VALUES(CASE WHEN TG_OP<>'INSERT' THEN OLD.path END,CASE WHEN TG_OP<>'INSERT' THEN OLD.data END),(CASE WHEN TG_OP<>'DELETE' THEN NEW.path END,CASE WHEN TG_OP<>'DELETE' THEN NEW.data END)) v(p,d) WHERE p IS NOT NULL LOOP
    IF item.p LIKE 'products/%' THEN keys:=array_append(keys,'catalog');
    ELSIF starts_with(item.p,'catalog_refs/') THEN keys:=array_append(keys,'references');
    ELSIF item.p LIKE 'tasks/%' THEN keys:=keys||tsukenya_state_task(item.d);
    ELSIF item.p LIKE 'ideas/%' THEN
      keys:=array_append(keys,'owner_ideas');
      IF item.d->>'scope'='operations' THEN keys:=array_append(keys,'ops_ideas'); END IF;
    ELSIF item.p LIKE 'expenses/%' THEN keys:=array_append(keys,'expenses');
    ELSIF item.p='project/state' THEN keys:=array_append(keys,'project_state');
    END IF;
  END LOOP;
  PERFORM tsukenya_state_bump(keys); RETURN NULL;
END $$;
CREATE FUNCTION tsukenya_state_store() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keys text[] := ARRAY['stores_all'];
BEGIN
  IF TG_OP='UPDATE' AND OLD.id=NEW.id AND OLD.name=NEW.name AND OLD.active=NEW.active THEN RETURN NULL; END IF;
  IF TG_OP<>'INSERT' THEN keys:=array_append(keys,'store:'||OLD.id); END IF;
  IF TG_OP<>'DELETE' THEN keys:=array_append(keys,'store:'||NEW.id); END IF;
  PERFORM tsukenya_state_bump(keys); RETURN NULL;
END $$;
CREATE FUNCTION tsukenya_state_campaign_keys(campaign_id uuid, area text, enabled boolean, archived boolean, starts date, ends date) RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE today date := (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Kyiv')::date; keys text[] := ARRAY[]::text[];
BEGIN
  IF NOT enabled OR archived OR starts>today OR ends<today THEN RETURN keys; END IF;
  IF area='network' THEN RETURN ARRAY['promotion_network']; END IF;
  SELECT coalesce(array_agg('promotion:'||store_id),ARRAY[]::text[]) INTO keys FROM erp_promotioncampaign_stores WHERE promotioncampaign_id=campaign_id;
  RETURN keys;
END $$;
CREATE FUNCTION tsukenya_state_campaign() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keys text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
  IF TG_OP<>'INSERT' THEN keys:=keys||tsukenya_state_campaign_keys(OLD.id,OLD.scope,OLD.active,OLD.archived,OLD.starts_on,OLD.ends_on); END IF;
  IF TG_OP<>'DELETE' THEN keys:=keys||tsukenya_state_campaign_keys(NEW.id,NEW.scope,NEW.active,NEW.archived,NEW.starts_on,NEW.ends_on); END IF;
  PERFORM tsukenya_state_bump(keys); RETURN NULL;
END $$;
CREATE FUNCTION tsukenya_state_promotionprice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; identifier uuid; keys text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
  FOR identifier IN SELECT DISTINCT v FROM unnest(ARRAY[CASE WHEN TG_OP<>'INSERT' THEN OLD.campaign_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.campaign_id END]) v WHERE v IS NOT NULL LOOP
    SELECT * INTO c FROM erp_promotioncampaign WHERE id=identifier;
    IF FOUND THEN keys:=keys||tsukenya_state_campaign_keys(c.id,c.scope,c.active,c.archived,c.starts_on,c.ends_on); END IF;
  END LOOP;
  PERFORM tsukenya_state_bump(keys); RETURN NULL;
END $$;
CREATE FUNCTION tsukenya_state_campaignstores() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; c record; keys text[] := ARRAY[]::text[]; today date := (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Kyiv')::date;
BEGIN
  IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
  FOR item IN SELECT cid,sid FROM (VALUES(CASE WHEN TG_OP<>'INSERT' THEN OLD.promotioncampaign_id END,CASE WHEN TG_OP<>'INSERT' THEN OLD.store_id END),(CASE WHEN TG_OP<>'DELETE' THEN NEW.promotioncampaign_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.store_id END)) v(cid,sid) WHERE cid IS NOT NULL LOOP
    SELECT * INTO c FROM erp_promotioncampaign WHERE id=item.cid;
    IF FOUND AND c.scope='stores' AND c.active AND NOT c.archived AND c.starts_on<=today AND c.ends_on>=today THEN keys:=array_append(keys,'promotion:'||item.sid); END IF;
  END LOOP;
  PERFORM tsukenya_state_bump(keys); RETURN NULL;
END $$;
CREATE FUNCTION tsukenya_state_ideaproject() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keys text[] := ARRAY['idea_links']; row record;
BEGIN
  IF TG_OP='UPDATE' AND OLD.id=NEW.id AND OLD.idea_id=NEW.idea_id AND OLD.store_id IS NOT DISTINCT FROM NEW.store_id THEN RETURN NULL; END IF;
  FOR row IN SELECT sid FROM (VALUES(CASE WHEN TG_OP<>'INSERT' THEN OLD.store_id END),(CASE WHEN TG_OP<>'DELETE' THEN NEW.store_id END)) v(sid) WHERE sid IS NOT NULL LOOP keys:=array_append(keys,'idea_links:'||row.sid); keys:=array_append(keys,'task_links:'||row.sid); END LOOP;
  -- A project store change also changes the initiative field of its task links.
  keys:=array_append(keys,'task_links');
  PERFORM tsukenya_state_bump(keys); RETURN NULL;
END $$;
CREATE FUNCTION tsukenya_state_projecttask() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keys text[] := ARRAY['task_links']; row record; task jsonb; sid bigint;
BEGIN
  IF TG_OP='UPDATE' AND OLD.document_id=NEW.document_id AND OLD.project_id=NEW.project_id THEN RETURN NULL; END IF;
  FOR row IN SELECT did,pid FROM (VALUES(CASE WHEN TG_OP<>'INSERT' THEN OLD.document_id END,CASE WHEN TG_OP<>'INSERT' THEN OLD.project_id END),(CASE WHEN TG_OP<>'DELETE' THEN NEW.document_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.project_id END)) v(did,pid) WHERE did IS NOT NULL LOOP
    IF TG_OP<>'UPDATE' OR OLD.document_id IS DISTINCT FROM NEW.document_id THEN
      SELECT data INTO task FROM erp_document WHERE path=row.did;
      IF FOUND THEN keys:=keys||tsukenya_state_task(task,true); END IF;
    END IF;
    SELECT store_id INTO sid FROM erp_ideaproject WHERE id=row.pid;
    IF sid IS NOT NULL THEN keys:=array_append(keys,'task_links:'||sid); END IF;
  END LOOP;
  PERFORM tsukenya_state_bump(keys); RETURN NULL;
END $$;
'''


def pg_install(connection):
    with connection.cursor() as cursor:
        cursor.execute(PG)
        for table in TABLES:
            func = {'promotioncampaign': 'campaign', 'promotionprice': 'promotionprice',
                    'promotioncampaign_stores': 'campaignstores'}.get(table, table)
            timing = 'BEFORE' if table == 'promotioncampaign' else 'AFTER'
            # Campaign delete must see its M2M rows before cascade; return row for BEFORE.
            if table == 'promotioncampaign':
                cursor.execute("ALTER FUNCTION tsukenya_state_campaign() RENAME TO tsukenya_state_campaign_changes")
                cursor.execute("""CREATE FUNCTION tsukenya_state_campaign() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                    PERFORM tsukenya_state_bump(CASE WHEN TG_OP='DELETE' THEN tsukenya_state_campaign_keys(OLD.id,OLD.scope,OLD.active,OLD.archived,OLD.starts_on,OLD.ends_on) ELSE ARRAY[]::text[] END);
                    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END $$""")
                cursor.execute(f'CREATE TRIGGER tsukenya_state_{table}_delete BEFORE DELETE ON erp_{table} FOR EACH ROW EXECUTE FUNCTION tsukenya_state_campaign()')
                cursor.execute(f'CREATE TRIGGER tsukenya_state_{table} AFTER INSERT OR UPDATE ON erp_{table} FOR EACH ROW EXECUTE FUNCTION tsukenya_state_campaign_changes()')
            else:
                cursor.execute(f'CREATE TRIGGER tsukenya_state_{table} {timing} INSERT OR UPDATE OR DELETE ON erp_{table} FOR EACH ROW EXECUTE FUNCTION tsukenya_state_{func}()')


def pg_uninstall(connection):
    with connection.cursor() as cursor:
        for table in TABLES:
            cursor.execute(f'DROP TRIGGER IF EXISTS tsukenya_state_{table} ON erp_{table}')
        cursor.execute('DROP TRIGGER IF EXISTS tsukenya_state_promotioncampaign_delete ON erp_promotioncampaign')
        for func, args in [('document',''),('store',''),('campaign',''),('campaign_changes',''),('promotionprice',''),('campaignstores',''),('ideaproject',''),('projecttask',''),('campaign_keys','uuid,text,boolean,boolean,date,date'),('task','jsonb,boolean'),('projection','jsonb,text[]'),('bump','text[]')]:
            cursor.execute(f'DROP FUNCTION IF EXISTS tsukenya_state_{func}({args})')
