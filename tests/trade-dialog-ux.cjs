/* Targeted isolated ERP checks. Called by ui-audit.cjs, never production. */
const assert = require('node:assert/strict');
module.exports = async function tradeDialogUX(page, base, wait) {
  const go = async tab => {
    await page.goto(`${base}/#trade/${tab}`, {waitUntil: 'domcontentloaded'});
    await wait(async () => (await page.locator('#main').innerText()).trim() && !(await page.locator('#main').innerText()).includes('Завантаження обліку'));
  };
  const active = () => page.locator('.trade-dialog[open]');
  const decline = () => page.once('dialog', d => d.dismiss());
  const discard = () => page.once('dialog', d => d.accept());
  const close = async () => {
    if(await active().count()) {
      if(await active().getAttribute('data-dirty') === '1') discard();
      await active().locator('[data-trade=close]').click();
      await wait(async () => !(await active().count()));
    }
  };
  const api = (endpoint, method='GET', body) => page.evaluate(async ({endpoint, method, body}) => {
    const state = await (await fetch('/api/state')).json();
    const response = await fetch('/api/erp/'+endpoint, {method, headers:{'Content-Type':'application/json', 'X-CSRF-Token':state.csrf}, body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status, body:await response.json()};
  }, {endpoint, method, body});
  const ok = async (...args) => {const response=await api(...args);assert(response.status<300, JSON.stringify(response));return response.body;};
  const state = await ok('state'), store=state.stores[0].id, cash=state.accounts.find(a=>a.kind==='cash').id;
  const today = await page.evaluate(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
  const warehouse=state.warehouses[0].id;
  if(process.env.QA_TRADE_FROM==='price'){await priceAndCashier();console.log('ERP price and scoped cashier tail passed');return;}
  await go('sales');
  const newSale = page.locator('[data-trade=new-voucher][data-kind=sale]');
  await newSale.click();
  await page.locator('#tradeVoucherForm').waitFor();
  await active().locator('[data-trade=remove-line]').click();
  assert.equal(await active().getAttribute('data-dirty'), '1', 'Removing an untouched row marks draft dirty');
  decline();
  await active().locator('[data-trade=close]').click();
  assert.equal(await active().count(), 1, 'Declining discard preserves editor');
  decline();
  await page.evaluate(() => location.hash = '#trade/stock');
  await wait(async () => page.url().endsWith('#trade/sales'));
  assert.equal(await active().count(), 1, 'Browser history route guard preserves editor');
  await close();
  assert.equal(await newSale.evaluate(el => document.activeElement === el), true, 'Closing returns focus to opener');

  await newSale.click();
  await page.locator('#tradeVoucherForm').waitFor();
  await active().locator('[data-trade=add-line]').click();
  assert.equal(await active().locator('.trade-line').count(), 2);
  await active().locator('[data-trade=remove-line]').last().click();
  assert.equal(await active().locator('.trade-line').count(), 1);
  assert.equal(await active().locator('[data-line=product]').evaluate(el => document.activeElement === el), true, 'Deleted row transfers keyboard focus to remaining row');
  await active().locator('[data-trade=add-payment]').click();
  await active().locator('[data-trade=remove-payment]').click();
  assert.equal(await active().locator('[data-trade=add-payment]').evaluate(el => document.activeElement === el), true, 'Deleted last payment focuses add action');
  for(const width of [1440, 390, 320]) {
    await page.setViewportSize({width, height:1000});
    await active().locator('[data-trade=add-payment]').click();
    for(const selector of ['[data-trade=remove-line]', '[data-trade=remove-payment]']) {
      const rect = await active().locator(selector).first().boundingBox();
      assert(rect.width >= 44 && rect.height >= 44, `${selector} touch target at ${width}: ${JSON.stringify(rect)}`);
    }
    assert.equal(await active().evaluate(d => d.scrollWidth > d.clientWidth + 1), false, `Sale dialog overflow at ${width}`);
    await active().locator('[data-trade=remove-payment]').click();
  }
  await close();
  await page.setViewportSize({width:1440, height:1000});

  // Gate a failure: inputs cannot be edited or the dialog discarded while it is saving.
  await go('customers');
  await page.locator('[data-trade=entity][data-party-kind=customer]').click();
  await active().locator('[name=name]').fill('Тест захисту форми');
  await active().locator('[name=phone]').evaluate(el => el.disabled = true);
  let requests = 0, release;
  const gate = new Promise(resolve => release = resolve);
  const entityURL = '**/api/erp/entities/parties';
  const entityHandler = async route => {
    if(route.request().method() !== 'POST') return route.continue();
    requests++;
    await gate;
    await route.fulfill({status:400, contentType:'application/json', body:JSON.stringify({error:'Тестова помилка збереження'})});
  };
  await page.route(entityURL, entityHandler);
  await active().locator('button[type=submit]').click();
  await wait(async () => await active().getAttribute('aria-busy') === 'true');
  assert.equal(await active().locator('[name=name]').isDisabled(), true);
  assert.equal(await active().locator('[data-trade=close]').isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await active().count(), 1, 'Escape cannot discard an in-flight write');
  assert.equal(await page.evaluate(() => window.Trade.canLeave()), false, 'Route change rejected during save');
  await page.evaluate(() => document.getElementById('tradeEntityForm').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true})));
  assert.equal(requests, 1, 'Duplicate submit ignored while busy');
  release();
  await wait(async () => await active().getAttribute('aria-busy') !== 'true');
  assert.equal(await active().locator('[name=name]').inputValue(), 'Тест захисту форми');
  assert.equal(await active().locator('[name=name]').isDisabled(), false);
  assert.equal(await active().locator('[name=phone]').isDisabled(), true, 'Existing disabled state survives failed write');
  assert.equal(await active().locator('[data-trade=close]').isDisabled(), false);
  assert.equal(await active().locator('#tradeFormError').innerText(), 'Тестова помилка збереження');
  assert.equal(await active().locator('#tradeFormError').evaluate(el => document.activeElement === el), true, 'Server error receives keyboard focus');
  await page.unroute(entityURL, entityHandler);
  await close();

  // Reporting failures preserve editable filters and the last successful report.
  await go('reports');
  await page.locator('#boundedReportRows tbody tr').waitFor();const previousReport = await page.locator('[data-report-summary]').innerText();
  let releaseReport;
  const reportGate = new Promise(resolve => releaseReport = resolve);
  const reportURL = '**/api/v1/trading/reports/summary?*';
  const reportHandler = async route => {
    await reportGate;
    await route.fulfill({status:503, contentType:'application/json', body:JSON.stringify({error:'Тестова помилка звіту'})});
  };
  await page.route(reportURL, reportHandler);
  await page.locator('[data-report-form] button[type=submit]').click();
  await wait(async () => await page.locator('[data-report-form]').getAttribute('aria-busy') === 'true');
  assert.equal(await page.locator('[data-report-form] [name=from]').isDisabled(), true);
  releaseReport();
  await wait(async () => await page.locator('[data-report-form]').getAttribute('aria-busy') !== 'true');
  assert.equal(await page.locator('[data-report-summary]').innerText(), previousReport);
  assert.equal(await page.locator('[data-report-error]').innerText(), 'Не вдалося прочитати звіт. Повторіть запит.');assert.match(await page.locator('[data-report-status]').innerText(),/попередній підтверджений/);assert.equal(await page.locator('[data-report-export][href]').count(),0);assert.equal(await page.locator('[data-report-source]:not([disabled])').count(),0);
  assert.equal(await page.locator('[data-report-form] [name=from]').isDisabled(), false);
  await page.unroute(reportURL, reportHandler);
  const zeroEmployee = (await ok('entities/employees','POST',{name:'Нульовий відсоток',store,shift_rate:400,bonus_percent:0,bonus_basis:'store'})).id;
  const workShift = (await ok('work-shifts','POST',{employee:zeroEmployee,date:today,units:1,shift_rate:400,bonus_percent:0,bonus_basis:'store'})).id;
  await go('staff');
  await page.locator('[data-trade=work-shift]:not([data-id])').click();
  await active().locator('[name=employee]').selectOption(String(zeroEmployee));
  await active().locator('[data-cash-choice]').waitFor();
  await wait(async()=>!(await active().locator('[data-cash-choice]').isDisabled()));
  assert.equal(await active().locator('[data-cash-choice]').getAttribute('required'), null, 'Zero bonus permits no cash shift');
  assert.equal(await active().locator('[name=units]').getAttribute('min'), '0.01');
  assert.equal(await active().locator('[name=units]').getAttribute('max'), '10');
  assert.equal(await active().locator('[name=date]').getAttribute('max'), today);
  await active().locator('[name=bonus_percent]').fill('5');
  assert.equal(await active().locator('[data-cash-choice]').getAttribute('required'), '', 'Nonzero bonus requires linked cash shift');
  await close();
  await ok('entities/employees','POST',{id:zeroEmployee,name:'Нульовий відсоток',store,shift_rate:400,bonus_percent:0,bonus_basis:'store',active:false});
  await go('staff');
  await page.locator(`[data-trade=work-shift][data-id="${workShift}"]`).click();
  assert.equal(await active().locator('[name=employeeDisplay]').isDisabled(), true);
  assert.equal(await active().locator('[name=employee]').inputValue(), String(zeroEmployee), 'Inactive historical employee remains selected');
  assert.equal(await active().locator('[name=date]').getAttribute('readonly'), '');
  await close();

  await go('setup');
  await page.locator(`[data-trade=entity][data-entity=accounts][data-id="${cash}"]`).click();
  assert.equal(await active().locator('[name=storeDisplay]').isDisabled(), true);
  assert.equal(await active().locator('[name=kindDisplay]').isDisabled(), true);
  const immutable = await active().locator('form').evaluate(form=>Object.fromEntries(new FormData(form)));
  assert.equal(immutable.store, String(store));
  assert.equal(immutable.kind, 'cash');
  await close();
  await page.locator('[data-trade=users]').click();
  await active().locator('[data-trade=user-edit]:not([data-id])').click();
  assert.equal(await active().locator('[name=username]').getAttribute('minlength'), '3');
  assert.equal(await active().locator('[name=username]').getAttribute('maxlength'), '80');
  assert.equal(await active().locator('[name=password]').getAttribute('maxlength'), '256');
  await close();

  const secondStore=(await ok('entities/stores','POST',{name:'Інший тестовий магазин'})).id;
  const secondWarehouse=(await ok('entities/warehouses','POST',{name:'Інший тестовий склад',store:secondStore})).id;
  const foreignEmployee=(await ok('entities/employees','POST',{name:'Працівник іншого магазину',store:secondStore,shift_rate:0,bonus_percent:0,bonus_basis:'store'})).id;
  await go('sales');
  await page.locator('[data-trade=shift-open]').click();
  await active().locator('[name=account]').selectOption(String(cash));
  const offeredEmployees=await active().locator('[name=employee] option').evaluateAll(options=>options.map(o=>o.value));
  assert.equal(offeredEmployees.includes(String(foreignEmployee)),false,'Cash employees follow selected cash account store');
  await close();

  const mockStock={totals:[{warehouse,name:'Видимий складський товар',product:'visible',quantity:'1',available:'1',value:'10',unit:'шт',minimum:'2',low:true},{warehouse:secondWarehouse,name:'Інший складський товар',product:'other',quantity:'2',available:'2',value:'20',unit:'шт',minimum:'3',low:true}],lots:[{id:1,warehouse,name:'Видимий складський товар',product:'visible',quantity:'1',value:'10',unit:'шт',lot:'VISIBLE',expiry:today,expired:false},{id:2,warehouse:secondWarehouse,name:'Інший складський товар',product:'other',quantity:'2',value:'20',unit:'шт',lot:'OTHER',expiry:today,expired:false}]};
  const filteredStock=query=>{const visible=x=>!query.get('store')||(x.warehouse===warehouse?store:secondStore)===Number(query.get('store'));return {totals:mockStock.totals.filter(visible),lots:mockStock.lots.filter(visible)};};
  const stockURL='**/api/erp/stock?*', stockHandler=route=>{const query=new URL(route.request().url()).searchParams,filtered=filteredStock(query),items=query.get('view')==='lots'?filtered.lots:filtered.totals;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items,total:items.length,page:1,pages:1,limit:30,summary:{value:String(filtered.totals.reduce((sum,x)=>sum+Number(x.value),0)),low:filtered.totals.length,expiry:filtered.lots.length,lots:filtered.lots.length,products:filtered.totals.length}})});};
  const stockCsvURL='**/api/erp/stock.csv?*', stockCsvHandler=route=>{const filtered=filteredStock(new URL(route.request().url()).searchParams),csv=require('../app/csv.js');return route.fulfill({status:200,headers:{'Content-Disposition':'attachment; filename="stock.csv"'},contentType:'text/csv',body:csv.serialize(['Товар','Склад','Кількість','Доступно','Од.','Вартість'].map((label,index)=>({label,kind:[2,3,5].includes(index)?'number':'text'})),filtered.totals.map(x=>[x.name,String(x.warehouse),x.quantity,x.available,x.unit,x.value]),{reversible:true})});};
  await page.route(stockCsvURL,stockCsvHandler);
  await page.route(stockURL,stockHandler);
  await go('stock');
  await page.locator('[name=filterStore]').selectOption(String(store));
  await wait(async()=>!(await page.locator('#main').innerText()).includes('Інший складський товар'));
  await page.locator('[data-disclosure=stock-lots]').evaluate(el=>el.open=true);
  await wait(async()=>(await page.locator('#main').innerText()).includes('VISIBLE'));
  assert.equal((await page.locator('#main').innerText()).includes('OTHER'),false,'Lot detail respects store filter');
  const downloadPromise=page.waitForEvent('download');
  await page.locator('[data-trade=stock-csv]').click();
  const download=await downloadPromise,stream=await download.createReadStream();
  const csv=await new Promise((resolve,reject)=>{let content='';stream.on('data',chunk=>content+=chunk.toString());stream.on('end',()=>resolve(content));stream.on('error',reject);});
  assert(csv.includes('Видимий складський товар'));
  assert.equal(csv.includes('Інший складський товар'),false,'CSV matches filtered rows');
  await page.unroute(stockURL,stockHandler);await page.unroute(stockCsvURL,stockCsvHandler);

  await priceAndCashier();
  async function priceAndCashier(){
  const legacy=await page.evaluate(async()=>await(await fetch('/api/state')).json()),product=legacy.data.products[0].id;
  const precise=await ok('vouchers','POST',{kind:'opening',date:today,store,warehouse,lines:[{product,quantity:'1',price:'0.3333'}]});
  await go('stock');
  await page.locator('[data-trade=refresh]').click();
  await page.locator(`[data-trade=view][data-id="${precise.id}"]`).click();
  assert((await active().innerText()).includes('0,3333 грн'),'Document unit price preserves all four supported decimals');
  await close();

  // Real scoped cashier session: an owner shift must not offer Close or selection for sale.
  const password='isolated-crm-test-password';
  await ok('users','POST',{username:'ui_cashier',password,role:'cashier',store,active:true});
  await ok('shifts','POST',{account:cash});
  const cashierContext=await page.context().browser().newContext({viewport:{width:390,height:1000}});
  try {
    const login=await cashierContext.request.post(base+'/api/login',{headers:{Origin:base},data:{username:'ui_cashier',password}});
    assert.equal(login.status(),200);
    const cashierPage=await cashierContext.newPage();
    await cashierPage.route('https://fonts.googleapis.com/**',route=>route.abort());
    await cashierPage.route('https://fonts.gstatic.com/**',route=>route.abort());
    await cashierPage.goto(base+'/#trade/sales',{waitUntil:'domcontentloaded'});
    await cashierPage.locator('[data-trade=shift-open]').waitFor();
    assert.equal(await cashierPage.locator('[data-trade=shift-close]').count(),0,'Cashier cannot close another cashier shift');
    await cashierPage.locator('[data-trade=new-voucher][data-kind=sale]').click();
    await cashierPage.locator('#tradeVoucherForm').waitFor();
    assert.equal(await cashierPage.locator('[name=shift] option:not([value=""])').count(),0,'Other cashier shift unavailable for new sale');
    await cashierPage.locator('.trade-dialog [data-trade=close]').click();
    await cashierPage.goto(base+'/#trade/stock',{waitUntil:'domcontentloaded'});
    await cashierPage.locator('[data-trade=stock-csv]').waitFor();
    assert.equal((await cashierPage.locator('#main').innerText()).includes('Вартість залишків'),false,'Unavailable stock cost is never displayed as zero');
  } finally {await cashierContext.close();}
  }
  console.log('ERP dialog UX: dirty/history/focus, 44px targets, in-flight/duplicate submit, disabled restoration, report errors, immutable dictionaries, payroll constraints, store dependencies, filtered CSV, decimal price and cashier actions passed');
};
