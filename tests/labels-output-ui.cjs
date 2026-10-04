/* Output cancellation against local Django/SQLite only; all products are synthetic. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const from = process.env.QA_OUTPUT_FROM || 'all';
assert(['all', 'tail', 'zoom'].includes(from), 'QA_OUTPUT_FROM must be all, tail or zoom');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-label-output-db-'));
const output = process.env.QA_OUTPUT_DIR || path.join(os.tmpdir(), 'tsukenya-label-output-qa');
fs.mkdirSync(output, { recursive: true });
const python = process.env.PYTHON_BIN || 'python3';
const port = 18223;
const base = `http://localhost:${port}`;
const password = 'isolated-label-output-password';
const hash = execFileSync(python, ['-c', 'from server.auth import hash_password; print(hash_password("isolated-label-output-password"))'], { cwd: root, encoding: 'utf8' }).trim();
const env = { ...process.env, DATA_DIR: data, ERP_DB_PATH: path.join(data, 'crm.sqlite3'), PORT: String(port), HOST: '127.0.0.1', OWNER_USERNAME: 'tester', OWNER_PASSWORD_HASH: hash };
for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) delete env[key];
const log = fs.openSync(path.join(data, 'server.log'), 'a');
const server = spawn(python, ['-m', 'server.main'], { cwd: root, env, stdio: ['ignore', log, log] });
fs.closeSync(log);
let browser, page, zoomContext, zoomProfile;
const results = { scope: from, screenshots: [], checks: [], pdf: null };
const errors = [];
let downloads = 0;

async function until(condition, label) {
  for (let i = 0; i < 120; i++) {
    if (await condition()) return;
    if (server.exitCode !== null) throw new Error(`Server exited during ${label}: ${fs.readFileSync(path.join(data, 'server.log'), 'utf8').slice(-2000)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(label);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
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
  const priceAt = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' });
  await request('PUT', '/api/docs/products/output_coffee', { name: 'Контрольна кава для виводу', type: 'Напої', category: 'Контроль', pack: 'Штучно', unit: 'шт', cost: 0, markup: 30, manualPrice: true, promotion: false, price: 45, priceAt });
  await request('PATCH', '/api/docs/settings/main', {
    chainName: 'Контрольна мережа', storeNames: ['Контрольний магазин'], staleDays: 30,
    tag: { styleVersion: 2, size: 's', border: 'dash', chain: false, store: false, storeIdx: 0, name: true, nameBig: false, pack: false, psize: false, price: true, kop: false, unit: true, per100: false, category: false, date: false, custom: '', customEnabled: false, promo: true, styles: { price: { size: 22, font: 'rubik', color: '#1c1c1c', weight: '700', align: 'left' } } },
  });
}
async function installGates(target) {
  await target.addInitScript(() => {
    const encode = HTMLCanvasElement.prototype.toBlob;
    window.__outputGate = { holdEncode: false, encoding: null, holdFonts: false, fontResolvers: [], printCalls: 0 };
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      const canvas = this;
      encode.call(this, blob => {
        if (window.__outputGate.holdEncode) window.__outputGate.encoding = { canvas, callback, blob };
        else callback(blob);
      }, type, quality);
    };
    const load = document.fonts.load.bind(document.fonts);
    document.fonts.load = (...args) => {
      const work = load(...args);
      if (!window.__outputGate.holdFonts) return work;
      return new Promise(resolve => window.__outputGate.fontResolvers.push(() => work.then(resolve)));
    };
    window.print = () => { window.__outputGate.printCalls++; };
  });
}
const pdfButton = () => page.getByRole('button', { name: 'Завантажити PDF', exact: true });
const cancelButton = () => page.getByRole('button', { name: 'Скасувати підготовку', exact: true });
async function assertFocus(locator, label) {
  await until(async () => await locator.evaluate(element => document.activeElement === element), label);
}
async function cleanOutput() {
  assert.equal(await page.locator('#printArea').count(), 0, 'print root cleaned');
  assert.equal(await page.evaluate(() => [...document.body.children].filter(element => element.style.left === '-10000px').length), 0, 'hidden output root cleaned');
}
async function proofStillValid() {
  assert.equal(await page.locator('.tk-studio-proof .tk-label-print-page').count(), 1, 'interactive proof mounts one A4');
  const visible = await page.locator('.tk-studio-proof .tk-label[data-product]').count();
  assert(visible > 0 && visible <= 21, 'visible page contains at most its physical capacity');
  assert(await page.getByText(/усі 22 цінників увійдуть у PDF та друк/).isVisible(), 'full selection is retained independently from displayed page');
  assert(await pdfButton().isEnabled(), 'cancel retains usable proof');
}
async function reviewSelection() {
  await page.getByRole('tab', { name: /^Товари для друку/ }).click();
  const quantity = page.getByLabel('Копій: Контрольна кава для виводу', { exact: true });
  await quantity.waitFor();
  assert.equal(await quantity.inputValue(), '22', 'selection and copies retained');
  const response = page.waitForResponse(value => value.url().endsWith('/api/v1/labels/prepare') && value.request().method() === 'POST');
  await page.getByRole('button', { name: /^Перевірити 22 цінників/ }).click();
  assert.equal((await response).status(), 200);
  await until(async () => await pdfButton().isEnabled(), 'proof ready');
  await proofStillValid();
}
async function initialSelection() {
  await page.getByRole('tab', { name: /^Товари для друку/ }).click();
  await page.getByRole('searchbox', { name: 'Пошук товарів' }).fill('Контрольна кава для виводу');
  await page.getByRole('checkbox', { name: 'Контрольна кава для виводу', exact: true }).waitFor();
  await page.locator('.tk-studio-product-row').filter({ hasText: 'Контрольна кава для виводу' }).locator('.tk-studio-check').click();
  const quantity = page.getByLabel('Копій: Контрольна кава для виводу', { exact: true });
  await quantity.fill('22');
  await quantity.press('Tab');
  await reviewSelection();
}
async function releaseEncoding() {
  await page.evaluate(() => {
    const gate = window.__outputGate;
    gate.holdEncode = false;
    const pending = gate.encoding;
    gate.encoding = null;
    if (pending) pending.callback(pending.blob);
  });
  // Explicit browser task barrier after delivery of the late encoding result.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function encodingPending() {
  await page.evaluate(() => { window.__outputGate.holdEncode = true; window.__outputGate.encoding = null; });
  await pdfButton().click();
  await page.waitForFunction(() => !!window.__outputGate.encoding);
  await page.getByRole('progressbar', { name: 'Підготовка PDF', exact: true }).waitFor();
  await assertFocus(cancelButton(), 'cancel focused during output');
}
async function cancelled(origin = pdfButton()) {
  await page.getByRole('status').filter({ hasText: 'Підготовку скасовано.' }).waitFor();
  await until(async () => !(await page.locator('.tk-studio-output').count()), 'progress cleared');
  await cleanOutput();
  await assertFocus(origin, 'focus returned to initiating output button');
}
async function cancelPrepare() {
  const seen = deferred(), release = deferred(), settled = deferred();
  let aborted = false;
  const onFailed = request => { if (request.url().endsWith('/api/v1/labels/prepare')) aborted = true; };
  page.on('requestfailed', onFailed);
  await page.route('**/api/v1/labels/prepare', async route => {
    const response = await route.fetch();
    seen.resolve();
    await release.promise;
    try { await route.fulfill({ response }); } catch (error) {
      if (!aborted) throw error;
    } finally { settled.resolve(); }
  });
  const before = downloads;
  try {
    await pdfButton().click();
    await seen.promise;
    await assertFocus(cancelButton(), 'cancel focused while authoritative prepare is pending');
    assert.equal(await page.getByRole('progressbar', { name: 'Підготовка PDF', exact: true }).getAttribute('value'), null, 'verification progress is indeterminate');
    await page.keyboard.press('Enter');
    await cancelled();
    await until(async () => aborted, 'prepare fetch aborted');
    release.resolve();
    await settled.promise;
    await proofStillValid();
    assert.equal(downloads, before, 'late prepare response never downloads');
    results.checks.push('POST prepare cancellation by keyboard, aborted request, late response, proof and focus retained');
  } finally {
    release.resolve();
    await page.unroute('**/api/v1/labels/prepare');
    page.off('requestfailed', onFailed);
  }
}
async function layoutAndEncodingCancel(width, label = String(width)) {
  if (width) await page.setViewportSize({ width, height: 1000 });
  const before = downloads;
  await encodingPending();
  const geometry = await page.locator('.tk-studio-output').evaluate(panel => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const button = panel.querySelector('button');
    const progress = panel.querySelector('progress');
    const gate = window.__outputGate;
    return { viewport: innerWidth, viewportHeight: innerHeight, stickyBottom: panel.closest('.tk-studio').querySelector('[role=tablist]').getBoundingClientRect().bottom, fits: document.documentElement.scrollWidth <= innerWidth + 1, panel: rect(panel), button: rect(button), progress: rect(progress), focused: document.activeElement === button, value: progress.value, max: progress.max, canvas: [gate.encoding.canvas.width, gate.encoding.canvas.height] };
  });
  assert(geometry.fits, `page fits at ${label}`);
  for (const key of ['panel', 'button', 'progress']) assert(geometry[key].left >= -1 && geometry[key].right <= geometry.viewport + 1, `${key} fits at ${label}`);
  assert(geometry.button.width >= 44 && geometry.button.height >= 44, `cancel touch target at ${label}`);
  assert(geometry.focused, `cancel focus at ${label}`);
  assert(geometry.button.top >= Math.max(0, geometry.stickyBottom) + 4, `cancel and focus ring below sticky tabs at ${label}`);
  assert(geometry.button.bottom + 4 <= geometry.viewportHeight, `complete cancel focus ring visible above viewport bottom at ${label}: ${geometry.button.bottom} + 4 <= ${geometry.viewportHeight}`);
  assert.equal(geometry.max, 2, 'two-page PDF progress maximum');
  assert.equal(geometry.value, 0, 'encoding first page progress');
  assert.deepEqual(geometry.canvas, [2480, 3508], '300 dpi A4 encoding');
  const screenshot = path.join(output, `tsukenya-label-output-${label}.png`);
  if (label === 'zoom-200') {
    const cdp = await zoomContext.newCDPSession(page);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
    await cdp.detach();
  } else await page.screenshot({ path: screenshot });
  results.screenshots.push(screenshot);
  await page.keyboard.press('Enter');
  await cancelled();
  assert.deepEqual(await page.evaluate(() => [window.__outputGate.encoding.canvas.width, window.__outputGate.encoding.canvas.height]), [0, 0], 'cancel releases canvas pixels');
  await releaseEncoding();
  await proofStillValid();
  assert.equal(downloads, before, 'late toBlob result cannot download');
  results.checks.push(`Pending encoding cancellation, 44px/focus/progress geometry and cleanup at ${label}`);
}
async function retryPdf() {
  const downloaded = page.waitForEvent('download');
  await pdfButton().click();
  const pdf = path.join(output, 'tsukenya-output-retry-2page.pdf');
  await (await downloaded).saveAs(pdf);
  await page.getByRole('status').filter({ hasText: 'PDF сформовано.' }).waitFor();
  await assertFocus(pdfButton(), 'PDF success focus return');
  await cleanOutput();
  await proofStillValid();
  const bytes = fs.readFileSync(pdf);
  assert(bytes.subarray(0, 8).toString().startsWith('%PDF-1.4'));
  const text = bytes.toString('latin1');
  assert.equal((text.match(/\/Type \/Page \/Parent/g) || []).length, 2);
  assert.equal((text.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g) || []).length, 2, 'both PDF pages are A4 points');
  const images = [...text.matchAll(/\/Subtype \/Image \/Width 2480 \/Height 3508 [^\n]+?\/Length (\d+) >>\nstream\n/g)];
  assert.equal(images.length, 2, 'both embedded JPEG pages are 300 dpi A4');
  const jpegData = images.map(match => bytes.subarray(match.index + match[0].length, match.index + match[0].length + Number(match[1])).toString('base64'));
  // Decode the actual PDF images in the existing browser, independently of Poppler and image previews.
  const pixels = await page.evaluate(async sources => {
    const imagePixels = await Promise.all(sources.map(async source => {
      const image = new Image();
      image.src = 'data:image/jpeg;base64,' + source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(105, 105, 655, 445).data;
      const dark = (top, bottom) => {
        let count = 0;
        for (let y = top - 105; y < bottom - 105; y++) for (let x = 0; x < 655; x++) {
          const offset = (y * 655 + x) * 4;
          if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 120) count++;
        }
        return count;
      };
      const fields = { name: dark(130, 190), price: dark(390, 480), unit: dark(495, 540) };
      canvas.width = canvas.height = 0;
      return { pixels, fields };
    }));
    let differing = 0;
    for (let i = 0; i < imagePixels[0].pixels.length; i++) if (imagePixels[0].pixels[i] !== imagePixels[1].pixels[i]) differing++;
    return { differingChannels: differing, fields: imagePixels.map(image => image.fields) };
  }, jpegData);
  assert.equal(pixels.differingChannels, 0, 'complete repeated label is pixel-identical on page two');
  for (const fields of pixels.fields) for (const field of ['name', 'price', 'unit']) assert(fields[field] > 10, `${field} renders on both PDF pages`);
  results.pdf = { path: pdf, bytes: bytes.length, pages: 2, dpi: 300, pixels };
  try {
    const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
    assert.match(info, /Pages:\s+2/);
    assert.match(info, /Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/);
    fs.writeFileSync(path.join(output, 'tsukenya-output-pdfinfo.txt'), info);
    execFileSync('pdftoppm', ['-f', '1', '-l', '2', '-r', '100', '-png', pdf, path.join(output, 'tsukenya-output-page')]);
    results.pdf.visual = 'Poppler rendered both pages; inspect PNGs';
    results.pdf.rendered = [path.join(output, 'tsukenya-output-page-1.png'), path.join(output, 'tsukenya-output-page-2.png')];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    results.pdf.visual = 'Skipped Poppler rendering: pdfinfo or pdftoppm unavailable; embedded JPEG pixel and physical geometry checks passed';
  }
  results.checks.push('Retry after cancellation downloads a physical two-page A4 PDF and returns focus');
}
async function routeDuringEncoding() {
  const before = downloads;
  await encodingPending();
  await page.locator('.tab[data-tab=products]').click();
  await page.locator('.tk-catalog').waitFor();
  await cleanOutput();
  await releaseEncoding();
  assert.equal(downloads, before, 'unmounted output never downloads a late encoder result');
  await page.goto(base + '/#operations/tags');
  await page.locator('.tk-studio').waitFor();
  await reviewSelection();
  results.checks.push('Route unmount aborts encoding, cleans output and preserves selection for a fresh proof');
}
async function changedSnapshot() {
  const before = downloads;
  await request('PATCH', '/api/docs/products/output_coffee', { price: 46 });
  await pdfButton().click();
  await page.getByRole('alert').filter({ hasText: 'Ціни або макет змінилися після перегляду' }).waitFor();
  assert.equal(downloads, before, 'changed snapshot cannot export');
  assert(await pdfButton().isDisabled());
  const refresh = page.getByRole('button', { name: 'Оновити перевірку', exact: true });
  await assertFocus(refresh, 'invalid proof returns focus to refresh');
  await refresh.click();
  await until(async () => await pdfButton().isEnabled(), 'fresh proof after changed price');
  results.checks.push('Authoritative price change invalidates proof and blocks export until refreshed');
}
async function printAndCsv() {
  const print = page.getByRole('button', { name: 'Друкувати', exact: true });
  await page.evaluate(() => { window.__outputGate.holdFonts = true; });
  await print.click();
  await page.waitForFunction(() => window.__outputGate.fontResolvers.length > 0);
  await assertFocus(cancelButton(), 'print preparation cancel focus');
  await page.keyboard.press('Enter');
  await cancelled(print);
  assert.equal(await page.evaluate(() => window.__outputGate.printCalls), 0, 'cancelled print preparation does not open native dialog');
  await page.evaluate(() => { window.__outputGate.holdFonts = false; window.__outputGate.fontResolvers.splice(0).forEach(resolve => resolve()); });
  await cleanOutput();
  await print.click();
  await until(async () => await page.evaluate(() => window.__outputGate.printCalls === 1), 'print retry invoked');
  await assertFocus(print, 'print success focus return');
  assert.equal(await page.locator('#printArea .tk-label-print-page').count(), 2);
  assert.equal(await page.locator('#printArea .tk-label').count(), 22);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await cleanOutput();
  const csv = page.getByRole('button', { name: 'Експорт CSV', exact: true });
  const downloaded = page.waitForEvent('download');
  await csv.click();
  await (await downloaded).saveAs(path.join(output, 'tsukenya-output-qa.csv'));
  await assertFocus(csv, 'CSV success focus return');
  results.checks.push('Native print preparation cancellation, successful print retry/afterprint cleanup and CSV focus return');
}
async function actualZoom() {
  const mainPage = page;
  zoomProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-output-zoom-'));
  fs.mkdirSync(path.join(zoomProfile, 'Default'));
  fs.writeFileSync(path.join(zoomProfile, 'Default', 'Preferences'), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } } }));
  zoomContext = await chromium.launchPersistentContext(zoomProfile, { executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, viewport: null, args: ['--window-size=1440,1000'] });
  page = zoomContext.pages()[0];
  page.setDefaultTimeout(12000);
  await installGates(page);
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', () => downloads++);
  await require('./browser-login.cjs')(page, base, password);
  assert.equal(await page.evaluate(() => devicePixelRatio), 2, 'actual browser zoom 200%');
  assert.equal(await page.evaluate(() => innerWidth), 720);
  await page.goto(base + '/#operations/tags');
  await page.locator('.tk-studio').waitFor();
  await initialSelection();
  await layoutAndEncodingCancel(null, 'zoom-200');
  await zoomContext.close();
  zoomContext = null;
  fs.rmSync(zoomProfile, { recursive: true, force: true });
  zoomProfile = null;
  page = mainPage;
}
(async () => {
  await until(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 'isolated output server startup');
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12000);
  await installGates(page);
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', () => downloads++);
  await require('./browser-login.cjs')(page, base, password);
  await seed();
  await page.goto(base + '/#operations/tags');
  await page.locator('.tk-studio').waitFor();
  assert(await page.evaluate(() => !!window.ReactLabels), 'production React bundle loaded');
  if (from !== 'zoom') {
    await initialSelection();
    if (from === 'all') {
      await cancelPrepare();
      for (const width of [1440, 390, 320]) await layoutAndEncodingCancel(width);
    }
    await page.setViewportSize({ width: 320, height: 1000 });
    const nextPage = page.getByRole('button', { name: 'Наступний аркуш', exact: true });
    await nextPage.focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('.tk-studio-proof .tk-label-print-page').getAttribute('data-page'), '2');
    assert.equal(await page.locator('.tk-studio-proof .tk-label[data-product]').count(), 1);
    const previewPage = page.getByRole('combobox', { name: 'Аркуш для перегляду' });
    await previewPage.fill('1');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await until(async () => await page.locator('.tk-studio-proof .tk-label-print-page').getAttribute('data-page') === '1', 'keyboard page jump');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'preview navigation fits native320');
    await page.screenshot({ path: path.join(output, 'tsukenya-page-preview-320.png') });
    results.checks.push('Native320 keyboard page navigation retains all22copies with only one A4 mounted');
    await retryPdf();
    if (from === 'all') {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await routeDuringEncoding();
      await changedSnapshot();
      await printAndCsv();
    }
  }
  if (process.platform === 'darwin') await actualZoom();
  assert.deepEqual(errors, [], 'browser runtime errors');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(output, `results-${from}.json`), JSON.stringify(results, null, 2));
  console.log(from === 'all' ? 'PASS: isolated Studio output cancellation, late responses/encoding, route cleanup, proof invalidation, keyboard focus, narrow progress layout, print/CSV and 2-page A4 PDF.' : from === 'zoom' ? 'PASS: targeted actual 200% progress layout and complete cancel focus ring visibility.' : 'PASS: targeted PDF pixel/geometry verification and actual 200% progress screenshot.');
  console.log(JSON.stringify(results, null, 2));
})().catch(async error => {
  if (page) await page.screenshot({ path: path.join(output, 'tsukenya-label-output-failure.png'), fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (zoomContext) await zoomContext.close();
  if (zoomProfile) fs.rmSync(zoomProfile, { recursive: true, force: true });
  await browser?.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => { const timer = setTimeout(resolve, 3000); server.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
  if (process.exitCode) fs.copyFileSync(path.join(data, 'server.log'), path.join(output, 'server.log'));
  fs.rmSync(data, { recursive: true, force: true });
});
