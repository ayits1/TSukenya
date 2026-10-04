/* Kyiv calendar boundaries, with all writes confined to disposable local SQLite. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port='18226';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-date-boundary-')),base=`http://localhost:${port}`,password='isolated-date-boundary-password';
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:port,HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of Object.keys(env))if(/^DB_|^PG/.test(key)||['DATABASE_URL','POSTGRES_URL'].includes(key))delete env[key];
const server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore','pipe','pipe']});let browser,page,startup='';
server.stdout.on('data',chunk=>startup+=chunk);server.stderr.on('data',chunk=>startup+=chunk);
const wait=async(fn,label)=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(`Timeout: ${label}`);};
const fixture=source=>execFileSync(python,['-c',`import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')\nimport django;django.setup()\n${source}`],{cwd:root,env,encoding:'utf8'});
const dialog=()=>page.locator('.trade-dialog[open]');
const go=async tab=>{await page.goto(base+'/#trade/'+tab,{waitUntil:'domcontentloaded'});await page.locator('#main .panel').first().waitFor();await wait(async()=>!(await page.locator('#main').innerText()).includes('Завантаження обліку'),tab);};
const close=async()=>{page.once('dialog',native=>native.accept());await page.keyboard.press('Escape');await dialog().waitFor({state:'hidden'});};
const bounds=async(input,expected)=>assert.deepEqual(await input.evaluate(el=>({type:el.type,min:el.min,max:el.max,step:el.step||'1'})),{type:'date',step:'1',...expected});
const fit=async()=>{assert.equal(await dialog().evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'320px dialog reflow');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'320px page reflow');};
(async()=>{
 await wait(async()=>{if(server.exitCode!==null)throw Error('Isolated server failed: '+startup);try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');
 const seed=JSON.parse(fixture(`import json
from datetime import datetime,timedelta,time
from zoneinfo import ZoneInfo
from django.utils import timezone
from server.erp.models import Employee,Store,CashAccount
today=timezone.localdate();midnight=datetime.combine(today,time(),tzinfo=ZoneInfo('Europe/Kyiv'))
store=Store.objects.first();account=CashAccount.objects.filter(store=store).first()
employee=Employee.objects.create(name='Синтетичний працівник меж дат',store=store,shift_rate='400',bonus_percent='0')
print(json.dumps({'today':str(today),'yesterday':str(today-timedelta(days=1)),'previous':str(today-timedelta(days=2)),'tomorrow':str(today+timedelta(days=1)),'before':(midnight-timedelta(seconds=30)).isoformat(),'after':(midnight+timedelta(seconds=30)).isoformat(),'employee':employee.pk,'store':store.pk,'account':account.pk}))`));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const ctx=await browser.newContext({viewport:{width:320,height:1000},timezoneId:'America/Los_Angeles'});page=await ctx.newPage();
 await page.route('https://fonts.googleapis.com/**',route=>route.abort());await page.route('https://fonts.gstatic.com/**',route=>route.abort());
 const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.clock.setFixedTime(new Date(seed.before));await require('./browser-login.cjs')(page,base,password);
 // A browser in the preceding local day must still use Kyiv on either side of midnight.
 for(const [instant,today,yesterday] of [[seed.before,seed.yesterday,seed.previous],[seed.after,seed.today,seed.yesterday]]){
  await page.clock.setFixedTime(new Date(instant));await go('setup');await page.locator('[data-trade=period]').press('Enter');
  await bounds(dialog().locator('[name=date]'),{min:'',max:yesterday});await close();
  await go('staff');await page.locator('[data-trade=work-shift]:not([data-id])').press('Enter');
  await bounds(dialog().locator('[name=date]'),{min:'',max:today});assert.equal(await dialog().locator('[name=date]').inputValue(),today);await close();
  await page.locator('[data-trade=new-voucher][data-kind=payroll]').press('Enter');
  await bounds(dialog().locator('[name=date]'),{min:'',max:today});assert.equal(await dialog().locator('[name=date]').inputValue(),today);await close();
 }
 assert.equal(await page.evaluate(()=>new Date().getDate()),Number(seed.yesterday.slice(-2)),'Browser is still in preceding day after Kyiv midnight');
 const csrf=(await(await ctx.request.get(base+'/api/state')).json()).csrf;
 const api=(method,url,value)=>ctx.request.fetch(base+url,{method,headers:{Origin:base,'X-CSRF-Token':csrf},data:value});
 // Actual Django rejects today's close, then accepts the completed preceding day.
 const rejected=await api('POST','/api/erp/period',{date:seed.today,reason:'Синтетична перевірка межі'});assert.equal(rejected.status(),400);assert.match((await rejected.json()).error,/лише завершені дні/);
 await go('setup');await page.locator('[data-trade=period]').press('Enter');await dialog().locator('[name=reason]').fill('Синтетичне закриття завершеного дня');
 const periodDate=dialog().locator('[name=date]');await periodDate.fill(seed.today);assert.equal(await periodDate.evaluate(el=>el.validity.rangeOverflow),true);await periodDate.fill(seed.yesterday);assert.equal(await periodDate.evaluate(el=>el.checkValidity()),true);await fit();
 let response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/erp/period'&&r.request().method()==='POST');await dialog().locator('[type=submit]').press('Enter');assert.equal((await response).status(),200);await dialog().waitFor({state:'hidden'});
 await go('staff');await page.locator('[data-trade=work-shift]:not([data-id])').press('Enter');const workDate=dialog().locator('[name=date]');
 await bounds(workDate,{min:seed.today,max:seed.today});await workDate.fill(seed.yesterday);assert.equal(await workDate.evaluate(el=>el.validity.rangeUnderflow),true);await workDate.fill(seed.tomorrow);assert.equal(await workDate.evaluate(el=>el.validity.rangeOverflow),true);await workDate.fill(seed.today);assert.equal(await workDate.evaluate(el=>el.checkValidity()),true);
 await wait(async()=>await dialog().locator('[data-cash-choice]').count()===1&&await dialog().locator('[data-cash-choice]').isEnabled(),'cash choice');await fit();
 for(const date of [seed.yesterday,seed.tomorrow]){const bad=await api('POST','/api/erp/work-shifts',{employee:seed.employee,date,units:'1',shift_rate:'400',bonus_percent:'0',bonus_basis:'store'});assert.equal(bad.status(),400);}
 response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/erp/work-shifts'&&r.request().method()==='POST');await dialog().locator('[type=submit]').press('Enter');const saved=await response;assert.equal(saved.status(),200);const work=(await saved.json()).id;await dialog().waitFor({state:'hidden'});
 await page.locator('[data-trade=new-voucher][data-kind=payroll]').press('Enter');await bounds(dialog().locator('[name=date]'),{min:seed.today,max:seed.today});await dialog().locator('[name=employee]').selectOption(String(seed.employee));const checkbox=dialog().locator(`[data-payroll-id="${work}"]`);await checkbox.waitFor();await checkbox.press('Space');assert.equal(await checkbox.isChecked(),true);await fit();
 response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/erp/vouchers'&&r.request().method()==='POST');await dialog().locator('[type=submit][value=draft]').press('Enter');const draft=await response;assert.equal(draft.status(),201);const voucher=(await draft.json()).id;await dialog().locator('[data-trade=edit-voucher]').waitFor();await close();
 const persisted=await(await ctx.request.get(base+'/api/erp/vouchers/'+voucher)).json();assert.equal(persisted.date,seed.today);assert.deepEqual(persisted.payload.shift_ids,[work]);
 for(const date of [seed.yesterday,seed.tomorrow]){const bad=await api('POST','/api/erp/vouchers',{kind:'expense',date,store:seed.store,account:seed.account,amount:'1',payload:{}});assert.equal(bad.status(),400);}
 // Explicit financial report uses the existing B17 end<=Kyiv today rule; legacy/default history remains compatible.
 await go('reports');const report=page.locator('[data-report-form]');await bounds(report.locator('[name=from]'),{min:'',max:seed.today});await bounds(report.locator('[name=to]'),{min:'',max:seed.today});
 await report.locator('[name=from]').fill(seed.today);await report.locator('[name=to]').fill(seed.yesterday);response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/trading/reports/summary');await report.locator('[type=submit]').press('Enter');assert.equal((await response).status(),400);await page.locator('[data-report-error]').filter({hasText:'Не вдалося прочитати звіт'}).waitFor();
 for(const endpoint of ['report','work-shifts','shifts']){assert.equal((await ctx.request.get(base+'/api/erp/'+endpoint+'?from='+seed.tomorrow+'&to='+seed.tomorrow)).status(),200);assert.equal((await ctx.request.get(base+'/api/erp/'+endpoint+'?from='+seed.tomorrow+'&to='+seed.today)).status(),400);}
 assert.deepEqual(errors,[]);console.log('PASS: Kyiv ±30s midnight in Los Angeles browser; native period/work/payroll daily min/max; real Django invalid400 and boundary200/201; period→work→payroll draft persists; Enter/Space/Escape and320px; report/history range ordering and future ranges. Disposable SQLite only. No source fix needed.');
})().catch(async error=>{if(page)await page.screenshot({path:path.join(os.tmpdir(),'tsukenya-date-boundary-failure.png')}).catch(()=>{});console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));fs.rmSync(data,{recursive:true,force:true});});
