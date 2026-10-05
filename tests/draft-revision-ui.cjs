const {documentButton,newDocumentButton}=require('./trading-document-controls.cjs');
/* B06 in the real portal: an opened draft or directory form saves over its own version only; a stale form gets 409 and stays open. Isolated SQLite. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-draft-revision-')),python=process.env.PYTHON_BIN||'python3',port=18231,base=`http://localhost:${port}`,password='isolated-draft-revision-password';
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password("${password}"))`],{cwd:root,encoding:'utf8'}).trim();
const isolatedEnv={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])delete isolatedEnv[key];
const server=spawn(python,['-m','server.main'],{cwd:root,env:isolatedEnv,stdio:'ignore'});
let browser;
const wait=async f=>{for(let i=0;i<120;i++){if(await f())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out');};
(async()=>{
await wait(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}});
browser=await chromium.launch({ headless: true });
const page=await (await browser.newContext({viewport:{width:1440,height:1050}})).newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await require('./browser-login.cjs')(page,base,password);
const api=(endpoint,method='GET',body)=>page.evaluate(async({endpoint,method,body})=>{const s=await(await fetch('/api/state')).json(),r=await fetch('/api/erp/'+endpoint,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};},{endpoint,method,body});
const ok=async(...args)=>{const r=await api(...args);assert(r.status<300,JSON.stringify(r));return r.data;};
const go=async tab=>{await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>{d.dataset.dirty='';d.close();}));await page.goto(base+'/#trade/'+tab);await wait(async()=>!(await page.locator('#main').innerText()).includes('Завантаження обліку'));};
const state=await page.evaluate(async()=>(await(await fetch('/api/v1/trading/bootstrap')).json())),store=state.defaultStoreId,wh=(await page.evaluate(async store=>(await(await fetch('/api/v1/trading/directories/warehouses?purpose=purchase_order&store='+store)).json()).items[0].id,store));
const supplier=(await ok('entities/parties','POST',{name:'Постачальник версії',kind:'supplier'})).id;
const p=await page.evaluate(async()=>(await(await fetch('/api/v1/trading/directories/products?purpose=purchase_order')).json()).items[0].id);
const date=await page.evaluate(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
const draft=await ok('vouchers','POST',{kind:'purchase_order',store,warehouse:wh,party:supplier,date,lines:[{product:p,quantity:'1',price:'5'}]});
const openDraft=async()=>{await go('purchases');await documentButton(page,draft.id).first().click();await page.locator('[data-trade=edit-voucher]').click();await page.locator('#tradeVoucherForm').waitFor();};
const saveDraft=()=>page.locator('[type=submit][form=tradeVoucherForm][value=draft]').click();
// 1. Opened draft saves over its own version.
await openDraft();await page.locator('#tradeVoucherForm [data-line=quantity]').fill('2');
let put=page.waitForResponse(r=>r.url().endsWith('/api/erp/vouchers/'+draft.id)&&r.request().method()==='PUT');await saveDraft();
assert.equal((await put).status(),200);await page.locator('#tradeVoucherForm').waitFor({state:'detached'});
assert.equal((await ok('vouchers/'+draft.id)).lines[0].quantity,'2.000');
// 2. Another device saves meanwhile; the older open form is refused and keeps the user's input.
await openDraft();await page.locator('#tradeVoucherForm [data-line=quantity]').fill('7');
const current=await ok('vouchers/'+draft.id);
await ok('vouchers/'+draft.id,'PUT',{kind:'purchase_order',store,warehouse:wh,party:supplier,date,revision:current.revision,lines:[{product:p,quantity:'3',price:'5'}]});
put=page.waitForResponse(r=>r.url().endsWith('/api/erp/vouchers/'+draft.id)&&r.request().method()==='PUT');await saveDraft();
assert.equal((await put).status(),409);
await wait(async()=>(await page.locator('#tradeFormError').innerText()).includes('іншому пристрої'));
assert.equal(await page.locator('#tradeVoucherForm [data-line=quantity]').inputValue(),'7');
assert.equal((await ok('vouchers/'+draft.id)).lines[0].quantity,'3.000');
// An older detail view may not post or delete lines changed after it was opened.
await go('purchases');await documentButton(page,draft.id).first().click();
const observed=await ok('vouchers/'+draft.id);
await ok('vouchers/'+draft.id,'PUT',{kind:'purchase_order',store,warehouse:wh,party:supplier,date,revision:observed.revision,lines:[{product:p,quantity:'9',price:'5'}]});
await page.locator('[data-trade=post-voucher]').click();await page.locator('#tradeActionForm').waitFor();
assert.equal(await page.locator('[data-action-send]').isDisabled(),true,'A stale detail requires an explicit current review before a new action');
assert.equal((await api('vouchers/'+draft.id+'/post','POST',{revision:observed.revision})).status,409,'Legacy observed-revision POST remains guarded');
assert.equal((await ok('vouchers/'+draft.id)).status,'draft');
await go('purchases');await documentButton(page,draft.id).first().click();const beforeDelete=await ok('vouchers/'+draft.id);
await ok('vouchers/'+draft.id,'PUT',{kind:'purchase_order',store,warehouse:wh,party:supplier,date,revision:beforeDelete.revision,note:'Concurrent note before delete',lines:[{product:p,quantity:'9',price:'5'}]});
await page.locator('[data-trade=delete-voucher]').click();await page.locator('#tradeActionForm').waitFor();
assert.equal(await page.locator('[data-action-send]').isDisabled(),true);
assert.equal((await api('vouchers/'+draft.id,'DELETE',{revision:beforeDelete.revision})).status,409,'Legacy stale DELETE remains guarded');
assert.equal((await ok('vouchers/'+draft.id)).lines[0].quantity,'9.000');
// A create committed but its reply was lost; another editor then updated it.
await go('purchases');await newDocumentButton(page,'purchase_order').click();
const newForm=page.locator('#tradeVoucherForm');await newForm.waitFor();
await page.evaluate(({supplier,p})=>{const f=document.querySelector('#tradeVoucherForm');window.TradeDirectories.setValue(f.elements.party,supplier);window.TradeDirectories.setValue(f.querySelector('[data-line=product]'),p);},{supplier,p});
await newForm.locator('[data-line=quantity]').fill('1');await newForm.locator('[data-line=price]').fill('5');
let lostId;
await page.route('**/api/erp/vouchers',async route=>{
 if(route.request().method()!=='POST')return route.continue();
 const response=await route.fetch(),created=await response.json();lostId=created.id;
 await ok('vouchers/'+lostId,'PUT',{kind:'purchase_order',store,warehouse:wh,party:supplier,date,revision:created.revision,lines:[{product:p,quantity:'11',price:'5'}]});
 await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Тест: відповідь втрачено після збереження'})});
});
await saveDraft();await wait(async()=>(await page.locator('#tradeFormError').innerText()).includes('відповідь втрачено'));
await page.unroute('**/api/erp/vouchers');
const retried=page.waitForResponse(r=>r.url().endsWith('/api/erp/vouchers')&&r.request().method()==='POST');
await page.locator('[data-voucher-exact]').click();assert.equal((await retried).status(),409);
await wait(async()=>(await page.locator('#tradeFormError').innerText()).includes('Початкове створення підтверджено'));
assert.equal(await newForm.locator('[data-line=quantity]').inputValue(),'1');
assert.equal((await ok('vouchers/'+lostId)).lines[0].quantity,'11.000');
assert.equal(await page.locator('[data-voucher-exact]').isVisible(),false,'Confirmed create must never repeat POST');
await page.locator('[data-voucher-read]').click();await page.getByRole('heading',{name:'Порівняти зміни документа'}).waitFor();
assert.equal(await newForm.locator('[data-line=quantity]').inputValue(),'1','GET must not adopt newer baseline');
// 3. Directory form opened before another device renamed the customer: 409, the newer name stays.
const customer=(await ok('entities/parties','POST',{name:'Клієнт версії',kind:'customer'})).id;
const party=async()=>page.evaluate(async id=>(await window.TradeDirectories.hydrate([{type:'parties',id:String(id)}],{purpose:'manage'})).items[0],customer);
await go('setup');await page.locator(`[data-directory-table=parties] [data-trade=entity][data-id="${customer}"]`).first().click();await page.locator('#tradeEntityForm').waitFor();
await page.locator('#tradeEntityForm [name=name]').fill('Стара форма');
await ok('entities/parties','POST',{id:customer,name:'Змінено деінде',kind:'customer',revision:(await party()).revision});
const entityPost=page.waitForResponse(r=>r.url().endsWith('/api/erp/entities/parties')&&r.request().method()==='POST');
await page.locator('#tradeEntityForm [type=submit]').click();assert.equal((await entityPost).status(),409);
await wait(async()=>(await page.locator('#tradeFormError').innerText()).includes('іншому пристрої'));
assert.equal((await party()).name,'Змінено деінде');
assert.deepEqual(errors,[]);
console.log('PASS: stale save/post/delete preserve newer drafts; repeated create after lost reply never adopts another editor revision; stale directory keeps newer name.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();fs.rmSync(data,{recursive:true,force:true});});
