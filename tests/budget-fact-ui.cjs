/* Budget plan versus actual expenses by accounting category; disposable local SQLite only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port=18237,base=`http://localhost:${port}`,password='isolated-budget-fact-password';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-budget-fact-db-'));
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of Object.keys(env))if(/^DB_|^PG/.test(key)||['DATABASE_URL','POSTGRES_URL'].includes(key))delete env[key];
delete env.TSUKENYA_REQUIRE_POSTGRES;
const log=fs.openSync(path.join(data,'server.log'),'a'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});fs.closeSync(log);let browser;
const wait=async(fn,label)=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);};
// Plan: rent 10 000 (category guessed from the name), sales staff 20 000 (guessed as payroll), delivery 3 000 (guessed as logistics).
// Actual this month: rent 12 000 (over plan) and payroll 5 000; a draft expense does not count.
const seed=`import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from django.contrib.auth.models import User
from django.utils import timezone
from server.erp.models import CashAccount, Document, Employee, Store, Voucher
Document.objects.filter(path__startswith='expenses/').delete()
for id,name,amount in [('rent','Оренда магазину',10000),('staff','Зарплата продавців',20000),('delivery','Доставка товару',3000)]:
    Document.objects.create(path='expenses/'+id,data={'name':name,'group':'fixed','amount':amount,'order':1})
owner=User.objects.get(username='tester');store=Store.objects.first();account=CashAccount.objects.filter(store=store).first();today=timezone.localdate()
worker=Employee.objects.create(name='Продавець',store=store,shift_rate=300)
for kind,total,status,extra in [('expense','12000','posted',{'payload':{'category':'Оренда'}}),('expense','999','draft',{'payload':{'category':'Логістика'}}),('payroll','5000','posted',{'employee':worker})]:
    Voucher.objects.create(kind=kind,status=status,date=today,store=store,account=account,total=total,created_by=owner,**extra)`;
const text=locator=>locator.innerText().then(value=>value.replace(/\s+/g,' ').trim());
(async()=>{try{
 await wait(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(data,'server.log'),'utf8').slice(-2000));try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');
 execFileSync(python,['-c',seed],{cwd:root,env});
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH||process.platform==='darwin'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());
 let fail=true;
 await page.route('**/api/erp/budget-fact',route=>fail?route.fulfill({status:500,contentType:'application/json',body:'{"error":"Ізольований збій"}'}):route.continue());
 await require('./browser-login.cjs')(page,base,password);
 await page.goto(base+'/#operations/expenses',{waitUntil:'domcontentloaded'});
 await page.locator('[data-budget-mode=catalog]').click();
 const card=page.locator('.budget-fact');await card.waitFor();
 await wait(async()=>/Не вдалося завантажити фактичні витрати/.test(await text(card)),'failure is explained');
 fail=false;await card.getByRole('button',{name:'Повторити'}).click();
 await wait(async()=>/Разом/.test(await text(card)),'table after retry');
 const row=name=>text(card.locator('tbody tr',{has:page.locator('th',{hasText:name})}));
 assert.match(await row('Оренда'),/Оренда 10 000,00 грн 12 000,00 грн 120% Перевищено на 2 000,00 грн/);
 assert.match(await row('Зарплата'),/Зарплата 20 000,00 грн 5 000,00 грн 25%/);
 assert.match(await row('Логістика'),/Логістика 3 000,00 грн 0,00 грн 0%/,'a draft expense is not actual');
 assert.match(await text(card.locator('tfoot')),/Разом 33 000,00 грн 17 000,00 грн 52%/);
 // The guessed category of a line can be changed and is saved on the line.
 const select=page.getByRole('combobox',{name:'Категорія обліку: Доставка товару'});
 assert.equal(await select.inputValue(),'Логістика');
 await select.selectOption('Інше');
 await wait(async()=>(await card.locator('tbody th',{hasText:'Логістика'}).count())===0&&/Інше 3 000,00 грн/.test(await row('Інше')),'category moves the plan');
 await wait(async()=>(await page.evaluate(async()=>(await(await fetch('/api/state')).json()).data.expenses.find(e=>e.id==='delivery')?.data.category))==='Інше','category is stored');
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:900});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`no page overflow at ${width}`);
  assert(await card.locator('tbody td').first().evaluate(td=>{const wrap=td.closest('.budget-fact-wrap').getBoundingClientRect(),r=document.createRange();r.selectNodeContents(td);return r.getBoundingClientRect().right<=wrap.right+1;}),`amounts stay visible at ${width}`);
  await card.screenshot({path:path.join(os.tmpdir(),`tsukenya-budget-fact-${width}.png`)});
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: budget plan versus fact — guessed and stored line categories, posted expenses and payroll only, over-plan warning, totals, retry after failure, 1440/390/320 layout; isolated data only.');
}catch(e){console.error(e);process.exitCode=1;}finally{await browser?.close();server.kill();}})();
