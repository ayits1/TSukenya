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
delete env.TSUKENYA_REQUIRE_POSTGRES;
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
    const state = await (await fetch('/api/state')).json(), settings = state.data['settings/main'];
    delete settings.budgetStores;
    const setup = await fetch('/api/docs/settings/main', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: JSON.stringify({ ...settings, stores: ['ERP A', 'ERP B'], storeNames: ['Цінник A'] }) });
    if (!setup.ok) throw new Error('Budget store fixture failed');
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
  await page.locator('[data-budget-mode=catalog]').click();
  await page.locator('[data-exp=qa_rent]').waitFor();
  assert.equal(await page.locator('#stores').inputValue(), '2', 'legacy store array has a usable numeric budget count');
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
  await page.locator('[data-newexp]').evaluateAll(inputs => inputs.forEach(el => el.value=''));
  const amount = page.getByRole('spinbutton', { name: 'Оренда, грн на місяць', exact: true });
  await amount.fill('12345.67');
  assert.equal(await amount.evaluate(el => el.checkValidity()), true, 'kopecks are a valid budget amount');
  await amount.press('Tab');
  await until(async () => await page.evaluate(async () => (await (await fetch('/api/state')).json()).data.expenses.find(e => e.id === 'qa_rent')?.data.amount === 12345.67), 'budget amount autosaved exactly');
  await page.reload();await page.locator('[data-budget-mode=catalog]').click();
  await amount.waitFor();
  assert.equal(await amount.inputValue(), '12345.67', 'budget amount survives reload');
  assert.match(await page.locator('.expense-group .total .num').first().innerText(), /,67 грн$/, 'budget total preserves kopecks');
  let amountWrites=0;
  const onRequest=request=>{if(request.method()==='PATCH' && request.url().endsWith('/api/docs/expenses/qa_rent'))amountWrites++;};
  page.on('request',onRequest);
  for(const invalid of ['', '-1', '1.234']){
    await amount.fill(invalid);await amount.press('Tab');
    await until(async()=>await amount.getAttribute('aria-invalid')==='true','invalid budget amount is explained');
    assert.equal(amountWrites,0,'invalid amount is not sent');
    assert.equal(await amount.inputValue(),invalid,'invalid draft is kept for correction');
  }
  await amount.fill('12345.67');await amount.press('Tab');
  await until(async()=>!(await page.locator('#budgetSaveError').innerText()),'correction clears invalid draft');
  await page.route('**/api/docs/expenses/qa_rent',route=>route.request().method()==='PATCH'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Сервіс тимчасово недоступний.'})}):route.continue());
  await amount.fill('20000.09');await amount.press('Tab');
  await until(async()=>(await page.locator('#budgetSaveError').innerText()).includes('Чернетку залишено'),'failed autosave has persistent error');
  assert.equal(await amount.inputValue(),'20000.09');
  // Trigger a real data refresh while the failed draft remains on screen.
  await page.evaluate(async()=>{const s=await(await fetch('/api/state')).json();await fetch('/api/docs/expenses/qa_variable',{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({amount:11.03})});});
  await until(async()=>await page.locator('[data-exp=qa_variable]').inputValue()==='11.03','refresh rendered another saved expense');
  assert.equal(await amount.inputValue(),'20000.09','refresh does not discard failed amount');
  page.once('dialog',dialog=>dialog.dismiss());
  await page.evaluate(()=>location.hash='#operations/work');
  await until(async()=>await page.evaluate(()=>location.hash==='#operations/expenses'),'failed draft protects route');
  await page.unroute('**/api/docs/expenses/qa_rent');
  await page.getByRole('button',{name:'Повторити збереження',exact:true}).click();
  await until(async()=>(await page.locator('#budgetSaveStatus').innerText())==='Усі зміни збережено','explicit retry completed');
  assert.equal(await amount.inputValue(),'20000.09');
  const saved=await page.evaluate(async()=> (await(await fetch('/api/state')).json()).data.expenses.find(e=>e.id==='qa_rent').data.amount);
  assert.equal(saved,20000.09,'retry saves exact kopecks');
  let releaseSave;
  await page.route('**/api/docs/expenses/qa_rent',async route=>{if(route.request().method()==='PATCH'){await new Promise(resolve=>releaseSave=resolve);}await route.continue();});
  await amount.fill('20001.10');await amount.press('Tab');
  await until(async()=>await amount.isDisabled(),'pending field is disabled');
  assert.equal(await page.locator('[data-del-exp=qa_rent]').isDisabled(),true,'pending expense cannot be removed');
  await page.evaluate(()=>location.hash='#operations/work');
  await until(async()=>await page.evaluate(()=>location.hash==='#operations/expenses'),'pending autosave protects route');
  releaseSave();await page.unroute('**/api/docs/expenses/qa_rent');
  await until(async()=>(await page.locator('#budgetSaveStatus').innerText())==='Усі зміни збережено','pending completed');
  const count=page.getByRole('spinbutton',{name:'Планова кількість магазинів'});
  const before=await page.evaluate(async()=>({state:await(await fetch('/api/state')).json(),erp:await(await fetch('/api/erp/state')).json(),labels:await(await fetch('/api/v1/labels/workspace')).json()}));
  for(const invalid of ['', '0', '1.5', '1001']){await count.fill(invalid);await count.press('Tab');await until(async()=>await count.getAttribute('aria-invalid')==='true','budget count validation');}
  await count.fill('7');await count.press('Tab');
  await until(async()=>(await page.locator('#budgetSaveStatus').innerText())==='Усі зміни збережено','budget count saved');
  const after=await page.evaluate(async()=>({state:await(await fetch('/api/state')).json(),erp:await(await fetch('/api/erp/state')).json(),labels:await(await fetch('/api/v1/labels/workspace')).json()}));
  assert.equal(after.state.data['settings/main'].budgetStores,7);
  assert.deepEqual(after.state.data['settings/main'].stores,before.state.data['settings/main'].stores);
  assert.deepEqual(after.state.data['settings/main'].storeNames,before.state.data['settings/main'].storeNames);
  assert.deepEqual(after.erp.stores,before.erp.stores);
  assert.equal(after.labels.revision,before.labels.revision,'budget has no label revision conflict');
  await page.reload();await page.locator('[data-budget-mode=catalog]').click();await count.waitFor();assert.equal(await count.inputValue(),'7');
  // A draft whose source was removed in another session remains visible.
  const orphan=page.locator('[data-exp=qa_long]');
  await page.route('**/api/docs/expenses/qa_long',route=>route.request().method()==='PATCH'?route.fulfill({status:503,json:{error:'Ізольований збій'}}):route.continue());
  await orphan.fill('8888.77');await orphan.press('Tab');
  await until(async()=>(await page.locator('#budgetSaveError').innerText()).includes('Чернетку залишено'),'orphan fixture has failed draft');
  await page.unroute('**/api/docs/expenses/qa_long');
  await page.evaluate(async()=>{const s=await(await fetch('/api/state')).json();await fetch('/api/docs/expenses/qa_long',{method:'DELETE',headers:{'X-CSRF-Token':s.csrf}});});
  await until(async()=>await orphan.count()===0,'external deletion refreshed');
  assert.match(await page.locator('#budgetOrphans').innerText(),/8888.77/,'orphan draft amount remains visible');
  assert.equal(await page.getByRole('button',{name:'Повторити збереження',exact:true}).isHidden(),true,'orphan is not sent as a missing record update');
  page.once('dialog',dialog=>dialog.dismiss());await page.evaluate(()=>location.hash='#operations/work');await until(async()=>await page.evaluate(()=>location.hash==='#operations/expenses'),'orphan guards leave');
  await page.getByRole('button',{name:/Відкинути чернетку: Оренда складського/}).click();
  assert.equal(await page.locator('#budgetOrphans').innerText(),'');assert.equal(await page.locator('#budgetSaveStatus').innerText(),'Усі зміни збережено');
  // Own deletion blocks duplicate requests and navigation until resolved.
  let releaseDelete,deleteCalls=0;
  await page.route('**/api/docs/expenses/qa_variable',async route=>{if(route.request().method()==='DELETE'){deleteCalls++;await new Promise(resolve=>releaseDelete=resolve);}await route.continue();});
  page.once('dialog',dialog=>dialog.accept());await page.locator('[data-del-exp=qa_variable]').click();
  await until(async()=>await page.locator('[data-del-exp=qa_variable]').isDisabled(),'delete is pending');
  await page.locator('[data-del-exp=qa_variable]').evaluate(el=>el.click());assert.equal(deleteCalls,1,'disabled button prevents duplicate deletion');
  await page.evaluate(()=>location.hash='#operations/work');await until(async()=>await page.evaluate(()=>location.hash==='#operations/expenses'),'pending delete protects route');
  releaseDelete();await page.unroute('**/api/docs/expenses/qa_variable');await until(async()=>await page.locator('[data-exp=qa_variable]').count()===0,'deleted row removed');
  execFileSync(python,['-c',`import os;os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from django.contrib.auth.models import User
from server.erp.models import Profile
u=User.objects.create_user(username='budget_manager',password='isolated-budget-password');Profile.objects.create(user=u,role='manager')`],{cwd:root,env});
  const restricted=await browser.newContext({viewport:{width:390,height:1000}});
  try{const login=await restricted.request.post(base+'/api/login',{headers:{Origin:base},data:{username:'budget_manager',password}});assert.equal(login.status(),200);const manager=await restricted.newPage();await manager.route('https://fonts.googleapis.com/**',r=>r.abort());await manager.route('https://fonts.gstatic.com/**',r=>r.abort());await manager.goto(base+'/#operations/expenses');await manager.getByText('Бюджет витрат доступний власнику мережі.',{exact:true}).waitFor();assert.equal(await manager.locator('[data-exp],#stores,[data-newexp]').count(),0,'non-owner sees no unavailable edit controls');assert.equal(await manager.locator('.tab[data-tab=expenses]').isHidden(),true);}
  finally{await restricted.close();}
  // Strict compact metadata and authoritative model DTO; never fake a full product snapshot.
  const realState=await(await page.request.get(base+'/api/v1/portal/state')).json();
  const realModel=await(await page.request.get(base+'/api/v1/portal/catalogue-model')).json();
  for(const [cost,price,expense,message] of [[10,20,0,'План витрат дорівнює нулю'],[0,20,10,'Недостатньо даних'],[30,20,10,'Середня маржа нульова або від’ємна']]){
    const fixture=structuredClone(realState);fixture.data.expenses=[{id:'qa_analytical',data:{name:'Оренда',group:'fixed',amount:expense}}];
    const coverage=cost>0?1:0,margin=coverage?(price-cost)/price:0;
    const model={...realModel,catalogCount:1,noPriceCount:0,stalePriceCount:0,exampleCount:0,allExampleCount:0,fixed:String(expense),variable:'0',plannedExpenses:String(expense),coverage,equalWeightMargin:String(margin),marginPercent:String(margin*100),breakEvenRevenue:margin>0?String(expense/margin):null,breakEvenDaily:margin>0?String(expense/margin/30):null,breakEvenPerStore:margin>0?String(expense/margin/30):null,reason:margin>0?'ready':coverage?'nonpositive_margin':'no_coverage'};
    await page.route('**/api/v1/portal/state',route=>route.fulfill({json:fixture}));
    await page.route('**/api/v1/portal/catalogue-model',route=>route.fulfill({json:model}));
    await page.reload();await page.locator('[data-budget-mode=catalog]').click();await until(async()=>(await page.locator('.be').innerText()).includes(message),'correct analytical state: '+message);
    await page.unroute('**/api/v1/portal/state');await page.unroute('**/api/v1/portal/catalogue-model');
  }
  page.off('request',onRequest);
  assert.deepEqual(errors, []);
  console.log('PASS: budget names/amounts separated, short/long names, 44px controls, 1440/1024/768/390/320 in both system themes, autosave 12345.67 and reload; failed/invalid drafts, retry, pending route protection, independent budget count, orphan external deletion, one pending DELETE, owner UI, zero/missing/loss analytical states.');
})().catch(async error => {
  if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'tsukenya-budget-failure.png'), fullPage: true }).catch(() => {});
  console.error(error); process.exitCode = 1;
}).finally(async () => {
  await browser?.close(); server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  fs.rmSync(data, { recursive: true, force: true });
});
