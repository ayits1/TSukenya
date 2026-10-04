/* B24 actual ERP stock/search/page/draft/download, disposable SQLite + bundled headless Chromium. */
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
 browser=await chromium.launch({ headless: true });
 const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{if(r.url().includes('/api/v1/trading/stock?')||r.url().includes('/api/v1/trading/assortment?')){try{const value=await r.json();if(r.status()===200)requests.push({url:r.url(),count:(value.items||value.rows||[]).length,total:value.total});}catch{}}});
 await require('./browser-login.cjs')(page,base,password);
 const api=(endpoint,method='GET',body)=>page.evaluate(async value=>{const s=await(await fetch('/api/state')).json(),r=await fetch('/api/erp/'+value.endpoint,{method:value.method,headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:value.body===undefined?undefined:JSON.stringify(value.body)});return{status:r.status,data:await r.json()};},{endpoint,method,body});
 const ok=async(...args)=>{const r=await api(...args);assert(r.status<300,JSON.stringify(r));return r.data;};
 const warehouse=(await ok('state')).warehouses[0].id;
 const ready=()=>wait(async()=>await page.locator('[data-react-stock] .stock-cards').count()===1&&!await page.getByText('Завантаження залишків…',{exact:true}).count());
 const pick=async(label,text)=>{const input=page.getByRole('combobox',{name:label,exact:true});await input.fill(text);await page.getByRole('option',{name:text,exact:true}).waitFor();await input.press('ArrowDown');await input.press('Enter');await ready();};
 const warehouseName=(await ok('state')).warehouses.find(w=>w.id===warehouse).name;
 await page.goto(base+'/#trade/stock');await ready();await pick('Склад залишків',warehouseName);
 const search=page.getByRole('textbox',{name:'Пошук товару',exact:true}),stock=page.locator('.stock-panel').first(),pager=page.getByRole('navigation',{name:'Сторінки товарів',exact:true});
 await search.fill('B24 Товар');await ready();await wait(async()=>(await pager.innerText()).includes('записів 67'));
 assert.equal(await stock.locator('tbody tr').count(),30);assert((await pager.getByRole('button',{name:'Далі',exact:true}).boundingBox()).height>=44);assert.match(await stock.locator('.stock-cards').innerText(),/670(?:,00)? грн/);
 await pager.getByRole('button',{name:'Далі',exact:true}).press('Enter');await ready();assert.match(await pager.innerText(),/2 \/ 3/);assert(await pager.getByRole('button',{name:'Далі',exact:true}).evaluate(e=>document.activeElement===e));
 await pager.getByRole('button',{name:'Далі',exact:true}).press('Enter');await ready();assert.match(await pager.innerText(),/3 \/ 3/);assert.equal(await stock.locator('tbody tr').count(),7);assert.match(await stock.innerText(),/B24 Товар 066/);
 await page.getByRole('button',{name:/^Партії/}).press('Enter');await ready();assert.equal(await page.getByRole('region',{name:'Партії — горизонтальна таблиця',exact:true}).locator('tbody tr').count(),30);
 await page.getByRole('button',{name:'Асортимент складу',exact:true}).press('Enter');await pick('Склад асортименту',warehouseName);
 const assortment=page.locator('.stock-panel').filter({has:page.getByRole('button',{name:'Асортимент складу',exact:true})}),row=page.locator(`[data-stock-draft="${warehouse}:b24_000"]`),input=row.getByRole('textbox');
 assert.equal(await assortment.locator(':scope > [data-stock-draft]').count(),30);assert((await row.getByRole('button',{name:'Зберегти',exact:true}).boundingBox()).height>=44);
 await input.fill('3.125');const assortmentPager=page.getByRole('navigation',{name:'Сторінки асортименту',exact:true});await assortmentPager.getByRole('button',{name:'Далі',exact:true}).press('Enter');await ready();assert.match(await assortmentPager.innerText(),/2 \/ 3/);
 await page.getByRole('button',{name:/B24 Товар 000.*відкрити чернетку/}).press('Enter');await ready();assert.equal(await assortment.locator(':scope > [data-stock-draft]').count(),1);assert.equal(await input.inputValue(),'3.125');await wait(async()=>await input.evaluate(node=>document.activeElement===node));assert(await input.evaluate(node=>document.activeElement===node),'opening the selected draft focuses its minimum input');
 // A fresh current GET leaves the original baseline intact; 409 requires explicit Apply and separate Save.
 await ok('assortment','POST',{warehouse,product:'b24_000',sold:true,min_stock:'4'});await page.getByRole('button',{name:'Оновити',exact:true}).click();await ready();assert.equal(await input.inputValue(),'3.125');
 await row.getByRole('button',{name:'Зберегти',exact:true}).press('Enter');await row.getByText('Запис змінився. Порівняйте зміни перед збереженням.',{exact:true}).waitFor();assert.equal((await ok('assortment?warehouse='+warehouse+'&product=b24_000')).rows[0].min_stock,'4.000');assert.equal(await input.inputValue(),'3.125');
 await row.getByRole('button',{name:'Порівняти поточний стан',exact:true}).press('Enter');await row.getByRole('radio',{name:'Залишити мої зміни',exact:true}).press('Space');await row.getByRole('button',{name:'Застосувати узгоджені зміни',exact:true}).press('Enter');assert.equal((await ok('assortment?warehouse='+warehouse+'&product=b24_000')).rows[0].min_stock,'4.000','Apply alone performs no write');
 await row.getByRole('button',{name:'Зберегти',exact:true}).press('Enter');await page.getByText('Асортимент збережено.',{exact:true}).waitFor();await ready();await wait(async()=>await row.getByRole('button',{name:'Зберегти',exact:true}).isDisabled());assert.equal((await ok('assortment?warehouse='+warehouse+'&product=b24_000')).rows[0].min_stock,'3.125');
 await input.fill('9');await row.getByRole('button',{name:'Скинути чернетку',exact:true}).click();assert.equal(await input.inputValue(),'3.125','discard restores the confirmed row');await wait(async()=>await row.getByRole('heading',{name:/B24 Товар 000/}).evaluate(node=>document.activeElement===node));assert(await row.getByRole('heading',{name:/B24 Товар 000/}).evaluate(node=>document.activeElement===node),'discard focuses the same row heading');
 await page.getByRole('button',{name:'Увесь асортимент',exact:true}).click();await ready();assert.equal(await assortment.locator(':scope > [data-stock-draft]').count(),30);await input.fill('6.250');
 let fail=true;await page.route('**/api/v1/trading/stock?*',route=>{if(fail){fail=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Ізольована помилка читання залишків'})});}return route.continue();});
 await search.fill('B24 Товар 066');await page.getByRole('button',{name:'Повторити читання',exact:true}).waitFor();assert(await page.evaluate(()=>window.ReactStock.hasDrafts()),'failed read retains the raw draft while current private results are unmounted');assert.equal(await page.getByRole('button',{name:'CSV залишків',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Повторити читання',exact:true}).press('Enter');await ready();assert.match(await pager.innerText(),/записів 1/);assert.equal(await input.inputValue(),'6.250','off-filter pinned draft returns after current read');await page.unroute('**/api/v1/trading/stock?*');
 // An earlier slow search cannot replace the newer filter/result or move its caret.
 await page.route('**/api/v1/trading/stock?*',async route=>{if(new URL(route.request().url()).searchParams.get('q')==='B24 Товар 00')await new Promise(resolve=>setTimeout(resolve,700));try{await route.continue();}catch{}});
 await search.fill('B24 Товар 00');await page.waitForTimeout(300);await search.fill('B24 Товар 066');await ready();await page.waitForTimeout(850);assert.equal(await search.inputValue(),'B24 Товар 066');assert(await search.evaluate(e=>document.activeElement===e&&e.selectionStart===e.value.length));assert.match(await stock.innerText(),/B24 Товар 066/);await page.unroute('**/api/v1/trading/stock?*');
 await page.getByRole('button',{name:/B24 Товар 000.*відкрити чернетку/}).click();await ready();assert.equal(await input.inputValue(),'6.250');await wait(async()=>await input.evaluate(node=>document.activeElement===node));assert(await input.evaluate(node=>document.activeElement===node),'reopening an off-filter draft focuses its minimum input');
 const geometry=[];for(const width of [1440,320]){await page.setViewportSize({width,height:1050});await stock.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(proof,'stock-'+width+'.png')});await assortment.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(proof,'assortment-'+width+'.png')});await input.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(proof,'assortment-row-'+width+'.png')});const bounds=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth}));assert(bounds.documentWidth<=width+1);geometry.push(bounds);}
 await search.fill('B24 Товар');await ready();assert.match(await pager.innerText(),/записів 67/);const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'CSV залишків',exact:true}).click();await(await downloaded).saveAs(path.join(proof,'stock.csv'));const records=csv.parse(fs.readFileSync(path.join(proof,'stock.csv'),'utf8'));assert.equal(records.length,68);assert(records.some(row=>row[0].includes('B24 Товар 066')));
 assert(requests.every(r=>r.count<=30));assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(proof,'report.json'),JSON.stringify({pass:true,geometry,requests,checks:['actual SQL-backed totals/lots/assortment page30','whole filtered670.00summary','last row reachable','keyboard pagination and focus','selected-ID draft hydration','fresh row conflict keeps draft','503retry keeps draft','abort/newestsearch caret','320/1440 no overflow','all67 CSV export']},null,2));
 console.log('PASS B24 native ERP stock/assortment page30, full summary, race/retry/drafts/CSV, keyboard320/1440; '+proof);
})().catch(async error=>{console.error(error);process.exitCode=1;const page=browser?.contexts()[0]?.pages()[0];if(page){fs.writeFileSync(path.join(proof,'failure.txt'),await page.locator('body').innerText());await page.screenshot({path:path.join(proof,'failure.png')});}}).finally(async()=>{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));fs.closeSync(log);fs.rmSync(data,{recursive:true,force:true});});
