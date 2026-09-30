"""Consistent PostgreSQL dump, private permissions, checksum and 14-day retention."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import hashlib
import os
import subprocess

DEST=Path('/opt/tsukenya/backups')
def main():
    os.umask(0o077)
    DEST.mkdir(mode=0o700,parents=True,exist_ok=True)
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    archive=DEST/f'tsukenya-crm-{stamp}.dump'
    temporary=archive.with_suffix('.partial')
    try:
        with temporary.open('wb') as output:
            subprocess.run(['docker','exec','tsukenya-tsukenya-postgres-1','pg_dump','-U','tsukenya','-d','tsukenya','-Fc','--no-owner','--no-acl'],stdout=output,check=True)
        with temporary.open('rb') as source:
            subprocess.run(['docker','exec','-i','tsukenya-tsukenya-postgres-1','pg_restore','--list'],stdin=source,stdout=subprocess.DEVNULL,check=True)
        temporary.rename(archive)
    finally:temporary.unlink(missing_ok=True)
    digest=hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.dump.sha256').write_text(f'{digest}  {archive.name}\n')
    cutoff=datetime.now(timezone.utc)-timedelta(days=14)
    for old in DEST.glob('tsukenya-crm-*.dump'):
        if datetime.fromtimestamp(old.stat().st_mtime,timezone.utc)<cutoff:
            old.unlink();old.with_suffix('.dump.sha256').unlink(missing_ok=True)
    print(archive)
if __name__=='__main__':main()
