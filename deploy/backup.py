"""Create a consistent local SQLite backup for the TSukenya VPS."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import gzip
import hashlib
import shutil
import sqlite3


SOURCE = Path("/opt/tsukenya/storage/tsukenya.sqlite3")
DEST = Path("/opt/tsukenya/backups")


def main():
    if not SOURCE.exists():
        raise SystemExit("TSukenya database is missing")
    DEST.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    plain = DEST / f"tsukenya-{stamp}.sqlite3"
    archive = DEST / f"tsukenya-{stamp}.sqlite3.gz"
    with sqlite3.connect(SOURCE) as source, sqlite3.connect(plain) as backup:
        source.backup(backup)
    try:
        with plain.open("rb") as src, gzip.open(archive, "wb", compresslevel=6) as dst:
            shutil.copyfileobj(src, dst)
    finally:
        plain.unlink(missing_ok=True)
    archive.chmod(0o600)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = archive.with_suffix(archive.suffix + ".sha256")
    checksum.write_text(f"{digest}  {archive.name}\n")
    checksum.chmod(0o600)
    cutoff = datetime.now(timezone.utc) - timedelta(days=14)
    for old in DEST.glob("tsukenya-*.sqlite3.gz"):
        if datetime.fromtimestamp(old.stat().st_mtime, timezone.utc) < cutoff:
            old.unlink()
            old.with_suffix(old.suffix + ".sha256").unlink(missing_ok=True)
    print(archive)


if __name__ == "__main__":
    main()
