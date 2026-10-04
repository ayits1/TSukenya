/* Actual shift-history directory toolbars. Disposable SQLite + bundled headless Chromium. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const cases = [['budget', 'monthly', 1440, 1], ['budget', 'monthly', 320, 1], ['budget', 'monthly', 1440, 2]];
const caseLabel = ([tab, , width, scale]) => `${tab}-${width}${scale === 2 ? '-text200' : ''}`;
const from = process.env.QA_BUDGET_PERIOD_FROM;
const only = process.env.QA_BUDGET_PERIOD_ONLY?.split(',');
assert(!only || (only.length && only.every(label => cases.some(row => caseLabel(row) === label))), 'Unknown QA_BUDGET_PERIOD_ONLY');
assert(!only || from === undefined, 'Use only one directory toolbar stage selector');
assert(from === undefined || cases.some(row => caseLabel(row) === from), 'Unknown QA_BUDGET_PERIOD_FROM');
const root = path.resolve(__dirname, '..');
const python = process.env.PYTHON_BIN || 'python3';
const port = Number(process.env.QA_BUDGET_PERIOD_PORT || 18641);
assert(Number.isInteger(port) && port > 1024 && port < 65536, 'Invalid isolated port');
const proof = process.env.BUDGET_PERIOD_PROOF_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-directory-toolbar-proof-'));
fs.mkdirSync(proof, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-directory-toolbar-data-'));
const base = `http://localhost:${port}`, password = 'isolated-directory-toolbar-password';
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(?:DB_|PG|DATABASE_URL$|POSTGRES_URL$|OWNER_PASSWORD|DJANGO_SETTINGS_MODULE$|DJANGO_SECRET_KEY$|TSUKENYA_REQUIRE_POSTGRES$)/.test(key)) delete env[key];
Object.assign(env, { HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, ERP_DB_PATH: path.join(data, 'isolated.sqlite3'), OWNER_USERNAME: 'tester', DJANGO_SETTINGS_MODULE: 'server.settings', DJANGO_SECRET_KEY: 'isolated-directory-toolbar-secret-not-production-at-least-fifty-characters' });
env.OWNER_PASSWORD_HASH = execFileSync(python, ['-c', `from server.auth import hash_password;print(hash_password('${password}'))`], { cwd: root, env, encoding: 'utf8' }).trim();
const log = fs.openSync(path.join(proof, 'server.log'), 'w');
const server = spawn(python, ['-m', 'server.main'], { cwd: root, env, stdio: ['ignore', log, log] });
let browser, page, ids;
const requests = [], errors = [], measurements = [], artifacts = [], stages = [];
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const manifest = path.join(root, 'frontend/dist/.vite/manifest.json');
const buildManifestSha256 = fs.existsSync(manifest) ? crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex') : null;

async function wait(check, message) {
  for (let i = 0; i < 250; i++) {
    if (server.exitCode !== null || server.signalCode !== null) throw Error('Isolated server exited: ' + message);
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Timed out: ' + message);
}
async function capture(name) {
  const file = path.join(proof, name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  artifacts.push(file);
}
const fixture = code => execFileSync(python, ['-c', `import django;django.setup()\n${code}`], {cwd:root,env,encoding:'utf8'}).trim();
let seeded = false;
async function exercise(tab, kind, width, scale = 1) {
  const label = `budget-${width}-${scale}`;
  await page.setViewportSize({ width, height: 1050 });
  await page.goto(base + '/?period-proof=' + width + '-' + scale + '#operations/expenses');
  const form = page.locator('#monthlyBudgetFilters');
  const month = form.locator('input[name=month]');
  const trigger = () => form.getByRole('button', {name:/^Місяць /});
  const saved = () => form.getByRole('button', {name:/Збережені місяці/});
  await trigger().waitFor();
  const original = await month.inputValue();
  assert(await page.evaluate(()=>window.MonthlyBudgets.canLeave()), 'Permission check succeeds');
  assert(await trigger().isVisible(), 'A permission check does not unmount the form before navigation is accepted');
  if (!seeded) {
    assert(await saved().isDisabled());
    assert.match(await saved().innerText(), /Ще немає бюджетів/);
    await capture('empty-saved-months');
    fixture("from server.erp.models import MonthlyBudget\nMonthlyBudget.objects.create(month='2025-08-01',planned_revenue='100')");
    seeded = true;
    await page.locator('[data-monthly=reload]').click();
    await wait(async()=>await saved().isEnabled(),'saved month options refreshed');
  }
  const enlarged = scale === 2 ? await page.addStyleTag({content: 'html{font-size:32px!important}.tk-month-option,.tk-select-trigger,.tk-option{font-size:26px!important}'}) : null;
  await trigger().click();
  const popup = page.getByRole('dialog',{name:'Вибір місяця: Місяць'});
  await popup.waitFor();
  const geometry = await popup.evaluate(node => {
    const panel=node.closest('.tk-month-popover'),r=panel.getBoundingClientRect();
    return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,overflow:panel.scrollWidth>panel.clientWidth+1,items:[...node.querySelectorAll('[role=option]')].map(item=>{const b=item.getBoundingClientRect();return {width:b.width,height:b.height,text:item.textContent};})};
  });
  assert(!geometry.overflow && geometry.x>=0 && geometry.right<=width+1 && geometry.y>=0 && geometry.bottom<=1051, JSON.stringify(geometry));
  assert.equal(geometry.items.length,12);
  assert(geometry.items.every(item=>item.width>=44&&item.height>=44));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page overflow');
  measurements.push({label,geometry});await capture(label+'-month');
  await page.keyboard.press('Escape');
  assert.equal(await month.inputValue(),original,'Escape preserves month');
  await popup.waitFor({state:'hidden'});
  await wait(async()=>await trigger().evaluate(node=>node===document.activeElement),'Escape restores trigger focus');
  await saved().click();
  const option = page.getByRole('option',{name:'Серпень 2025',exact:true});
  await option.waitFor();await capture(label+'-saved');
  const before = requests.filter(row=>row.url.includes('/monthly-budgets')).length;
  await option.click();
  await wait(async()=>await month.inputValue()==='2025-08','saved month sets ISO');
  assert.match(await trigger().innerText(),/Серпень 2025/);
  assert.equal(requests.filter(row=>row.url.includes('/monthly-budgets')).length,before,'selection does not load or save a budget');
  const response = page.waitForResponse(r=>r.url().includes('/api/erp/monthly-budgets?')&&new URL(r.url()).searchParams.get('month')==='2025-08');
  await form.getByRole('button',{name:'Відкрити',exact:true}).click();
  assert.equal((await response).status(),200);
  await wait(async()=>await page.locator('#monthlyBudgetForm [name=planned_revenue]').inputValue()==='100.00','explicit Open loads selected budget');
  if (width===1440&&scale===1) {
    await page.locator('#monthlyBudgetForm [name=planned_revenue]').fill('321.09');
    await require('./browser-month-picker.cjs')(page,'2025-09');
    assert.equal(await page.locator('#monthlyBudgetForm [name=planned_revenue]').inputValue(),'321.09','month picker does not replace draft');
    assert.equal(await form.locator('[name=past]').inputValue(),'','manual choice clears stale saved caption');
    await form.getByRole('button',{name:'Відкрити',exact:true}).click();
    await wait(async()=>await page.locator('#monthlyBudgetForm [name=planned_revenue]').inputValue()==='0.00','new period loaded');
    await require('./browser-month-picker.cjs')(page,'2025-08');
    await form.getByRole('button',{name:'Відкрити',exact:true}).click();
    await wait(async()=>await page.locator('#monthlyBudgetForm [name=planned_revenue]').inputValue()==='321.09','in-page draft preserved');
  }
  if(enlarged)await enlarged.evaluate(node=>node.remove());
  await trigger().click();
  await page.evaluate(()=>window.location.hash='#operations/tasks');
  await wait(async()=>!(await page.getByRole('dialog',{name:'Вибір місяця: Місяць'}).count()),'route disposes popup');
  stages.push(label+': geometry, saved ISO selection, explicit GET, draft preservation, Escape/focus/disposal PASS');
}

(async () => {
  assert(buildManifestSha256, 'Matching built frontend is required');
  await wait(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 'readiness');
  ids = JSON.parse(execFileSync(python, ['-c', `import os,json
import django;django.setup()
from server.erp.models import Store,Employee
first=Store.objects.order_by('pk').first();first.name='Магазин «Центральний Поділ»';first.save()
second=Store.objects.create(name='Магазин «Сонячна Долина»');third=Store.objects.create(name='Магазин «Третя Набережна»')
employees=[Employee.objects.create(name='Працівниця Марія Коваленко',store=first,shift_rate=0,bonus_percent=0,bonus_basis='store'),Employee.objects.create(name='Працівник Остап Гончаренко',store=first,shift_rate=0,bonus_percent=0,bonus_basis='store')]
assert Store.objects.count()==3 and Employee.objects.count()==2
print(json.dumps({'stores':[{'id':s.pk,'name':s.name} for s in [first,second,third]],'employees':[{'id':e.pk,'name':e.name} for e in employees]}))`], { cwd: root, env, encoding: 'utf8' }));
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', prompt=>prompt.accept());
  page.on('request', request => { if (request.url().startsWith(base + '/api/')) requests.push({ method: request.method(), url: request.url() }); });
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await require('./browser-login.cjs')(page, base, password);
  for (const row of (only ? cases.filter(row => only.includes(caseLabel(row))) : cases.slice(from === undefined ? 0 : cases.findIndex(row => caseLabel(row) === from)))) await exercise(...row);
  assert.equal(fixture("from server.erp.models import MonthlyBudget,Voucher,StockEntry,CashEntry\nprint(str(MonthlyBudget.objects.get(month='2025-08-01').planned_revenue)+'|'+str(Voucher.objects.count())+'|'+str(StockEntry.objects.count())+'|'+str(CashEntry.objects.count()))"),'100.00|0|0|0','No saved budget/accounting changes');
  assert(requests.every(row => row.method === 'GET' || row.url.endsWith('/api/login') || row.url.endsWith('/directories/details')), 'No business mutation requests');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(proof, 'report.json'), JSON.stringify({ pass: true, partial: from !== undefined || !!only, from: from || null, only: only || null, source, buildManifestSha256, ids, stages, measurements, artifacts, requests, errors, limitations: ['Synthetic SQLite directory fixtures; no payroll or posting mutations.', 'CSS text enlargement at1440;320 at normal text. No system browser or full regression.'] }, null, 2));
  console.log('BUDGET PERIOD PASS ' + proof);
})().catch(async error => {
  console.error(error);
  if (page) { await capture('failure').catch(() => {}); fs.writeFileSync(path.join(proof, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => '')); }
  fs.writeFileSync(path.join(proof, 'report.json'), JSON.stringify({ pass: false, partial: from !== undefined || !!only, from: from || null, only: only || null, source, buildManifestSha256, error: String(error), ids, stages, measurements, artifacts, requests, errors }, null, 2));
  console.error('proof=' + proof); process.exitCode = 1;
}).finally(async () => {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) await new Promise(resolve => { const timer = setTimeout(() => server.kill('SIGKILL'), 5000); server.once('exit', () => { clearTimeout(timer); resolve(); }); server.kill('SIGTERM'); });
  fs.closeSync(log); fs.rmSync(data, { recursive: true, force: true });
});