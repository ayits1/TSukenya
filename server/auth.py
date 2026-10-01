"""Authentication helpers and existing portal screens."""
import hashlib
import hmac
import secrets

def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**15, r=8, p=1, maxmem=128 * 1024 * 1024)
    return salt.hex() + ':' + digest.hex()

def valid_password(password, encoded):
    try:
        salt, expected = encoded.split(':', 1)
        actual = hash_password(password, bytes.fromhex(salt)).split(':', 1)[1]
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False

FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#245c46"/><path d="M8 9h11l5 7-5 7H8z" fill="#fff"/><circle cx="19" cy="16" r="2" fill="#245c46"/></svg>'
AUTH_STYLE = """<link rel="stylesheet" href="/ui.css"><style>@layer legacy {
*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,sans-serif;background:#f5f6f7;color:#172b3a;min-height:100dvh;margin:0;padding:24px;display:grid;place-items:center}
main{background:#fff;padding:32px;border:1px solid #d7dfe6;border-radius:8px;width:min(440px,100%)}h1{font-size:26px;line-height:1.2;margin:16px 0 8px}p{color:#526575;margin:0 0 24px}label{display:block;font-size:14px;font-weight:500;margin:18px 0}input{display:block;width:100%;padding:11px 12px;margin-top:6px;border:1px solid #d7dfe6;border-radius:5px;font:inherit;background:white;color:#172b3a}
button{background:#205c91;color:white;border:0;border-radius:5px;padding:11px 18px;font:inherit;font-weight:500;cursor:pointer;width:100%}button:hover{background:#174d7c}button:disabled{opacity:.6;cursor:wait}button.secondary{background:transparent;color:#172b3a;border:1px solid #d7dfe6;margin-top:18px}button.secondary:hover{background:#f5f6f7}a{color:#205c91}small{display:block;font-weight:400;color:#526575;margin-top:6px}.error{color:#a12626;margin:14px 0 0;font-size:14px}.error:empty{display:none}:focus-visible{outline:3px solid #205c91;outline-offset:3px}@media(max-width:480px){body{padding:16px}main{padding:24px}}button,input,a{touch-action:manipulation}
}</style>"""
LOGIN_HTML = """<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f5f6f7"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Вхід · Цукерня</title>""" + AUTH_STYLE + """</head><body class="ui-root"><main><h1>Цукерня</h1><p>Бізнес-портал власника</p><form id="f"><label>Логін<input class="ui-input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label><label>Пароль<input class="ui-input" name="password" type="password" autocomplete="current-password" required></label><button class="ui-button ui-button--primary" type="submit">Увійти</button><p id="e" class="error" role="alert"></p></form></main><script>
const form=document.getElementById('f'),error=document.getElementById('e');
form.onsubmit=async ev=>{ev.preventDefault();const b=form.querySelector('button');b.disabled=true;b.textContent='Вхід…';error.textContent='';try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});if(r.ok)location.href='/';else{error.textContent=(await r.json()).error||'Не вдалося увійти. Перевірте логін і пароль.';form.elements.password.focus();}}catch(_){error.textContent='Немає з’єднання із сервером. Перевірте інтернет і повторіть.';}finally{b.disabled=false;b.textContent='Увійти';}};
</script></body></html>"""
ACCOUNT_HTML = """<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f5f6f7"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Обліковий запис · Цукерня</title>""" + AUTH_STYLE + """</head><body class="ui-root"><main><a href="/">Повернутися до порталу</a><h1>Обліковий запис</h1><p>Змінити пароль власника</p><form id="f"><label>Поточний пароль<input class="ui-input" name="current" type="password" autocomplete="current-password" required></label><label>Новий пароль<input class="ui-input" name="new" type="password" autocomplete="new-password" minlength="14" required aria-describedby="passwordHint"><small id="passwordHint">Щонайменше 14 символів. Після зміни потрібно увійти знову.</small></label><button class="ui-button ui-button--primary" type="submit">Зберегти пароль</button><p id="e" class="error" role="alert"></p></form><button id="out" class="ui-button secondary" type="button">Вийти з порталу</button></main><script>
const form=document.getElementById('f'),error=document.getElementById('e'),out=document.getElementById('out');
const csrf=fetch('/api/state').then(r=>{if(r.status===401)location.href='/';if(!r.ok)throw Error();return r.json();}).then(x=>x.csrf);
csrf.catch(()=>{error.textContent='Не вдалося завантажити обліковий запис. Оновіть сторінку.';});
form.onsubmit=async ev=>{ev.preventDefault();const b=form.querySelector('button');b.disabled=true;b.textContent='Збереження…';error.textContent='';try{const r=await fetch('/api/account/password',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':await csrf},body:JSON.stringify(Object.fromEntries(new FormData(form)))});if(r.ok){location.href='/';}else{error.textContent=(await r.json()).error||'Не вдалося змінити пароль. Повторіть спробу.';form.elements.current.focus();}}catch(_){error.textContent='Немає з’єднання із сервером. Перевірте інтернет і повторіть.';}finally{b.disabled=false;b.textContent='Зберегти пароль';}};
out.onclick=async()=>{out.disabled=true;try{const r=await fetch('/api/logout',{method:'POST',headers:{'X-CSRF-Token':await csrf}});if(!r.ok)throw Error();location.href='/';}catch(_){error.textContent='Не вдалося завершити сеанс. Перевірте з’єднання і повторіть.';out.disabled=false;}};
</script></body></html>"""

