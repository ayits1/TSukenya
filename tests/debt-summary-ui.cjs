/* Overview debts card: overdue both ways and the supplier payment calendar; disposable local SQLite only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port=18233,base=`http://localhost:${port}`,password='isolated-debts-password';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-debts-db-'));
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of Object.keys(env))if(/^DB_|^PG/.test(key)||['DATABASE_URL','POSTGRES_URL'].includes(key))delete env[key];
const log=fs.openSync(path.join(data,'server.log'),'a'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});fs.closeSync(log);let browser;
const wait=async(fn,label)=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);};
// Posted documents written directly: one overdue sale (60 грн left), one overdue receipt, eight supplier payments due soon, one later.
const seed=`import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from datetime import timedelta
from django.contrib.auth.models import User
from django.utils import timezone
from server.erp.models import CashAccount, Counterparty, Store, Voucher
today=timezone.localdate();owner=User.objects.get(username='tester');store=Store.objects.first();bank=CashAccount.objects.filter(store=store).exclude(kind='cash').first()
supplier=Counterparty.objects.create(name='ТОВ «Солодкий світ» — постачальник кондитерських виробів для всієї мережі магазинів',kind='supplier')
customer=Counterparty.objects.create(name='Кав’ярня на розі',kind='customer')
def post(kind,party,total,days,**payload):
    Voucher.objects.create(kind=kind,status='posted',date=today,store=store,party=party,total=total,created_by=owner,payload={'due_date':(today+timedelta(days=days)).isoformat(),**payload})
post('sale',customer,'100',-2,payments=[{'account':bank.pk,'amount':'40'}])
post('receipt',supplier,'250',-1)
post('receipt',supplier,'100',0)
post('receipt',supplier,'1234.56',3)
for days in range(4,10):post('receipt',supplier,'10',days)
post('receipt',supplier,'999',30)`;
const text=locator=>locator.innerText().then(value=>value.replace(/\s+/g,' ').trim());
(async()=>{try{
 await wait(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(data,'server.log'),'utf8').slice(-2000));try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');
 execFileSync(python,['-c',seed],{cwd:root,env});
 browser=await chromium.launch({ headless: true });
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());
 // The first summary request fails; the card explains it and retries on request.
 let fail=true;
 await page.route('**/api/erp/debts/summary',route=>fail?route.fulfill({status:500,contentType:'application/json',body:'{"error":"Ізольований збій"}'}):route.continue());
 await require('./browser-login.cjs')(page,base,password);
 const card=page.locator('#main section.panel',{has:page.getByRole('heading',{name:'Борги й оплати'})});
 await wait(async()=>/Не вдалося завантажити борги/.test(await text(card)),'failure is explained');
 fail=false;await card.getByRole('button',{name:'Повторити'}).click();
 await wait(async()=>/Календар оплат постачальникам/.test(await text(card)),'calendar after retry');
 const stat=label=>text(card.locator('.stat',{hasText:label}));
 assert.equal(await stat('Прострочено: нам винні'),'Прострочено: нам винні 60,00 грн 1 документ');
 assert.equal(await stat('Прострочено: ми винні'),'Прострочено: ми винні 250,00 грн 1 документ');
 assert.equal(await stat('Оплатити постачальникам за 14 днів'),'Оплатити постачальникам за 14 днів 1 394,56 грн 8 документів');
 const rows=card.locator('.debt-calendar li');
 assert.equal(await rows.count(),5,'five nearest payments are listed; the count and total cover all eight');
 assert.match(await text(rows.first()),/^Сьогодні ТОВ «Солодкий світ».* · № \d{6} 100,00 грн$/);
 assert.match(await text(rows.nth(1)),/1 234,56 грн$/);
 assert.match(await text(card),/І ще 3 у найближчі 14 днів/);
 assert.doesNotMatch(await text(card),/999/,'a payment beyond 14 days is not listed');
 assert.equal(await card.getByRole('link',{name:'Фінанси'}).getAttribute('href'),'#trade/finance');
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:900});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`no page overflow at ${width}`);
  assert(await rows.first().evaluate(row=>[...row.children].every(child=>child.getBoundingClientRect().right<=row.getBoundingClientRect().right+1)),`calendar row fits at ${width}`);
  assert(await rows.first().evaluate(row=>row.querySelector('.who').getBoundingClientRect().width>=row.getBoundingClientRect().width*0.6),`supplier name keeps a readable width at ${width}`);
  await card.screenshot({path:path.join(os.tmpdir(),`tsukenya-debts-${width}.png`)});
 }
 // A cashier has no financial access, so the overview has no debts card and makes no summary request.
 const created=await page.evaluate(async()=>{const s=await(await fetch('/api/v1/session')).json(),state=await(await fetch('/api/erp/state')).json();return(await fetch('/api/erp/users',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({username:'cashier',password:'isolated-cashier-password',role:'cashier',store:state.stores[0].id})})).status;});
 assert.equal(created,200);
 const context=await browser.newContext(),cashier=await context.newPage(),requests=[];
 cashier.on('request',r=>{if(r.url().includes('/api/erp/debts'))requests.push(r.url());});
 await cashier.goto(base);await cashier.locator('[name=username]').fill('cashier');await cashier.locator('[name=password]').fill('isolated-cashier-password');await cashier.locator('button[type=submit]').click();
 await cashier.waitForSelector('#main .stats');
 assert.equal(await cashier.getByRole('heading',{name:'Борги й оплати'}).count(),0);assert.deepEqual(requests,[]);
 await context.close();
 assert.deepEqual(errors,[]);
 console.log('PASS: overview debts card — overdue both ways, 14-day supplier calendar, failure retry, 1440/390/320 layout, no card or request for a cashier; isolated data only.');
}catch(e){console.error(e);process.exitCode=1;}finally{await browser?.close();server.kill();}})();
