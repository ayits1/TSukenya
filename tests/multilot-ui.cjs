/* B11 isolated receipt UI: multiple lots, stable draft identity and exact source return. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'b11-multilot-ui-')),python=process.env.PYTHON_BIN||'python3',port=18234,base=`http://localhost:${port}`,password='isolated-b11-owner-password';
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'test.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])delete env[key];
const server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:'ignore'});let browser;
const wait=async fn=>{for(let n=0;n<100;n++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out');};
(async()=>{
 await wait(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}});
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await require('./browser-login.cjs')(page,base,password);
 const api=(endpoint,method='GET',value)=>page.evaluate(async({endpoint,method,value})=>{const s=await(await fetch('/api/state')).json();const response=await fetch('/api/'+endpoint,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:value===undefined?undefined:JSON.stringify(value)});return{status:response.status,value:await response.json()};},{endpoint,method,value});
 const ok=async(...args)=>{const result=await api(...args);assert(result.status<300,JSON.stringify(result));return result.value;};
 const state=await ok('erp/state'),store=state.stores[0].id,warehouse=state.warehouses[0].id,account=state.accounts[0].id;
 const supplier=(await ok('erp/entities/parties','POST',{name:'B11 постачальник',kind:'supplier'})).id;
 const product=(await ok('v1/catalog/products','POST',{name:'B11 один товар — дві партії',cost:'1',markup:'100'})).id;
 const date=new Date();date.setUTCDate(date.getUTCDate()+10);const early=date.toISOString().slice(0,10);date.setUTCDate(date.getUTCDate()+10);const late=date.toISOString().slice(0,10);
 if(process.argv.includes('--origins-only')){
  const other=(await ok('erp/entities/stores','POST',{name:'B11 другий магазин'})).id;
  await ok('erp/entities/warehouses','POST',{name:'B11 другий склад',store:other});
  let order=await ok('erp/vouchers','POST',{kind:'purchase_order',store,warehouse,date:new Date().toISOString().slice(0,10),party:supplier,lines:[{product,quantity:2,price:1}]});
  order=await ok('erp/vouchers/'+order.id+'/post','POST',{});
  await page.goto(base+'/#trade/purchases');await page.locator(`[data-trade=view][data-id="${order.id}"]`).click();await page.locator('[data-trade=from-order][data-kind=receipt]').click();
  await page.locator('#tradeVoucherForm').waitFor();assert(await page.locator('[data-line=reference_line]').inputValue());
  await page.locator('#tradeVoucherForm [name=store]').selectOption(String(other));
  assert.equal(await page.locator('[data-line=reference_line]').inputValue(),'');assert.equal(await page.locator('.line-origin').count(),0);assert.equal(await page.locator('[name=reference]').inputValue(),'');
  await page.locator('[type=submit][form=tradeVoucherForm][value=draft]').click();await page.getByRole('heading',{name:/Надходження · №/}).waitFor();
  const receipts=await ok('erp/vouchers?kind=receipt'),detail=await ok('erp/vouchers/'+receipts.items[0].id);assert.equal(detail.store,other);assert.equal(detail.reference,null);assert.equal(detail.lines[0].reference_line,null);
  assert.deepEqual(errors,[]);console.log('MULTILOT SOURCE CLEAR PASS: store change clears origin and saves independent draft');return;
 }
 await page.goto(base+'/#trade/purchases');await page.locator('[data-trade=new-voucher][data-kind=receipt]').click();
 const form=()=>page.locator('#tradeVoucherForm');await form().locator('[name=party]').selectOption(String(supplier));await form().locator('[name=additional_cost]').fill('0.03');
 const row=i=>page.locator('.trade-line').nth(i);
 await row(0).locator('[data-line=product]').selectOption(product);await row(0).locator('[data-line=quantity]').fill('3');await row(0).locator('[data-line=price]').fill('1.1111');await row(0).locator('[data-line=lot]').fill('LATE');await row(0).locator('[data-line=expiry]').fill(late);
 await page.getByRole('button',{name:'Додати товар',exact:true}).click();await row(1).locator('[data-line=product]').selectOption(product);await row(1).locator('[data-line=quantity]').fill('2');await row(1).locator('[data-line=price]').fill('2');await row(1).locator('[data-line=lot]').fill('EARLY');await row(1).locator('[data-line=expiry]').fill(early);
 for(const width of [1440,390]){await page.setViewportSize({width,height:950});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`receipt body overflow ${width}`);assert(await page.locator('dialog.trade-dialog[open]').evaluate(d=>d.scrollWidth<=d.clientWidth+1),`receipt dialog overflow ${width}`);}
 await page.setViewportSize({width:1440,height:1000});
 const keys=await page.locator('[data-line=line_key]').evaluateAll(els=>els.map(e=>e.value));assert.notEqual(keys[0],keys[1]);
 await page.locator('[type=submit][form=tradeVoucherForm][value=draft]').click();await page.getByRole('heading',{name:/Надходження · №/}).waitFor();
 let list=await ok('erp/vouchers?kind=receipt');const receipt=list.items[0];let detail=await ok('erp/vouchers/'+receipt.id);assert.deepEqual(detail.lines.map(l=>l.line_key),keys);const ids=detail.lines.map(l=>l.id);
 await page.locator('[data-trade=edit-voucher]').click();await page.locator('#tradeVoucherForm').waitFor();assert.deepEqual(await page.locator('[data-line=line_key]').evaluateAll(els=>els.map(e=>e.value)),keys);
 await page.locator('[type=submit][form=tradeVoucherForm][value=post]').click();await page.locator('[data-trade=from-order][data-kind=supplier_return]').waitFor();detail=await ok('erp/vouchers/'+receipt.id);assert.deepEqual(detail.lines.map(l=>l.id),ids);assert.equal(detail.total,'7.36');assert.equal(detail.outstanding,'7.36');
 await page.locator('[data-trade=from-order][data-kind=supplier_return]').click();await form().waitFor();assert.equal(await page.locator('.trade-line').count(),2);
 assert.equal(await row(1).locator('[data-line=reference_line]').inputValue(),String(ids[1]));assert.equal(await row(1).locator('[data-line=lot]').inputValue(),'EARLY');assert.equal(await row(1).locator('[data-line=expiry]').inputValue(),early);assert(await row(1).locator('[data-line=product]').isDisabled());assert(await row(1).locator('[data-line=lot]').evaluate(el=>el.readOnly));
 for(const width of [1440,390]){await page.setViewportSize({width,height:950});assert(await page.locator('dialog.trade-dialog[open]').evaluate(d=>d.scrollWidth<=d.clientWidth+1),`return dialog overflow ${width}`);const overlap=await row(0).evaluate(r=>{const a=r.querySelector('.line-origin').getBoundingClientRect(),b=r.querySelector('[data-trade=remove-line]').getBoundingClientRect();return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;});assert.equal(overlap,false,`source/removal overlap ${width}`);}
 await row(0).locator('[data-trade=remove-line]').click();await row(0).locator('[data-line=quantity]').fill('1');await row(0).locator('[data-line=quantity]').focus();await page.keyboard.press('Tab');assert(await row(0).locator('[data-line=price]').evaluate(el=>el===document.activeElement));
 await page.locator('[type=submit][form=tradeVoucherForm][value=post]').click();await page.getByRole('heading',{name:/Повернення постачальнику · №/}).waitFor();
 list=await ok('erp/vouchers?kind=supplier_return');const returned=await ok('erp/vouchers/'+list.items[0].id);assert.equal(returned.total,'2.00');assert.equal(returned.lines[0].reference_line,ids[1]);assert.equal(returned.movements[0].lot,'EARLY');assert.equal(returned.movements[0].quantity,'-1.000');assert.equal(returned.movements[0].line,returned.lines[0].id);
 detail=await ok('erp/vouchers/'+receipt.id);assert.equal(detail.lines[0].remaining,'3.000');assert.equal(detail.lines[1].remaining,'1.000');assert.equal(detail.outstanding,'5.36');
 assert.deepEqual(errors,[]);console.log('MULTILOT UI PASS: repeated SKU, two expiries, additional cents, stable draft keys/PK, concrete return origin, keyboard and two layouts');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();server.kill();fs.rmSync(data,{recursive:true,force:true});});
