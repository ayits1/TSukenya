/* CRM React route against an owned temporary Django database; never production. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-customers-ui-'));
const python = process.env.PYTHON_BIN || 'python3';
const password = 'isolated-customer-ui-password';
const hash = execFileSync(python, ['-c', `from server.auth import hash_password; print(hash_password(${JSON.stringify(password)}))`], { cwd: root, encoding: 'utf8' }).trim();
const base = 'http://localhost:18219';
const env = { ...process.env, DATA_DIR: data, ERP_DB_PATH: path.join(data, 'crm.sqlite3'), HOST: '127.0.0.1', PORT: '18219', OWNER_USERNAME: 'tester', OWNER_PASSWORD_HASH: hash };
for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) delete env[key];
const server = spawn(python, ['-m', 'server.main'], { cwd: root, env, stdio: 'ignore' });
let browser;
const wait = async (fn, name) => { for (let i = 0; i < 120; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(name); };
function fixture(source) { return execFileSync(python, ['manage.py', 'shell', '-c', source], { cwd: root, env, encoding: 'utf8' }); }
(async () => {
  await wait(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 'isolated server');
  fixture(`from server.erp.models import *
from server.erp.services import save_voucher,post_voucher
from django.utils import timezone
u=User.objects.get(username='tester');s=Store.objects.first();w=Warehouse.objects.filter(store=s).first();a=CashAccount.objects.filter(store=s,kind='bank').first()
if a is None:a=CashAccount.objects.create(store=s,kind='bank',name='Банк QA')
c=Counterparty.objects.create(name='Олена QA',kind='customer',phone='0991234567',email='olena@example.invalid')
Counterparty.objects.bulk_create([Counterparty(name=f'Клієнт QA {i:03}',kind='customer') for i in range(65)])
p=Document.objects.create(path='products/qa-customer-product',data={'name':'Товар QA CRM','unit':'шт','manualPrice':True,'price':10,'cost':5})
def post(kind,qty,price,**extra):
 body={'kind':kind,'store':s.pk,'warehouse':w.pk,'date':timezone.localdate().isoformat(),'lines':[{'product':'qa-customer-product','quantity':qty,'price':price}],**extra}
 return post_voucher(u,save_voucher(u,body).pk)
supplier=Counterparty.objects.create(name='Постачальник QA CRM',kind='supplier')
post('receipt',100,5,party=supplier.pk)
sale=post('sale',2,10,party=c.pk,payload={'payments':[{'account':a.pk,'amount':'20'}]})
post('sale',1,30,party=c.pk,payload={'payments':[{'account':a.pk,'amount':'30'}]})
returned=post('customer_return',1,10,party=c.pk,reference=sale.pk,payload={'payments':[{'account':a.pk,'amount':'10'}]})
Voucher.objects.filter(pk=returned.pk).update(party=None)
`);
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  page.setDefaultTimeout(10000);
  await require('./browser-login.cjs')(page, base, password);
  await page.goto(base + '/#trade/customers');
  await page.locator('.customer-list li').first().waitFor();
  assert(await page.evaluate(() => !!window.ReactCustomers));
  assert.equal(await page.locator('.customer-list li').count(), 30);
  await page.getByRole('button', { name: 'Наступна', exact: true }).click();
  await page.getByText('Клієнтів: 66. Сторінка 2 з 3.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Наступна', exact: true }).click();
  await page.getByText('Клієнтів: 66. Сторінка 3 з 3.', { exact: true }).waitFor();
  assert.equal(await page.locator('.customer-list li').count(), 6);
  const search = page.getByRole('searchbox', { name: 'Пошук клієнта', exact: true });
  await search.fill('Олена QA');
  const customer = page.getByRole('button', { name: /Олена QA 0991234567/ });
  await customer.waitFor(); await customer.focus(); await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Олена QA', exact: true }).waitFor();
  assert(await page.getByRole('heading', { name: 'Олена QA', exact: true }).evaluate(el => el === document.activeElement));
  const profile = page.locator('.customer-profile');
  assert.equal(await profile.getByText('25,00 грн', { exact: true }).count(), 1);
  assert.equal(await profile.getByText('40,00 грн', { exact: true }).count(), 1);
  assert.equal(await profile.getByText('Повторні покупки', { exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Історія документів', exact: true }).click();
  await page.locator('.trade-document-browser tbody tr').first().waitFor();
  assert.equal(await page.locator('.trade-document-browser tbody tr').count(), 3, 'source-linked return without own party remains in history');
  await page.keyboard.press('Escape');
  await wait(async () => !(await page.getByRole('button', { name: 'Історія документів', exact: true }).isDisabled()), 'history close');
  await wait(async () => await page.getByRole('button', { name: 'Історія документів', exact: true }).evaluate(el => el === document.activeElement), 'history trigger focus return');
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'CRM overflow ' + width);
    const violations = (await new AxeBuilder({ page }).include('.customers-workspace').analyze()).violations;
    assert.deepEqual(violations, [], 'CRM accessibility ' + width);
    assert(await page.locator('.skip-link').evaluate(el => el.getBoundingClientRect().bottom <= 0), 'Unfocused skip link remains outside viewport');
    if (process.env.QA_CUSTOMERS_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.QA_CUSTOMERS_ARTIFACT_DIR, { recursive: true });
      // Capture from the top so a fixed offscreen skip link is not painted inside a stitched full page.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(process.env.QA_CUSTOMERS_ARTIFACT_DIR, `customers-${width}.png`), fullPage: true });
    }
  }
  // A contact created after the ERP snapshot must open an editor for its actual ID, not a create form.
  const created = await page.evaluate(async () => {
    const state = await (await fetch('/api/state')).json();
    const response = await fetch('/api/erp/entities/parties', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify({ name: 'Новий після snapshot QA', kind: 'customer', active: true }) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  await search.fill('Новий після snapshot QA');
  await page.getByRole('button', { name: /Новий після snapshot QA Контакти не вказано/ }).click();
  await page.getByRole('heading', { name: 'Новий після snapshot QA' }).waitFor();
  await page.getByRole('button', { name: 'Історія документів', exact: true }).click();
  await page.getByRole('heading', { name: 'Історія: Новий після snapshot QA', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await wait(async () => !(await page.getByRole('button', { name: 'Редагувати клієнта', exact: true }).isDisabled()), 'fresh customer history close');
  let editReads = 0;
  await page.route('**/api/erp/state', route => ++editReads === 1 ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA збій перед відкриттям редактора' }) }) : route.continue());
  await page.getByRole('button', { name: 'Редагувати клієнта', exact: true }).click();
  const editError = page.getByText('QA збій перед відкриттям редактора', { exact: true });
  await editError.waitFor();
  assert(await editError.evaluate(el => el === document.activeElement), 'editor read error receives focus');
  assert.equal(await page.locator('#tradeEntityForm').count(), 0);
  await page.getByRole('button', { name: 'Редагувати клієнта', exact: true }).click();
  await page.unroute('**/api/erp/state');
  const editor = page.locator('#tradeEntityForm');
  await editor.waitFor(); assert.equal(await editor.locator('[name=name]').inputValue(), 'Новий після snapshot QA');
  await editor.locator('[name=phone]').fill('000123');
  await editor.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Новий після snapshot QA' }).waitFor();
  await page.locator('.customer-profile').getByText('000123', { exact: true }).waitFor();
  const saved = await page.evaluate(async id => (await (await fetch('/api/erp/state')).json()).parties.filter(p => p.id === id), created.id);
  assert.equal(saved.length, 1); assert.equal(saved[0].phone, '000123');
  await search.fill('немає QA');
  await page.getByText('Клієнтів за цим пошуком не знайдено. Очистіть або змініть пошук.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'До списку клієнтів', exact: true }).click();
  assert(await search.evaluate(el => el === document.activeElement), 'absent selected contact returns to search');
  await page.getByRole('button', { name: 'Очистити пошук', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.locator('.customer-list li').first().waitFor();
  assert.equal(await search.inputValue(), ''); assert(await search.evaluate(el => el === document.activeElement));
  assert.deepEqual(errors, []);
  console.log('PASS: real React CRM paging/search, posted sales/returns, history, keyboard/focus, fresh-contact edit and confirmed refresh; desktop/320px geometry and axe.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); server.kill('SIGTERM');
});
