// Дістає з app/index.html код між маркерами SYNC-ENGINE-* (planSync) і SYNC-RUNNER-* (gsSync) і запускає його в Node.
const fs = require("fs");
const html = fs.readFileSync(process.env.APP_HTML || __dirname + "/../app/index.html", "utf8");
const region = name => {
  const m = html.match(new RegExp(`/\\* ${name}-START \\*/[\\s\\S]*?/\\* ${name}-END \\*/`));
  if (!m) throw new Error(`У app/index.html немає маркерів ${name}-START / ${name}-END`);
  return m[0];
};
const ENGINE = region("SYNC-ENGINE"), RUNNER = region("SYNC-RUNNER");

// Допоміжні функції застосунку (спрощені копії; округлення 0,5 грн, націнка за замовчуванням 30 %)
const norm = v => String(v ?? "").toLowerCase().replace(/[.,:;()№]/g, " ").replace(/\s+/g, " ").trim();
const num = v => { const x = parseFloat(String(v).replace(",", ".")); return isFinite(x) ? x : 0; };
function parseNum(v){ if (typeof v === "number") return isFinite(v) ? v : 0; const x = parseFloat(String(v ?? "").replace(/[\s ]/g, "").replace(/грн|₴|uah/gi, "").replace(",", ".")); return isFinite(x) ? x : 0; }
function unitNorm(v){ const s = norm(v); if (!s) return ""; if (s === "кг") return "кг"; if (s === "100 г") return "100 г"; if (["уп","упаковка"].includes(s)) return "уп"; return "шт"; }
const PACKS = ["Банка","ПЕТ","Скло","Стакан","Коробка","Пакет","Упаковка","Ваговий","Штучно"];
const packNorm = v => { const t = norm(v); if (!t) return ""; return PACKS.find(x => norm(x) === t) || String(v).trim(); };
const roundPrice = x => Math.ceil(x / 0.5 - 1e-9) * 0.5;
function priceOf(p){ if (p.manualPrice && p.price != null) return num(p.price); return roundPrice(num(p.cost) * (1 + num(p.markup ?? 30) / 100)); }
const pj = r => { let x = r && r.payload; if (typeof x === "string"){ try{ x = JSON.parse(x); }catch(_){} } return x; };

const {planSync, GS_COLS} = new Function(ENGINE + "; return {planSync, GS_COLS};")();

function makeEnv(extra = {}){
  let k = 0;
  return Object.assign({defMarkup:30, priceOf, norm, parseNum, unitNorm, packNorm, today:"2026-09-29", newId:() => "g" + (++k), deleted:new Set()}, extra);
}

// Одна вкладка застосунку: власний стан S і таймери, спільні база й таблиця.
// Таймери не спрацьовують самі — тест запускає їх через timers[i].fn().
function device({db, mcp, today = "2026-10-03"}){
  const S = {settings:{gsId:"sheet1"}, allProducts:[]}, timers = [];
  const make = new Function("S", "db", "mcp", "defMarkup", "priceOf", "norm", "parseNum", "unitNorm", "packNorm", "today", "updateSyncUi", "pj", "setTimeout", "clearTimeout",
    ENGINE + RUNNER + "; return gsSync;");
  const gsSync = make(S, db, mcp, () => 30, priceOf, norm, parseNum, unitNorm, packNorm, () => today, () => {}, pj,
    (fn, ms) => { timers.push({fn, ms}); return timers.length; }, () => {});
  return {S, gsSync, timers};
}

module.exports = {planSync, GS_COLS, makeEnv, device, priceOf, norm};
