// Дістає з app/index.html блоки між маркерами *-START / *-END (синхронізація, розрахунки, імпорт) і запускає їх у Node.
const fs = require("fs");
const html = fs.readFileSync(process.env.APP_HTML || __dirname + "/../app/index.html", "utf8");
const region = name => {
  const m = html.match(new RegExp(`/\\* ${name}-START \\*/[\\s\\S]*?/\\* ${name}-END \\*/`));
  if (!m) throw new Error(`У app/index.html немає маркерів ${name}-START / ${name}-END`);
  return m[0];
};
const ENGINE = region("SYNC-ENGINE"), RUNNER = region("SYNC-RUNNER"), CALC = region("CALC"), IMPORT = region("IMPORT");

const num = v => { const x = parseFloat(String(v).replace(",", ".")); return isFinite(x) ? x : 0; }; // як у застосунку
// Списки груп і пакувань — як allTypes/allPacks у застосунку: стандартні плюс ті, що трапляються в товарах
const TYPES = ["Напої","Цукерки","Печиво і вафлі","Торти і десерти","Інше"];
const PACKS = ["Банка","ПЕТ","Скло","Стакан","Коробка","Пакет","Упаковка","Ваговий","Штучно"];
// Блок імпорту застосунку (IMPORT) над товарами products; settings — як S.settings
function importer(products = [], settings = {defaultMarkup:30}, today = "2026-10-03"){
  const S = {products, settings};
  const allTypes = () => [...TYPES, ...new Set(products.map(p => p.type).filter(t => t && !TYPES.includes(t)))];
  const allPacks = () => [...PACKS, ...new Set(products.map(p => p.pack).filter(x => x && !PACKS.includes(x)))];
  return new Function("S", "allTypes", "allPacks", "defMarkup", "today",
    IMPORT + "; return {norm, parseNum, unitNorm, packNorm, typeNorm, parseSheet, buildPlan, packFromName, sizeFromName};")(
    S, allTypes, allPacks, () => settings.defaultMarkup ?? 30, () => today);
}
const {norm, parseNum, unitNorm, packNorm} = importer();
const sizeLabel = new Function(region("SIZE-LABEL") + "; return sizeLabel;")();
// Блок розрахунків застосунку (CALC) з налаштуваннями settings; за замовчуванням — округлення 0,5 грн і націнка 30 %
function calc(settings = {rounding:0.5, defaultMarkup:30}){
  return new Function("S", "num", CALC + "; return {priceOf, marginOf, roundPrice, priceState, checkedAt, breakEven, staleDays, backupDue};")({settings}, num);
}
const {priceOf} = calc();
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

module.exports = {planSync, GS_COLS, makeEnv, device, calc, importer, sizeLabel, priceOf, norm, region, html};
