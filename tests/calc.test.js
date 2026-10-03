// Розрахунки застосунку: ціна, маржа, застарілість ціни, точка беззбитковості.
const test = require("node:test"), assert = require("node:assert/strict");
const {calc} = require("./sync-harness.js");

const DAY = 864e5, NOW = Date.parse("2026-10-03T12:00:00Z");
const ago = d => new Date(NOW - d*DAY).toISOString().slice(0, 10);

test("ціна продажу: ручна ціна, націнка, округлення вгору", () => {
  const {priceOf} = calc({rounding:0.5, defaultMarkup:30});
  assert.equal(priceOf({manualPrice:true, price:49}), 49);
  assert.equal(priceOf({cost:40, markup:35}), 54);
  assert.equal(priceOf({cost:25}), 32.5, "без націнки — націнка за замовчуванням");
  assert.equal(priceOf({cost:10, markup:33}), 13.5, "13,30 → 13,50");
  assert.equal(priceOf({cost:"12,5", markup:0}), 12.5, "кома в числі");
  assert.equal(priceOf({cost:0, markup:30}), 0);
  assert.equal(calc({rounding:1}).priceOf({cost:10, markup:33}), 14);
  assert.equal(calc({rounding:0.01}).priceOf({cost:10, markup:33}), 13.3);
});

test("маржа рахується від ціни продажу", () => {
  const {marginOf} = calc();
  assert.equal(marginOf({manualPrice:true, price:100, cost:75}), 0.25);
  assert.equal(marginOf({manualPrice:true, price:0, cost:10}), 0, "без ціни маржі немає");
});

test("застаріла ціна: для товару із закупівлею — від дати закупівлі, а не від зміни націнки", () => {
  const {priceState} = calc({staleDays:30});
  assert.equal(priceState({manualPrice:true, price:0}, NOW), "none");
  assert.equal(priceState({cost:10}, NOW), "stale", "дата невідома — застаріла");
  assert.equal(priceState({cost:10, costAt:ago(5), priceAt:ago(5)}, NOW), "ok");
  assert.equal(priceState({cost:10, costAt:ago(45), priceAt:ago(1)}, NOW), "stale", "націнку змінили вчора, а закупівлі 45 днів");
  assert.equal(priceState({cost:10, priceAt:ago(10)}, NOW), "ok", "старі товари без costAt — за priceAt");
  assert.equal(priceState({manualPrice:true, price:35, priceAt:ago(10), costAt:ago(90)}, NOW), "ok", "ручна ціна без закупівлі — за priceAt");
  assert.equal(calc({staleDays:7}).priceState({cost:10, costAt:ago(10)}, NOW), "stale");
});

const exp = [{group:"fixed", amount:30000}, {group:"variable", amount:"10000"}];
const prod = (cost, price, extra) => Object.assign({cost, manualPrice:true, price}, extra);

test("беззбитковість: витрати ÷ середня маржа, охоплення товарів", () => {
  const {breakEven} = calc();
  const t = breakEven([prod(75, 100), prod(60, 100), prod(0, 35), prod(0, 49)], exp);
  assert.equal(t.fixed, 30000); assert.equal(t.variable, 10000);
  assert.equal(t.n, 2); assert.equal(t.total, 4);
  assert.ok(Math.abs(t.avgM - 0.325) < 1e-9);
  assert.ok(Math.abs(t.be - 40000/0.325) < 1e-6);
});

test("беззбитковість: товари-приклади й товари без ціни не враховуються", () => {
  const {breakEven} = calc();
  const t = breakEven([prod(50, 100), prod(10, 100, {example:true}), prod(10, 0)], exp);
  assert.equal(t.n, 1); assert.equal(t.total, 2); assert.equal(t.examples, 1);
  assert.equal(t.avgM, 0.5); assert.equal(t.be, 80000);
});

test("беззбитковість: діапазон за чвертями асортименту", () => {
  const {breakEven} = calc();
  const t = breakEven([prod(90, 100), prod(80, 100), prod(70, 100), prod(60, 100), prod(50, 100)], exp);
  assert.ok(Math.abs(t.lo - 0.2) < 1e-9 && Math.abs(t.hi - 0.4) < 1e-9);
  assert.ok(Math.abs(t.beLo - 100000) < 1e-6 && Math.abs(t.beHi - 200000) < 1e-6);
  assert.ok(t.beLo <= t.be && t.be <= t.beHi);
});

test("беззбитковість: немає витрат, немає закупівель або маржа ≤ 0 — суми немає", () => {
  const {breakEven} = calc();
  assert.equal(breakEven([prod(50, 100)], []).be, 0);
  assert.equal(breakEven([prod(0, 100)], exp).be, 0);
  assert.equal(breakEven([prod(120, 100)], exp).be, 0, "продаж у мінус");
});

test("нагадування про резервну копію — якщо її не було або минув тиждень", () => {
  const {backupDue} = calc();
  assert.equal(backupDue(null, NOW), true);
  assert.equal(backupDue("не дата", NOW), true);
  assert.equal(backupDue(ago(6), NOW), false);
  assert.equal(backupDue(ago(8), NOW), true);
});

test("округлення до копійок і 10 коп. без хвостів 1.2000000000000002", () => {
  for (const r of [0.01, 0.1]){
    const {priceOf} = calc({rounding:r, defaultMarkup:30});
    for (let c = 1; c <= 200; c += 0.5) for (const m of [20, 25, 30, 35, 40]){
      const v = priceOf({cost:c, markup:m});
      assert.equal(v, Math.round(v*100)/100, `${c} грн + ${m}% з кроком ${r}: ${v}`);
      assert.ok(v >= c*(1+m/100) - 1e-9, "округлення лише вгору");
    }
  }
});

test("цінник: ще не друкували, ціна змінилась після друку, актуальний", () => {
  const {tagStatus} = calc();
  assert.equal(tagStatus({manualPrice:true, price:0}), "none");
  assert.equal(tagStatus({manualPrice:true, price:35}), "new");
  assert.equal(tagStatus({manualPrice:true, price:35, printedPrice:35}), "ok");
  assert.equal(tagStatus({manualPrice:true, price:39, printedPrice:35}), "changed");
  assert.equal(tagStatus({cost:40, markup:35, printedPrice:"54"}), "ok", "54 грн = 40 + 35 %");
});
