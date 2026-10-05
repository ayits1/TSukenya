const staff=require('./staff-navigation.cjs');
/* Actual shift-history directory toolbars. Disposable SQLite + bundled headless Chromium. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const cases = [['staff', 'work', 1440, 1], ['sales', 'cash', 1440, 1], ['staff', 'work', 320, 1], ['sales', 'cash', 320, 1], ['staff', 'work', 1440, 2], ['sales', 'cash', 1440, 2]];
const caseLabel = ([tab, , width, scale]) => `${tab}-${width}${scale === 2 ? '-text200' : ''}`;
const from = process.env.QA_DIRECTORY_TOOLBAR_FROM;
const only = process.env.QA_DIRECTORY_TOOLBAR_ONLY?.split(',');
assert(!only || (only.length && only.every(label => cases.some(row => caseLabel(row) === label))), 'Unknown QA_DIRECTORY_TOOLBAR_ONLY');
assert(!only || from === undefined, 'Use only one directory toolbar stage selector');
assert(from === undefined || cases.some(row => caseLabel(row) === from), 'Unknown QA_DIRECTORY_TOOLBAR_FROM');
const root = path.resolve(__dirname, '..');
const python = process.env.PYTHON_BIN || 'python3';
const port = Number(process.env.QA_DIRECTORY_TOOLBAR_PORT || 18637);
assert(Number.isInteger(port) && port > 1024 && port < 65536, 'Invalid isolated port');
const proof = process.env.DIRECTORY_TOOLBAR_PROOF_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-directory-toolbar-proof-'));
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
async function ready(host) {
  await wait(async () => (await host.locator('[data-shift-status]').innerText()) !== 'Завантажуємо зміни…' && !(await host.locator('[data-shift-results]').getAttribute('aria-busy')), 'shift history ready');
  assert.equal(await host.locator('[data-shift-error]').innerText(), '', 'History read succeeded');
}
async function closeMenu(input) {
  await input.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
}
async function inspectFields(form, label, width, scale) {
  const boxes = await form.locator('input[role=combobox]').evaluateAll(inputs => inputs.map(input => {
    const rect = input.getBoundingClientRect(), control = input.closest('.tk-combo-group').getBoundingClientRect(), field = input.closest('.trade-directory-field,.tk-directory-control').getBoundingClientRect(), caption = input.closest('.tk-field').querySelector('.tk-label').getBoundingClientRect(), style = getComputedStyle(input);
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    context.font = style.font;
    return { label: input.getAttribute('aria-label'), placeholder: input.placeholder, value: input.value, x: rect.x, y: rect.y, width: rect.width, height: rect.height, controlWidth: control.width, fieldWidth: field.width, controlX: control.x, controlRight: control.right, labelControlGap: control.y - caption.bottom, textWidth: context.measureText(input.placeholder).width, contentWidth: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
  }));
  assert.equal(boxes.length, 2, 'Actual store and employee React controls');
  for (const box of boxes) {
    assert.equal(box.value, '', label + ' empty caption remains a placeholder');
    if (width === 1440) assert(box.controlWidth >= 180 && box.fieldWidth >= 180, label + ' field shrink: ' + JSON.stringify(box));
    assert(box.height >= 44, label + ' field touch height');
    assert(box.labelControlGap >= -1 && box.labelControlGap <= 12, label + ' label/control vertical gap: ' + JSON.stringify(box));
    assert(box.x >= -1 && box.x + box.width <= width + 1 && box.controlX >= -1 && box.controlRight <= width + 1, label + ' field outside viewport');
    assert(box.contentWidth >= box.textWidth, label + ' empty caption clipped: ' + JSON.stringify(box));
  }
  assert.deepEqual(boxes.map(box => box.placeholder), ['Усі магазини', 'Усі працівники']);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label + ' document overflow');
  measurements.push({ label, width, scale, fields: boxes });
}
async function inspectMenu(label, width, expectedNames) {
  const popup = page.locator('.tk-popover--directory');
  await popup.waitFor();
  await wait(async () => (await popup.getByRole('option').count()) === expectedNames.length && await popup.locator('[data-directory-paging]').count() === 0, label + ' directory page ready');
  assert.deepEqual(await page.getByRole('option').allTextContents(), expectedNames);
  const geometry = await popup.evaluate(element => {
    const bounds = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const words = [];
    for (const option of element.querySelectorAll('[role=option]')) {
      const walker = document.createTreeWalker(option, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        for (const match of node.textContent.matchAll(/[\p{L}]{8,}/gu)) {
          const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
          words.push({ word: match[0], lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.y))).size });
        }
      }
    }
    return { popup: bounds(element), pagerCount: element.querySelectorAll('[data-directory-paging]').length, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, viewport: { width: innerWidth, height: innerHeight }, words };
  });
  const p = geometry.popup;
  assert(p.width >= Math.min(280, width - 64) - 1, label + ' unreadable popup width: ' + JSON.stringify(geometry));
  assert(p.x >= -1 && p.right <= width + 1 && p.y >= -1 && p.bottom <= geometry.viewport.height + 1, label + ' popup outside viewport: ' + JSON.stringify(geometry));
  assert(geometry.scrollWidth <= geometry.clientWidth + 1, label + ' popup horizontal overflow');
  assert.equal(geometry.pagerCount, 0, 'No paging controls for one page');
  assert(geometry.words.every(word => word.lines === 1), label + ' ordinary word broken inside narrow option: ' + JSON.stringify(geometry.words));
  measurements.push({ label, menu: geometry });
  await capture(label + '-popup');
}
async function exerciseSales(width,scale){
 const label=`sales-${width}${scale===2?'-text200':''}`;
 await page.setViewportSize({width,height:1050});await page.goto(base+'/#trade/sales');
 const host=page.locator('[data-react-sales]');await host.getByRole('tab',{name:'Касові зміни',exact:true}).click();
 const form=host.locator('form.sales-filters');await host.getByRole('heading',{name:'Касові зміни',exact:true}).waitFor();
 for(const name of ['Магазин','Працівник']){const clear=form.getByRole('button',{name:'Очистити вибір: '+name,exact:true});if(await clear.count()){await clear.click();await wait(async()=>!(await form.getByRole('combobox',{name:'Працівник',exact:true}).isDisabled()),'React cleared filter');}}
 const enlarged=scale===2?await page.addStyleTag({content:'html{font-size:32px!important}.sales-filters :is(.tk-label,.tk-combo-input,.tk-button,label,input){font-size:28px!important}.tk-popover--directory .tk-option{font-size:26px!important}'}):null;
 await form.scrollIntoViewIfNeeded();await inspectFields(form,label,width,scale);await capture(label+'-toolbar');
 const store=form.getByRole('combobox',{name:'Магазин',exact:true});await store.focus();await store.press('ArrowDown');
 await inspectMenu(label,width,ids.stores.map(row=>row.name).sort((a,b)=>a.localeCompare(b,'uk')));
 await store.fill('Тимчасовий пошук');await closeMenu(store);assert.equal(await store.inputValue(),'');
 await store.fill('Центральний');await page.getByRole('option',{name:ids.stores[0].name,exact:true}).waitFor();
 await store.press('ArrowDown');await store.press('Enter');await wait(async()=>!(await store.isDisabled())&&await store.inputValue()===ids.stores[0].name,'React committed store caption');
 await store.fill('Незбережений текст');await closeMenu(store);assert.equal(await store.inputValue(),ids.stores[0].name);
 const employee=form.getByRole('combobox',{name:'Працівник',exact:true});await employee.fill('Коваленко');await page.getByRole('option',{name:/Коваленко/}).waitFor();
 const response=page.waitForResponse(r=>{const url=new URL(r.url());return url.pathname==='/api/v1/trading/sales/cash-shifts'&&url.searchParams.get('store')===String(ids.stores[0].id)&&url.searchParams.get('employee')===String(ids.employees[0].id);});
 await employee.press('ArrowDown');await employee.press('Enter');assert.equal((await response).status(),200);
 await wait(async()=>!(await employee.isDisabled()),'React filtered read complete');
 assert.match(await employee.inputValue(),new RegExp(' · №'+ids.employees[0].id+'$'));measurements.push({label,committedQuery:{store:ids.stores[0].id,employee:ids.employees[0].id}});
 stages.push(label+': React toolbar/menu/keyboard/temp search/committed IDs/filtered GET PASS');if(enlarged)await enlarged.evaluate(el=>el.remove());
}
async function exercise(tab, kind, width, scale = 1) {
  if(kind==='cash')return exerciseSales(width,scale);
  const label = `${tab}-${width}${scale === 2 ? '-text200' : ''}`;
  await page.setViewportSize({ width, height: 1050 });await page.goto(base+'/#trade/staff');await staff.tab(page,'work');
  const form=staff.host(page).locator('form.staff-filters');
  for(const name of ['Магазин','Працівник']){const clear=form.getByRole('button',{name:'Очистити вибір: '+name,exact:true});if(await clear.count()){await clear.click();await staff.ready(page);}}
  const enlarged=scale===2?await page.addStyleTag({content:'html{font-size:32px!important}.staff-filters :is(.tk-label,.tk-combo-input,.tk-button,label,input){font-size:28px!important}.tk-popover--directory .tk-option{font-size:26px!important}'}):null;
  await form.scrollIntoViewIfNeeded();await inspectFields(form,label,width,scale);await capture(label+'-toolbar');
  const store=form.getByRole('combobox',{name:'Магазин',exact:true});await store.focus();await store.press('ArrowDown');
  await inspectMenu(label,width,ids.stores.map(row=>row.name).sort((a,b)=>a.localeCompare(b,'uk')));
  await store.fill('Тимчасовий пошук');await closeMenu(store);assert.equal(await store.inputValue(),'','Escape cannot commit temporary store search');
  await store.fill('Центральний');await page.getByRole('option',{name:ids.stores[0].name,exact:true}).waitFor();
  const storeRead=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/v1/trading/staff/work-shifts'&&u.searchParams.get('store')===String(ids.stores[0].id);});
  await store.press('ArrowDown');await store.press('Enter');assert.equal((await storeRead).status(),200);await staff.ready(page);
  await wait(async()=>await store.inputValue()===ids.stores[0].name,'React committed store caption');
  await closeMenu(store);await store.fill('Незбережений текст');await closeMenu(store);assert.equal(await store.inputValue(),ids.stores[0].name,'Escape restores committed caption');
  const employee=form.getByRole('combobox',{name:'Працівник',exact:true});await employee.fill('Коваленко');await wait(async()=>await page.getByRole('option').count()===1&&await page.getByRole('option').first().getAttribute('aria-disabled')!=='true'&&await page.locator('.tk-popover--directory').getByText('Завантаження…',{exact:true}).count()===0&&await page.getByRole('option').first().innerText().then(t=>t.includes('Коваленко')),'current searched employee option ready');
  const read=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/v1/trading/staff/work-shifts'&&u.searchParams.get('store')===String(ids.stores[0].id)&&u.searchParams.get('employee')===String(ids.employees[0].id);});
  await employee.press('ArrowDown');await employee.press('Enter');const response=await read;assert.equal(response.status(),200);const body=await response.json();
  assert.equal(body.query.store,ids.stores[0].id);assert.equal(body.query.employee,ids.employees[0].id);await staff.ready(page);
  await wait(async()=>new RegExp(' · №'+ids.employees[0].id+'$').test(await employee.inputValue()),'React committed employee caption');
  const caption=await employee.inputValue();await employee.fill('Незбережений працівник');await closeMenu(employee);assert.equal(await employee.inputValue(),caption);
  measurements.push({label,committedQuery:{store:body.query.store,employee:body.query.employee}});
  stages.push(label+': actual React toolbar/popup/keyboard/temp search/committed IDs/filtered GET PASS');if(enlarged)await enlarged.evaluate(el=>el.remove());
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
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  page.on('request', request => { if (request.url().startsWith(base + '/api/')) requests.push({ method: request.method(), url: request.url() }); });
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await require('./browser-login.cjs')(page, base, password);
  for (const row of (only ? cases.filter(row => only.includes(caseLabel(row))) : cases.slice(from === undefined ? 0 : cases.findIndex(row => caseLabel(row) === from)))) await exercise(...row);
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 1000});
    await page.goto(base + '/#trade/sales');
    const history = page.locator('[data-react-sales]');await history.getByRole('tab',{name:'Касові зміни',exact:true}).click();await history.getByRole('heading',{name:'Касові зміни',exact:true}).waitFor();
    const status = history.getByRole('button', {name: /Стан/});
    await status.waitFor();
    await status.click();
    await page.getByRole('option', {name: 'Закриті', exact: true}).click();
    const statusRequest = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/trading/sales/cash-shifts' && new URL(r.url()).searchParams.get('status') === 'closed');
    await history.getByRole('button', {name: 'Знайти', exact: true}).click();
    assert.equal((await statusRequest).status(), 200);
    await history.getByRole('button',{name:'Відкрити зміну',exact:true}).click();
    const dialog = page.locator('dialog[open]');
    const employee = dialog.getByRole('combobox', {name:'Працівник',exact:true});
    await employee.click();
    await wait(async () => await page.getByRole('option').count() === 2 && await page.locator('[data-directory-paging]').count() === 0, 'compact employee menu ready');
    const labels = await page.getByRole('option').allTextContents();
    assert(labels.every(label => label.includes('магазин №') && label.includes(' · №')), 'Employee identity visible');
    const menu = page.locator('.tk-popover--directory');
    const d = await dialog.boundingBox(), m = await menu.boundingBox();
    assert(m.y >= d.y - 1 && m.y + m.height <= d.y + d.height + 1, 'Menu inside native dialog');
    assert(m.x >= d.x - 1 && m.x + m.width <= d.x + d.width + 1, 'Menu horizontally inside dialog');
    await capture('cash-shift-menu-' + width);
    await employee.press('ArrowDown'); await employee.press('Enter');
    assert.equal(await dialog.locator('select[name=employee]').inputValue(), (await employee.inputValue()).match(/ · №(\d+)$/)[1]);
    const selectedEmployee = await dialog.locator('select[name=employee]').inputValue();
    assert(ids.employees.some(e => String(e.id) === selectedEmployee));
    await employee.press('ArrowDown'); await wait(async () => await employee.getAttribute('aria-expanded') === 'true', 'menu reopened'); await employee.press('Escape');
    assert(await dialog.isVisible(), 'Escape closes menu, not form');
    await dialog.locator('[data-trade=close]').click();
    await page.locator('dialog[open]').waitFor({state:'hidden'});
    stages.push('cash shift ' + width + ': compact menu, dialog bounds, employee ID, Escape and status filtering PASS');
  }
  assert(requests.some(row => row.url.includes('/directories/stores?') && new URL(row.url).searchParams.get('q') === 'Центральний'), 'Actual server store search');
  assert(requests.some(row => row.url.includes('/directories/employees?') && new URL(row.url).searchParams.get('q') === 'Коваленко'), 'Actual server employee search');
  assert(requests.every(row => row.method === 'GET' || row.url.endsWith('/api/login') || row.url.endsWith('/directories/details')), 'No business mutation requests');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(proof, 'report.json'), JSON.stringify({ pass: true, partial: from !== undefined || !!only, from: from || null, only: only || null, source, buildManifestSha256, ids, stages, measurements, artifacts, requests, errors, limitations: ['Synthetic SQLite directory fixtures; no payroll or posting mutations.', 'CSS text enlargement at1440;320 at normal text. No system browser or full regression.'] }, null, 2));
  console.log('DIRECTORY TOOLBAR PASS ' + proof);
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
