/* Purchases: products below minimum open a prefilled purchase order draft; disposable local SQLite only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port=18235,base=`http://localhost:${port}`,password='isolated-replenish-password';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-replenish-db-'));
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of Object.keys(env))if(/^DB_|^PG/.test(key)||['DATABASE_URL','POSTGRES_URL'].includes(key))delete env[key];
const log=fs.openSync(path.join(data,'server.log'),'a'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});fs.closeSync(log);let browser;
const wait=async(fn,label)=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);};
// Caramel: minimum 10, received 10 at 12.50 and written off 7, so 7 are suggested from its supplier. Gingerbread: minimum 3, never received.
const seed=`import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from django.contrib.auth.models import User
from django.utils import timezone
from server.erp.models import Counterparty, Document, Store, Warehouse
from server.erp.services import post_voucher, save_voucher
owner=User.objects.get(username='tester');store=Store.objects.first();wh=Warehouse.objects.get(store=store)
Document.objects.create(path='products/caramel',data={'name':'Карамель льодяникова','unit':'шт','minStock':10})
Document.objects.create(path='products/ginger',data={'name':'Пряник медовий','unit':'шт','minStock':3})
supplier=Counterparty.objects.create(name='ТОВ «Солодкий світ»',kind='supplier')
today=timezone.localdate().isoformat()
for kind,price,quantity in [('receipt','12.50',10),('writeoff','0',7)]:
    body={'kind':kind,'store':store.pk,'warehouse':wh.pk,'date':today,'lines':[{'product':'caramel','quantity':quantity,'price':price}]}
    if kind=='receipt':body['party']=supplier.pk
    post_voucher(owner,save_voucher(owner,body).pk)
print(supplier.pk)`;
const text=locator=>locator.innerText().then(value=>value.replace(/\s+/g,' ').trim());
(async()=>{try{
 await wait(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(data,'server.log'),'utf8').slice(-2000));try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');
 const supplier=execFileSync(python,['-c',seed],{cwd:root,env,encoding:'utf8'}).trim();
 browser=await chromium.launch({ headless: true });
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());
 await require('./browser-login.cjs')(page,base,password);
 await page.goto(base+'/#trade/purchases',{waitUntil:'domcontentloaded'});
 const panel=page.locator('#main section.panel',{has:page.getByRole('heading',{name:'Поповнення запасів'})});
 await panel.waitFor();
 const rows=panel.locator('tbody tr');
 assert.equal(await rows.count(),2,'one row per supplier and warehouse');
 assert.match(await text(rows.first()),/ТОВ «Солодкий світ».*Карамель льодяникова — 7 шт.*87,50 грн/);
 assert.match(await text(rows.nth(1)),/Не визначено.*Пряник медовий — 3 шт.*0,00 грн/);
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:900});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`no page overflow at ${width}`);
 }
 await page.setViewportSize({width:1440,height:1000});
 // The draft carries the supplier, warehouse, quantity and last price; the user posts it after review.
 await panel.getByRole('button',{name:/Створити замовлення: ТОВ «Солодкий світ»/}).click();
 const form=page.locator('#tradeVoucherForm');await form.waitFor();
 assert.equal(await form.locator('[name=party]').inputValue(),supplier);
 assert.equal(await form.locator('[data-line=product]').inputValue(),'caramel');
 assert.equal(Number(await form.locator('[data-line=quantity]').inputValue()),7);
 assert.equal(Number(await form.locator('[data-line=price]').inputValue()),12.5);
 await page.locator('[type=submit][form=tradeVoucherForm][value=post]').click();
 await page.locator('.trade-dialog-head h2').filter({hasText:'Замовлення постачальнику ·'}).waitFor();
 const order=await page.evaluate(async()=>(await(await fetch('/api/erp/vouchers?kind=purchase_order')).json()).items[0]);
 assert.deepEqual([order.status,order.total],['posted','87.50']);
 // The posted order covers the caramel; only the product without a supplier is still suggested.
 await page.locator('.trade-dialog [data-trade=close]').click();
 await page.goto(base+'/#trade/stock',{waitUntil:'domcontentloaded'});await page.goto(base+'/#trade/purchases',{waitUntil:'domcontentloaded'});
 await wait(async()=>(await rows.count())===1&&/Пряник медовий/.test(await text(rows.first())),'ordered product leaves the suggestions');
 assert.match(await text(panel),/1 товарів нижче мінімуму вже покриті проведеними замовленнями/);
 // Warehouse assortment (B13): the gingerbread is not sold in this warehouse, so it leaves the suggestions; keyboard only.
 await page.goto(base+'/#trade/stock',{waitUntil:'domcontentloaded'});
 const assortment=page.locator('#main section.panel',{has:page.getByRole('heading',{name:'Асортимент складу'})});
 await assortment.waitFor();await assortment.getByText('Що продається на складі та мінімальні залишки').click();
 const sold=assortment.getByRole('checkbox',{name:/Продається тут: Пряник медовий/});
 assert.equal(await sold.isChecked(),true,'without a row the product is sold everywhere');
 assert.equal(await assortment.getByRole('spinbutton',{name:/Мінімум на складі: Пряник медовий/}).getAttribute('placeholder'),'3');
 await sold.focus();await page.keyboard.press('Space');assert.equal(await sold.isChecked(),false);
 await page.keyboard.press('Tab');await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Зберегти асортимент: Пряник медовий');
 await page.keyboard.press('Enter');
 await wait(async()=>/Збережено: Пряник медовий\. Не продається на цьому складі/.test(await text(assortment.locator('#tradeAssortmentStatus'))),'assortment row saved');
 assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Зберегти асортимент: Пряник медовий','focus returns to the saved row');
 assert.equal(await assortment.getByRole('checkbox',{name:/Продається тут: Пряник медовий/}).isChecked(),false);
 // A second form that opened before this save carries an old version and is refused.
 const stale=await page.evaluate(async()=>{const csrf=(await(await fetch('/api/state')).json()).csrf,wh=(await(await fetch('/api/erp/state')).json()).warehouses[0].id;const r=await fetch('/api/erp/assortment',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({warehouse:wh,product:'ginger',sold:true,min_stock:null})});return [r.status,(await r.json()).code];});
 assert.deepEqual(stale,[409,'revision_conflict']);
 for(const width of [390,320]){
  await page.setViewportSize({width,height:900});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`no assortment overflow at ${width}`);
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(base+'/#trade/purchases',{waitUntil:'domcontentloaded'});
 await wait(async()=>(await rows.count())===0&&/Усі товари вище мінімального залишку/.test(await text(panel)),'not sold product leaves the suggestions');
 assert.deepEqual(errors,[]);
 console.log('PASS: purchases replenishment — minimum minus available and open orders, last supplier and price, prefilled purchase order, covered after posting, warehouse assortment by keyboard removes a not sold product, stale assortment version 409, 1440/390/320 layout; isolated data only.');
}catch(e){console.error(e);process.exitCode=1;}finally{await browser?.close();server.kill();}})();
