/* Actual Reports workspace, isolated synthetic SQLite, bundled headless Chromium. */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-react-reports-'));
const python = process.env.PYTHON_BIN || 'python3', port = Number(process.env.QA_REACT_REPORTS_PORT || 18561), base = `http://localhost:${port}`;
const stage = process.env.QA_REACT_REPORTS_STAGE || 'all', password = 'synthetic-reports-qa-password';
assert(['all', 'sections', 'callbacks', 'payment', 'layout', 'privacy', 'detail', 'tail', 'heading', 'grant', 'grant-late', 'payment-late'].includes(stage));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('DB_') || key.startsWith('PG') || ['DATABASE_URL', 'POSTGRES_URL', 'TSUKENYA_REQUIRE_POSTGRES', 'DATA_DIR', 'ERP_DB_PATH'].includes(key)) delete env[key];
Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, ERP_DB_PATH: path.join(data, 'qa.sqlite3'), DJANGO_SECRET_KEY: 'synthetic-reports-native-tests-fifty-characters-private-fixture', OWNER_USERNAME: 'tester' });
env.OWNER_PASSWORD_HASH = execFileSync(python, ['-c', `from server.auth import hash_password;print(hash_password('${password}'))`], { cwd: root, env, encoding: 'utf8' }).trim();
const log = fs.openSync(path.join(data, 'server.log'), 'w'), server = spawn(python, ['-m', 'server.main'], { cwd: root, env, stdio: ['ignore', log, log] });
const requests = [], errors = [], evidence = []; let browser, page;
const wait = async fn => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Reports condition timed out'); };
const pass = name => { evidence.push(name); console.log(name + ' PASS'); };
const pythonRun = source => execFileSync(python, ['-c', `import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')\nimport django;django.setup()\n${source}`], { cwd: root, env, encoding: 'utf8' });
(async () => {
  await wait(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } });
  pythonRun(`from django.contrib.auth.models import User
from django.utils import timezone
from server.erp.models import *
from tests.test_bounded_reports import BoundedReportsTests
f=BoundedReportsTests();f.u=User.objects.get(username='tester');f.store=Store.objects.first();f.wh=Warehouse.objects.first();f.cash=CashAccount.objects.first();f.bank=f.cash;f.today=timezone.localdate().isoformat();f.party=Counterparty.objects.create(name='Постачальник');f.customer=Counterparty.objects.create(name='Покупець',kind='customer');f.wide()
Document.objects.filter(pk='products/w1').update(data={'name':'<img src=x onerror=alert(1)>','unit':'шт'})
VoucherLine.objects.filter(product_id='products/w1').update(name='<img src=x onerror=alert(1)>')
`);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.url().includes('/api/')) requests.push({ url: r.url(), method: r.method() }); });
  await require('./browser-login.cjs')(page, base, password); await page.goto(base + '/#trade/reports');
  const workspace = page.locator('[data-react-reports]'), pager = workspace.locator('[data-report-pager]');
  const ready = async () => wait(async () => await workspace.locator('[data-report-form]').getAttribute('aria-busy').then(x => x === 'false').catch(() => false) && await pager.count() === 1);
  const region = title => workspace.getByRole('region', { name: title, exact: true });
  const select = async (section, title) => { await workspace.locator(`[data-report-section=${section}]`).click(); await ready(); await region(title).waitFor(); };
  const mode = async value => { await workspace.locator(`[data-report-mode=${value}]`).click(); await ready(); };
  await ready(); await region('Товари').waitFor();
  assert.equal(await region('Товари').locator('tbody tr').count(), 30); assert.equal(await region('Товари').locator('img').count(), 0);
  assert((await region('Товари').innerText()).includes('<img src=x'));
  pass('actual React initial page30 / escaped name');
  if (['all', 'heading'].includes(stage)) {
    for (const width of [1440, 320]) {
      await page.setViewportSize({width,height:1000}); await page.evaluate(()=>scrollTo(0,0));
      const title=page.getByRole('heading',{name:'Звіти',exact:true}), tabs=workspace.getByRole('tablist',{name:'Режим фінансового звіту',exact:true});
      assert.equal(await title.count(),1); assert.equal(await workspace.getAttribute('aria-label'),'Фінансові звіти');
      const heading=await title.boundingBox(), modes=await tabs.boundingBox();
      assert(heading && modes && modes.y>=heading.y+heading.height && modes.x>=0 && modes.x+modes.width<=width+1);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:path.join(data,`heading-${width}.png`)});
    }
    await page.setViewportSize({width:1440,height:1000}); pass('single shell Reports title / named workspace / mode bounds1440+320');
  }
  if (['all', 'sections'].includes(stage)) {
    await pager.getByRole('button', { name: 'Наступна' }).press('Enter'); await ready();
    assert.match(await pager.innerText(), /Сторінка 2 із 3/); assert.equal(await region('Товари').locator('tbody tr').count(), 30);
    await pager.getByRole('button', { name: 'Наступна' }).click(); await ready(); assert.equal(await region('Товари').locator('tbody tr').count(), 5);
    const download = page.waitForEvent('download'); await workspace.locator('[data-report-search] [data-report-export]').click();
    const csv = fs.readFileSync(await (await download).path(), 'utf8'); assert.equal(csv.split('\r\n').filter(Boolean).length, 67); assert(csv.includes('\t=1+1'));
    for (const [key, title] of [['by_store', 'Магазини'], ['expenses_by_category', 'Статті витрат'], ['cashiers', 'Касири']]) { await select(key, title); assert.equal(await region(title).locator('tbody tr').count(), 30); }
    await mode('balances');
    for (const [key, title] of [['stock', 'Товарні залишки'], ['cash', 'Кошти'], ['debts', 'Історичні борги'], ['advances', 'Аванси'], ['payroll_debts', 'Борги із зарплати']]) { await select(key, title); assert.equal(await region(title).locator('tbody tr').count(), 30); }
    assert.equal(await workspace.locator('[data-report-current-debts]').count(), 0);
    const all = page.waitForEvent('download'); await workspace.locator('[data-report-summary] [data-report-export]').click(); const allCsv = fs.readFileSync(await (await all).path(), 'utf8');
    assert(allCsv.includes('Касир064')); assert(allCsv.includes('Покупець')); assert(allCsv.includes('Постачальник'));
    pass('all nine sections / pages30+30+5 / complete section and all-balances CSV');
    await workspace.locator('[data-report-mode=abc]').press('Enter'); await workspace.getByRole('heading', { name: 'ABC-аналітика товарів' }).waitFor();
    await workspace.getByRole('button', { name: 'Показати ABC', exact: true }).click(); await wait(async () => await workspace.locator('.tk-abc [role=status]').innerText().then(t => !t.includes('Обчислення')).catch(() => false));
    assert(await workspace.locator('.tk-abc').innerText().then(t => t.includes('Товар064') || t.includes('Товар'))); assert(requests.some(r => r.url.includes('/reports/abc')));
    pass('direct ABC actual consumer / unchanged server API');
  }
  if (['all', 'callbacks', 'payment'].includes(stage)) {
    await mode('period'); await ready();
    if(stage !== 'payment') {
    await workspace.locator('.trade-report-source-actions summary').press('Enter'); const source = workspace.locator('[data-report-source][data-metric=expenses]'); await source.press('Enter');
    const sources = page.locator('[data-report-sources]'); await sources.locator('[data-source-voucher]').first().waitFor(); assert.equal(await sources.locator('[data-source-voucher]').count(), 30); assert.match(await sources.innerText(), /195,00 грн/);
    assert(await sources.locator('h2').evaluate(e => e === document.activeElement)); await sources.locator('[data-source-voucher]').first().press('Enter');
    const voucher = page.locator('dialog[open]').last(); await voucher.getByRole('heading', { name: 'Витрата · № 000003', exact: true }).waitFor(); assert.match(await voucher.innerText(), /Крамниця000/); assert.match(await voucher.innerText(), /3,00 грн/); await voucher.press('Escape');
    await sources.waitFor({ state: 'detached' }); await wait(() => source.evaluate(e => e === document.activeElement));
    pass('strict source dialogue → real voucher / Escape opener');
    }
    const debt = workspace.locator('[data-report-current-debts]'); await debt.getByRole('button', { name: /Оплатити борг за документом/ }).first().waitFor();
    const opener = debt.getByRole('button', { name: /Оплатити борг за документом/ }).first(); await opener.press('Enter');
    const payment = page.locator('dialog[open]').last(); await payment.getByRole('heading', { name: /Платіж/ }).waitFor(); await payment.getByRole('button', { name: 'Закрити вікно', exact: true }).click();
    await payment.waitFor({ state: 'detached' }); await wait(() => opener.evaluate(e => e === document.activeElement));
    pass('current debt → native payment / Close opener / no write');
  }
  if (['all', 'tail', 'layout'].includes(stage)) {
    const bounds = async selector => page.locator(selector).evaluateAll(nodes => nodes.filter(n => n.getClientRects().length).map(n => { const r = n.getBoundingClientRect(); return { text: n.textContent.slice(0,80), left: r.left, right: r.right, width: r.width }; }).filter(r => r.left < -1 || r.right > innerWidth + 1));
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 1000 }); await mode('period');
      for (const [key, title] of [['products','Товари'],['cashiers','Касири']]) {
        await select(key,title); await region(title).locator('tbody tr').first().scrollIntoViewIfNeeded();
        assert.deepEqual(await bounds('.reports-table-wrap, .reports-table, .reports-table td button, .reports-table td summary, [data-report-pager] button'), [], `${key} geometry${width}`);
        await page.screenshot({ path: path.join(data, `${key}-${width}.png`) });
      }
      const debt = workspace.locator('[data-report-current-debts]'); await debt.getByRole('button', { name: /Оплатити борг/ }).first().scrollIntoViewIfNeeded();
      assert.deepEqual(await bounds('[data-report-current-debts] .reports-table, [data-report-current-debts] button'), [], `debts geometry${width}`);
      await page.screenshot({ path: path.join(data, `debts-${width}.png`) });
      await mode('balances'); await select('stock','Товарні залишки'); await region('Товарні залишки').locator('tbody tr').first().scrollIntoViewIfNeeded();
      assert.deepEqual(await bounds('.reports-table-wrap, .reports-table, .reports-table button'), [], `stock geometry${width}`); await page.screenshot({ path: path.join(data, `stock-${width}.png`) });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    pass('1440/320 actual table, actions, details, payment and source bounds');
  }
  if (['all', 'grant'].includes(stage)) {
    await page.setViewportSize({width:1440,height:1000}); await mode('period');
    await workspace.locator('.trade-report-source-actions summary').press('Enter');
    await workspace.locator('[data-report-source][data-metric=revenue]').press('Enter');
    const sources=page.locator('[data-report-sources]'), document=sources.locator('[data-source-voucher]').first(); await document.waitFor();
    const id=await document.getAttribute('data-source-voucher');
    pythonRun(`from server.erp.models import Profile,Voucher;v=Voucher.objects.get(pk=${Number(id)});Profile.objects.filter(user__username='tester').update(role='cashier',store=v.store)`);
    const readable=await page.context().request.get(base+'/api/erp/vouchers/'+id); assert.equal(readable.status(),200);
    const sale=await readable.json(); assert.equal(sale.kind,'sale');assert.equal(Object.hasOwn(sale,'cost'),false);
    const before=requests.filter(r=>new URL(r.url).pathname==='/api/v1/trading/documents/'+id).length;
    await document.press('Enter');await workspace.getByRole('alert').waitFor();
    assert.equal(await workspace.locator('[data-report-summary],[data-report-current-debts],[data-report-export]').count(),0);assert.equal(await page.locator('dialog[open]').count(),0);
    assert.equal(requests.filter(r=>new URL(r.url).pathname==='/api/v1/trading/documents/'+id).length,before);
    pass('source revalidates Reports grant: readable cashier SALE200/redacted, no native fetch/modal, private report cleared');
    pythonRun("from server.erp.models import Profile;Profile.objects.filter(user__username='tester').update(role='owner',store=None)");
    await page.goto('about:blank');await page.goto(base+'/#trade/reports');await ready();
    const debt=workspace.locator('[data-report-current-debts]').getByRole('button',{name:/Оплатити борг за документом/}).first();await debt.waitFor();
    const debtId=Number((await debt.getAttribute('aria-label')).match(/(\d+)$/)[1]);
    pythonRun("from server.erp.models import Profile;Profile.objects.filter(user__username='tester').update(role='accountant')");
    const permitted=await page.context().request.get(base+'/api/erp/references?purpose=payment&id='+debtId);assert.equal(permitted.status(),200);assert.equal((await permitted.json()).items[0].id,debtId);
    const refs=requests.filter(r=>new URL(r.url).pathname==='/api/erp/references').length;
    await debt.press('Enter');await workspace.getByRole('alert').waitFor();
    assert.equal(await workspace.locator('[data-report-summary],[data-report-current-debts],[data-report-export]').count(),0);assert.equal(await page.locator('dialog[open]').count(),0);
    assert.equal(requests.filter(r=>new URL(r.url).pathname==='/api/erp/references').length,refs);
    pass('payment callback rejects changed Reports identity despite allowed accountant references200; no native form or businesswrite');
    pythonRun("from server.erp.models import Profile;Profile.objects.filter(user__username='tester').update(role='owner',store=None)");
    if(stage==='all'){await page.goto('about:blank');await page.goto(base+'/#trade/reports');await ready();}
  }
  if (['all','grant-late'].includes(stage)) {
    await mode('period'); await workspace.locator('.trade-report-source-actions summary').press('Enter');
    await workspace.locator('[data-report-source][data-metric=revenue]').press('Enter');
    const sources=page.locator('[data-report-sources]'), document=sources.locator('[data-source-voucher]').first();await document.waitFor();
    const id=await document.getAttribute('data-source-voucher'), url='**/api/v1/trading/documents/'+id;let held;
    await page.route(url,route=>{held=route;});await document.press('Enter');await wait(()=>!!held);
    pythonRun(`from server.erp.models import Profile,Voucher;v=Voucher.objects.get(pk=${Number(id)});Profile.objects.filter(user__username='tester').update(role='cashier',store=v.store)`);
    const response=await page.context().request.get(base+'/api/v1/trading/documents/'+id);assert.equal(response.status(),200);const sale=await response.json();assert.equal(sale.document.kind,'sale');assert.equal(sale.document.cost,null);assert.equal(sale.context.role,'cashier');
    await held.fulfill({status:200,contentType:'application/json',body:JSON.stringify(sale)});await page.locator('#main').getByRole('alert').waitFor();
    assert.equal(await page.locator('[data-report-summary],[data-report-current-debts],[data-report-export]').count(),0);assert.equal(await page.locator('dialog[open]').count(),0);
    await page.unroute(url);pass('post-SALEGET fresh Reports grant: owner preflight, cashier real200/redacted after heldGET, no private native DOM');
    pythonRun("from server.erp.models import Profile;Profile.objects.filter(user__username='tester').update(role='owner',store=None)");
    if(stage==='all'){await page.goto('about:blank');await page.goto(base+'/#trade/reports');await ready();}
  }
  if (['all','payment-late'].includes(stage)) {
    const debt=workspace.locator('[data-report-current-debts]').getByRole('button',{name:/Оплатити борг за документом/}).first();await debt.waitFor();
    const id=Number((await debt.getAttribute('aria-label')).match(/(\d+)$/)[1]), url='**/api/erp/references?purpose=payment&id='+id;let held;
    await page.route(url,route=>{held=route;});await debt.press('Enter');await wait(()=>!!held);
    pythonRun("from server.erp.models import Profile;Profile.objects.filter(user__username='tester').update(role='accountant')");
    const response=await page.context().request.get(base+'/api/erp/references?purpose=payment&id='+id);assert.equal(response.status(),200);const refs=await response.json();assert.equal(refs.items[0].id,id);
    await held.fulfill({status:200,contentType:'application/json',body:JSON.stringify(refs)});await workspace.getByRole('alert').waitFor();
    assert.equal(await workspace.locator('[data-report-summary],[data-report-current-debts],[data-report-export]').count(),0);assert.equal(await page.locator('dialog[open]').count(),0);
    await page.unroute(url);pass('post-references/ensure fresh Reports grant: owner preflight, accountant real references200 after heldGET, no payment modal or businesswrite');
    pythonRun("from server.erp.models import Profile;Profile.objects.filter(user__username='tester').update(role='owner',store=None)");
    if(stage==='all'){await page.goto('about:blank');await page.goto(base+'/#trade/reports');await ready();}
  }
  if (['all', 'tail', 'detail'].includes(stage)) {
    await mode('period'); await workspace.locator('.trade-report-source-actions summary').press('Enter');
    await workspace.locator('[data-report-source][data-metric=expenses]').press('Enter');
    const sources=page.locator('[data-report-sources]'); await sources.locator('[data-source-voucher]').first().waitFor();
    pythonRun("from server.erp.models import Profile;Profile.objects.filter(user__username='tester').update(role='warehouse')");
    await sources.locator('[data-source-voucher]').first().press('Enter'); await workspace.getByRole('alert').waitFor();
    assert.equal(await workspace.locator('[data-report-summary], [data-report-current-debts], [data-report-export]').count(),0); assert.equal(await page.locator('dialog[open]').count(),0);
    pass('actual revoked-role source document403 clears report and callbacks');
    pythonRun("from server.erp.models import Profile;Profile.objects.filter(user__username='tester').update(role='owner')");
    await page.goto('about:blank'); await page.goto(base+'/#trade/reports'); await ready();
    await page.route('**/api/v1/trading/reports/abc?*', route=>route.fulfill({status:403,contentType:'application/json',body:'{}'}));
    await workspace.locator('[data-report-mode=abc]').press('Enter'); await workspace.getByRole('alert').waitFor();
    assert.equal(await workspace.locator('table, [role=combobox], [data-report-export], .tk-abc').count(),0);
    await page.unroute('**/api/v1/trading/reports/abc?*');
    pass('current ABC403 clears workspace including filters/private captions');
    if(['all','tail'].includes(stage)){await page.goto('about:blank');await page.goto(base+'/#trade/reports');await ready();}
  }
  if (['all', 'tail', 'privacy'].includes(stage)) {
    await page.setViewportSize({ width: 1440, height: 1000 }); await mode('period');
    const rowsURL = '**/api/v1/trading/reports/rows?*'; let bad = true;
    await page.route(rowsURL, route => bad ? (bad = false, route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })) : route.continue());
    await pager.getByRole('button', { name: 'Наступна' }).click(); await workspace.locator('[data-report-retry]').waitFor(); assert.equal(await workspace.locator('[data-report-export][href]').count(), 0);
    await workspace.locator('[data-report-retry]').press('Enter'); await ready(); assert.match(await pager.innerText(), /Сторінка 2 із 3/); await page.unroute(rowsURL);
    await page.route(rowsURL, route => route.fulfill({ status: 403, contentType: 'application/json', body: '{}' }));
    await workspace.locator('[data-report-form] [type=submit]').click(); await workspace.getByRole('alert').waitFor();
    assert.equal(await workspace.locator('[data-report-summary], [data-report-current-debts], [data-report-export], [data-report-source]').count(), 0); await page.unroute(rowsURL);
    pass('malformed200 clears actions / exact page GET retry / current403 clears all private report areas');
  }
  assert.deepEqual(errors, []);
  assert.equal(requests.filter(r => /\/api\/erp\/(report\?|state)/.test(r.url) || r.url.endsWith('/api/state')).length, 0);
  assert.deepEqual(requests.filter(r => r.method !== 'GET' && !r.url.endsWith('/api/login') && !r.url.endsWith('/api/v1/trading/directories/details')), []);
  fs.writeFileSync(path.join(data, 'report.json'), JSON.stringify({ stage, evidence, requests, errors }, null, 2)); console.log('REACT REPORTS PASS ' + data);
})().catch(async error => { console.error(error); fs.writeFileSync(path.join(data, 'partial-report.json'), JSON.stringify({stage,evidence,requests,errors,passed:false},null,2)); if (page) { fs.writeFileSync(path.join(data, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(data, 'failure.png') }).catch(() => {}); } console.error('Artifacts ' + data); process.exitCode = 1; }).finally(async () => { await browser?.close(); server.kill(); fs.closeSync(log); });
