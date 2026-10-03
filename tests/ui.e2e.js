// Перевірки в браузері: справжня сторінка app/index.html з підробленими базою, Google Sheets і завантаженнями.
// Потрібен Playwright з Chromium: npm i -D playwright && npx playwright install chromium; тоді npm run test:ui.
// Свій Chromium: PW_CHROMIUM=/шлях/до/chrome npm run test:ui
const assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
let chromium;
try { ({chromium} = require("playwright")); }
catch (_) {
  try { ({chromium} = require(path.join(require("child_process").execSync("npm root -g").toString().trim(), "playwright"))); }
  catch (_) { console.error("Немає Playwright. Встановіть: npm i -D playwright && npx playwright install chromium"); process.exit(2); }
}
const APP = path.resolve(process.env.APP_HTML || path.join(__dirname, "../app/index.html"));
const fakes = fs.readFileSync(path.join(__dirname, "fakes.js"), "utf8");

// Підробки в сторінці. window.__fdb пише так само, як застосунок (зі знімками), window.__db — сирі дані.
const init = seed => `(() => {
  const module = {exports:{}}; ${fakes}
  const F = module.exports, db = F.fakeDb(), sh = F.fakeSheets([["Назва","Закупівля, грн","Націнка, %","Ціна продажу, грн"]]), subs = [];
  window.__delay = 0;
  const slow = () => new Promise(r => setTimeout(r, window.__delay));
  const fire = () => subs.forEach(f => f());
  const wrapRef = r => Object.assign({}, r, {
    set: async d => { await slow(); await r.set(d); fire(); }, update: async d => { await slow(); await r.update(d); fire(); },
    delete: async () => { await r.delete(); fire(); },
    onSnapshot(next){ const f = () => r.get().then(next); subs.push(f); f(); return () => {}; } });
  const fdb = {doc: p => wrapRef(db.doc(p)), collection: n => { const c = db.collection(n); return Object.assign({}, c, {
    doc: id => wrapRef(c.doc(id)), add: async d => { await slow(); const r = await c.add(d); fire(); return r; },
    onSnapshot(next){ const f = () => c.get().then(next); subs.push(f); f(); return () => {}; } }); }};
  for (const [k, v] of Object.entries(${JSON.stringify(seed)})) db.docs.set(k, v);
  window.__saved = []; window.__db = db; window.__fdb = fdb; window.__sh = sh;
  const dl = {save: async r => { window.__saved.push(r.filename); return {status:"saved"}; }};
  window.claude = {use: n => Promise.resolve(n === "db" ? fdb : n === "mcp" ? {callTool: sh.callTool} : n === "downloads" ? dl : null)};
})();`;

const BASE = {
  "settings/main": {},
  "products/p1": {name:"Еспресо", cost:0, manualPrice:true, price:35, unit:"шт", type:"Напої", category:"Кав'ярня"},
  "products/p2": {name:"Зефір ванільний", cost:140, markup:35, manualPrice:false, unit:"кг", type:"Цукерки", category:"Зефір"},
  "products/p3": {name:"Цук.Рошен.Ромашка.вагові.глазуровані", cost:300, markup:35, manualPrice:false, unit:"шт", type:"Цукерки", category:"Цукерки"},
  "products/p4": {name:"Приклад", cost:10, manualPrice:true, price:100, unit:"шт", example:true},
  "products/p5": {name:"Халва (прихована)", cost:40, markup:35, manualPrice:false, unit:"шт", hidden:true, gsBase:{name:"Халва (прихована)"}},
  "expenses/e1": {name:"Оренда", group:"fixed", amount:20000, order:1},
  "tasks/t1": {title:"Внести ціни", stage:2, status:"doing", order:1}
};

const cases = [];
const scenario = (name, fn, seed = BASE, hash = "") => cases.push({name, fn, seed, hash});
const docs = page => page.evaluate(() => [...window.__db.docs].map(([k, v]) => Object.assign({_path:k}, v)));

const clickHuman = async (page, sel) => { // натискання з паузою, як у людини (між pointerdown і pointerup)
  const bb = await page.locator(sel).first().boundingBox();
  await page.mouse.move(bb.x + bb.width/2, bb.y + bb.height/2); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
};

scenario("знімок бази, поки людина вводить текст, не губить ні текст, ні клік «Додати»", async page => {
  await page.click('[data-tab="plan"]');
  await page.click("#newTask");
  await page.evaluate(() => window.__fdb.collection("products").doc("p1").update({price:36}));
  await page.waitForTimeout(100);
  await page.type("#newTask", "Купити каву");
  await clickHuman(page, '[data-act="addTask"]');
  await page.waitForTimeout(300);
  assert.equal((await docs(page)).filter(d => d.title === "Купити каву").length, 1);
  assert.equal(await page.inputValue("#newTask"), "");
});

scenario("«Скинути» очищує пошук, а чернетка нового товару переживає оновлення даних", async page => {
  await page.click('[data-tab="products"]');
  await page.click('[data-act="panel"][data-panel="add"]');
  await page.fill("#npName", "Халва 250 г");
  await page.fill("#q", "зеф"); await page.waitForTimeout(300);
  await page.click('[data-act="fReset"]'); await page.waitForTimeout(100);
  assert.equal(await page.inputValue("#q"), "");
  assert.equal(await page.inputValue("#npName"), "Халва 250 г");
  await page.evaluate(() => window.__fdb.collection("products").doc("p1").update({price:37})); await page.waitForTimeout(200);
  assert.equal(await page.inputValue("#npName"), "Халва 250 г");
});

scenario("клік по товару при відкритому фільтрі вибирає товар", async page => {
  await page.click('[data-tab="tags"]');
  await page.click('[data-ddtoggle="types"]');
  await page.click('[data-tag="p1"]');
  await page.waitForTimeout(100);
  assert.equal(await page.isChecked('[data-tag="p1"]'), true);
});

scenario("довга назва без пробілів зменшує шрифт цінника", async page => {
  await page.click('[data-tab="tags"]');
  await page.click('[data-tag="p3"]'); await page.waitForTimeout(100);
  const x = await page.evaluate(() => { const t = [...document.querySelectorAll("#preview .tag")].find(e => e.textContent.includes("Ромашка")); return t && +getComputedStyle(t).getPropertyValue("--x"); });
  assert.ok(x > 0 && x < 1, `--x = ${x}`);
});

scenario("PDF запам'ятовує ціну; після зміни ціни товар пропонується передрукувати — і з «Сьогодні» теж", async page => {
  await page.click('[data-tab="tags"]');
  await page.click('[data-tag="p1"]');
  await page.click('[data-act="dlPdf"]');
  await page.waitForFunction(() => window.__saved.some(f => f.endsWith(".pdf")), null, {timeout:20000});
  await page.waitForFunction(() => window.__db.docs.get("products/p1").printedPrice === 35, null, {timeout:5000});
  await page.evaluate(() => window.__fdb.collection("products").doc("p1").update({price:39}));
  await page.waitForTimeout(300);
  assert.match(await page.textContent('[data-st="changed"]'), /Ціна змінилась після друку · 1/);
  await page.click('[data-tab="today"]');
  await page.click('[data-act="goReprint"]'); await page.waitForTimeout(200);
  assert.equal(await page.isChecked('[data-tag="p1"]'), true);
  assert.equal(await page.isChecked('[data-tag="p2"]'), false);
});

scenario("повторне натискання «Додати в базу» під час імпорту не створює дублів", async page => {
  await page.click('[data-tab="products"]');
  const file = path.join(os.tmpdir(), `tsukenya-imp-${process.pid}.csv`);
  fs.writeFileSync(file, "Назва;Закупівля\n" + Array.from({length:12}, (_, i) => `Товар ${i+1};${10+i}`).join("\n"));
  await page.setInputFiles("#impFile", file);
  await page.waitForSelector('[data-act="impGo"]');
  await page.evaluate(() => { window.__delay = 25; });
  await page.click('[data-act="impGo"]');
  await page.waitForTimeout(120);
  const clickedAgain = await page.evaluate(() => { const b = document.querySelector('[data-act="impGo"]'); if (b && !b.disabled){ b.click(); return true; } return false; });
  assert.equal(clickedAgain, false, "під час імпорту кнопки немає");
  await page.waitForFunction(() => /Готово/.test(document.querySelector("#impBox").textContent), null, {timeout:10000});
  assert.equal((await docs(page)).filter(d => /^Товар \d+$/.test(d.name || "")).length, 12);
  assert.match(await page.textContent("#impBox"), /Ціна змінилась у 12 товарів/);
  fs.unlinkSync(file);
});

scenario("«Сьогодні»: беззбитковість без прикладів, що потребує уваги, копія, версія", async page => {
  assert.match(await page.textContent("#main"), /по 2 з 3 товарів/);
  assert.match(await page.textContent("#main"), /Потребує уваги/);
  assert.match(await page.textContent("#foot"), /версія \d+\.\d+\.\d+/);
  await page.click('[data-act="backup"]');
  await page.waitForFunction(() => window.__saved.some(f => f.endsWith(".json")) && window.__db.docs.get("settings/main").lastBackupAt, null, {timeout:5000});
});

scenario("видалений товар повертається кнопкою «Скасувати»", async page => {
  await page.click('[data-tab="products"]');
  await page.click('[data-del-prod="p1"]');
  await page.waitForFunction(() => !window.__db.docs.has("products/p1"), null, {timeout:3000});
  assert.ok(await page.evaluate(() => window.__db.docs.has("deletedProducts/p1")), "«надгробок» є");
  await page.click("#toastA");
  await page.waitForFunction(() => window.__db.docs.has("products/p1"), null, {timeout:3000});
  assert.equal(await page.evaluate(() => window.__db.docs.get("products/p1").price), 35);
  assert.equal(await page.evaluate(() => window.__db.docs.has("deletedProducts/p1")), false);
});

scenario("видалення задачі й статті витрат теж скасовується", async page => {
  await page.click('[data-tab="money"]');
  await page.click('[data-del-exp="e1"]');
  await page.waitForFunction(() => !window.__db.docs.has("expenses/e1"), null, {timeout:3000});
  await page.click("#toastA");
  await page.waitForFunction(() => window.__db.docs.has("expenses/e1") && window.__db.docs.get("expenses/e1").amount === 20000, null, {timeout:3000});
});

scenario("масова націнка показує наслідки до застосування і скасовується", async page => {
  await page.click('[data-tab="products"]');
  await page.click('[data-act="panel"][data-panel="bulk"]');
  await page.fill("#bulkM", "50"); await page.waitForTimeout(100);
  assert.match(await page.textContent("#bulkPrev"), /отримають націнку 50/);
  await page.click('[data-act="bulk"]');
  await page.waitForFunction(() => window.__db.docs.get("products/p2").markup === 50, null, {timeout:3000});
  assert.equal(await page.evaluate(() => window.__db.docs.get("products/p1").manualPrice), false, "ручна ціна замінена");
  await page.click("#toastA");
  await page.waitForFunction(() => window.__db.docs.get("products/p2").markup === 35 && window.__db.docs.get("products/p1").manualPrice === true, null, {timeout:3000});
});

scenario("розділ відкривається за адресою #money, старі назви теж працюють", async page => {
  assert.match(await page.textContent("#main"), /Щоб вийти в нуль/);
  assert.equal(await page.getAttribute('[data-tab="money"]', "aria-selected"), "true");
}, BASE, "#expenses");

scenario("синхронізація, видалення з «надгробком», повернення прихованого товару, відключення другим натисканням", async page => {
  await page.waitForFunction(() => window.__sh.sheet.length === 5, null, {timeout:10000}); // заголовок + 4 видимі товари
  await page.click('[data-tab="products"]');
  await page.click('[data-del-prod="p2"]');
  await page.waitForFunction(() => !window.__sh.sheet.some(r => r[0] === "Зефір ванільний"), null, {timeout:15000});
  assert.ok(await page.evaluate(() => window.__db.docs.has("deletedProducts/p2")));
  await page.click("#hidden summary");
  await page.click('[data-unhide="p5"]');
  await page.waitForFunction(() => window.__sh.sheet.some(r => r[0] === "Халва (прихована)" && r.includes("p5")), null, {timeout:10000});
  assert.equal(await page.evaluate(() => window.__db.docs.get("products/p5").hidden), false);
  await page.click('[data-act="gsUnlink"]'); await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => window.__db.docs.get("settings/main").gsId), "перше натискання лише просить підтвердити");
  await page.click('[data-act="gsUnlink"]');
  await page.waitForFunction(() => !window.__db.docs.get("settings/main").gsId, null, {timeout:3000});
}, Object.assign({}, BASE, {"settings/main": {gsId:"sheet1", gsTitle:"База"}}));

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? {executablePath:process.env.PW_CHROMIUM} : {});
  let failed = 0;
  for (const c of cases){
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", e => errors.push(e.message)); page.on("dialog", d => d.accept());
    await page.route(/^https?:/, r => r.abort()); // без мережі: шрифти й бібліотеки не потрібні
    await page.addInitScript(init(c.seed));
    try {
      await page.goto("file://" + APP + (c.hash || ""));
      await page.waitForFunction(() => window.__db && document.querySelector("#main").children.length, null, {timeout:5000});
      await page.waitForTimeout(150);
      await c.fn(page);
      assert.deepEqual(errors, [], "помилки JavaScript на сторінці");
      console.log("ok   -", c.name);
    } catch (e) { failed++; console.log("FAIL -", c.name, "\n      ", String(e.message).split("\n")[0]); }
    await page.close();
  }
  await browser.close();
  console.log(failed ? `\n${failed} з ${cases.length} не пройшли` : `\nусі ${cases.length} пройшли`);
  process.exit(failed ? 1 : 0);
})();
