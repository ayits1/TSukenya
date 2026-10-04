/* Label Studio against an isolated Django database. Never accepts a remote base URL. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium, webkit } = require('playwright');

const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-labels-ui-'));
const python = process.env.PYTHON_BIN || 'python3';
const port = 18211;
const base = `http://localhost:${port}`;
const password = 'isolated-label-studio-password';
const hash = execFileSync(python, ['-c', 'from server.auth import hash_password; print(hash_password("isolated-label-studio-password"))'], { cwd: root, encoding: 'utf8' }).trim();
const env = { ...process.env, DATA_DIR: data, ERP_DB_PATH: path.join(data, 'crm.sqlite3'), PORT: String(port), HOST: '127.0.0.1', OWNER_USERNAME: 'tester', OWNER_PASSWORD_HASH: hash };
for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) delete env[key];
const log = fs.openSync(path.join(data, 'server.log'), 'a');
const server = spawn(python, ['-m', 'server.main'], { cwd: root, env, stdio: ['ignore', log, log] });
const fixture = source => execFileSync(python, ['-c', `import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')\nimport django;django.setup()\n${source}`], { cwd: root, env, encoding: 'utf8' });
fs.closeSync(log);
const output = process.env.QA_OUTPUT_DIR || os.tmpdir();
fs.mkdirSync(output, { recursive: true });
let browser;
let page;

async function until(condition, label) {
  for (let i = 0; i < 120; i++) {
    if (await condition()) return;
    if (server.exitCode !== null) throw new Error(`Server exited during ${label}: ${fs.readFileSync(path.join(data, 'server.log'), 'utf8').slice(-2000)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(label);
}

async function request(method, endpoint, value) {
  return page.evaluate(async ({ method, endpoint, value }) => {
    const session = await (await fetch('/api/v1/session')).json();
    // Existing products are versioned like the browser runtime: send the current revision.
    const product = method !== 'PUT' && endpoint.match(/^\/api\/docs\/products\/([A-Za-z0-9_-]+)$/)?.[1];
    const revision = product ? (await (await fetch('/api/v1/catalog/products/' + product)).json()).revision : undefined;
    const response = await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf, ...(revision ? { 'If-Match': revision } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const body = await response.json();
    if (!response.ok) throw new Error(`Isolated ${method} ${endpoint}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  }, { method, endpoint, value });
}

async function seed() {
  const currentDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' });
  const products = [
    ['studio_current', { name: 'Контрольна кава', promotion: true, price: 60, promotionPrice: 45, priceAt: currentDate }],
    ['studio_other', { name: 'Контрольний чай', promotion: false, price: 25, priceAt: currentDate }],
    // No cost and no manual price: a valid record whose missing price stays visible.
    ['studio_missing', { name: 'Контрольний без ціни', promotion: false, manualPrice: false, price: null, priceAt: currentDate }],
    ['studio_stale', { name: 'Контрольний застарілий', promotion: false, price: 30, priceAt: currentDate }],
  ];
  for (const [id, product] of products) await request('PUT', `/api/docs/products/${id}`, { type: 'Напої', category: 'Контроль', pack: 'Штучно', unit: 'шт', cost: 0, markup: 30, manualPrice: true, ...product });
  // A new price is reviewed today; an old review date is a separate, metadata-only edit.
  await request('PATCH', '/api/docs/products/studio_stale', { priceAt: '2001-01-01' });
  // The API no longer creates badge-only promotions, so this historical record is stored directly.
  fixture(`from server.erp.models import Document\nDocument.objects.create(path='products/studio_badge',data={'name':'Контрольна акція без суми','type':'Напої','category':'Контроль','pack':'Штучно','unit':'шт','cost':0,'markup':30,'manualPrice':True,'price':30,'promotion':True,'priceAt':'${currentDate}'})`);
  await request('PATCH', '/api/docs/settings/main', {
    chainName: 'Контрольна мережа', storeNames: ['Контрольний магазин'], staleDays: 30,
    tag: { styleVersion: 2, size: 's', border: 'dash', chain: false, store: false, storeIdx: 0, name: true, nameBig: false, pack: false, psize: false, price: true, kop: false, unit: true, per100: false, category: false, date: false, custom: '', customEnabled: false, promo: true, styles: { price: { size: 22, font: 'rubik', color: '#1c1c1c', weight: '700', align: 'left' } } },
  });
}

async function checkNavigation() {
  const tabs = page.getByRole('tablist', { name: 'Етапи підготовки цінників' });
  const design = page.getByRole('tab', { name: 'Макет', exact: true });
  const products = page.getByRole('tab', { name: /^Товари для друку/ });
  const review = page.getByRole('tab', { name: 'Перевірка перед друком', exact: true });
  const before = await request('GET', '/api/v1/labels/workspace');
  await page.locator('.tk-studio-layer[data-label-field=price]').click();
  await page.getByLabel('Розмір, pt', { exact: true }).fill('24');
  await page.getByLabel('Розмір, pt', { exact: true }).press('Tab');
  await products.click();
  await page.getByRole('searchbox', { name: 'Пошук товарів' }).fill('Контрольна кава');
  const row = page.locator('.tk-studio-product-row').filter({ hasText: 'Контрольна кава' });
  await row.locator('.tk-studio-check').click();
  await page.getByLabel('Копій: Контрольна кава', { exact: true }).fill('3');
  await page.getByLabel('Копій: Контрольна кава', { exact: true }).press('Tab');
  await design.click();
  assert.equal(Number(await page.getByLabel('Розмір, pt', { exact: true }).inputValue()), 24);
  // Keyboard navigation shares the same controlled tabs and keeps the draft.
  await design.focus();
  await design.press('ArrowRight');
  await until(async () => await products.getAttribute('aria-selected') === 'true', 'keyboard product tab');
  assert.equal(await page.getByLabel('Копій: Контрольна кава', { exact: true }).inputValue(), '3');
  await products.press('ArrowRight');
  await page.getByRole('alert').filter({ hasText: /^Збережіть макет перед перевіркою друку\.$/ }).waitFor();
  assert.equal(await review.getAttribute('aria-selected'), 'true');
  await design.click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const geometry = await tabs.evaluate(bar => ({
      top: bar.getBoundingClientRect().top,
      studioTop: bar.closest('.tk-studio').getBoundingClientRect().top,
      items: [...bar.querySelectorAll('[role=tab]')].map(item => {
        const r = item.getBoundingClientRect();
        return { left: r.left, right: r.right, height: r.height };
      }),
      fits: document.documentElement.scrollWidth <= innerWidth,
    }));
    assert(Math.abs(geometry.top - geometry.studioTop) < 2, 'tabs begin directly below page heading');
    assert(geometry.fits, `no horizontal overflow at ${width}`);
    for (const item of geometry.items) assert(item.height >= 44 && item.left >= 0 && item.right <= width, `all tabs fit at ${width}`);
    await page.evaluate(() => window.scrollTo(0, 700));
    const pinned = await tabs.boundingBox();
    assert(pinned.y >= -1 && pinned.y < 3, `sticky navigation at ${width}`);
    await products.click();
    assert.equal(await page.getByRole('searchbox', { name: 'Пошук товарів' }).inputValue(), 'Контрольна кава');
    assert.equal(await page.getByLabel('Копій: Контрольна кава', { exact: true }).inputValue(), '3');
    const newTop = await tabs.boundingBox();
    assert(newTop.y >= -1, 'switch opens the beginning of the new work area');
    await design.click();
    assert.equal(Number(await page.getByLabel('Розмір, pt', { exact: true }).inputValue()), 24);
    await page.screenshot({ path: path.join(output, `tsukenya-label-tabs-${width}.png`) });
  }
  assert.deepEqual((await request('GET', '/api/v1/labels/workspace')).config, before.config, 'tab switches never save a draft');
  console.log('PASS: tabs placement, sticky scrolling, keyboard, draft/selection/filter preservation, 1440/390/320 layout.');
}

async function checkStudio() {
  const preview = page.getByRole('combobox', { name: 'Товар для перегляду', exact: true });
  const shownName = () => page.locator('.tk-studio-canvas .tk-label[data-product] [data-field=name]').innerText();
  const select = async (label, option) => {
    await page.getByText(label, { exact: true }).locator('..').locator('.tk-select-trigger').click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  const save = async () => {
    const response = page.waitForResponse(response => response.url().endsWith('/api/v1/labels/workspace') && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Зберегти макет', exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 200, 'layout save succeeded');
    await until(async () => await page.getByRole('button', { name: 'Зберегти макет', exact: true }).isDisabled(), 'saved layout status');
  };
  const workspace = () => request('GET', '/api/v1/labels/workspace');
  const setNumber = async (label, value) => {
    const input = page.getByLabel(label, { exact: true });
    await input.fill(String(value));
    await input.press('Tab');
  };
  const selectProduct = async name => {
    await page.getByRole('tab', { name: /^Товари/ }).click();
    await page.getByRole('searchbox', { name: 'Пошук товарів' }).fill(name);
    await page.getByRole('checkbox', { name, exact: true }).waitFor();
    await page.locator('.tk-studio-product-row').filter({ has: page.getByRole('checkbox', { name, exact: true }) }).locator('.tk-studio-check').click();
  };
  const review = async () => {
    const response = page.waitForResponse(response => response.url().endsWith('/api/v1/labels/prepare') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /^Перевірити \d+ цінників/ }).click();
    assert.equal((await response).status(), 200, 'authoritative print preparation');
    await page.getByRole('heading', { name: 'Переддруковий перегляд' }).waitFor();
    await until(async () => !(await page.getByText('Завантажуємо актуальні ціни та перевіряємо макет…', { exact: true }).count()), 'print validation finished');
  };

  // The search text is temporary: Escape and Tab must retain the committed preview.
  await preview.fill('Контрольна кава');
  await page.getByRole('option', { name: 'Контрольна кава', exact: true }).waitFor();
  await preview.press('ArrowDown');
  await preview.press('Enter');
  await until(async () => await shownName() === 'Контрольна кава', 'keyboard preview commit');
  const focusRing = await preview.evaluate(input => {
    const group = input.closest('.tk-combo-group');
    return { inner: getComputedStyle(input).outlineStyle, outer: getComputedStyle(group).outlineStyle, width: parseFloat(getComputedStyle(group).outlineWidth) };
  });
  assert.equal(focusRing.inner, 'none', 'legacy shell does not add an inner combobox focus ring');
  assert.equal(focusRing.outer, 'solid', 'compound combobox retains its accessible focus ring');
  assert(focusRing.width >= 3, 'visible outer combobox focus ring');
  assert.equal(await page.locator('.tk-studio-canvas [data-field=promo]').innerText(), 'Акція');
  assert.equal(await page.locator('.tk-studio-canvas [data-field=oldPrice]').innerText(), '60,00 грн');
  assert.equal(await page.locator('.tk-studio-canvas [data-field=oldPrice]').evaluate(field => getComputedStyle(field).textDecorationLine), 'line-through');
  await preview.fill('Невідомий тестовий товар');
  await preview.press('Escape');
  assert.equal(await shownName(), 'Контрольна кава', 'Escape retained committed product');
  await preview.fill('Інший невідомий товар');
  await preview.press('Tab');
  assert.equal(await shownName(), 'Контрольна кава', 'Tab retained committed product');

  await page.locator('.tk-studio-layer[data-label-field=price]').click();
  await setNumber('Розмір, pt', 24);
  await select('Шрифт', 'Georgia');
  await page.getByLabel('Колір', { exact: true }).evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '#123456');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await select('Вирівнювання', 'По центру');
  await save();
  let saved = await workspace();
  assert.deepEqual({ size: saved.config.styles.price.size, font: saved.config.styles.price.font, color: saved.config.styles.price.color, align: saved.config.styles.price.align }, { size: 24, font: 'georgia', color: '#123456', align: 'center' });
  assert.equal(saved.config.styleVersion, 2);
  await page.reload();
  await page.locator('.tk-studio').waitFor();
  await page.locator('.tk-studio-layer[data-label-field=price]').click();
  assert.equal(Number(await page.getByLabel('Розмір, pt', { exact: true }).inputValue()), 24, 'physical point size survived reload');
  await page.locator('.tk-studio-layer[data-label-field=name]').click();
  await setNumber('Розмір, pt', 11);
  assert.equal((await workspace()).config.styles.price.size, 24, 'independent field draft leaves saved price intact');

  // A dirty route change can be cancelled, and a competing owner edit cannot overwrite a draft.
  const cancelRoute = new Promise(resolve => page.once('dialog', async dialog => {
    assert.match(dialog.message(), /незбережен|Відкинути/i);
    await dialog.dismiss();
    resolve();
  }));
  await page.locator('.tab[data-tab=products]').click();
  await cancelRoute;
  await until(async () => /#operations\/tags$/.test(page.url()), 'cancelled route restored label Studio');
  assert.match(page.url(), /#operations\/tags$/);
  assert.equal(Number(await page.getByLabel('Розмір, pt', { exact: true }).inputValue()), 11);
  const dataNow = await request('GET', '/api/state');
  const competingTag = structuredClone(dataNow.data['settings/main'].tag);
  competingTag.styles.price.size = 26;
  await request('PATCH', '/api/docs/settings/main', { tag: competingTag });
  const conflictResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/labels/workspace') && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Зберегти макет', exact: true }).click();
  assert.equal((await conflictResponse).status(), 409);
  await page.getByRole('button', { name: 'Завантажити збережений макет' }).waitFor();
  assert.equal(Number(await page.getByLabel('Розмір, pt', { exact: true }).inputValue()), 11, '409 retained local draft');
  page.once('dialog', async dialog => { assert.match(dialog.message(), /Відкинути|чернет|незбережен/i); await dialog.accept(); });
  await page.getByRole('button', { name: 'Завантажити збережений макет' }).click();
  await page.locator('.tk-studio-layer[data-label-field=price]').click();
  await until(async () => Number(await page.getByLabel('Розмір, pt', { exact: true }).inputValue()) === 26, 'explicit reload received competing layout');

  await selectProduct('Контрольна кава');
  await setNumber('Копій: Контрольна кава', 22);
  await review();
  const pages = page.locator('.tk-studio-proof .tk-label-print-page');
  await until(async () => await pages.count() === 1, 'interactive preview mounts only the current A4');
  assert.equal(await pages.locator('.tk-label[data-product]').count(), 21);
  assert(await page.getByText(/Аркуш 1 із 2 · усі 22 цінників увійдуть у PDF та друк/).isVisible(), 'all22copies retained for two output pages');
  assert.equal(await page.getByRole('button', { name: 'Завантажити PDF', exact: true }).isEnabled(), true);
  const geometry = await pages.first().evaluate(sheet => {
    const tag = sheet.querySelector('.tk-label[data-product]');
    const computed = getComputedStyle(sheet), label = getComputedStyle(tag);
    return { pageWidth: parseFloat(computed.width), pageHeight: parseFloat(computed.height), margin: parseFloat(computed.paddingTop), width: parseFloat(label.width), height: parseFloat(label.height), font: getComputedStyle(tag.querySelector('[data-field=price]')).fontSize };
  });
  for (const [key, mm] of [['pageWidth', 210], ['pageHeight', 297], ['margin', 8], ['width', 58], ['height', 40]]) assert(Math.abs(geometry[key] - mm * 96 / 25.4) < 0.25, `${key}: physical mm size ${geometry[key]}`);
  assert(Math.abs(parseFloat(geometry.font) - 26 * 96 / 72) < 0.1, 'review uses configured physical points');
  await page.screenshot({ path: path.join(output, 'tsukenya-label-studio-review.png') });
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Завантажити PDF', exact: true }).click();
  const pdf = path.join(output, 'tsukenya-react-labels-qa.pdf');
  await (await downloaded).saveAs(pdf);
  assert(fs.readFileSync(pdf).subarray(0, 8).toString().startsWith('%PDF-1.4'), 'valid PDF header');
  try {
    const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
    assert.match(info, /Pages:\s+2/);
    assert.match(info, /Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/);
    console.log('PDF A4/two-page verified:', pdf);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('pdfinfo unavailable; PDF header and physical DOM dimensions verified:', pdf);
  }

  // A price changed after review must invalidate that review before any download.
  await request('PATCH', '/api/docs/products/studio_current', { promotionPrice: 46 });
  let unexpectedDownloads = 0;
  const onDownload = () => unexpectedDownloads++;
  page.on('download', onDownload);
  await page.getByRole('button', { name: 'Завантажити PDF', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Ціни або макет змінилися' }).waitFor();
  assert.equal(unexpectedDownloads, 0, 'stale snapshot cannot download');
  page.off('download', onDownload);
  await page.getByRole('button', { name: 'Оновити перевірку' }).click();
  await until(async () => await page.getByRole('button', { name: 'Завантажити PDF', exact: true }).isEnabled(), 'explicit review refresh allows current prices');

  // Browser printing receives the same physical pages and hides the editor chrome.
  await page.evaluate(() => { window.print = () => { window.__labelPrintOpened = true; }; });
  await page.getByRole('button', { name: 'Друкувати', exact: true }).click();
  await until(async () => await page.evaluate(() => window.__labelPrintOpened === true), 'native print invoked');
  assert.equal(await page.locator('#printArea .tk-label-print-page').count(), 2);
  assert.equal(await page.locator('#printArea .tk-label[data-product]').count(), 22);
  await page.emulateMedia({ media: 'print' });
  assert(await page.locator('#printArea').isVisible(), 'print area visible in print media');
  assert.equal(await page.locator('.tk-studio').isVisible(), false, 'studio controls hidden during print');
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  assert.equal(await page.locator('#printArea').count(), 0, 'print area cleaned after print');

  // Price size 72 must be rejected by the same renderer used to create the PDF.
  await page.getByRole('tab', { name: 'Макет', exact: true }).click();
  await page.locator('.tk-studio-layer[data-label-field=price]').click();
  await setNumber('Розмір, pt', 72);
  await save();
  await page.getByRole('tab', { name: /^Товари/ }).click();
  await review();
  await until(async () => await page.getByRole('button', { name: 'Завантажити PDF', exact: true }).isDisabled(), 'clipped label blocks PDF');
  assert.match(await page.locator('.tk-studio-proof').locator('..').innerText(), /вміщу|обріз|меж/i);
  await page.getByRole('tab', { name: 'Макет', exact: true }).click();
  await setNumber('Розмір, pt', 22);
  await save();

  await page.getByRole('tab', { name: /^Товари/ }).click();
  await page.getByRole('button', { name: 'Очистити вибір' }).click();
  await selectProduct('Контрольний без ціни');
  await review();
  await page.getByRole('alert').waitFor();
  assert(await page.getByRole('button', { name: 'Завантажити PDF', exact: true }).isDisabled());
  assert.match(await page.getByRole('alert').innerText(), /ціни|ціну/);
  await page.getByRole('tab', { name: /^Товари/ }).click();
  await page.getByRole('button', { name: 'Очистити вибір' }).click();
  await selectProduct('Контрольна акція без суми');
  await review();
  await page.getByRole('alert').filter({ hasText: 'Акція без окремої акційної ціни' }).waitFor();
  assert(await page.getByRole('button', { name: 'Завантажити PDF', exact: true }).isDisabled(), 'legacy badge without discount blocks ambiguous print');
  await page.getByRole('tab', { name: /^Товари/ }).click();
  await page.getByRole('button', { name: 'Очистити вибір' }).click();
  await selectProduct('Контрольний застарілий');
  await review();
  await page.getByRole('checkbox', { name: 'Ціни перевірено, можна друкувати' }).waitFor();
  assert(await page.getByRole('button', { name: 'Завантажити PDF', exact: true }).isDisabled());
  await page.getByText('Ціни перевірено, можна друкувати', { exact: true }).click();
  await until(async () => await page.getByRole('button', { name: 'Завантажити PDF', exact: true }).isEnabled(), 'stale price requires acknowledgement');
  await page.getByRole('tab', { name: /^Товари/ }).click();
  await review();
  assert.equal(await page.getByRole('checkbox', { name: 'Ціни перевірено, можна друкувати' }).isChecked(), false, 'new preparation resets stale-price acknowledgement');

  await page.getByRole('tab', { name: 'Макет', exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `studio overflow at ${width}`);
    await page.screenshot({ path: path.join(output, `tsukenya-label-studio-${width}.png`), fullPage: true });
  }
  await select('Елемент цінника', 'Ціна');
  assert.equal(await page.locator('.tk-studio-properties h3').innerText(), 'Ціна', 'mobile field picker selects inspector');
}

(async () => {
  await until(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 'isolated label server startup');
  const type = process.env.QA_BROWSER === 'webkit' ? webkit : chromium;
  browser = await type.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await require('./browser-login.cjs')(page, base, password);
  await seed();
  await page.goto(base + '/#operations/tags');
  await page.locator('.tk-studio').waitFor();
  assert(await page.evaluate(() => !!window.ReactLabels), 'React label module loaded');
  if (process.env.QA_NAV_ONLY === '1') await checkNavigation();
  else await checkStudio();
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('PASS: isolated Label Studio feature checks.');
})().catch(async error => {
  if (page) await page.screenshot({ path: path.join(output, 'tsukenya-label-studio-failure.png'), fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 3000);
      server.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
  fs.rmSync(data, { recursive: true, force: true });
});
