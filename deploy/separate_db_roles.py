"""Run as VPS root once: keep existing protected admin, create a restricted app role."""
import json
import os
from pathlib import Path
import secrets
import subprocess

ROOT=Path('/opt/tsukenya')
SQL_SCRIPT=r'''
import json,sys,os
import psycopg
from psycopg import sql
p=json.load(sys.stdin)
with psycopg.connect(host=os.environ['DB_HOST'],dbname='tsukenya',user='tsukenya',password=p['admin_password']) as db:
    with db.cursor() as c:
        c.execute("SELECT 1 FROM pg_roles WHERE rolname='tsukenya_app'")
        if not c.fetchone():
            c.execute(sql.SQL('CREATE ROLE {} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}').format(sql.Identifier('tsukenya_app'),sql.Literal(p['app_password'])))
        else:
            c.execute(sql.SQL('ALTER ROLE {} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}').format(sql.Identifier('tsukenya_app'),sql.Literal(p['app_password'])))
        c.execute("SELECT relname,relkind FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='public' AND relkind IN ('r','p')")
        for name,kind in c.fetchall():
            c.execute(sql.SQL('ALTER TABLE public.{} OWNER TO {}').format(sql.Identifier(name),sql.Identifier('tsukenya_app')))
        c.execute("SELECT relname FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace JOIN pg_roles r ON r.oid=relowner WHERE n.nspname='public' AND relkind='S' AND r.rolname<>'tsukenya_app'")
        for (name,) in c.fetchall():
            c.execute(sql.SQL('ALTER SEQUENCE public.{} OWNER TO {}').format(sql.Identifier(name),sql.Identifier('tsukenya_app')))
        c.execute('ALTER DATABASE tsukenya OWNER TO tsukenya_app')
        c.execute('GRANT USAGE, CREATE ON SCHEMA public TO tsukenya_app')
print('Restricted application role prepared; existing administrator retained.')
'''
def parse(text):
    return dict(line.split('=',1) for line in text.splitlines() if line and not line.startswith('#') and '=' in line)
def main():
    os.umask(0o077)
    env=ROOT/'.env';config=parse(env.read_text())
    database_env=ROOT/'.env.database'
    admin=parse(database_env.read_text())['POSTGRES_PASSWORD'] if database_env.exists() else config['DB_PASSWORD']
    private=ROOT/'.private';private.mkdir(mode=0o700,exist_ok=True)
    password_file=private/'db-app-password'
    if not password_file.exists():password_file.write_text(secrets.token_urlsafe(48))
    app=password_file.read_text().strip()
    subprocess.run(['docker','exec','-i','tsukenya-web-1','python','-c',SQL_SCRIPT],input=json.dumps({'admin_password':admin,'app_password':app}),text=True,check=True)
    database_env.write_text('POSTGRES_PASSWORD='+admin+'\n')
    config['DB_PASSWORD']=app
    config['DB_USER']='tsukenya_app'
    env.write_text('\n'.join(k+'='+v for k,v in config.items())+'\n')
    env.chmod(0o600);database_env.chmod(0o600);password_file.chmod(0o600)
    print('Private database configuration saved without logging passwords.')
if __name__=='__main__':main()
