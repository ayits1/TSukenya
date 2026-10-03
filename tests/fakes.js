// Підробки для тестів синхронізації: спільна база артефакту (db) і Google-таблиця (конектор Google Sheets).
// Кожен виклик чекає випадкові 0–3 мс, щоб паралельні синхронізації різних пристроїв перемежовувались, як у житті.
const tick = () => new Promise(r => setTimeout(r, Math.random() * 3));
const clone = o => o === undefined ? undefined : JSON.parse(JSON.stringify(o));
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
function merge(a, b){ for (const k of Object.keys(b)){ if (isObj(b[k]) && isObj(a[k])) merge(a[k], b[k]); else a[k] = b[k]; } return a; }

// opts.now — годинник для замків (тести його пересувають); opts.noLease — середовище без acquire.
function fakeDb(opts = {}){
  const docs = new Map(), leases = new Map(), now = opts.now || Date.now; let seq = 0;
  const snap = (path, d) => ({id:path.split("/").pop(), exists:!!d, data:()=>clone(d), metadata:{fromCache:false, hasPendingWrites:false}});
  const docRef = path => ({
    id: path.split("/").pop(), path,
    async get(){ await tick(); return snap(path, docs.get(path)); },
    async set(data){ await tick(); docs.set(path, clone(data)); },
    async update(data){ await tick(); const d = docs.get(path); if (!d) throw {code:"invalid_argument"}; merge(d, clone(data)); },
    async delete(){ await tick(); docs.delete(path); },
    acquire: opts.noLease ? undefined : async ({holder, ttlMs}) => {
      await tick();
      const t = now(), l = leases.get(path), ttl = Math.min(600000, Math.max(1000, ttlMs || 30000));
      if (l && l.until > t && l.holder !== holder) return {acquired:false, expiresAt:new Date(l.until).toISOString()};
      leases.set(path, {holder, until:t + ttl});
      return {acquired:true, holder, version:++seq, expiresAt:new Date(t + ttl).toISOString()};
    }
  });
  const colRef = name => ({
    doc: id => docRef(name + "/" + (id ?? ("auto" + (++seq).toString(36)))),
    async add(data){ const r = docRef(name + "/auto" + (++seq).toString(36)); await r.set(data); return r; },
    async get(){
      await tick();
      const list = [...docs].filter(([p]) => p.startsWith(name + "/") && p.split("/").length === name.split("/").length + 1).map(([p, d]) => snap(p, d));
      return {docs:list, size:list.length, empty:!list.length};
    }
  });
  return {doc:docRef, collection:colRef, docs,
    // Дані колекції як масив {id, ...поля} — так їх бачить застосунок у S.allProducts
    list(name){ return [...docs].filter(([p]) => p.startsWith(name + "/") && p.split("/").length === 2).map(([p, d]) => Object.assign({id:p.split("/")[1]}, clone(d))); }};
}

// Таблиця зберігає рядки як текст, як їх повертає get_values (форматовані значення, кома в дробах).
// Значення з апострофом на початку записуються як текст без апострофа; null у записі пропускає клітинку.
function fakeSheets(rows){
  const sheet = rows.map(r => r.slice()), calls = [];
  const disp = v => v === null || v === undefined ? undefined : typeof v === "number" ? String(v).replace(".", ",") : String(v).replace(/^'/, "");
  const firstRow = a1 => { const m = String(a1).match(/^[A-Z]+(\d*)/); return m && m[1] ? +m[1] : 1; };
  const row = i => { while (sheet.length <= i) sheet.push([]); return sheet[i]; };
  return {sheet, calls,
    async callTool(server, tool, input){
      await tick(); calls.push(tool);
      if (server !== "Google Sheets") throw {code:"server_not_connected"};
      if (tool === "get_values") return {payload:JSON.stringify({values:sheet.map(r => r.slice())})};
      if (tool === "update_values"){
        const r1 = firstRow(input.range);
        input.values.forEach((vals, i) => { if (!vals) return; const r = row(r1 - 1 + i); vals.forEach((v, j) => { const d = disp(v); if (d !== undefined){ while (r.length < j) r.push(""); r[j] = d; } }); });
        return {payload:"{}"};
      }
      if (tool === "batch_clear_values"){ input.ranges.forEach(a => { sheet[firstRow(a) - 1] = []; }); return {payload:"{}"}; }
      throw {code:"tool_error"};
    }};
}

module.exports = {fakeDb, fakeSheets, clone};
