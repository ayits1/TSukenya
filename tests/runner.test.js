// gsSync з підробленими базою й таблицею: кілька вкладок/пристроїв, замок, «надгробки» видалених товарів.
const test = require("node:test"), assert = require("node:assert/strict");
const {device} = require("./sync-harness.js");
const {fakeDb, fakeSheets} = require("./fakes.js");

const HEAD = ["Назва", "Закупівля, грн", "Націнка, %", "Ціна продажу, грн"];

async function setup(opts = {}){
  const clock = {t:Date.parse("2026-10-03T08:00:00Z")};
  const db = fakeDb({now:() => clock.t, noLease:opts.noLease});
  await db.doc("products/p1").set({name:"Еспресо", cost:0, manualPrice:true, price:35, unit:"шт"});
  const sh = fakeSheets([HEAD]);
  const A = device({db, mcp:sh}), B = device({db, mcp:sh});
  await A.gsSync();                 // таблиця й база вже пов'язані
  assert.equal(A.S.sync.error, null);
  clock.t += 5000;                  // замок після синхронізації тримається 1 с
  return {db, sh, A, B, clock};
}
const named = (db, n) => db.list("products").filter(p => p.name === n);
const idCol = sh => sh.sheet[0].indexOf("ID");

test("два пристрої синхронізують одночасно — новий рядок стає одним товаром (30 прогонів)", async () => {
  for (let i = 0; i < 30; i++){
    const {db, sh, A, B, clock} = await setup();
    sh.sheet.push(["Халва 250 г", "40", "35", ""]);
    await Promise.all([A.gsSync(), B.gsSync()]);
    const waiter = [A, B].filter(d => d.S.sync.waiting);
    assert.equal(waiter.length, 1, "один пристрій синхронізує, інший чекає");
    assert.equal(waiter[0].timers.length, 1, "той, хто чекає, планує повтор");
    clock.t += 5000;
    await waiter[0].timers[0].fn();   // повтор після звільнення замка
    assert.equal(waiter[0].S.sync.waiting, false); assert.equal(waiter[0].S.sync.error, null);
    const halva = named(db, "Халва 250 г");
    assert.equal(halva.length, 1, "без дубля"); assert.ok(!halva[0].hidden);
    const rows = sh.sheet.filter(r => r[0] === "Халва 250 г");
    assert.equal(rows.length, 1); assert.equal(rows[0][idCol(sh)], halva[0].id);
  }
});

test("другий пристрій зі застарілим знімком бази не стирає щойно доданий рядок", async () => {
  const {db, sh, A, B, clock} = await setup();
  B.S.allProducts = db.list("products");          // знімок B — до появи нового товару
  sh.sheet.push(["Халва 250 г", "40", "35", ""]);
  await A.gsSync(); clock.t += 5000;
  await B.gsSync(); clock.t += 5000;
  await A.gsSync();
  const row = sh.sheet.find(r => r[0] === "Халва 250 г");
  assert.ok(row, "рядок на місці");
  const halva = named(db, "Халва 250 г");
  assert.equal(halva.length, 1); assert.ok(!halva[0].hidden); assert.equal(row[idCol(sh)], halva[0].id);
});

test("замок зайнятий — синхронізація не чіпає таблицю, показує очікування і планує повтор", async () => {
  const {db, sh, A} = await setup();
  await db.doc("sync/lock").acquire({holder:"інший пристрій", ttlMs:30000});
  const before = sh.calls.length;
  await A.gsSync();
  assert.equal(sh.calls.length, before, "жодного звернення до таблиці");
  assert.equal(A.S.sync.waiting, true); assert.equal(A.S.sync.busy, false);
  assert.equal(A.timers.length, 1);
  assert.ok(A.timers[0].ms >= 2000 && A.timers[0].ms <= 66500);
});

test("середовище без замків (старий рантайм) — синхронізація працює як раніше", async () => {
  const {db, sh, A} = await setup({noLease:true});
  sh.sheet.push(["Халва 250 г", "40", "35", ""]);
  await A.gsSync();
  assert.equal(A.S.sync.error, null);
  assert.equal(named(db, "Халва 250 г").length, 1);
});

test("помилка замка — зрозуміле повідомлення, таблиця не змінюється", async () => {
  const {db, sh, A} = await setup();
  const ref = db.doc("sync/lock"), orig = db.doc;
  db.doc = p => p === "sync/lock" ? Object.assign({}, ref, {acquire:async () => { throw {code:"unavailable"}; }}) : orig(p);
  const before = sh.calls.length;
  await A.gsSync();
  assert.match(A.S.sync.error, /інший пристрій/);
  assert.equal(sh.calls.length, before);
  assert.equal(A.S.sync.busy, false);
});

test("немає прав на запис — синхронізація не запускається і пояснює чому", async () => {
  const {db, sh, A} = await setup();
  const ref = db.doc("sync/lock"), orig = db.doc;
  db.doc = p => p === "sync/lock" ? Object.assign({}, ref, {acquire:async () => { throw {code:"invalid_argument"}; }}) : orig(p);
  const before = sh.calls.length;
  await A.gsSync();
  assert.match(A.S.sync.error, /Немає прав/);
  assert.equal(sh.calls.length, before);
});

test("товар видалено в застосунку — рядок очищується; видалено без «надгробка» — рядок лишається товаром", async () => {
  const {db, sh, A, clock} = await setup();
  sh.sheet.push(["Халва 250 г", "40", "35", ""], ["Зефір", "140", "35", ""]);
  await A.gsSync(); clock.t += 5000;
  const [halva] = named(db, "Халва 250 г"), [zefir] = named(db, "Зефір");
  // як del("products", id) у застосунку
  await db.collection("deletedProducts").doc(halva.id).set({at:"2026-10-03"});
  await db.collection("products").doc(halva.id).delete();
  // видалено повз застосунок (без «надгробка»)
  await db.collection("products").doc(zefir.id).delete();
  await A.gsSync();
  assert.equal(A.S.sync.error, null);
  assert.equal(sh.sheet.filter(r => r[0] === "Халва 250 г").length, 0, "рядок видаленого товару очищено");
  const z = named(db, "Зефір");
  assert.equal(z.length, 1, "рядок без «надгробка» знову став товаром"); assert.ok(!z[0].hidden);
  assert.equal(sh.sheet.find(r => r[0] === "Зефір")[idCol(sh)], z[0].id);
});

test("прихований товар повертають у застосунку — рядок знову з’являється в таблиці, товар більше не ховається", async () => {
  const {db, sh, A, clock} = await setup();
  sh.sheet.push(["Халва 250 г", "40", "35", ""]);
  await A.gsSync(); clock.t += 5000;
  const [halva] = named(db, "Халва 250 г");
  sh.sheet.splice(sh.sheet.findIndex(r => r[0] === "Халва 250 г"), 1);   // рядок видалили в таблиці
  await A.gsSync(); clock.t += 5000;
  assert.equal(named(db, "Халва 250 г")[0].hidden, true);
  await db.collection("products").doc(halva.id).update({hidden:false, gsBase:null});   // кнопка «Повернути»
  await A.gsSync(); clock.t += 5000;
  await A.gsSync();
  const [back] = named(db, "Халва 250 г");
  assert.ok(!back.hidden, "не сховався знову");
  const rows = sh.sheet.filter(r => r[0] === "Халва 250 г");
  assert.equal(rows.length, 1); assert.equal(rows[0][idCol(sh)], halva.id);
});
