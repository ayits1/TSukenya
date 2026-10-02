/* Budget layout and amount persistence against an isolated local database only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-expenses-'));
const python = process.env.PYTHON_BIN || 'python3';
const base = 'http://localhost:18213', password = 'isolated-budget-password';
const hash = execFileSync(python, ['-c', 'from server.auth import hash_password; print(hash_password("isolated-budget-password"))'], { cwd: root, encoding: 'utf8' }).trim();
const env = { ...process.env, DATA_DIR: data, ERP_DB_PATH: path.join(data, 'crm.sqlite3'), PORT: '18213', HOST: '127.0.0.1', OWNER_USERNAME: 'tester', OWNER_PASSWORD_HASH: hash };
for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) delete env[key];
const server = spawn(python, ['-m', 'server.main'], { cwd: root, env, stdio: 'ignore' });
let browser, page;
async function until(check, message) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
(async () => {
  await until(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 'isolated server startup');
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://fonts.googleapis.com/**', r => r.abort());
  await page.route('https://fonts.gstatic.com/**', r => r.abort());
  await require('./browser-login.cjs')(page, base, password);
  await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/session')).json();
    for (const [id, name, group] of [
      ['qa_rent', 'Оренда', 'fixed'],
      ['qa_long', 'Оренда складського приміщення та щомісячне обслуговування обладнання', 'fixed'],
      ['qa_variable', 'Доставка закуплених товарів до магазинів мережі', 'variable'],
    ]) {
      const response = await fetch('/api/docs/expenses/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: JSON.stringify({ name, group, amount: 10000, order: 1 }) });
      if (!response.ok) throw new Error('Isolated budget fixture failed: ' + response.status);
    }
  });
  await page.goto(base + '/#operations/expenses', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-exp=qa_rent]').waitFor();
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'budget fits at ' + width);
      const rows = await page.locator('.expense-budget .exp').evaluateAll(rows => rows.map(row => {
        const name = row.querySelector('.n'), input = row.querySelector('input'), remove = row.querySelector('button'), r = row.getBoundingClientRect(), n = name.getBoundingClientRect(), i = input.getBoundingClientRect(), d = remove.getBoundingClientRect();
        return { name: name.textContent, nameWidth: n.width, nameHeight: n.height, lineHeight: parseFloat(getComputedStyle(name).lineHeight), inputWidth: i.width, inputHeight: i.height, removeWidth: d.width, removeHeight: d.height, fits: n.right <= r.right + 1 && i.right <= r.right + 1 && d.right <= r.right + 1, separated: n.bottom <= i.top + 1 || n.right <= i.left + 1 };
      }));
      for (const row of rows) {
        assert(row.nameWidth >= 100 && row.inputWidth >= 100 && row.fits && row.separated, 'names and amounts have usable separate space: ' + JSON.stringify(row));
        assert(row.inputHeight >= 44 && row.removeWidth >= 44 && row.removeHeight >= 44, 'touch targets remain usable');
        if (row.name === 'Оренда') assert(row.nameHeight < row.lineHeight * 1.5, 'short name never wraps one character per row');
      }
      await page.getByRole('textbox', { name: 'Нова стаття: Постійні' }).fill('Нова довга назва статті');
      await page.screenshot({ path: path.join(os.tmpdir(), `tsukenya-budget-${width}-${colorScheme}.png`), fullPage: true });
    }
  }
  const amount = page.getByRole('spinbutton', { name: 'Оренда, грн на місяць', exact: true });
  await amount.fill('12345.67');
  assert.equal(await amount.evaluate(el => el.checkValidity()), true, 'kopecks are a valid budget amount');
  await amount.press('Tab');
  await until(async () => await page.evaluate(async () => (await (await fetch('/api/state')).json()).data.expenses.find(e => e.id === 'qa_rent')?.data.amount === 12345.67), 'budget amount autosaved exactly');
  await page.reload();
  await amount.waitFor();
  assert.equal(await amount.inputValue(), '12345.67', 'budget amount survives reload');
  assert.match(await page.locator('.expense-group .total .num').first().innerText(), /,67 грн$/, 'budget total preserves kopecks');
  assert.deepEqual(errors, []);
  console.log('PASS: budget names/amounts separated, short/long names, 44px controls, 1440/1024/768/390/320 in both system themes, autosave 12345.67 and reload.');
})().catch(async error => {
  if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'tsukenya-budget-failure.png'), fullPage: true }).catch(() => {});
  console.error(error); process.exitCode = 1;
}).finally(async () => {
  await browser?.close(); server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  fs.rmSync(data, { recursive: true, force: true });
});
