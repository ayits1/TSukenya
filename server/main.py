"""Small single-owner server for the TSukenya dashboard."""

import csv
import hashlib
import hmac
import http.cookies
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "tsukenya.sqlite3"
APP_PATH = ROOT / "app" / "index.html"
RUNTIME_PATH = ROOT / "server" / "runtime.js"
PORT = int(os.environ.get("PORT", "8080"))
OWNER = os.environ.get("OWNER_USERNAME", "pavlo")
INITIAL_HASH = os.environ.get("OWNER_PASSWORD_HASH", "")
SESSION_DAYS = 7
COLLECTIONS = {"tasks", "ideas", "products", "expenses"}
SINGLE_DOCS = {"settings/main", "project/state"}
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
write_lock = threading.RLock()


def connect():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=10000")
    return db


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**15, r=8, p=1, maxmem=128 * 1024 * 1024)
    return salt.hex() + ":" + digest.hex()


def valid_password(password, encoded):
    try:
        salt, expected = encoded.split(":", 1)
        actual = hash_password(password, bytes.fromhex(salt)).split(":", 1)[1]
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def seed_products(db):
    seed_path = ROOT / "seed.csv"
    if not seed_path.exists():
        seed_path = ROOT / "data" / "tovary-source-2026-09-29.csv"
    with seed_path.open(encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            name, product_id = row["Назва"].strip(), row["ID"].strip()
            if not name or not ID_RE.fullmatch(product_id):
                continue

            def number(field):
                raw = row[field].replace("\u00a0", "").replace(" ", "").replace(",", ".").strip()
                return float(raw) if raw else None

            cost, markup, price = (number(field) for field in ("Закупівля, грн", "Націнка, %", "Ціна продажу, грн"))
            product = {
                "name": name,
                "type": row["Група"].strip(),
                "category": row["Категорія"].strip(),
                "pack": row["Пакування"].strip(),
                "size": row["Об’єм / вага"].strip(),
                "unit": row["Од."].strip() or "шт",
                "cost": cost or 0,
                "markup": markup if markup is not None else 30,
                "manualPrice": price is not None,
                "price": price,
                "priceAt": row["Ціна оновлена"].strip(),
            }
            db.execute("INSERT INTO documents(path,data) VALUES (?,?)", (f"products/{product_id}", json.dumps(product, ensure_ascii=False)))


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS documents (path TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS account (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        if not db.execute("SELECT 1 FROM meta WHERE key='seeded'").fetchone():
            seed_products(db)
            db.execute("INSERT INTO meta(key,value) VALUES ('seeded','2026-09-29')")
            db.execute("INSERT INTO documents(path,data) VALUES (?,?)", (
                "settings/main", json.dumps({"chainName": "Цукерня", "gsUrl": "https://docs.google.com/spreadsheets/d/134HsmPHl97xsbCjcEVrFqqjv2Z2_3Qc1Fdhs1kLfNow/edit?gid=345870360"}, ensure_ascii=False)))
        db.commit()


def account_hash(db):
    row = db.execute("SELECT value FROM account WHERE key='password_hash'").fetchone()
    return row[0] if row else INITIAL_HASH


class Handler(BaseHTTPRequestHandler):
    server_version = "TSukenya/1"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)

    def headers_common(self, content_type, length, status=200, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()

    def send_bytes(self, data, content_type="text/html; charset=utf-8", status=200, extra=None):
        self.headers_common(content_type, len(data), status, extra)
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, value, status=200, extra=None):
        self.send_bytes(json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8", status, extra)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 1024 * 1024:
            raise ValueError("bad request size")
        value = json.loads(self.rfile.read(length))
        if not isinstance(value, dict):
            raise ValueError("expected JSON object")
        return value

    def session(self, db):
        try:
            jar = http.cookies.SimpleCookie()
            jar.load(self.headers.get("Cookie", ""))
            token = jar["ts_session"].value
        except (KeyError, http.cookies.CookieError):
            return None
        return db.execute("SELECT csrf FROM sessions WHERE token_hash=? AND expires>?", (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()

    def allowed_write(self, session):
        if not session:
            self.send_json({"error": "unauthorized"}, 401)
            return False
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin", "")
        if origin not in (f"https://{host}", f"http://{host}") or not hmac.compare_digest(self.headers.get("X-CSRF-Token", ""), session["csrf"]):
            self.send_json({"error": "forbidden"}, 403)
            return False
        return True

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/favicon.svg":
            self.send_bytes(FAVICON.encode(), "image/svg+xml")
            return
        if path == "/health":
            self.send_json({"status": "ok"})
            return
        with connect() as db:
            session = self.session(db)
            if path == "/api/state" and not session:
                self.send_json({"error": "Сеанс завершився. Увійдіть знову."}, 401)
                return
            if path == "/account" and not session:
                self.send_bytes(b"", status=302, extra={"Location": "/"})
                return
            if path == "/":
                if not session:
                    self.send_bytes(LOGIN_HTML.encode())
                else:
                    html = APP_PATH.read_text(encoding="utf-8").replace("<script>", '<script src="/runtime.js"></script>\n<script>', 1)
                    self.send_bytes(html.encode())
                return
            if path == "/runtime.js" and session:
                self.send_bytes(RUNTIME_PATH.read_bytes(), "text/javascript; charset=utf-8")
                return
            if path == "/api/state" and session:
                rows = db.execute("SELECT path,data FROM documents").fetchall()
                data = {"tasks": [], "ideas": [], "products": [], "expenses": [], "settings/main": {}, "project/state": {}}
                for row in rows:
                    col, _, doc_id = row["path"].partition("/")
                    entry = json.loads(row["data"])
                    if col in COLLECTIONS:
                        data[col].append({"id": doc_id, "data": entry})
                    elif row["path"] in SINGLE_DOCS:
                        data[row["path"]] = entry
                self.send_json({"data": data, "csrf": session["csrf"]})
                return
            if path == "/account" and session:
                self.send_bytes(ACCOUNT_HTML.encode())
                return
        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/login":
            try:
                body = self.read_json()
                with connect() as db:
                    if body.get("username") != OWNER or not valid_password(str(body.get("password", "")), account_hash(db)):
                        time.sleep(0.3)
                        self.send_json({"error": "Невірний логін або пароль"}, 401)
                        return
                    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
                    db.execute("INSERT INTO sessions(token_hash,csrf,expires) VALUES (?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), csrf, int(time.time()) + SESSION_DAYS * 86400))
                    db.commit()
                self.send_json({"ok": True}, extra={"Set-Cookie": f"ts_session={token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={SESSION_DAYS*86400}"})
            except (ValueError, json.JSONDecodeError):
                self.send_json({"error": "Невірний запит"}, 400)
            return
        with connect() as db:
            session = self.session(db)
            if not self.allowed_write(session):
                return
            if path == "/api/logout":
                jar = http.cookies.SimpleCookie(); jar.load(self.headers.get("Cookie", ""))
                token = jar["ts_session"].value
                db.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
                db.commit()
                self.send_json({"ok": True}, extra={"Set-Cookie": "ts_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"})
                return
            if path == "/api/account/password":
                try:
                    body = self.read_json()
                    current, new = str(body.get("current", "")), str(body.get("new", ""))
                    if not valid_password(current, account_hash(db)):
                        self.send_json({"error": "Поточний пароль неправильний"}, 403); return
                    if len(new) < 14 or len(new) > 256:
                        self.send_json({"error": "Новий пароль має містити від 14 до 256 символів"}, 400); return
                    db.execute("INSERT INTO account(key,value) VALUES ('password_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (hash_password(new),))
                    db.execute("DELETE FROM sessions")
                    db.commit()
                    self.send_json({"ok": True}, extra={"Set-Cookie": "ts_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"})
                except (ValueError, json.JSONDecodeError):
                    self.send_json({"error": "Невірний запит"}, 400)
                return
            if path in (f"/api/{col}" for col in COLLECTIONS):
                try:
                    value = self.read_json()
                    doc_id = secrets.token_urlsafe(18).replace("-", "_")
                    col = path.rsplit("/", 1)[1]
                    with write_lock:
                        db.execute("INSERT INTO documents(path,data) VALUES (?,?)", (f"{col}/{doc_id}", json.dumps(value, ensure_ascii=False)))
                        db.commit()
                    self.send_json({"id": doc_id}, 201)
                except (ValueError, json.JSONDecodeError):
                    self.send_json({"error": "Невірний запит"}, 400)
                return
        self.send_json({"error": "not found"}, 404)

    def do_PUT(self):
        self.mutate_document("PUT")

    def do_PATCH(self):
        self.mutate_document("PATCH")

    def do_DELETE(self):
        self.mutate_document("DELETE")

    def mutate_document(self, method):
        path = urlparse(self.path).path
        parts = path.split("/")
        if len(parts) != 5 or parts[:3] != ["", "api", "docs"] or (parts[3] not in COLLECTIONS and "/".join(parts[3:]) not in SINGLE_DOCS) or not ID_RE.fullmatch(parts[4]):
            self.send_json({"error": "not found"}, 404); return
        key = "/".join(parts[3:])
        with connect() as db:
            if not self.allowed_write(self.session(db)):
                return
            try:
                body = self.read_json() if method != "DELETE" else None
            except (ValueError, json.JSONDecodeError):
                self.send_json({"error": "Невірний запит"}, 400); return
            with write_lock:
                row = db.execute("SELECT data FROM documents WHERE path=?", (key,)).fetchone()
                if method == "DELETE":
                    db.execute("DELETE FROM documents WHERE path=?", (key,))
                elif method == "PUT":
                    db.execute("INSERT INTO documents(path,data) VALUES (?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data", (key, json.dumps(body, ensure_ascii=False)))
                elif row:
                    old = json.loads(row[0]); old.update(body)
                    db.execute("UPDATE documents SET data=? WHERE path=?", (json.dumps(old, ensure_ascii=False), key))
                else:
                    self.send_json({"error": "not found"}, 404); return
                db.commit()
            self.send_json({"ok": True})


FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#205c91"/><path d="M8 9h11l5 7-5 7H8z" fill="#fff"/><circle cx="19" cy="16" r="2" fill="#205c91"/></svg>'
AUTH_STYLE = """<style>
*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,sans-serif;background:#f4f6f8;color:#172b3a;min-height:100dvh;margin:0;padding:24px;display:grid;place-items:center}
main{background:#fff;padding:32px;border:1px solid #d7dfe6;border-radius:8px;width:min(440px,100%)}h1{font-size:26px;line-height:1.2;margin:16px 0 8px}p{color:#526575;margin:0 0 24px}label{display:block;font-size:14px;font-weight:500;margin:18px 0}input{display:block;width:100%;padding:11px 12px;margin-top:6px;border:1px solid #d7dfe6;border-radius:5px;font:inherit;background:white;color:#172b3a}
button{background:#205c91;color:white;border:0;border-radius:5px;padding:11px 18px;font:inherit;font-weight:500;cursor:pointer;width:100%}button:hover{background:#174d7c}button:disabled{opacity:.6;cursor:wait}button.secondary{background:transparent;color:#172b3a;border:1px solid #d7dfe6;margin-top:18px}button.secondary:hover{background:#f4f6f8}a{color:#205c91}small{display:block;font-weight:400;color:#526575;margin-top:6px}.error{color:#a12626;margin:14px 0 0;font-size:14px}.error:empty{display:none}:focus-visible{outline:3px solid #205c91;outline-offset:3px}@media(max-width:480px){body{padding:16px}main{padding:24px}}button,input,a{touch-action:manipulation}
</style>"""
LOGIN_HTML = """<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f4f6f8"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Вхід · Цукерня</title>""" + AUTH_STYLE + """</head><body><main><h1>Цукерня</h1><p>Бізнес-портал власника</p><form id="f"><label>Логін<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label><label>Пароль<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Увійти</button><p id="e" class="error" role="alert"></p></form></main><script>
const form=document.getElementById('f'),error=document.getElementById('e');
form.onsubmit=async ev=>{ev.preventDefault();const b=form.querySelector('button');b.disabled=true;b.textContent='Вхід…';error.textContent='';try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});if(r.ok)location.href='/';else{error.textContent=(await r.json()).error||'Не вдалося увійти. Перевірте логін і пароль.';form.elements.password.focus();}}catch(_){error.textContent='Немає з’єднання із сервером. Перевірте інтернет і повторіть.';}finally{b.disabled=false;b.textContent='Увійти';}};
</script></body></html>"""
ACCOUNT_HTML = """<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f4f6f8"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Обліковий запис · Цукерня</title>""" + AUTH_STYLE + """</head><body><main><a href="/">Повернутися до порталу</a><h1>Обліковий запис</h1><p>Змінити пароль власника</p><form id="f"><label>Поточний пароль<input name="current" type="password" autocomplete="current-password" required></label><label>Новий пароль<input name="new" type="password" autocomplete="new-password" minlength="14" required aria-describedby="passwordHint"><small id="passwordHint">Щонайменше 14 символів. Після зміни потрібно увійти знову.</small></label><button type="submit">Зберегти пароль</button><p id="e" class="error" role="alert"></p></form><button id="out" class="secondary" type="button">Вийти з порталу</button></main><script>
const form=document.getElementById('f'),error=document.getElementById('e'),out=document.getElementById('out');
const csrf=fetch('/api/state').then(r=>{if(r.status===401)location.href='/';if(!r.ok)throw Error();return r.json();}).then(x=>x.csrf);
csrf.catch(()=>{error.textContent='Не вдалося завантажити обліковий запис. Оновіть сторінку.';});
form.onsubmit=async ev=>{ev.preventDefault();const b=form.querySelector('button');b.disabled=true;b.textContent='Збереження…';error.textContent='';try{const r=await fetch('/api/account/password',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':await csrf},body:JSON.stringify(Object.fromEntries(new FormData(form)))});if(r.ok){location.href='/';}else{error.textContent=(await r.json()).error||'Не вдалося змінити пароль. Повторіть спробу.';form.elements.current.focus();}}catch(_){error.textContent='Немає з’єднання із сервером. Перевірте інтернет і повторіть.';}finally{b.disabled=false;b.textContent='Зберегти пароль';}};
out.onclick=async()=>{out.disabled=true;try{const r=await fetch('/api/logout',{method:'POST',headers:{'X-CSRF-Token':await csrf}});if(!r.ok)throw Error();location.href='/';}catch(_){error.textContent='Не вдалося завершити сеанс. Перевірте з’єднання і повторіть.';out.disabled=false;}};
</script></body></html>"""


if __name__ == "__main__":
    if not INITIAL_HASH:
        raise RuntimeError("OWNER_PASSWORD_HASH is required")
    init_db()
    ThreadingHTTPServer((os.environ.get("HOST", "0.0.0.0"), PORT), Handler).serve_forever()
