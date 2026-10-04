/* Actual document editors; synthetic SQLite fixtures, no document saves or postings. */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), python = process.env.PYTHON_BIN || 'python3';
const cases = ['receipt', 'sale', 'inventory', 'supplier_return'], only = process.env.QA_LINE_LAYOUT_ONLY?.split(',') || cases;
assert(only.length && only.every(kind => cases.includes(kind)), 'Unknown QA_LINE_LAYOUT_ONLY');
const widths = process.env.QA_LINE_LAYOUT_WIDTHS?.split(',').map(Number) || [1440, 768, 320], geometryOnly = !widths.includes(1440);
assert(widths.length && widths.every(width => [1440, 768, 320].includes(width)), 'Unknown QA_LINE_LAYOUT_WIDTHS');
const port = Number(process.env.QA_LINE_LAYOUT_PORT || 18639);
assert(Number.isInteger(port) && port > 1024 && port < 65536, 'Invalid isolated port');
const proof = process.env.LINE_LAYOUT_PROOF_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-line-layout-proof-'));
fs.mkdirSync(proof, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-line-layout-data-')), base = `http://localhost:${port}`, password = 'isolated-line-layout-password';
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(?:DB_|PG|DATABASE_URL$|POSTGRES_URL$|OWNER_PASSWORD|DJANGO_SETTINGS_MODULE$|DJANGO_SECRET_KEY$|TSUKENYA_REQUIRE_POSTGRES$)/.test(key)) delete env[key];
Object.assign(env, { HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, ERP_DB_PATH: path.join(data, 'isolated.sqlite3'), OWNER_USERNAME: 'tester', DJANGO_SETTINGS_MODULE: 'server.settings', DJANGO_SECRET_KEY: 'isolated-line-layout-secret-not-production-at-least-fifty-characters' });
env.OWNER_PASSWORD_HASH = execFileSync(python, ['-c', `from server.auth import hash_password;print(hash_password('${password}'))`], { cwd: root, env, encoding: 'utf8' }).trim();
const log = fs.openSync(path.join(proof, 'server.log'), 'w'), server = spawn(python, ['-m', 'server.main'], { cwd: root, env, stdio: ['ignore', log, log] });
let browser, page, before, passed = false;
const errors = [], writes = [], measurements = [], artifacts = [], checks = [];
const fixture = code => execFileSync(python, ['-c', `import django;django.setup()\n${code}`], { cwd: root, env, encoding: 'utf8' }).trim();
const ledger = () => fixture("import json\nfrom server.erp.models import Voucher,VoucherLine,StockEntry,CashEntry\nprint(json.dumps({'vouchers':list(Voucher.objects.order_by('pk').values('pk','status','revision','total')),'lines':list(VoucherLine.objects.order_by('pk').values('pk','quantity','price','amount')),'stock':StockEntry.objects.count(),'cash':CashEntry.objects.count()},default=str))");
async function wait(check, label) { for (let n = 0; n < 250; n++) { if (server.exitCode !== null || server.signalCode !== null) throw Error('Isolated server exited: ' + label); if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Timed out: ' + label); }
const dialog = () => page.locator('.trade-dialog[open]'), rows = () => dialog().locator('.trade-line');
async function close() { if (await dialog().count()) { await dialog().locator('[data-trade=close]').click(); await dialog().waitFor({ state: 'hidden' }); } }
async function inspect(kind, width, state, screenshot = false) {
  await rows().first().scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${kind}/${width} page overflow`);
  assert(await dialog().evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${kind}/${width} dialog overflow`);
  const geometry = await rows().evaluateAll(nodes => nodes.map(node => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const fields = [...node.querySelectorAll(':scope > .line-field')].filter(field => field.getBoundingClientRect().height > 0).map(field => {
      const control = field.querySelector('.tk-combo-group') || field.querySelector('input:not([type=hidden]),[data-trade=remove-line]');
      const caption = field.querySelector('.tk-label,:scope > span');
      return { name: field.className, field: rect(field), control: control ? rect(control) : null, caption: caption ? rect(caption) : null, value: control?.value ?? control?.querySelector('input')?.value ?? null };
    });
    const origin = node.querySelector('.line-origin');
    return { row: rect(node), fields, origin: origin ? rect(origin) : null, overflow: node.scrollWidth > node.clientWidth + 1 };
  }));
  for (const row of geometry) {
    assert(!row.overflow, `${kind}/${width} row overflow`);
    assert.equal(row.fields.length, kind === 'sale' ? 4 : 6, 'Visible named fields');
    for (const field of row.fields) {
      assert(field.control, 'Each field has an actual control: ' + field.name);
      assert(field.control.height >= 44 && field.control.width >= 44, 'Control touch size: ' + JSON.stringify(field));
      assert(field.control.x >= row.row.x - 1 && field.control.right <= row.row.right + 1, 'Control contained by row');
      if (row.origin) assert(field.control.y >= row.origin.bottom, 'Reference origin precedes controls');
      const sameRow = row.fields.filter(peer => Math.abs(peer.field.y - field.field.y) <= 1);
      assert(sameRow.every(peer => Math.abs(peer.control.y - field.control.y) <= 1), 'Same grid row control alignment: ' + JSON.stringify(row));
    }
    if (width === 1440) assert(row.fields.every(field => Math.abs(field.control.y - row.fields[0].control.y) <= 1), 'All desktop controls aligned: ' + JSON.stringify(row));
    if (width <= 900) {
      const field = name => row.fields.find(item => item.name.split(' ').includes('line-' + name));
      assert(field('quantity').caption.y - field('product').control.bottom >= 11, 'Mobile quantity group spacing: ' + JSON.stringify(row));
      if (kind !== 'sale') {
        const lower = width <= 600 ? 'lot' : 'expiry';
        assert(field(lower).caption.y - field('quantity').control.bottom >= 11, 'Mobile lower group spacing: ' + JSON.stringify(row));
      }
      if (width <= 600) for (const name of ['price', ...(kind === 'sale' ? [] : ['expiry'])]) assert(field(name).control.width >= 130, 'Readable mobile ' + name + ' width: ' + JSON.stringify(row));
    }
  }
  if (state === 'selected-and-empty') {
    assert.equal(geometry[0].fields.find(field => field.name.split(' ').includes('line-price')).value, '12.3456', 'Four-decimal price remains intact');
    if (kind !== 'sale') assert.equal(geometry[0].fields.find(field => field.name.split(' ').includes('line-expiry')).value, '2026-12-31', 'Full synthetic date remains intact');
  }
  const actions = dialog().locator('.trade-line-actions'), buttons = actions.locator('button');
  const rects = await buttons.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }));
  assert.equal(rects.length, ['receipt', 'inventory'].includes(kind) ? 3 : 1, 'Expected line actions');
  for (let i = 0; i < rects.length; i++) {
    assert(rects[i].height >= 44 && rects[i].width >= 44, 'Action touch size');
    if (i) { const a = rects[i - 1], b = rects[i]; assert(Math.abs(a.y - b.y) <= 1 ? b.x - a.right >= 7 : b.y - a.bottom >= 7, 'Actions have a visible gap: ' + JSON.stringify(rects)); }
  }
  measurements.push({ kind, width, state, geometry, actions: rects });
  if (screenshot) {
    if (width <= 768) await rows().first().locator('[data-line=quantity]').evaluate(node => node.scrollIntoView({ block: 'center' }));
    const file = path.join(proof, `${kind}-${state === 'initial' ? 'empty-' : ''}${width}.png`); await page.screenshot({ path: file }); artifacts.push(file);
  }
}
(async () => {
  await wait(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 'server health');
  const ids = JSON.parse(fixture(`import json
from django.contrib.auth.models import User
from django.utils import timezone
from server.erp.models import Document,Store,Warehouse,Counterparty,Voucher,VoucherLine
u=User.objects.get(username='tester');s=Store.objects.first();w=Warehouse.objects.first();today=timezone.localdate()
p=Document.objects.create(path='products/line_layout_product',data={'name':'Перевірка рядка · шоколад із горіхами та довгою українською назвою','unit':'шт','cost':'12.3456','manualPrice':True,'price':'21.99','promotion':False})
party=Counterparty.objects.create(name='Постачальник для перевірки рядків',kind='supplier')
source=Voucher.objects.create(kind='receipt',status='posted',date=today,store=s,warehouse=w,party=party,created_by=u,total='24.69')
line=VoucherLine.objects.create(voucher=source,product=p,name=p.data['name'],unit='шт',quantity='2',price='12.3456',amount='24.69',lot='Партія з довгою назвою',expiry=today)
draft=Voucher.objects.create(kind='supplier_return',date=today,store=s,warehouse=w,party=party,created_by=u,reference=source,total='12.35')
VoucherLine.objects.create(voucher=draft,product=p,name=p.data['name'],unit='шт',quantity='1',price='12.3456',amount='12.35',lot=line.lot,expiry=today,reference_line=line)
print(json.dumps({'linkedReturn':draft.pk,'sourceLine':line.pk}))`));
  before = ledger();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'uk-UA' });
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', prompt => prompt.accept());
  await page.route('https://fonts.googleapis.com/**', route => route.abort()); await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.route('**/api/erp/vouchers**', route => { const request = route.request(); if (request.method() !== 'GET') { writes.push({ method: request.method(), url: request.url() }); return route.abort(); } return route.continue(); });
  await require('./browser-login.cjs')(page, base, password);
  for (const kind of only) {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(base + '/#trade/' + (kind === 'sale' ? 'sales' : kind === 'inventory' ? 'stock' : 'purchases'));
    if (kind === 'supplier_return') { await page.locator(`[data-trade=view][data-id="${ids.linkedReturn}"]`).click(); await dialog().locator('[data-trade=edit-voucher]').click(); }
    else if (kind === 'inventory') await page.getByRole('button', { name: '+ Інвентаризація', exact: true }).click();
    else await page.locator(`[data-trade=new-voucher][data-kind=${kind}]`).click();
    await rows().first().getByRole('combobox', { name: 'Товар', exact: true }).waitFor();
    if (!geometryOnly) await inspect(kind, 1440, 'initial', kind === 'receipt');
    const product = rows().first().getByRole('combobox', { name: 'Товар', exact: true });
    if (kind === 'supplier_return') {
      assert(await product.isDisabled(), 'Referenced return product stays locked');
      assert.equal(await rows().first().locator('[data-line=reference_line]').inputValue(), String(ids.sourceLine));
      assert.equal(await rows().first().locator('[data-line=lot]').getAttribute('readonly'), '');
    } else {
      await product.fill('Перевірка рядка'); await page.getByRole('option', { name: /Перевірка рядка/ }).waitFor(); await wait(async () => await page.getByRole('option').count() === 1 && await page.locator('[data-directory-paging]').count() === 0, 'fresh search result');
      if (geometryOnly) await page.getByRole('option', { name: /Перевірка рядка/ }).click();
      else {
      await product.press('Escape'); await page.getByRole('listbox').waitFor({ state: 'hidden' });
      assert(await product.evaluate(node => node === document.activeElement), 'Escape returns focus without closing document');
      assert.equal(await rows().first().locator('[data-line=product]').inputValue(), '', 'Search cancel does not commit a product');
      await product.fill('Перевірка рядка'); await page.getByRole('option', { name: /Перевірка рядка/ }).waitFor(); await wait(async () => await page.getByRole('option').count() === 1 && await page.locator('[data-directory-paging]').count() === 0, 'fresh search result'); await product.press('ArrowDown'); await product.press('Enter');
      await wait(async () => await rows().first().locator('[data-line=product]').inputValue() === 'line_layout_product', 'keyboard product commit');
      await page.getByRole('listbox').waitFor({ state: 'hidden' }); await product.press('Tab');
      assert(await rows().first().locator('[data-line=quantity]').evaluate(node => node === document.activeElement), 'Tab goes to quantity');
      }
      await rows().first().locator('[data-line=quantity]').fill('2.125');
      await rows().first().locator('[data-line=price]').fill('12.3456');
      if (kind !== 'sale') await rows().first().locator('[data-line=expiry]').fill('2026-12-31');
      assert.equal(await rows().first().locator('.tk-help').count(), 0, 'Required hint leaves after actual selection');
      if (!geometryOnly) await inspect(kind, 1440, 'selected');
      await dialog().locator('[data-trade=add-line]').press('Enter'); await wait(async () => await rows().count() === 2, 'second row');
    }
    for (const width of widths) { await page.setViewportSize({ width, height: 1050 }); await inspect(kind, width, kind === 'supplier_return' ? 'locked-source' : 'selected-and-empty', true); }
    if (kind !== 'supplier_return' && !geometryOnly) {
      await rows().last().locator('[data-trade=remove-line]').press('Enter'); assert.equal(await rows().count(), 1);
      assert.equal(await rows().first().locator('[data-line=quantity]').inputValue(), '2.125', 'Deleting second row preserves first');
      assert(await product.evaluate(node => node === document.activeElement), 'Remove returns focus to product');
    }
    checks.push(`${kind}: shared-row alignment, ${widths.join('/')}, action gaps, ${kind === 'supplier_return' ? 'locked linked source' : geometryOnly ? 'mobile geometry and readable full date/4dp price' : 'keyboard commit/add/remove'}, no document write`);
    await close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.equal(ledger(), before, 'Document and accounting fixtures remain unchanged'); passed = true;
  console.log('PASS document-line layout: ' + only.join(', ') + '; proof ' + proof);
})().catch(async error => { console.error(error); if (page) await page.screenshot({ path: path.join(proof, 'failure.png') }).catch(() => {}); process.exitCode = 1; }).finally(async () => {
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const hashes = Object.fromEntries(['app/erp.js', 'app/erp.css', 'frontend/dist/.vite/manifest.json'].map(file => [file, fs.existsSync(path.join(root, file)) ? crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') : null]));
  fs.writeFileSync(path.join(proof, 'report.json'), JSON.stringify({ passed, source, hashes, checks, measurements, artifacts, writes, errors, limits: ['synthetic isolated SQLite', 'document layout only; no save/post, full regression, physical device or VPS check'] }, null, 2));
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]); if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); } }
  fs.closeSync(log); fs.rmSync(data, { recursive: true, force: true });
});
