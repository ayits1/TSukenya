const finance=require('./finance-navigation.cjs');
/* B24 actual ERP directory consumers: disposable SQLite + bundled headless Chromium. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-directories-ui-'));

const proof=process.env.DIRECTORIES_PROOF_DIR||'/tmp/tsukenya-directories-proof',python=process.env.PYTHON_BIN||'python3';
fs.mkdirSync(proof,{recursive:true});const base='http://localhost:18502',password='isolated-directories-password';
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:'18502',HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of Object.keys(env))if(key==='DATABASE_URL'||key.startsWith('DB_')||key.startsWith('PG'))delete env[key];
const log=fs.openSync(path.join(proof,'server.log'),'w'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});
let browser,page,zoomContext,zoomProfile;const errors=[],requests=[],stages=[];
const wait=async check=>{for(let i=0;i<160;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out directory UI');};
(async()=>{
 await wait(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}});
 const ids=JSON.parse(execFileSync(python,['-c',`import os,json
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from django.contrib.auth.models import User
from django.utils import timezone
from server.erp.models import *
u=User.objects.get(username='tester');s=Store.objects.first();w=Warehouse.objects.first();a=CashAccount.objects.first()
Document.objects.update_or_create(path='settings/main',defaults={'data':{'defaultMarkup':30,'rounding':.5}})
for i in range(67):
 Store.objects.create(name=f'B24 Магазин {i:03}',active=i!=66)
 Warehouse.objects.create(name=f'B24 Склад {i:03}',store=s)
 CashAccount.objects.create(name=f'B24 Рахунок {i:03}',store=s,kind='bank')
 Employee.objects.create(name=f'B24 Працівник {i:03}',store=s,shift_rate='11.22',bonus_percent='1.123',active=i!=66)
 Counterparty.objects.create(name=f'B24 Постачальник {i:03}',kind='supplier',active=i!=66)
 Counterparty.objects.create(name=f'B24 Покупець {i:03}',kind='customer',active=i!=66)
 ExpenseCategory.objects.create(name=f'B24 Стаття {i:03}')
for i in range(205):
 p=Document.objects.create(path=f'products/b24_{i:03}',data={'name':f'B24 Товар {i:03} · довга українська назва для вузького екрана','unit':'шт','cost':'1.2345','manualPrice':True,'price':'13.01','promotion':i==66,'promotionPrice':'10.01' if i==66 else None,'barcode':f'B24-{i:03}','hidden':i==204})
 StockLot.objects.create(warehouse=w,product=p,code=f'B24-{i:03}',quantity=100,value=100)
for i in range(2):Document.objects.create(path=f'products/amb{i}',data={'name':'B24 Точна назва','unit':'шт','cost':1,'manualPrice':True,'price':'13.01','barcode':f'AMB{i}'})
cross=Store.objects.get(name='B24 Магазин 065')
Warehouse.objects.create(name='B24 Інший склад',store=cross)
CashAccount.objects.create(name='B24 Інший рахунок',store=cross,kind='bank')
CashAccount.objects.create(name='B24 Нова каса',store=s,kind='cash')
shift=CashShift.objects.create(store=s,account=a,opened_by=u,opening_cash=0)
former=Employee.objects.get(name='B24 Працівник 066')
work=WorkShift.objects.create(employee=former,store=s,date=timezone.localdate(),cash_shift=shift,shift_rate='77.89',bonus_percent='2.345',bonus_basis='store')
supplier=Counterparty.objects.get(name='B24 Постачальник 066')
draft=Voucher.objects.create(kind='supplier_return',store=s,warehouse=w,party=supplier,date=timezone.localdate(),created_by=u,payload={})
VoucherLine.objects.create(voucher=draft,product_id='products/b24_204',name='Збережена історична назва',unit='шт',quantity=1,price='7.89',amount='7.89')
large=Voucher.objects.create(kind='opening',store=s,warehouse=w,date=timezone.localdate(),created_by=u,payload={})
for i in range(200):VoucherLine.objects.create(voucher=large,product_id=f'products/b24_{i:03}',name=f'Frozen {i:03}',unit='шт',quantity=1,price='1.2345',amount='1.23')
out=Document.objects.get(path='products/b24_000');out.data['recipe']=[{'product':f'b24_{i:03}','quantity':'1.001'} for i in range(1,101)];out.save()
print(json.dumps({'store':s.pk,'warehouse':w.pk,'account':a.pk,'shift':shift.pk,'work':work.pk,'returnDraft':draft.pk,'large':large.pk}))
`],{cwd:root,env,encoding:'utf8'}));
 browser=await chromium.launch({ headless: true });
 page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 page.on('request',request=>{if(request.url().includes('/api/v1/trading/')||request.url().includes('/api/erp/state'))requests.push({url:request.url(),method:request.method(),body:request.postDataJSON?.()});});
 await require('./browser-login.cjs')(page,base,password);
 const api=async(endpoint,method='GET',body)=>page.evaluate(async value=>{const boot=await(await fetch('/api/v1/trading/bootstrap')).json(),r=await fetch('/api/erp/'+value.endpoint,{method:value.method,headers:{'Content-Type':'application/json','X-CSRF-Token':boot.csrf},...(value.body===undefined?{}:{body:JSON.stringify(value.body)})});return {status:r.status,data:await r.json()};},{endpoint,method,body});
 async function choose(label,text,match){const host=await page.locator('dialog[open]').count()?page.locator('dialog[open]'):page;const input=host.getByRole('combobox',{name:label,exact:true});await input.fill(text);await page.getByRole('option',{name:match}).waitFor();await page.getByRole('option',{name:match}).click();return input;}
 async function close(){const dialog=page.locator('dialog[open]');if(await dialog.count()){await dialog.locator('[data-trade=close]').click();await page.locator('dialog[open]').waitFor({state:'hidden'});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}}
 if(!['tail','layout','zoom','race'].includes(process.env.DIRECTORIES_FROM)){
 await page.goto(base+'/#trade/sales');await page.getByRole('button',{name:'+ Продаж',exact:true}).click();
 await page.getByRole('combobox',{name:'Товар',exact:true}).waitFor();
 await choose('Товар','B24 Товар 066',/B24 Товар 066/);
 assert.equal(await page.locator('[data-line=price]').inputValue(),'10.01');
 await page.locator('[data-line=quantity]').fill('3.125');
 await page.locator('[name=barcode]').fill('B24-200');await page.locator('[data-trade=barcode]').click();await wait(async()=>await page.locator('[data-line=product]').count()===2);
 assert.equal(await page.locator('[data-line=quantity]').first().inputValue(),'3.125');assert.equal(await page.locator('[data-line=price]').last().inputValue(),'13.01');
 await page.locator('[name=barcode]').fill('B24 Точна назва');await page.locator('[data-trade=barcode]').click();await page.getByRole('option',{name:/B24 Точна назва/}).first().waitFor();assert.equal(await page.locator('[data-line=quantity]').first().inputValue(),'3.125');
 await page.getByRole('option',{name:/B24 Точна назва/}).first().click();await page.keyboard.press('Escape');stages.push('POS off-page price/ambiguity + preserved draft');
 for(const width of [1440,320]){await page.setViewportSize({width,height:1050});await page.screenshot({path:path.join(proof,'sale-'+width+'.png')});assert((await page.evaluate(()=>document.documentElement.scrollWidth))<=width);}
 await close();await page.goto(base+'/#trade/setup');const stores=page.locator('[data-directory-table=stores]');await stores.locator('[name=q]').fill('B24 Магазин');await stores.locator('[type=submit]').click();await wait(async()=>(await stores.locator('[data-directory-status]').innerText()).includes('67 записів'));assert.equal(await stores.locator('tbody tr').count(),30);
 await stores.locator('[data-directory-page=next]').focus();await page.keyboard.press('Enter');await wait(async()=>(await stores.locator('[data-directory-status]').innerText()).includes('2 з 3'));assert(await stores.locator('[data-directory-status]').evaluate(node=>document.activeElement===node));
 await stores.locator('[data-directory-page=next]').click();await wait(async()=>(await stores.innerText()).includes('B24 Магазин 066'));stages.push('actual setup paged table');
 await page.goto(base+'/#trade/staff');const employees=page.locator('[data-directory-table=employees]');await employees.locator('[name=q]').fill('B24 Працівник');await employees.locator('[type=submit]').click();await wait(async()=>(await employees.locator('[data-directory-status]').innerText()).includes('67 записів'));await employees.locator('[data-directory-page=next]').click();await wait(async()=>(await employees.locator('[data-directory-status]').innerText()).includes('2 з 3'));await employees.locator('[data-directory-page=next]').click();await wait(async()=>(await employees.innerText()).includes('B24 Працівник 066'));stages.push('actual staff paged private terms');
 await page.locator(`[data-trade=work-shift][data-id="${ids.work}"]`).click();await wait(async()=>(await page.locator('dialog[open]').getByRole('combobox',{name:'Працівник',exact:true}).inputValue()).includes('B24 Працівник 066'));assert.equal(await page.locator('[name=shift_rate]').inputValue(),'77.89');assert.equal(await page.locator('[name=bonus_percent]').inputValue(),'2.345');stages.push('inactive pinned employee + immutable captured shift terms');await close();
 await page.goto(base+'/#trade/stock');await page.getByRole('button',{name:'+ Початкові залишки',exact:true}).waitFor();
 // Targeted selected-ID detail: 200 off-page document lines, no 200 choice-page requests.
 let before=requests.length;await page.evaluate(id=>{const button=document.createElement('button');button.dataset.trade='edit-voucher';button.dataset.id=String(id);document.getElementById('main').append(button);button.click();button.remove();},ids.large);
 await wait(async()=>await page.locator('[data-line=product]').count()===200);await wait(async()=>!(await page.getByRole('combobox',{name:'Товар',exact:true}).last().inputValue()).includes('Завантажуємо'));
 const largeRequests=requests.slice(before).filter(request=>request.url.includes('/directories/details'));const productBatches=largeRequests.filter(request=>request.body.ids.some(ref=>ref.type==='products'));assert.equal(new Set(productBatches.flatMap(request=>request.body.ids.filter(ref=>ref.type==='products').map(ref=>ref.id))).size,200);assert(productBatches.length<=2);assert(largeRequests.every(request=>request.body.ids.length<=200));assert(!requests.slice(before).some(request=>request.url.includes('/directories/products?')));stages.push('200 line batched selected hydration and lazy choice search');await close();
 await page.getByRole('button',{name:'Версії рецептур',exact:true}).click();await choose('Готовий товар','B24 Товар 000',/B24 Товар 000/);await wait(async()=>await page.locator('[data-component=product]').count()===100);await wait(async()=>!(await page.getByRole('combobox',{name:'Інгредієнт',exact:true}).last().inputValue()).includes('Завантажуємо'));stages.push('100 recipe components batched current captions');await close();
 await page.goto(base+'/#trade/customers');await page.getByRole('combobox',{name:'Магазин для аналітики'}).waitFor();await choose('Магазин для аналітики','B24 Магазин 065',/B24 Магазин 065/);stages.push('React customer actual server store filter');
 }
 // Separate matching tail: field families, read failures and top-layer keyboard/reflow.
 if(!['layout','zoom','race','primary'].includes(process.env.DIRECTORIES_FROM)){
 await page.setViewportSize({width:1440,height:1050});await page.goto(base+'/#trade/purchases');await page.getByRole('button',{name:'+ Надходження',exact:true}).waitFor();const filterRead=page.waitForResponse(r=>r.url().includes('/api/v1/trading/purchases/documents?')&&r.url().includes('store=1'));await choose('Магазин','Основний магазин',/Основний магазин/);await filterRead;await page.getByRole('button',{name:'+ Надходження',exact:true}).click();await page.locator('dialog[open]').waitFor();
 await choose('Магазин','Основний магазин',/Основний магазин/);await choose('Склад','B24 Склад 065',/B24 Склад 065/);await choose('Постачальник','B24 Постачальник 065',/B24 Постачальник 065/);await choose('Товар','B24 Товар 040',/B24 Товар 040/);assert.equal(await page.locator('[data-line=price]').inputValue(),'1.2345');stages.push('actual receipt warehouse/supplier/current 4dp cost');await close();
 async function edit(id){await page.evaluate(id=>{const button=document.createElement('button');button.dataset.trade='edit-voucher';button.dataset.id=String(id);document.getElementById('main').append(button);button.click();button.remove();},id);await page.locator('dialog[open]').waitFor();}
 await page.route('**/api/v1/trading/directories/details',route=>{const body=route.request().postDataJSON();return body.ids.some(ref=>ref.type==='products')?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Ізольована недоступність вибраного товару'})}):route.continue();});
 await edit(ids.returnDraft);await page.locator('#tradeLines').getByRole('button',{name:'Повторити читання вибраного'}).waitFor();assert.equal(await page.locator('[data-line=price]').inputValue(),'7.8900');await page.locator('[data-line=quantity]').fill('2.125');await page.unroute('**/api/v1/trading/directories/details');await page.locator('#tradeLines').getByRole('button',{name:'Повторити читання вибраного'}).click();await wait(async()=>(await page.locator('dialog[open]').getByRole('combobox',{name:'Товар',exact:true}).inputValue()).includes('B24 Товар 204'));assert.equal(await page.locator('[data-line=price]').inputValue(),'7.8900');assert.equal(await page.locator('[data-line=quantity]').inputValue(),'2.125');assert((await page.locator('dialog[open]').getByRole('combobox',{name:'Постачальник'}).inputValue()).includes('неактивний'));stages.push('503 selected-ID explicit read retry preserves hidden product/inactive party/edited qty/frozen price');await close();
 await page.goto(base+'/#trade/stock');await page.getByRole('button',{name:'+ Переміщення',exact:true}).click();await page.locator('dialog[open]').waitFor();await choose('Склад призначення','B24 Інший склад',/B24 Інший склад/);assert.notEqual(await page.locator('[name=target]').inputValue(),String(ids.warehouse));stages.push('actual cross-store transfer target retained');await close();
 await page.goto(base+'/#trade/finance');await finance.create(page,'cash_transfer').click();await page.locator('dialog[open]').waitFor();await choose('На рахунок','B24 Інший рахунок',/B24 Інший рахунок/);stages.push('actual cross-store cash target retained');await close();
 await finance.create(page,'expense').click();await page.locator('dialog[open]').waitFor();await choose('Стаття витрат','B24 Стаття 065',/B24 Стаття 065/);await choose('Грошовий рахунок','B24 Рахунок 065',/B24 Рахунок 065/);stages.push('actual expense category/account server fields');await close();
 await page.goto(base+'/#trade/sales');await page.getByRole('tab',{name:'Касові зміни',exact:true}).click();await page.getByRole('button',{name:'Відкрити зміну',exact:true}).click();await page.locator('dialog[open]').waitFor();await choose('Каса','B24 Нова каса',/B24 Нова каса/);await choose('Працівник','B24 Працівник 065',/B24 Працівник 065/);stages.push('actual shift account/employee purpose selectors');await close();
 }
 if(!['layout','zoom','primary'].includes(process.env.DIRECTORIES_FROM)){
 async function lateOpening(tab,selector,pattern,accept){await page.goto(base+'/#trade/'+tab);const action=typeof selector==='string'?page.locator(selector):selector();await action.first().waitFor();let release,entered=false;const gate=new Promise(resolve=>release=resolve);await page.route(pattern,async route=>{if(!accept(route.request()))return route.continue();entered=true;await gate;await route.continue();});await action.first().click();await wait(async()=>entered);await page.goto(base+'/#trade/finance');await finance.tab(page,'accounts');const response=page.waitForResponse(r=>accept(r.request()));release();await response;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.locator('dialog[open]').count(),0);await page.unroute(pattern);}
 await lateOpening('setup','[data-directory-table=stores] [data-trade=entity]','**/api/v1/trading/directories/details',r=>r.method()==='POST'&&r.postDataJSON()?.purpose==='manage');
 await lateOpening('staff','[data-trade=work-shift]:not([data-id])','**/api/v1/trading/directories/employees?**',r=>r.url().includes('purpose=work_shift'));
 await lateOpening('stock',()=>page.getByRole('button',{name:'+ Початкові залишки',exact:true}),'**/api/v1/trading/directories/warehouses?**',r=>r.url().includes('purpose=opening')&&r.url().includes('sort=id'));
 stages.push('delayed entity/work-shift/voucher defaults never replace another route');
 }
 if(!['race','primary'].includes(process.env.DIRECTORIES_FROM)){
 await page.goto(base+'/#trade/sales');await page.getByRole('button',{name:'+ Продаж',exact:true}).waitFor();
 async function modalPaging(label){await page.getByRole('button',{name:'+ Продаж',exact:true}).click();await page.locator('dialog[open]').waitFor();const product=page.locator('dialog[open]').getByRole('combobox',{name:'Товар',exact:true});await product.fill('B24 Товар');await page.getByRole('option',{name:/B24 Товар 000/}).waitFor();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'Далі');await page.keyboard.press('Enter');await wait(async()=>await product.evaluate(node=>document.activeElement===node));await page.getByRole('option',{name:/B24 Товар 030/}).waitFor();const overlay=page.locator('.tk-popover');assert(await overlay.evaluate(node=>!!node.closest('dialog[open]')));const geom=await overlay.evaluate(node=>{const r=node.getBoundingClientRect();const d=node.closest('dialog').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,top:r.top,minTop:Math.max(0,d.top),bottom:r.bottom,height:Math.min(innerHeight,d.bottom),scroll:node.scrollWidth,client:node.clientWidth,style:node.getAttribute('style'),classes:node.className,box:getComputedStyle(node).boxSizing,max:getComputedStyle(node).maxHeight,display:getComputedStyle(node).display,dialogScroll:node.closest('dialog').scrollTop,dialogHeight:node.closest('dialog').clientHeight};});assert(geom.left>=0&&geom.right<=geom.width+1&&geom.bottom<=geom.height+1&&geom.top>=geom.minTop-1,JSON.stringify(geom));assert(geom.scroll<=geom.client+1);if(label.endsWith('200')){const cdp=await page.context().newCDPSession(page);try{const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(proof,label+'.png'),Buffer.from(shot.data,'base64'));}finally{await cdp.detach();}}else await page.screenshot({path:path.join(proof,label+'.png')});await page.keyboard.press('Escape');assert.equal(await page.locator('[data-line=product]').inputValue(),'');assert(await product.evaluate(node=>document.activeElement===node));assert(await product.evaluate(node=>{const r=node.getBoundingClientRect(),foot=node.closest('dialog').querySelector('.trade-dialog-foot').getBoundingClientRect();return r.top>=0&&r.bottom+4<=foot.top;}));await close();}
 await page.setViewportSize({width:320,height:1050});if(process.env.DIRECTORIES_FROM!=='zoom'){await modalPaging('modal-paging-320');stages.push('native top-layer 320 Tab/Enter page/focus/Escape geometry');}
 zoomProfile=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-directories-zoom-'));fs.mkdirSync(path.join(zoomProfile,'Default'));fs.writeFileSync(path.join(zoomProfile,'Default','Preferences'),JSON.stringify({partition:{default_zoom_level:{x:Math.log(2)/Math.log(1.2)}}}));zoomContext=await chromium.launchPersistentContext(zoomProfile,{ headless: true, viewport:null, args:['--window-size=720,525','--force-device-scale-factor=2'] });page=zoomContext.pages()[0];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());await require('./browser-login.cjs')(page,base,password);assert.equal(await page.evaluate(()=>devicePixelRatio),2);assert.equal(await page.evaluate(()=>innerWidth),720);await page.goto(base+'/#trade/sales');await page.getByRole('button',{name:'+ Продаж',exact:true}).waitFor();await modalPaging('modal-paging-200');stages.push('bundled Chromium display200% top-layer paging/focus/geometry');
 }
 assert(!requests.some(request=>request.url.includes('/api/erp/state')));assert.equal(errors.length,0,errors.join('\n'));
 fs.writeFileSync(path.join(proof,'report-'+(process.env.DIRECTORIES_FROM||'all')+'.json'),JSON.stringify({status:'PASS',stages,requests,errors,limits:{legacyGlobalCatalog:'separate remaining runtime package',page:30,details:200}},null,2));console.log('B24 directories native PASS',stages);
})().catch(async error=>{console.error(error);fs.writeFileSync(path.join(proof,'failure.json'),JSON.stringify({error:String(error),stages,errors,requests},null,2));if(page)await page.screenshot({path:path.join(proof,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await zoomContext?.close();if(zoomProfile)fs.rmSync(zoomProfile,{recursive:true,force:true});await browser?.close();server.kill('SIGTERM');fs.closeSync(log);fs.rmSync(data,{recursive:true,force:true});});
