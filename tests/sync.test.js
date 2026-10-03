// Сценарії planSync: таблиця й база змінюються з обох боків, після кожної зміни повторна синхронізація нічого не робить.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs");
const {planSync, makeEnv} = require("./sync-harness.js");

// Застосовує план так, як це роблять Google Sheets (текстові значення, кома в дробах) і база артефакту
const disp = v => v === null || v === undefined ? undefined : typeof v === "number" ? String(v).replace(".", ",") : String(v).replace(/^'/, "");
function apply(sheet, prods, plan){
  if (plan.header) sheet[0] = plan.header.slice();
  for (const w of plan.rowWrites){ const r = sheet[w.row - 1] || []; w.values.forEach((v, i) => { const d = disp(v); if (d !== undefined) r[i] = d; }); sheet[w.row - 1] = r; }
  for (const a of plan.appends) sheet.push(a.map(v => disp(v) ?? ""));
  for (const c of plan.clears) sheet[c - 1] = [];
  for (const u of plan.dbUpdates){ const p = prods.find(x => x.id === u.id); Object.assign(p, JSON.parse(JSON.stringify(u.patch))); }
  for (const a of plan.dbAdds) prods.push(Object.assign({id:a.id}, JSON.parse(JSON.stringify(a.data))));
}
const counts = p => ({writes:p.rowWrites.length, appends:p.appends.length, clears:p.clears.length, dbUpdates:p.dbUpdates.length, dbAdds:p.dbAdds.length, changed:p.changed, pushed:p.pushed});
const ZERO = {writes:0, appends:0, clears:0, dbUpdates:0, dbAdds:0, changed:0, pushed:0};
const load = f => JSON.parse(fs.readFileSync(__dirname + "/fixtures/" + f, "utf8"));

let sheet = load("sheet.json"), prods = load("products.json");
const env = makeEnv();
const run = () => { const p = planSync(sheet, prods, env); assert.equal(p.error, undefined); apply(sheet, prods, p); return p; };
const col = name => sheet[0].indexOf(name);
const rowOf = (c, v) => sheet.findIndex(r => r[c] === v);
const assertStable = () => assert.deepEqual(counts(run()), ZERO, "повторна синхронізація має нічого не змінювати");

test("перша синхронізація: додає стовпці ID і «Ціна на цінник», дописує товари, яких нема в таблиці", () => {
  const p = run();
  assert.deepEqual(counts(p), {writes:38, appends:7, clears:0, dbUpdates:45, dbAdds:0, changed:0, pushed:38});
  assert.ok(p.header.includes("ID") && p.header.includes("Ціна на цінник, грн"));
  assert.equal(sheet.filter((r, i) => i > 0 && r[col("ID")]).length, 45, "кожен товар має рядок з ID");
  assertStable();
});

test("зміна в таблиці: закупівля Coca-Cola 0,5 л = 25, ручну ціну стерто", () => {
  const r = rowOf(0, "Coca-Cola 0,5 л"); sheet[r][col("Закупівля, грн")] = "25"; sheet[r][col("Ціна продажу, грн")] = "";
  assert.deepEqual(counts(run()), {...ZERO, writes:1, dbUpdates:1, changed:1});
  const p = prods.find(x => x.name === "Coca-Cola 0,5 л");
  assert.equal(p.cost, 25); assert.equal(p.manualPrice, false); assert.equal(p.price, null);
  assert.equal(p.costAt, env.today, "нова закупівля з таблиці — від неї рахується застарілість");
  assert.equal(env.priceOf(p), 32.5);
  assert.equal(sheet[r][col("Ціна на цінник, грн")], "32,5");
  assertStable();
});

test("зміна в застосунку: закупівля w01 = 10 потрапляє в таблицю", () => {
  Object.assign(prods.find(x => x.id === "w01"), {cost:10, priceAt:"2026-09-30"});
  assert.deepEqual(counts(run()), {...ZERO, writes:1, dbUpdates:1, pushed:1});
  const r = sheet[rowOf(col("ID"), "w01")];
  assert.equal(r[col("Закупівля, грн")], "10");
  assert.equal(r[col("Ціна на цінник, грн")], "13");
  assert.equal(r[col("Ціна оновлена")], "2026-09-30");
  assertStable();
});

test("конфлікт: ціну Джмеля змінили з обох боків — перемагає таблиця", () => {
  const r = rowOf(0, "Джміль"); sheet[r][col("Ціна продажу, грн")] = "95";
  const p = prods.find(x => x.name === "Джміль"); p.price = 99;
  run();
  assert.equal(p.price, 95); assert.equal(sheet[r][col("Ціна продажу, грн")], "95");
  assertStable();
});

test("новий рядок у таблиці стає товаром, ID записується в рядок", () => {
  sheet.push(["Халва соняшникова 250 г", "Цукерки", "Халва", "Упаковка", "250 г", "шт", "40", "35"]);
  assert.deepEqual(counts(run()), {...ZERO, writes:1, dbAdds:1});
  const p = prods.find(x => x.name === "Халва соняшникова 250 г"), r = sheet[sheet.length - 1];
  assert.equal(env.priceOf(p), 54);
  assert.equal(r[col("ID")], p.id);
  assert.equal(r[col("Ціна на цінник, грн")], "54");
  assertStable();
});

test("зміна лише назви не оновлює дату закупівлі", () => {
  const p = prods.find(x => x.name === "Coca-Cola 0,5 л"); p.costAt = "2026-09-01";
  const r = rowOf(0, "Coca-Cola 0,5 л"); sheet[r][0] = "Coca-Cola 0,5 л (ПЕТ)";
  run();
  assert.equal(p.name, "Coca-Cola 0,5 л (ПЕТ)"); assert.equal(p.costAt, "2026-09-01");
  sheet[r][0] = "Coca-Cola 0,5 л"; run(); assertStable();
});

test("рядок видалено в таблиці — товар ховається", () => {
  sheet.splice(rowOf(0, "Fanta 1 л"), 1);
  assert.deepEqual(counts(run()), {...ZERO, dbUpdates:1});
  assert.equal(prods.find(x => x.name === "Fanta 1 л").hidden, true);
  assertStable();
});

test("рядок повернули (Ctrl+Z) — товар знову видно", () => {
  const p = prods.find(x => x.name === "Fanta 1 л");
  sheet.push(["Fanta 1 л", "Напої", "Готові напої", "ПЕТ", "1 л", "шт", "", "30", "", "", "", "", p.id]);
  run();
  assert.equal(p.hidden, false);
  assertStable();
});

test("товар видалено в застосунку (є «надгробок») — рядок очищується", () => {
  const p = prods.find(x => x.name === "Sprite 1 л");
  prods = prods.filter(x => x !== p); env.deleted.add(p.id);
  assert.deepEqual(counts(run()), {...ZERO, clears:1});
  assert.equal(sheet.filter(r => r[0] === "Sprite 1 л").length, 0);
  assertStable();
});

test("незнайомий ID не стирає рядок: товар із такою назвою знаходиться, ID виправляється", () => {
  const p = prods.find(x => x.name === "Sprite 0,5 л"), r = rowOf(0, "Sprite 0,5 л");
  sheet[r][col("ID")] = "зіпсований-id";
  const plan = run();
  assert.equal(plan.clears.length, 0);
  assert.equal(sheet[r][0], "Sprite 0,5 л");
  assert.equal(sheet[r][col("ID")], p.id);
  assert.equal(prods.filter(x => x.name === "Sprite 0,5 л").length, 1, "без дубля");
  assertStable();
});

test("незнайомий ID без збігу за назвою (рядок зі старої копії) — рядок стає товаром, нічого не стирається", () => {
  sheet.push(["Sprite 2 л", "Напої", "Готові напої", "ПЕТ", "2 л", "шт", "30", "30", "", "", "", "", "старий-id"]);
  const plan = run();
  assert.equal(plan.clears.length, 0); assert.equal(plan.dbAdds.length, 1);
  const p = prods.find(x => x.name === "Sprite 2 л");
  assert.ok(p && !p.hidden);
  assert.equal(sheet[sheet.length - 1][col("ID")], p.id);
  assertStable();
});

test("перейменування в таблиці оновлює назву, а не створює новий товар", () => {
  const r = rowOf(0, "Допіо"); sheet[r][0] = "Допіо (подвійне еспресо)";
  assert.deepEqual(counts(run()), {...ZERO, dbUpdates:1, changed:1});
  assert.deepEqual(prods.filter(x => x.name.startsWith("Допіо")).map(x => x.name), ["Допіо (подвійне еспресо)"]);
  assertStable();
});

test("стерту націнку повертає значення за замовчуванням", () => {
  const r = rowOf(0, "Coca-Cola 0,5 л"); sheet[r][col("Націнка, %")] = "";
  assert.deepEqual(counts(run()), {...ZERO, writes:1, pushed:1});
  assert.equal(sheet[r][col("Націнка, %")], "30");
  assertStable();
});

test("таблиця без стовпця «Назва» — зрозуміла помилка, жодних записів", () => {
  const p = planSync([["Товар?", "Ціна"]], prods, env);
  assert.match(p.error, /Назва/);
});
