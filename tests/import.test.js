// Імпорт товарів із накладних і таблиць: розпізнавання стовпців (parseSheet) і план змін (buildPlan); підпис розміру на цінику.
const test = require("node:test"), assert = require("node:assert/strict");
const {importer, sizeLabel, priceOf} = require("./sync-harness.js");

const INVOICE = [
  ["ТОВ «Постачальник»"], ["Видаткова накладна № 12 від 01.10.2026"], [],
  ["№", "Найменування", "Од. вим.", "К-сть", "Ціна прих., грн", "Сума"],
  [1, "Coca-Cola 0,5 л", "шт", 24, "22,50 грн", 540],
  [2, "Цукерки Ромашка", "кг", 5, 180, 900],
  [3, "Вафлі Артек 100г", "шт", 10, "", 0],
  [4, "Халва 250 г", "шт", 10, 40, 400],
  [5, "Халва 250 г", "шт", 10, 41, 410],
  ["", "Разом", "", "", "", 2250]];

test("накладна: заголовок нижче реквізитів, скорочені назви стовпців, рядок «Разом» відкинуто", () => {
  const r = importer().parseSheet(INVOICE, "n.xlsx");
  assert.equal(r.error, undefined);
  assert.deepEqual(r.rows.map(x => x.name), ["Coca-Cola 0,5 л", "Цукерки Ромашка", "Вафлі Артек 100г", "Халва 250 г", "Халва 250 г"]);
  assert.equal(r.rows[0].cost, 22.5, "«Ціна прих.» — закупівля, «22,50 грн» — число");
  assert.equal(r.rows[1].unit, "кг");
  assert.deepEqual([r.rows[0].size, r.rows[2].size], ["0,5 л", "100 г"], "розмір із назви");
  assert.ok(r.mapping.some(m => m.startsWith("Закупівля ←")));
});

test("без стовпця з назвою — зрозуміла помилка", () => {
  assert.match(importer().parseSheet([["Код", "Ціна"], [1, 2]], "x.csv").error, /назв/i);
});

test("стовпець просто «Ціна»: за замовчуванням закупівля, можна перемкнути на ціну продажу", () => {
  const im = importer(), r = im.parseSheet([["Назва", "Ціна"], ["Еспресо", "35"]], "c.csv");
  assert.equal(r.hasGeneric, true);
  assert.equal(im.buildPlan(r).items[0].data.cost, 35);
  const p = im.buildPlan(Object.assign({}, r, {genericAs:"price"})).items[0].data;
  assert.equal(p.price, 35); assert.equal(p.manualPrice, true);
});

test("націнка: 0,3 і 0.35 — частки, «35%» — відсотки", () => {
  const r = importer().parseSheet([["Назва", "Націнка", "Закупівля"], ["A", "0,3", "10"], ["B", "35%", "10"], ["C", "0.35", "10"]], "m.csv");
  assert.deepEqual(r.rows.map(x => x.markup), [30, 35, 35]);
});

test("пакування з назви й одиниці з крапками", () => {
  const im = importer(), r = im.parseSheet([["Назва", "Од.", "Ціна продажу"], ["Fanta 0,33 л банка", "Кг.", 30], ["Боржомі скло 0,5", "пач.", 40]], "p.csv");
  assert.deepEqual(r.rows.map(x => [x.pack, x.unit]), [["Банка", "кг"], ["Скло", "пач"]]);
});

test("план: повтори у файлі й рядки без ціни пропускаються, наявний товар оновлюється", () => {
  const im = importer([{id:"x1", name:"Coca-Cola 0,5 л", type:"Напої", unit:"шт", cost:20, markup:40}]);
  const plan = im.buildPlan(im.parseSheet(INVOICE, "n.xlsx"));
  assert.equal(plan.skipped, 1); assert.equal(plan.dup, 1);
  assert.equal(plan.nNew, 2); assert.equal(plan.nUpd, 1);
  const coca = plan.items.find(i => i.ex).data;
  assert.equal(coca.cost, 22.5); assert.equal(coca.costAt, "2026-10-03"); assert.equal(coca.type, "Напої");
  assert.equal(coca.markup, 30, "націнка з форми імпорту");
  assert.equal(plan.items.find(i => i.data.name === "Халва 250 г").data.cost, 40, "з повторів береться перший");
});

test("накладна з самою закупівлею не стирає ручну ціну наявного товару", () => {
  const ex = {id:"d04", name:"Coca-Cola 1,25 л", unit:"шт", cost:0, manualPrice:true, price:69, markup:30, priceAt:"2026-09-29"};
  const im = importer([ex]);
  const it = im.buildPlan(im.parseSheet([["Найменування", "Ціна прих., грн"], ["Coca-Cola 1,25 л", "45"]], "n.xlsx")).items[0];
  const after = Object.assign({}, ex, it.data);
  assert.equal(priceOf(after), 69); assert.equal(after.cost, 45); assert.equal(after.costAt, "2026-10-03");
  assert.equal(after.priceAt, "2026-09-29", "ціна продажу не змінилась");
});

test("якщо у файлі є націнка або ціна продажу — ручна ціна замінюється", () => {
  const ex = {id:"d04", name:"Sprite 1,25 л", unit:"шт", cost:0, manualPrice:true, price:69};
  const im = importer([ex]);
  const withMarkup = im.buildPlan(im.parseSheet([["Назва", "Закупівля", "Націнка"], ["Sprite 1,25 л", 45, 40]], "a.csv")).items[0].data;
  assert.equal(priceOf(Object.assign({}, ex, withMarkup)), 63);
  const withPrice = im.buildPlan(im.parseSheet([["Назва", "Ціна продажу"], ["Sprite 1,25 л", 72]], "b.csv")).items[0].data;
  assert.equal(priceOf(Object.assign({}, ex, withPrice)), 72);
});

test("підпис розміру на цінику", () => {
  const cases = [[{size:"0,5", pack:"ПЕТ"}, "об’єм 0,5 л"], [{size:"500", pack:"Банка"}, "об’єм 500 мл"], [{size:"250 г"}, "вага 250 г"],
    [{size:"XL", pack:"Стакан"}, "розмір XL"], [{size:"12 × 0,5 л"}, "об’єм 12 × 0,5 л"], [{size:""}, ""], [{size:"300", pack:"Упаковка"}, "вага 300 г"]];
  for (const [p, want] of cases) assert.equal(sizeLabel(p), want, JSON.stringify(p));
});
