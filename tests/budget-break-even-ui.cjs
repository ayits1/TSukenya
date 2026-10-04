/* Owner break-even: catalogue model without legacy demo products, plus actual 30-day sales; disposable local SQLite only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port=18231,base=`http://localhost:${port}`,password='isolated-examples-password';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-break-even-db-'));
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of Object.keys(env))if(/^DB_|^PG/.test(key)||['DATABASE_URL','POSTGRES_URL'].includes(key))delete env[key];
delete env.TSUKENYA_REQUIRE_POSTGRES;
const log=fs.openSync(path.join(data,'server.log'),'a'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});fs.closeSync(log);let browser,page;
const wait=async(fn,label)=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);};
// Two real products at 50% margin, two artifact examples at 90% margin, one fixed expense.
const seed=`import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from server.erp.models import Document
Document.objects.filter(path__startswith='products/').delete()
for id,name,cost,markup,example in [('real_a','Пряник медовий',50,100,False),('real_b','Карамель льодяникова',50,100,False),('p1','Цукерки глазуровані вагові',10,900,True),('p2','Печиво вівсяне',10,900,True)]:
 data={'name':name,'unit':'шт','cost':cost,'markup':markup,'manualPrice':False,'price':None,'priceAt':''}
 if example:data['example']=True
 Document.objects.create(path='products/'+id,data=data)
Document.objects.update_or_create(path='expenses/qa_rent',defaults={'data':{'name':'Оренда','group':'fixed','amount':1000,'order':1}})`;
const products=()=>page.evaluate(async()=>(await(await fetch('/api/state')).json()).data.products.map(p=>p.id).sort());
(async()=>{try{
 await wait(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(data,'server.log'),'utf8').slice(-2000));try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');
 execFileSync(python,['-c',seed],{cwd:root,env});
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH||process.platform==='darwin'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());
 await require('./browser-login.cjs')(page,base,password);
 const stat=label=>page.locator('.stat',{hasText:label}).locator('.v');
 await wait(async()=>(await stat('Товарів у каталозі').innerText())==='2','overview counts only real products');
 const notice=page.locator('#main p',{hasText:'товарів-прикладів'});
 assert.match(await notice.innerText(),/^2 товарів-прикладів/,'overview names the excluded examples');
 // The sales report fails once, then returns 30 000 грн revenue at 30% gross margin.
 const reports=[];let reportFails=true;
 const day=new Date(),to=day.toLocaleDateString('en-CA',{timeZone:'Europe/Kyiv'});day.setDate(day.getDate()-29);const from=day.toLocaleDateString('en-CA',{timeZone:'Europe/Kyiv'});
 await page.route('**/api/v1/portal/sales-margin',route=>{reports.push(true);return reportFails?route.fulfill({status:500,json:{error:'Ізольований збій'}}):route.fulfill({status:200,json:{from,to,revenue:'30000.00',gross:'9000.00',dailyRevenue:'1000.00',marginPercent:'30',needDaily:'111.11',gapDaily:'-888.89',basis:'accounting_dates_30d_weighted',reason:'ready'}});});
 await page.evaluate(()=>location.hash='#operations/expenses');
 await page.locator('[data-budget-mode=catalog]').click();
 const be=page.locator('.expense-budget .be');await be.waitFor();
 await wait(async()=>/Не вдалося завантажити фактичні продажі/.test(await be.innerText()),'report failure is explained');
 reportFails=false;await be.getByRole('button',{name:'Повторити'}).click();
 await wait(async()=>/За фактичними продажами/.test(await be.innerText()),'actual sales block');
 const facts=(await be.locator('.be-fact').innerText()).replace(/\s+/g,' ');
 assert.match(facts,/виторг 30 000,00 грн, валова маржа 30%, у середньому 1 000,00 грн на день/);
 assert.match(facts,/потрібно ≈ 111,11 грн на день/);
 assert.match(facts,/План покривається; відхилення -888,89 грн на день/);
 await be.getByText('Сценарії за каталогом',{exact:true}).click();
 const text=(await be.innerText()).replace(/\s+/g,' ');
 assert.match(text,/Маржа товарів: приблизно 50,00%/,'margin uses real products only, not the 90% examples');
 assert.match(text,/Враховано 2 із 2 товарів/,'coverage counts real products only');
 assert.match(text,/2 000,00 грн на місяць/,'break-even is 1000 / 0.5');
 assert.match(text,/2 товарів-прикладів/,'budget explains excluded examples');
 // Real source-history guard rejects one row while exact cleanup retains the rest.
 execFileSync(python,['-c',`import os;os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from server.erp.models import Document,Voucher,VoucherLine,Store
from django.contrib.auth.models import User
from datetime import date
v=Voucher.objects.create(kind='receipt',date=date.today(),store=Store.objects.first(),created_by=User.objects.get(username='tester'))
VoucherLine.objects.create(voucher=v,product=Document.objects.get(pk='products/p2'),quantity=1,price=1,amount=1)`],{cwd:root,env});
 await be.getByRole('button',{name:'Прибрати приклади'}).click();const dialog=page.locator('dialog[open]');await dialog.getByText(/2 прикладів/).waitFor();page.once('dialog',d=>d.accept());await dialog.getByRole('button',{name:'Прибрати приклади цієї сторінки'}).click();await dialog.getByText(/p1: прибрано/).waitFor();await dialog.getByText(/Товар уже використовується в обліку/).waitFor();assert.deepEqual(await products(),['p2','real_a','real_b']);await dialog.getByRole('button',{name:'Закрити',exact:true}).click();
 execFileSync(python,['-c',`import os;os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings');import django;django.setup()
from server.erp.models import VoucherLine
VoucherLine.objects.filter(product_id='products/p2').delete()`],{cwd:root,env});
 await be.getByRole('button',{name:'Прибрати приклади'}).click();await page.locator('dialog[open]').getByText(/1 прикладів/).waitFor();page.once('dialog',d=>d.accept());await page.locator('dialog[open]').getByRole('button',{name:'Прибрати приклади цієї сторінки'}).click();await page.locator('dialog[open]').getByText(/p2: прибрано/).waitFor();await page.locator('dialog[open]').getByRole('button',{name:'Закрити',exact:true}).click();assert.deepEqual(await products(),['real_a','real_b']);await wait(async()=>await page.locator('.be',{hasText:'товарів-прикладів'}).count()===0,'notice disappears');
 assert(reports.length>=2,'failed facts request can be explicitly retried');
 assert.deepEqual(errors,[]);
 console.log('budget-break-even-ui: ok');
}finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));fs.rmSync(data,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
