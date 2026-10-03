/* Assortment drafts and pending requests: isolated SQLite, no production writes. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port=18239,base=`http://localhost:${port}`,password='isolated-assortment-password';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-assortment-drafts-'));
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of Object.keys(env))if(/^DB_|^PG/.test(key)||['DATABASE_URL','POSTGRES_URL'].includes(key))delete env[key];
const log=fs.openSync(path.join(data,'server.log'),'a'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});fs.closeSync(log);let browser;
const until=async(fn,label)=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);};
(async()=>{try{
 await until(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(data,'server.log'),'utf8').slice(-1600));try{return(await fetch(base+'/health')).ok;}catch{return false;}},'isolated server');
 execFileSync(python,['-c',`import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from server.erp.models import Document,Store,Warehouse
Warehouse.objects.create(store=Store.objects.first(),name='Склад Б')
Document.objects.create(path='products/alpha',data={'name':'Альфа','unit':'шт','minStock':2})
Document.objects.create(path='products/beta',data={'name':'Бета','unit':'шт','minStock':3})`],{cwd:root,env});
 browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('https://fonts.googleapis.com/**',route=>route.abort());await page.route('https://fonts.gstatic.com/**',route=>route.abort());
 await require('./browser-login.cjs')(page,base,password);
 const navigate=async hash=>{await page.evaluate(hash=>location.hash=hash,hash);await page.locator('#main').getByRole('heading',{name:hash.includes('stock')?'Залишки товарів':'Поповнення запасів'}).waitFor();};
 await navigate('#trade/stock');
 const panel=page.locator('section[aria-labelledby=tradeAssortmentTitle]');await panel.getByText('Що продається на складі та мінімальні залишки').click();
 const warehouse=panel.locator('[name=assortmentWarehouse]'),ids=await warehouse.locator('option').evaluateAll(options=>options.map(option=>option.value).filter(Boolean));assert.equal(ids.length,2);
 const minimum=product=>panel.locator(`[data-assortment-min="${product}"]`),save=product=>panel.locator(`[data-trade=assortment-save][data-product="${product}"]`);
 const choose=async id=>{await warehouse.selectOption(id);await minimum('alpha').waitFor();await until(async()=>await panel.getAttribute('data-assortment-warehouse')===id&&await minimum('beta').count()===1,'warehouse loaded');};
 await choose(ids[0]);await minimum('alpha').fill('9.5');await minimum('beta').fill('7');await save('alpha').click();
 await until(async()=>/Збережено: Альфа/.test(await panel.locator('#tradeAssortmentStatus').innerText()),'first row saved');
 assert.equal(await minimum('beta').inputValue(),'7','saving alpha retains beta draft');
 let releaseDraw,drawStarted=false;
 await page.route('**/api/erp/vouchers**',async route=>{if(drawStarted)return route.continue();drawStarted=true;await new Promise(resolve=>releaseDraw=resolve);return route.continue();});
 await panel.getByRole('button',{name:'Оновити асортимент'}).click();await until(async()=>drawStarted,'reload waits for documents');
 await minimum('beta').fill('8');const oldInput=await minimum('beta').elementHandle();releaseDraw();await until(async()=>!await oldInput.evaluate(input=>input.isConnected),'reload finished');
 assert.equal(await minimum('beta').inputValue(),'8','typing while redraw is pending retains latest draft');await minimum('beta').fill('7');await page.unroute('**/api/erp/vouchers**');
 const search=page.locator('[name=stockSearch]');await search.fill('Альфа');await until(async()=>await minimum('beta').count()===0,'filtered beta');await search.fill('');await minimum('beta').waitFor();assert.equal(await minimum('beta').inputValue(),'7');
 await choose(ids[1]);assert.equal(await minimum('beta').inputValue(),'');await minimum('beta').fill('4');await choose(ids[0]);assert.equal(await minimum('beta').inputValue(),'7');await choose(ids[1]);assert.equal(await minimum('beta').inputValue(),'4');
 await navigate('#trade/purchases');await navigate('#trade/stock');await minimum('beta').waitFor();assert.equal(await minimum('beta').inputValue(),'4','route navigation retains drafts');
 assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),true,'closing page warns about drafts');
 let release,started=0,completed=0,mode='error';page.on('response',response=>{if(response.url()===base+'/api/erp/assortment'&&response.request().method()==='POST')completed++;});
 await page.route('**/api/erp/assortment',async route=>{if(route.request().method()!=='POST')return route.continue();started++;await new Promise(resolve=>release=resolve);if(mode==='error')return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Конфлікт складу Б',code:'revision_conflict'})});return route.continue();});
 await save('beta').click();await until(async()=>started===1,'delayed POST began');assert.equal(await minimum('beta').isDisabled(),true);assert.equal(await save('beta').isDisabled(),true);
 await search.fill('Бета');await until(async()=>await minimum('alpha').count()===0,'pending row redrawn by search');assert.equal(await save('beta').isDisabled(),true,'new DOM button remains locked');await save('beta').evaluate(button=>button.click());assert.equal(started,1);
 await search.fill('');await minimum('alpha').waitFor();await choose(ids[0]);release();await until(async()=>completed===1,'late error received');
 assert.doesNotMatch(await panel.locator('#tradeAssortmentStatus').innerText(),/Конфлікт складу Б/,'late B error does not pollute A');assert.equal(await minimum('beta').inputValue(),'7');
 await choose(ids[1]);await until(async()=>!await save('beta').isDisabled(),'failed row unlocked');assert.equal(await minimum('beta').inputValue(),'4','failure retains its draft');assert.match(await panel.innerText(),/Конфлікт складу Б/);
 mode='success';await save('beta').click();await until(async()=>started===2,'second delayed POST began');await choose(ids[0]);release();await until(async()=>completed===2,'late success received');assert.equal(await minimum('beta').inputValue(),'7','late success preserves different warehouse draft');
 await choose(ids[1]);await until(async()=>!await save('beta').isDisabled(),'successful row unlocked');assert.equal(Number(await minimum('beta').inputValue()),4);
 assert.equal(await panel.locator('[data-trade=assortment-reset][data-product=beta]').count(),0,'successful offscreen save clears only sent draft');
 await choose(ids[0]);await panel.locator('[data-trade=assortment-reset][data-product=beta]').click();assert.equal(await minimum('beta').inputValue(),'');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-trade')),'assortment-save','discard returns focus');
 for(const width of [390,320]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`layout ${width}`);}
 assert.deepEqual(errors,[]);console.log('PASS: multirow drafts, reload/search/warehouse/routes, unload warning, delayed POST row locks after redraw, late errors/success isolated by warehouse, discard focus, 390/320 layout.');
}catch(error){console.error(error);process.exitCode=1;}finally{await browser?.close();server.kill();}})();
