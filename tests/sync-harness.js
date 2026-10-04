const CatalogSchema=require('../app/catalog-schema.js');
const fs=require('fs');
const html=fs.readFileSync(process.argv[2]||__dirname+'/../app/portal.js','utf8');
const src=html.match(/\/\* SYNC-ENGINE-START \*\/[\s\S]*?\/\* SYNC-ENGINE-END \*\//)[0];
const S={settings:{rounding:0.5,defaultMarkup:30}};
const norm = v => String(v ?? "").toLowerCase().replace(/[.,:;()№]/g, " ").replace(/\s+/g, " ").trim();
const num = v => { const x = parseFloat(String(v).replace(",", ".")); return isFinite(x) ? x : 0; };
function parseNum(v){ if (typeof v === "number") return isFinite(v) ? v : 0; const x = parseFloat(String(v ?? "").replace(/[\s ]/g, "").replace(/грн|₴|uah/gi, "").replace(",", ".")); return isFinite(x) ? x : 0; }
function unitNorm(v){ const s = norm(v); if (!s) return ""; if (["кг"].includes(s)) return "кг"; if (s==="100 г") return "100 г"; if (["уп","упаковка"].includes(s)) return "уп"; return "шт"; }
const PACKS=["Банка","ПЕТ","Скло","Стакан","Коробка","Пакет","Упаковка","Ваговий","Штучно"];
const packNorm = v => { const t = norm(v); if (!t) return ""; return PACKS.find(x=>norm(x)===t) || String(v).trim(); };
function roundPrice(x){ const r = 0.5; return Math.ceil(x/r - 1e-9)*r; }
function priceOf(p){ if (p.manualPrice && p.price != null) return num(p.price); const m = p.markup ?? 30; return roundPrice(num(p.cost)*(1+num(m)/100)); }
eval(src.replace(/const /g,'var ').replace(/function planSync/,'global.planSync=planSync;function planSync'));
let k=0; const env={defMarkup:30, priceOf, norm, parseNum, unitNorm, packNorm, today:"2026-09-29", newId:()=>"g"+(++k)};
module.exports={env, planSync:global.planSync};
