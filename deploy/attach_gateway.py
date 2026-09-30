"""Attach TSukenya to the existing Caddy gateway; run on the VPS as root."""

from datetime import datetime, timezone
from pathlib import Path
import shutil
import subprocess


EDGE = Path("/opt/edge")
COMPOSE = EDGE / "compose.yaml"
CADDY = EDGE / "Caddyfile"
BLOCK = """\n\ntsukernya.pp.ua {
    encode zstd gzip
    header X-Robots-Tag "noindex, nofollow"
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy tsukenya-web-1:8080
}

www.tsukernya.pp.ua {
    redir https://tsukernya.pp.ua{uri} 308
}
"""


def run(*command):
    subprocess.run(command, check=True, cwd=EDGE)


def main():
    compose = COMPOSE.read_text()
    caddy = CADDY.read_text()
    if "tsukenya_edge" in compose or "tsukernya.pp.ua" in caddy:
        raise SystemExit("TSukenya gateway entries already exist; inspect manually")
    old_network = "  catering:\n    external: true\n    name: ${CATERING_EDGE_NETWORK:-catering_edge}\n"
    if "networks: [catering]" not in compose or old_network not in compose:
        raise SystemExit("Gateway Compose changed; inspect manually")
    if "smachna-podiya.pp.ua {" not in caddy:
        raise SystemExit("Caddyfile changed; inspect manually")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = EDGE / "backups" / stamp
    backup.mkdir(parents=True, exist_ok=False)
    shutil.copy2(COMPOSE, backup / "compose.yaml")
    shutil.copy2(CADDY, backup / "Caddyfile")

    compose = compose.replace("networks: [catering]", "networks: [catering, tsukenya]")
    compose = compose.replace(old_network, old_network + "  tsukenya:\n    external: true\n    name: tsukenya_edge\n")
    CADDY.write_text(caddy.rstrip() + BLOCK)
    COMPOSE.write_text(compose)
    try:
        run("docker", "compose", "config", "--quiet")
        run("docker", "run", "--rm", "-v", f"{CADDY}:/etc/caddy/Caddyfile:ro", "caddy:2-alpine", "caddy", "validate", "--config", "/etc/caddy/Caddyfile")
        run("docker", "compose", "up", "-d", "gateway")
    except Exception:
        shutil.copy2(backup / "compose.yaml", COMPOSE)
        shutil.copy2(backup / "Caddyfile", CADDY)
        run("docker", "compose", "up", "-d", "gateway")
        raise
    print(f"Gateway configured. Backup: {backup}")


if __name__ == "__main__":
    main()
