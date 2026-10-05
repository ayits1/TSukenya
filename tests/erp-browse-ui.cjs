const finance=require('./finance-navigation.cjs');
const {documentButton}=require('./trading-document-controls.cjs');
/* Source lookup/history and scoped roles, against ui-audit's isolated database. */
const assert=require('node:assert/strict'),os=require('node:os'),path=require('node:path');
module.exports=async function browseUX(page,base,wait){
 const recoveryOnly=['recovery','finance-reference'].includes(process.env.QA_BROWSE_FROM),financeOnly=['finance','finance-tail','finance-reference'].includes(process.env.QA_BROWSE_FROM),financeTail=process.env.QA_BROWSE_FROM==='finance-tail',password='isolated-crm-test-password';
 const api=(endpoint,method='GET',value)=>page.evaluate(async({endpoint,method,value})=>{const session=await(await fetch('/api/state')).json(),r=await fetch('/api/erp/'+endpoint,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:value===undefined?undefined:JSON.stringify(value)});return{status:r.status,value:await r.json()};},{endpoint,method,value});
 const ok=async(...args)=>{const result=await api(...args);assert(result.status<300,JSON.stringify(result));return result.value;};
 const state=await ok('state'),store=state.stores[0].id,warehouse=state.warehouses[0].id,cash=state.accounts.find(a=>a.kind==='cash').id,supplier=state.parties.find(p=>p.kind==='supplier').id,customer=state.parties.find(p=>p.kind==='customer').id;
 const legacy=await page.evaluate(async()=>await(await fetch('/api/state')).json()),product=legacy.data.products[0].id,today=await page.evaluate(()=>new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Kyiv'}));
 const create=async value=>{const voucher=await ok('vouchers','POST',{date:today,store,warehouse,...value});await ok(`vouchers/${voucher.id}/post`,'POST',{});return voucher;};
 const oldest=await create({kind:'receipt',party:supplier,lines:[{product,quantity:'10',price:'5'}]});
 if(!recoveryOnly)for(let i=0;i<64;i++){await create({kind:'debt_opening',party:customer,amount:'1'});await create({kind:'debt_opening',party:supplier,amount:'1'});}
 const go=async route=>{await page.goto(base+'/#trade/'+route,{waitUntil:'domcontentloaded'});await wait(async()=>(await page.locator('#main').innerText()).trim()&&!(await page.locator('#main').innerText()).includes('Завантаження обліку'));};
 const primary=()=>page.locator('.trade-dialog[open]:not(.trade-document-browser)'),picker=()=>page.locator('.trade-document-browser[open]');
 const loaded=async()=>wait(async()=>await picker().locator('[data-browse-results]').getAttribute('aria-busy')!=='true');
 const choose=async(p,host,label,text)=>{await host.getByRole('combobox',{name:label,exact:true}).fill(text);await p.getByRole('option',{name:new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).click();};
 const newPayment=async()=>{await go('finance');await finance.create(page,'payment').click();await primary().locator('#tradeAllocationForm').waitFor();await choose(page,primary(),'Контрагент',state.parties.find(p=>p.id===supplier).name);await choose(page,primary(),'Грошовий рахунок',state.accounts.find(a=>a.id===cash).name);await primary().locator('[name=amount]').fill('50.00');};
 if(!recoveryOnly){
 if(!financeTail){
 await newPayment();
 await primary().locator('[name=note]').fill('Чернетка має лишитися');await primary().locator('[data-pay=add]').click();await loaded();
 assert.match(await picker().locator('[data-browse-status]').innerText(),/із 65/);
 await picker().locator('[data-browse=next]').click();await loaded();await picker().locator('[data-browse=next]').click();await loaded();
 assert.equal(await picker().locator(`[data-browse=choose][data-id="${oldest.id}"]`).count(),1,'Old receipt is selectable beyond first30');
 await picker().locator('[name=q]').fill('№ '+String(oldest.id).padStart(6,'0'));await loaded();await wait(async()=>(await picker().locator('[data-browse=choose]').count())===1);
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await picker().evaluate(d=>d.scrollWidth>d.clientWidth+1),false,'Picker fits at'+width);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:path.join(os.tmpdir(),`tsukenya-document-picker-${width}.png`),fullPage:false});}
 await picker().locator('[data-browse=close]').click();await wait(async()=>!(await picker().count()));
 assert.equal(await primary().locator('[name=note]').inputValue(),'Чернетка має лишитися');assert.equal(await primary().locator('[data-pay=add]').evaluate(el=>document.activeElement===el),true);
 await primary().locator('[data-pay=add]').click();await loaded();await picker().locator('[name=q]').fill(String(oldest.id));await wait(async()=>(await picker().locator('[data-browse-status]').innerText()).includes('із 1'));
 await picker().locator('[data-browse=choose]').press('Enter');await wait(async()=>!(await picker().count())&&(await primary().locator('[data-allocation]').count())===1);
 assert.match(await primary().locator('[data-pay-lines]').innerText(),new RegExp('№ '+String(oldest.id).padStart(6,'0')));assert.equal(await primary().locator('[data-allocation]').inputValue(),'50.00');assert.equal(await primary().locator('[name=amount]').inputValue(),'50.00');assert.equal(await primary().locator('[name=note]').inputValue(),'Чернетка має лишитися');assert.equal(await primary().locator('[data-allocation]').evaluate(el=>document.activeElement===el),true);assert.equal(await primary().locator('[data-pay=remove]').isDisabled(),false);await primary().locator('[data-pay=remove]').click();assert.equal(await primary().locator('[data-allocation]').count(),0);assert.equal(await primary().locator('[data-pay=add]').evaluate(el=>document.activeElement===el),true);
 page.once('dialog',d=>d.accept());await primary().locator('[data-trade=close]').click();
 console.log('PASS: allocation picker65 sources, paging/search, draft/cancel/selection/removal focus and1440/390/320.');
 }
 await page.setViewportSize({width:1440,height:1000});await go('customers');await page.locator('.customer-list').getByRole('button',{name:new RegExp(state.parties.find(p=>p.id===customer).name)}).click();await page.getByRole('button',{name:'Історія документів',exact:true}).click();await loaded();
 assert.match(await picker().locator('[data-browse-status]').innerText(),/із 64/);await picker().locator('[data-browse=next]').click();await loaded();assert.match(await picker().locator('[data-browse-status]').innerText(),/31–60/);await picker().locator('[data-browse=next]').click();await loaded();assert.match(await picker().locator('[data-browse-status]').innerText(),/61–64/);
 await picker().locator('[data-browse=close]').click();
 // Failed GET leaves the parent untouched and exposes an explicit retry.
 await newPayment();await primary().locator('[name=note]').fill('Після мережевого збою');
 const url='**/api/erp/references?*',failure=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Тестова недоступність'})});await page.route(url,failure);await primary().locator('[data-pay=add]').click();await picker().locator('[data-browse=retry]').waitFor();assert.equal(await picker().locator('[data-browse-error]').innerText(),'Тестова недоступність');await page.unroute(url,failure);await picker().locator('[data-browse=retry]').click();await loaded();assert.match(await picker().locator('[data-browse-status]').innerText(),/із 65/);await page.keyboard.press('Escape');await wait(async()=>!(await picker().count()));assert.equal(await primary().locator('[name=note]').inputValue(),'Після мережевого збою');page.once('dialog',d=>d.accept());await primary().locator('[data-trade=close]').click();
 // Real accountant can pay a receipt while receipt mutation stays forbidden.
 await ok('users','POST',{username:'browse_accountant',password,role:'accountant',store,active:true});
 const context=await page.context().browser().newContext({viewport:{width:390,height:1000}});
 try{const login=await context.request.post(base+'/api/login',{headers:{Origin:base},data:{username:'browse_accountant',password}});assert.equal(login.status(),200);const p=await context.newPage();await p.route('https://fonts.googleapis.com/**',r=>r.abort());await p.route('https://fonts.gstatic.com/**',r=>r.abort());await p.goto(base+'/#trade/finance',{waitUntil:'domcontentloaded'});await finance.tab(p,'debts');await finance.search(p,String(oldest.id));await finance.debt(p,oldest.id).waitFor({timeout:10000}).catch(async error=>{throw Error(error.message+' UI: '+(await p.locator('#main').innerText()).slice(0,1500)+' API: '+JSON.stringify(await Promise.all(['state','report','ledger'].map(async path=>{const r=await p.request.get(base+'/api/erp/'+path);return{path,status:r.status(),text:(await r.text()).slice(0,160)};}))));});await finance.debt(p,oldest.id).click();await p.locator('#tradeAllocationForm').waitFor();assert.match(await p.locator('[data-pay-lines]').innerText(),new RegExp('№ '+String(oldest.id).padStart(6,'0')));await choose(p,p.locator('#tradeAllocationForm'),'Грошовий рахунок',state.accounts.find(a=>a.id===cash).name);await p.locator('[name=amount]').fill('10');await p.locator('[data-allocation]').fill('10');await p.locator('[value=post]').click();await wait(async()=>!(await p.locator('#tradeAllocationForm').count())&&(await p.locator('.trade-dialog[open] h2').innerText()).includes('Платіж / аванс'));assert.equal((await ok('vouchers/'+oldest.id)).outstanding,'40.00');}finally{await context.close();}
 if(!financeOnly){
 // After deleting the last row on page2, the list returns to a valid page.
 for(let i=0;i<31;i++)await ok('vouchers','POST',{kind:'opening',date:today,store,warehouse,lines:[{product,quantity:'1',price:'1'}]});
 await go('stock');await page.locator('[data-trade=next]').click();await wait(async()=>(await page.locator('.trade-pagination').innerText()).includes('31–31'));
 await page.locator('[data-trade=view]').click();await primary().locator('[data-trade=delete-voucher]').click();await require('./voucher-action-navigation.cjs')(page);await wait(async()=>(await page.locator('.trade-pagination').innerText()).includes('1–30 із 30'));
 }
 }
 if(!recoveryOnly)console.log('PASS: customer history64, source503 retry and actual accountant allocation/outstanding40.');
 // A now-unavailable source in a saved draft must recover without editing that draft on the server.
 let paidSale;
 if(!financeOnly){const shift=(await ok('shifts','POST',{account:cash})).id;paidSale=await create({kind:'sale',party:customer,shift,lines:[{product,quantity:'1',price:'20'}],payload:{payments:[{account:cash,amount:'20'}],discount_reason:'Ізольована перевірка історичної ціни'}});assert.equal((await ok('vouchers/'+paidSale.id)).outstanding,'0.00');}
 const returnSource=await create({kind:'receipt',party:supplier,lines:[{product,quantity:'1',price:'5'}]});
 const sourceLine=(await ok('vouchers/'+returnSource.id)).lines[0];
 const returnBody={kind:'supplier_return',date:today,store,warehouse,party:supplier,reference:returnSource.id,lines:[{product,quantity:'1',price:'5',reference_line:sourceLine.id}],note:'Недоступне джерело: збережена чернетка'};
 const unavailableDraft=await ok('vouchers','POST',returnBody);await create(returnBody);
 const secondStore=(await ok('entities/stores','POST',{name:'Другий магазин для перевірки джерел'})).id;
 const openUnavailable=async()=>{
  await go('purchases');
  await documentButton(page,unavailableDraft.id).click();
  await primary().locator('[data-trade=edit-voucher]').click();
  await primary().locator('[data-reference-warning]').waitFor();
  assert.equal(await primary().locator('[name=reference]').inputValue(),String(returnSource.id));
  assert((await primary().locator('#tradeReferenceValue').innerText()).includes('недоступний'));
 };
 const discardParent=async()=>{page.once('dialog',d=>d.accept());await primary().locator('[data-trade=close]').click();await wait(async()=>!(await primary().count()));};
 await openUnavailable();
 await primary().locator('[data-trade=choose-reference]').click();await loaded();
 await picker().locator('[name=q]').fill(String(oldest.id));
 await wait(async()=>(await picker().locator('[data-browse-status]').innerText()).includes('із 1'));
 page.once('dialog',d=>d.accept());await picker().locator(`[data-browse=choose][data-id="${oldest.id}"]`).press('Enter');
 await wait(async()=>!(await picker().count())&&(await primary().locator('[name=reference]').inputValue())===String(oldest.id)&&(await primary().getAttribute('aria-busy'))!=='true');
 assert.equal(await primary().locator('[data-reference-warning]').count(),0,'Valid selection removes unavailable source warning');
 assert.equal(await primary().locator('[data-trade=clear-reference]').isDisabled(),false);
 assert.equal(await primary().locator('[name=note]').inputValue(),'Недоступне джерело: збережена чернетка');
 assert.equal(await primary().locator('#tradeReferenceValue').evaluate(el=>document.activeElement===el),true);
 await discardParent();
 await openUnavailable();
 await primary().locator('[data-trade=clear-reference]').press('Enter');
 assert.equal(await primary().locator('[data-reference-warning]').count(),0,'Clearing unavailable source removes warning');
 assert.equal(await primary().locator('[name=reference]').inputValue(),'');
 assert.equal(await primary().locator('[data-trade=clear-reference]').isDisabled(),true);
 assert.equal(await primary().locator('#tradeReferenceValue').evaluate(el=>document.activeElement===el),true);
 await discardParent();
 await openUnavailable();
 await choose(page,primary(),'Магазин','Другий магазин для перевірки джерел');
 assert.equal(await primary().locator('[data-reference-warning]').count(),0,'Changing store removes unavailable source warning');
 assert.equal(await primary().locator('[name=reference]').inputValue(),'');
 assert.equal(await primary().locator('[data-trade=clear-reference]').isDisabled(),true);
 await discardParent();
 assert.equal((await ok('vouchers/'+unavailableDraft.id)).reference,returnSource.id,'Discarded recovery actions never write the original draft');
 if(financeOnly){console.log('PASS: generic unavailable-reference replacement/clear/store/no-write. Previous allocation/history/accountant stages reused when selected; stock/cashier tail not rerun.');return;}

 // Actual scoped cashier gets selling amounts and quantities, without any cost metadata.
 await ok('users','POST',{username:'browse_cashier',password,role:'cashier',store,active:true});
 const cashierContext=await page.context().browser().newContext({viewport:{width:390,height:1000}});
 try{
  const login=await cashierContext.request.post(base+'/api/login',{headers:{Origin:base},data:{username:'browse_cashier',password}});
  assert.equal(login.status(),200);
  const response=await cashierContext.request.get(base+'/api/erp/vouchers/'+paidSale.id);
  assert.equal(response.status(),200);
  const detail=await response.json();
  assert.equal(Object.hasOwn(detail,'cost'),false,'Cashier voucher DTO has no cost summary');
  assert(detail.lines.length>0&&detail.movements.length>0,'Sale fixture has lines and stock movements to check redaction');
  assert(detail.lines.every(line=>!Object.hasOwn(line,'cost')),'Cashier line DTOs have no cost');
  assert(detail.movements.every(movement=>!Object.hasOwn(movement,'value')),'Cashier movement DTOs have no stock value');
  const p=await cashierContext.newPage(),cashierPrimary=()=>p.locator('.trade-dialog[open]:not(.trade-document-browser)'),cashierPicker=()=>p.locator('.trade-document-browser[open]');
  await p.route('https://fonts.googleapis.com/**',route=>route.abort());await p.route('https://fonts.gstatic.com/**',route=>route.abort());
  await p.goto(base+'/#trade/sales',{waitUntil:'domcontentloaded'});
  await documentButton(p,paidSale.id).click();
  await cashierPrimary().locator('h2').waitFor();
  assert.equal((await cashierPrimary().innerText()).includes('Собівартість'),false,'No cashier cost summary or line column is rendered');
  await cashierPrimary().locator('details').evaluateAll(nodes=>nodes.forEach(node=>node.open=true));
  assert.equal(await cashierPrimary().getByRole('columnheader',{name:'Вартість',exact:true}).count(),0,'No cashier stock movement value column');
  const stockHeaders=await cashierPrimary().locator('details th').allTextContents();
  assert.deepEqual(stockHeaders,['Склад','Партія','Кількість']);
  await cashierPrimary().locator('[data-trade=close]').click();
  await p.getByRole('button',{name:'+ Повернення покупця',exact:true}).click();
  await cashierPrimary().locator('[data-trade=choose-reference]').click();
  await wait(async()=>(await cashierPicker().locator('[data-browse-results]').getAttribute('aria-busy'))!=='true');
  await cashierPicker().locator('[name=q]').fill(String(paidSale.id));
  await wait(async()=>(await cashierPicker().locator('[data-browse-status]').innerText()).includes('із 1'));
  await cashierPicker().locator(`[data-browse=choose][data-id="${paidSale.id}"]`).press('Enter');
  await wait(async()=>!(await cashierPicker().count())&&(await cashierPrimary().locator('[name=reference]').inputValue())===String(paidSale.id)&&(await cashierPrimary().getAttribute('aria-busy'))!=='true');
  const label=await cashierPrimary().locator('#tradeReferenceValue').innerText();
  assert(label.includes('20,00 грн'),'Fully paid sale remains labelled by total20, not debt0');
  assert.equal(label.includes(' · 0,00 грн'),false);
  assert.equal(await cashierPrimary().locator('[data-trade=clear-reference]').isDisabled(),false);
  assert.equal(await cashierPrimary().locator('#tradeReferenceValue').evaluate(el=>document.activeElement===el),true);
  assert.equal(await cashierPrimary().locator('[data-line=quantity]').inputValue(),'1.000');
  p.once('dialog',d=>d.accept());await cashierPrimary().locator('[data-trade=close]').click();
 }finally{await cashierContext.close();}
 console.log(recoveryOnly?'PASS: unavailable warning valid/clear/store recovery, real scoped cashier paid-source label/focus, API/UI cost redaction.':'PASS:65sources/3pages/numbersearch, keyboard/320–1440, parent draft/focus, retry, real accountant receipt payment, page clamp after delete, unavailable draft warning recovery, real scoped cashier paid-source labels and cost redaction.');
};
