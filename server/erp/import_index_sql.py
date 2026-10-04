"""Migration-owned transactional dirty queue; normalization remains exact Python."""

def install(connection):
    with connection.cursor() as cursor:
        if connection.vendor=='postgresql':
            cursor.execute("""CREATE OR REPLACE FUNCTION tsukenya_import_index_dirty() RETURNS trigger AS $$
            BEGIN
              IF TG_OP <> 'INSERT' AND OLD.path LIKE 'products/%%' THEN
                INSERT INTO erp_catalogindexdirty(path,revision) VALUES(OLD.path,1) ON CONFLICT(path) DO UPDATE SET revision=erp_catalogindexdirty.revision+1;
              END IF;
              IF TG_OP <> 'DELETE' AND NEW.path LIKE 'products/%%' THEN
                INSERT INTO erp_catalogindexdirty(path,revision) VALUES(NEW.path,1) ON CONFLICT(path) DO UPDATE SET revision=erp_catalogindexdirty.revision+1;
              END IF;
              IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
            END; $$ LANGUAGE plpgsql;""")
            cursor.execute('CREATE TRIGGER tsukenya_import_index_changed AFTER INSERT OR UPDATE OR DELETE ON erp_document FOR EACH ROW EXECUTE FUNCTION tsukenya_import_index_dirty()')
        elif connection.vendor=='sqlite':
            for operation,prefix in [('INSERT','NEW'),('DELETE','OLD')]:
                cursor.execute(f"CREATE TRIGGER tsukenya_import_index_{operation.lower()} AFTER {operation} ON erp_document WHEN {prefix}.path LIKE 'products/%%' BEGIN INSERT INTO erp_catalogindexdirty(path,revision) VALUES({prefix}.path,1) ON CONFLICT(path) DO UPDATE SET revision=revision+1; END")
            cursor.execute("CREATE TRIGGER tsukenya_import_index_update AFTER UPDATE ON erp_document BEGIN INSERT INTO erp_catalogindexdirty(path,revision) SELECT OLD.path,1 WHERE OLD.path LIKE 'products/%%' ON CONFLICT(path) DO UPDATE SET revision=revision+1; INSERT INTO erp_catalogindexdirty(path,revision) SELECT NEW.path,1 WHERE NEW.path LIKE 'products/%%' ON CONFLICT(path) DO UPDATE SET revision=revision+1; END")


def uninstall(connection):
    with connection.cursor() as cursor:
        if connection.vendor=='postgresql':
            cursor.execute('DROP TRIGGER IF EXISTS tsukenya_import_index_changed ON erp_document');cursor.execute('DROP FUNCTION IF EXISTS tsukenya_import_index_dirty()')
        elif connection.vendor=='sqlite':
            for operation in ('insert','update','delete'):cursor.execute(f'DROP TRIGGER IF EXISTS tsukenya_import_index_{operation}')
