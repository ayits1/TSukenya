/* B24 actual ERP stock/search/page/draft/download, disposable SQLite + native Chrome. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright'),csv=require('../app/csv.js');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-bounded-ui-'));
const proof=process.env.BOUNDED_STOCK_PROOF_DIR||'/tmp/tsukenya-bounded-stock-proof',python=process.env.PYTHON_BIN||'python3';
fs.mkdirSync(proof,{recursive:true});const base='http://localhost:18485',password='isolated-bounded-stock-password';
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:'18485',HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of ['DATABASE_URL','DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])delete env[key];
const log=fs.openSync(path.join(proof,'server.log'),'w'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});
let browser;const wait=async check=>{for(let i=0;i<150;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out B24 UI');};
(async()=>{
 await wait(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}});
 execFileSync(python,['-c',`import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from server.erp.models import Document,StockLot,Warehouse
w=Warehouse.objects.first()
for i in range(67):
 p=Document.objects.create(path=f'products/b24_{i:03}',data={'name':f'B24 Товар {i:03} · довга українська назва для перевірки складу','unit':'кг' if i%2 else 'шт','minStock':2})
 StockLot.objects.create(warehouse=w,product=p,code=f'QA-{i:03}',quantity=1,value=10)
`],{cwd:root,env});
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{if(r.url().includes('/api/erp/stock?')||r.url().includes('/api/erp/assortment?')){try{const value=await r.json();if(r.status()===200)requests.push({url:r.url(),count:(value.items||value.rows).length,total:value.total});}catch{}}});
 await require('./browser-login.cjs')(page,base,password);
 const api=(endpoint,method='GET',body)=>page.evaluate(async value=>{const s=await(await fetch('/api/state')).json(),r=await fetch('/api/erp/'+value.endpoint,{method:value.method,headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:value.body===undefined?undefined:JSON.stringify(value.body)});return{status:r.status,data:await r.json()};},{endpoint,method,body});
 const ok=async(...args)=>{const r=await api(...args);assert(r.status<300,JSON.stringify(r));return r.data;};
 const warehouse=(await ok('state')).warehouses[0].id;
 await page.goto(base+'/#trade/stock');await page.locator('[name=stockSearch]').waitFor();
 await page.locator('[name=stockWarehouse]').selectOption(String(warehouse));
 const search=page.locator('[name=stockSearch]');await search.fill('B24 Товар');
 await wait(async()=>(await page.locator('[data-stock-page-status]').innerText()).includes('із 67')&&await page.locator('[data-trade=stock-next]').isEnabled());
 assert.equal(await page.locator('[data-stock-panel] table').first().locator('tbody tr').count(),30);
 assert((await page.locator('[data-trade=stock-next]').boundingBox()).height>=44);
 assert((await page.locator('[data-stock-panel] .trade-card').first().innerText()).includes('670,00'));
 await page.locator('[data-trade=stock-next]').focus();await page.keyboard.press('Enter');
 await wait(async()=>(await page.locator('[data-stock-page-status]').innerText()).includes('31–60'));
 assert(await page.locator('[data-stock-page-status]').evaluate(e=>document.activeElement===e));
 await page.locator('[data-trade=stock-next]').focus();await page.keyboard.press('Enter');
 await wait(async()=>(await page.locator('[data-stock-page-status]').innerText()).includes('61–67'));
 assert((await page.locator('[data-stock-panel]').innerText()).includes('B24 Товар 066'));
 await page.locator('[data-disclosure=stock-lots] summary').focus();await page.keyboard.press('Enter');
 await wait(async()=>(await page.locator('[data-lots-page-status]').innerText()).includes('із 67'));
 assert.equal(await page.locator('[data-disclosure=stock-lots] tbody tr').count(),30);
 await page.locator('[data-disclosure=stock-assortment] summary').focus();await page.keyboard.press('Enter');
 await wait(async()=>await page.locator('[data-assortment-min]').count()===30);
 assert((await page.locator('[data-trade=assortment-save]').first().boundingBox()).height>=44);
 const input=page.locator('[data-assortment-min="b24_000"]');await input.fill('3.125');
 await page.locator('[data-trade=assortment-next]').focus();await page.keyboard.press('Enter');
 await wait(async()=>(await page.locator('[data-assortment-page-status]').innerText()).includes('31–60'));
 await page.locator('[data-trade=assortment-draft]').focus();await page.keyboard.press('Enter');
 await wait(async()=>await page.locator('[data-assortment-min]').count()===1);
 assert.equal(await input.inputValue(),'3.125');assert(await input.evaluate(e=>document.activeElement===e));
 // Fresh selected-ID detail must not replace a draft's original revision.
 await ok('assortment','POST',{warehouse,product:'b24_000',sold:true,min_stock:'4'});
 await page.locator('[data-trade=assortment-reload]').click();await wait(async()=>!(await page.locator('[data-trade=assortment-reload]').isDisabled()));
 assert.equal(await input.inputValue(),'3.125');
 await page.locator('[data-trade=assortment-save]').click();await wait(async()=>(await page.locator('#tradeAssortmentStatus').innerText()).includes('Оновіть асортимент'));
 assert.equal((await ok('assortment?warehouse='+warehouse+'&product=b24_000')).rows[0].min_stock,'4.000');
 await page.locator('[data-trade=assortment-reset]').click();assert.equal(await input.inputValue(),'4.000');
 await input.fill('3.125');await page.locator('[data-trade=assortment-save]').focus();await page.keyboard.press('Enter');
 await wait(async()=>(await page.locator('#tradeAssortmentStatus').innerText()).includes('Збережено:'));
 assert.equal((await ok('assortment?warehouse='+warehouse+'&product=b24_000')).rows[0].min_stock,'3.125');
 await page.locator('[data-trade=assortment-all]').click();await wait(async()=>await page.locator('[data-assortment-min]').count()===30);
 await input.fill('6.250');
 let fail=true;await page.route('**/api/erp/stock?*',route=>{if(fail){fail=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Ізольована помилка читання залишків'})});}return route.continue();});
 await search.fill('B24 Товар 066');await page.locator('[data-stock-retry]').waitFor({state:'visible'});
 assert.equal(await input.inputValue(),'6.250');assert(await input.isDisabled());
 await page.locator('[data-stock-retry]').focus();await page.keyboard.press('Enter');
 await wait(async()=>(await page.locator('[data-stock-page-status]').innerText()).includes('із 1'));
 await page.unroute('**/api/erp/stock?*');
 // Abort/generation: an earlier, slow broad search cannot replace newer results or caret.
 await page.route('**/api/erp/stock?*',async route=>{if(new URL(route.request().url()).searchParams.get('q')==='B24 Товар 00')await new Promise(resolve=>setTimeout(resolve,700));try{await route.continue();}catch{}});
 await search.fill('B24 Товар 00');await page.waitForTimeout(300);await search.fill('B24 Товар 066');
 await wait(async()=>(await page.locator('[data-stock-page-status]').innerText()).includes('із 1'));
 await page.waitForTimeout(850);assert.equal(await search.inputValue(),'B24 Товар 066');assert(await search.evaluate(e=>document.activeElement===e&&e.selectionStart===13));
 assert((await page.locator('[data-stock-panel]').innerText()).includes('B24 Товар 066'));await page.unroute('**/api/erp/stock?*');
 await page.locator('[data-trade=assortment-draft]').click();await wait(async()=>await page.locator('[data-assortment-min="b24_000"]').count()===1);
 assert.equal(await input.inputValue(),'6.250');
 const geometry=[];
 for(const width of [1440,320]){await page.setViewportSize({width,height:1050});await page.locator('[data-stock-panel]').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(proof,'stock-'+width+'.png')});
  await page.locator('#tradeAssortmentTitle').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(proof,'assortment-'+width+'.png')});
  await input.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(proof,'assortment-row-'+width+'.png')});
  const bounds=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth}));assert(bounds.documentWidth<=width);geometry.push(bounds);}
 await search.fill('B24 Товар');await wait(async()=>(await page.locator('[data-stock-page-status]').innerText()).includes('із 67'));
 const downloaded=page.waitForEvent('download');await page.locator('[data-trade=stock-csv]').click();const file=await downloaded;await file.saveAs(path.join(proof,'stock.csv'));
 const records=csv.parse(fs.readFileSync(path.join(proof,'stock.csv'),'utf8'));assert.equal(records.length,68);assert(records.some(row=>row[0].includes('B24 Товар 066')));
 assert(requests.every(r=>r.count<=30));assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(proof,'report.json'),JSON.stringify({pass:true,geometry,requests,checks:['actual SQL-backed totals/lots/assortment page30','whole filtered670.00summary','last row reachable','keyboard pagination and focus','selected-ID draft hydration','fresh row conflict keeps draft','503retry keeps draft','abort/newestsearch caret','320/1440 no overflow','all67 CSV export']},null,2));
 console.log('PASS B24 native ERP stock/assortment page30, full summary, race/retry/drafts/CSV, keyboard320/1440; '+proof);
})().catch(async error=>{console.error(error);process.exitCode=1;const page=browser?.contexts()[0]?.pages()[0];if(page){fs.writeFileSync(path.join(proof,'failure.txt'),await page.locator('body').innerText());await page.screenshot({path:path.join(proof,'failure.png')});}}).finally(async()=>{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));fs.closeSync(log);fs.rmSync(data,{recursive:true,force:true});});
