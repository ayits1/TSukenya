/* Actual native bounded report consumers; disposable SQLite, synthetic data only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-bounded-reports-ui-')),python=process.env.PYTHON_BIN||'python3',port=18516,base=`http://localhost:${port}`,password='isolated-bounded-reports-password';
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'test.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of Object.keys(env))if(key==='DATABASE_URL'||key==='TSUKENYA_REQUIRE_POSTGRES'||key.startsWith('DB_')||key.startsWith('PG'))delete env[key];
const log=fs.openSync(path.join(data,'server.log'),'w'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});let browser,page;const errors=[],calls=[],artifacts=[];
const wait=async fn=>{for(let n=0;n<180;n++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out bounded reports');};
const stage=text=>console.log(text);
(async()=>{
 await wait(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}});
 execFileSync(python,['-c',`import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from django.contrib.auth.models import User
from django.utils import timezone
from server.erp.models import *
from tests.test_bounded_reports import BoundedReportsTests
u=User.objects.get(username='tester');s=Store.objects.first();w=Warehouse.objects.first();a=CashAccount.objects.first()
f=BoundedReportsTests();f.u=u;f.store=s;f.wh=w;f.cash=a;f.bank=a;f.today=timezone.localdate().isoformat();f.party=Counterparty.objects.create(name='Постачальник',kind='supplier');f.customer=Counterparty.objects.create(name='Покупець',kind='customer');f.wide()
Document.objects.filter(pk='products/w1').update(data={'name':'<img src=x onerror=alert(1)>','unit':'шт'})
VoucherLine.objects.filter(product_id='products/w1').update(name='<img src=x onerror=alert(1)>')
import hashlib,time
own=Store.objects.get(name='Крамниця000')
for role in ['manager','owner']:
 person=User.objects.create(username='scoped-'+role);Profile.objects.create(user=person,role=role,store=own)
 PortalSession.objects.create(user=person,token_hash=hashlib.sha256(('scoped-'+role).encode()).hexdigest(),csrf='qa-report-scope',expires=int(time.time())+3600)
`],{cwd:root,env,stdio:'pipe'});
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/'))calls.push({url:r.url(),method:r.method()});});
 await require('./browser-login.cjs')(page,base,password);await page.goto(base+'/#trade/reports');
 await wait(async()=>await page.locator('[data-report-pager]').innerText().then(t=>t.includes('65 рядків')).catch(()=>false));
 assert.equal(await page.locator('#boundedReportRows tbody tr').count(),30);assert.equal(await page.locator('#boundedReportRows img').count(),0);assert((await page.locator('#boundedReportRows').innerText()).includes('<img src=x'));
 stage('initial period page30 / escaped name PASS');
 if(process.env.QA_REPORT_FROM==='network'){fs.writeFileSync(path.join(data,'requests.json'),JSON.stringify(calls,null,2));console.log('legacyCandidates='+JSON.stringify(calls.filter(x=>/\/api\/erp\/(report\?|state)/.test(x.url)||x.url.endsWith('/api/state'))));return;}
 async function expiryProof(){
  // A transport that ignores AbortSignal must still be fenced after cancellation/navigation.
  await page.evaluate(()=>{const host=document.createElement('div');host.id='expiry-cancel-host';document.body.append(host);window.expiryReports=window.TradeReports.create();window.expiryReports.mount(host);});
  const extra=page.locator('#expiry-cancel-host');await wait(async()=>await extra.locator('[data-report-form]').getAttribute('aria-busy')==='false');
  await page.evaluate(()=>{window.beforeExpiryFetch=window.fetch;window.fetch=(input,opts)=>String(input).includes('/reports/summary?')?window.beforeExpiryFetch(input,{...opts,signal:undefined}).then(r=>{window.lateExpiryArrived=true;return r;}):window.beforeExpiryFetch(input,opts);});
  let lateRoute;const lateURL='**/api/v1/trading/reports/summary?*';await page.route(lateURL,route=>{lateRoute=route;});await extra.locator('[data-report-form] [type=submit]').click();await wait(async()=>!!lateRoute);
  await page.evaluate(()=>{window.expiryReports.cancel();document.getElementById('expiry-cancel-host').remove();location.hash='#operations/overview';});await page.locator('#main .stats').first().waitFor();await lateRoute.fulfill({status:401,contentType:'application/json',body:'{}'});await wait(async()=>await page.evaluate(()=>window.lateExpiryArrived===true));await page.evaluate(()=>new Promise(r=>setTimeout(r,20)));assert.equal(new URL(page.url()).hash,'#operations/overview');assert.equal(await page.locator('[name=username]').count(),0);await page.unroute(lateURL);await page.evaluate(()=>{window.fetch=window.beforeExpiryFetch;});stage('cancel/navigation fences late401 even with ignored AbortSignal PASS');
  await page.goto(base+'/#trade/reports');await wait(async()=>await page.locator('[data-report-form]').getAttribute('aria-busy')==='false'&&await page.locator('#boundedReportRows tbody tr').count()===30);
  // Isolate report recovery from the independent background metadata poll.
  const metadata=await(await page.context().request.get(base+'/api/v1/portal/state')).json();await page.route('**/api/v1/portal/state',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(metadata)}));
  await page.evaluate(()=>window.addEventListener('beforeunload',()=>sessionStorage.setItem('report-expiry-clear',JSON.stringify({summary:document.querySelector('[data-report-summary]')?.textContent,debts:document.querySelector('[data-report-debts]')?.textContent,exports:document.querySelectorAll('[data-report-export][href]').length,sources:document.querySelectorAll('[data-report-source]').length})),{once:true}));
  execFileSync(python,['-c',"import os,time;os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings');import django;django.setup();from server.erp.models import PortalSession;PortalSession.objects.filter(user__username='tester').update(expires=int(time.time())-1)"],{cwd:root,env});
  const expiredResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/trading/reports/summary'&&r.status()===401);await page.locator('[data-report-form] [type=submit]').click();await expiredResponse;await page.locator('[name=username]').waitFor();const cleared=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('report-expiry-clear')));assert.deepEqual(cleared,{summary:'',debts:'',exports:0,sources:0});assert.equal(new URL(page.url()).hash,'');assert.equal(await page.locator('[data-report-summary]').count(),0);stage('actual expired server session401 clears private report/debts before redirect to login PASS');
 }
 if(process.env.QA_REPORT_FROM==='expiry'){await expiryProof();return;}
 async function sourcesProof(){
  await wait(async()=>await page.locator('[data-report-form]').getAttribute('aria-busy')==='false');await page.locator('.trade-report-source-actions summary').press('Enter');const opener=page.locator('[data-report-source][data-metric=expenses]');await opener.press('Enter');
  const dialog=page.locator('[data-report-sources]');await wait(async()=>await dialog.count()&&await dialog.locator('[data-source-content]').getAttribute('aria-busy')!=='true'&&!!await dialog.locator('[data-source-status]').innerText());assert.match(await dialog.innerText(),/195,00 грн/);assert.equal(await dialog.locator('[data-source-voucher]').count(),30);assert(await dialog.locator('h2').evaluate(e=>e===document.activeElement));
  await dialog.press('Escape');await dialog.waitFor({state:'detached'});assert(await opener.evaluate(e=>e===document.activeElement));stage('actual summary source drilldown paged30 / heading focus / Escape return PASS');
 }
 if(process.env.QA_REPORT_FROM==='sources'){await sourcesProof();return;}
 async function recoveryProof(){
  await wait(async()=>await page.locator('[data-report-form]').getAttribute('aria-busy')==='false');
  const previous=await page.locator('[data-report-summary]').innerText(),oldFrom=await page.locator('[data-report-form] [name=from]').inputValue();
  const earlier=new Date(oldFrom+'T12:00:00Z');earlier.setUTCDate(earlier.getUTCDate()-1);const changed=earlier.toISOString().slice(0,10);await page.locator('[data-report-form] [name=from]').fill(changed);
  let release;const gate=new Promise(resolve=>release=resolve),url='**/api/v1/trading/reports/summary?*';
  await page.route(url,async route=>{await gate;await route.fulfill({status:503,contentType:'application/json',body:'{}'});});
  await page.locator('[data-report-form] [type=submit]').click();await wait(async()=>await page.locator('[data-report-form]').getAttribute('aria-busy')==='true');assert(await page.locator('[data-report-form] [name=from]').isDisabled());release();
  await page.locator('[data-report-retry]').waitFor({state:'visible'});assert.equal(await page.locator('[data-report-summary]').innerText(),previous);assert.equal(await page.locator('[data-report-form] [name=from]').inputValue(),changed);assert(!(await page.locator('[data-report-form] [name=from]').isDisabled()));assert.match(await page.locator('[data-report-status]').innerText(),/попередній підтверджений/);assert.equal(await page.locator('[data-report-export][href]').count(),0);assert.equal(await page.locator('[data-report-source]:not([disabled])').count(),0);
  await page.unroute(url);await page.locator('[data-report-retry]').focus();await page.keyboard.press('Enter');await wait(async()=>await page.locator('[data-report-form]').getAttribute('aria-busy')==='false'&&await page.locator('[data-report-export][href]').count()>0);assert((await page.locator('[data-report-summary]').innerText()).includes(changed));
  await page.route(url,route=>route.fulfill({status:403,contentType:'application/json',body:'{}'}));await page.locator('[data-report-form] [type=submit]').click();await page.locator('[data-report-retry]').waitFor({state:'visible'});assert.equal(await page.locator('[data-report-summary]').innerText(),'');assert.equal(await page.locator('[data-report-debts]').innerText(),'');await page.unroute(url);
  stage('503 previous-confirmed dates / failed draft retained / busy+keyboard GET retry /403 privacy clear PASS');
 }
 if(process.env.QA_REPORT_FROM==='recovery'){await recoveryProof();return;}
 async function tailProof(){
 if(process.env.QA_REPORT_FROM!=='scope'){
  if(process.env.QA_REPORT_FROM!=='layout'){
  const delayed='**/api/v1/trading/reports/summary?*';await page.route(delayed,async r=>{await new Promise(resolve=>setTimeout(resolve,350));await r.continue().catch(()=>{});});
  await page.getByRole('tab',{name:'Обороти періоду',exact:true}).focus();await page.keyboard.press('ArrowRight');assert(await page.getByRole('tab',{name:'Залишки на дату',exact:true}).evaluate(e=>e===document.activeElement));
  await page.keyboard.press('ArrowLeft');assert(await page.getByRole('tab',{name:'Обороти періоду',exact:true}).evaluate(e=>e===document.activeElement));
  await wait(async()=>await page.locator('[data-report-section="products"][aria-selected=true]').count()===1&&await page.locator('#boundedReportRows tbody tr').count()===30);await page.unroute(delayed);stage('pending rapidArrow immediate focus PASS');
  await page.evaluate(()=>{const host=document.createElement('div');host.id='same-report-host';document.body.append(host);window.sameReports=window.TradeReports.create();window.sameReports.mount(host);window.sameReports.mount(host);});
  const same=page.locator('#same-report-host');await wait(async()=>await same.locator('tbody tr').count()===30);const before=calls.filter(r=>r.url.includes('/reports/rows?')).length;
  await same.locator('[data-report-section="cashiers"]').click();await wait(async()=>await same.locator('th').filter({hasText:'З розходженням'}).count()===1&&await same.locator('tbody tr').count()===30);assert.equal(calls.filter(r=>r.url.includes('/reports/rows?')).length-before,1);
  await page.evaluate(()=>window.sameReports.cancel());const after=calls.length;await same.locator('[data-report-section="by_store"]').click();await new Promise(resolve=>setTimeout(resolve,150));assert.equal(calls.length,after);await same.evaluate(e=>e.remove());stage('samehost remount one handler / cancel inert PASS');
  }
  await page.locator('[data-report-section="expenses_by_category"]').click();await wait(async()=>await page.locator('#boundedReportRows tbody tr').count()===30&&await page.locator('[data-report-form]').getAttribute('aria-busy')==='false'&&await page.locator('#boundedReportRows th').filter({hasText:'Стаття'}).count()===1);assert((await page.locator('#boundedReportRows').innerText()).includes('Крамниця'));assert((await page.locator('[data-report-summary]').innerText()).includes('Кредитний продаж'));
  for(const width of [1440,320]){
   await page.setViewportSize({width,height:1000});await page.evaluate(()=>window.scrollTo(0,0));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overflow '+width);
   const file=path.join(data,`period-viewport-${width}.png`);await page.screenshot({path:file,fullPage:false});artifacts.push(file);
   await page.locator('[data-report-section="expenses_by_category"]').scrollIntoViewIfNeeded();const rows=path.join(data,`period-rows-${width}.png`);await page.screenshot({path:rows,fullPage:false});artifacts.push(rows);
  }
  }
  if(process.env.QA_REPORT_FROM!=='layout')for(const role of ['manager','owner']){
   await page.context().addCookies([{name:'ts_session',value:'scoped-'+role,url:base}]);await page.goto('about:blank');await page.goto(base+'/#trade/reports');await wait(async()=>await page.locator('#boundedReportRows tbody tr').count()===1);
   assert((await page.locator('[data-report-summary]').innerText()).includes('Крамниця000'));assert.equal(await page.locator('[data-report-form] input[type=hidden][name=store]').count(),1);
   await page.locator('[data-report-section="cashiers"]').click();await wait(async()=>await page.locator('#boundedReportRows tbody tr').count()===1&&await page.locator('[data-report-section="cashiers"][aria-selected=true]').count()===1);assert.equal(await page.locator('#boundedReportRows th').filter({hasText:'Бонус пізніх повернень'}).count(),role==='manager'?0:1);assert.equal(await page.locator('#boundedReportRows th').filter({hasText:'З розходженням'}).count(),1);
   await page.getByRole('tab',{name:'Залишки на дату',exact:true}).click();await wait(async()=>await page.locator('#boundedReportRows tbody tr').count()===1);assert.equal(await page.locator('[data-report-section="payroll_debts"]').count(),role==='manager'?0:1);
  }
  assert.deepEqual(errors,[]);assert.equal(calls.filter(x=>/\/api\/erp\/(report\?|state)/.test(x.url)||x.url.endsWith('/api/state')).length,0);assert.equal(calls.filter(x=>x.method!=='GET'&&!x.url.endsWith('/api/login')&&!x.url.endsWith('/api/v1/trading/directories/details')).length,0);
  console.log('BOUNDED REPORTS '+(process.env.QA_REPORT_FROM||'complete')+' PASS; artifacts='+JSON.stringify(artifacts));return;
 }
 if(['tail','scope','layout'].includes(process.env.QA_REPORT_FROM)){await tailProof();return;}
 await page.locator('[data-report-page="2"]').focus();await page.keyboard.press('Enter');await wait(async()=>await page.locator('[data-report-pager]').innerText().then(t=>t.includes('Сторінка 2')).catch(()=>false));assert.equal(await page.locator('#boundedReportRows tbody tr').count(),30);
 await page.locator('[data-report-page="3"]').click();await wait(async()=>await page.locator('#boundedReportRows tbody tr').count()===5);
 const download=page.waitForEvent('download');await page.locator('#boundedReportRows [data-report-export]').click();const csv=fs.readFileSync(await(await download).path(),'utf8');assert.equal(csv.split('\r\n').filter(Boolean).length,67);assert(csv.includes('\t=1+1'));
 stage('page3 + full65 CSV PASS');
 // A malformed page is not treated as a successful empty result; retry is GET-only and retains page.
 let bad=true;const route='**/api/v1/trading/reports/rows?*';await page.route(route,async route=>{if(bad){bad=false;await route.fulfill({status:200,contentType:'application/json',body:'{}'});}else await route.continue();});
 await page.locator('[data-report-page="2"]').click();await page.locator('[data-report-retry]').waitFor({state:'visible'});assert.equal(await page.locator('[data-report-export][href]').count(),0);await page.locator('[data-report-retry]').focus();await page.keyboard.press('Enter');await wait(async()=>await page.locator('[data-report-pager]').innerText().then(t=>t.includes('Сторінка 2')).catch(()=>false));await page.unroute(route);
 stage('malformed200 disables actions / exact GET retry PASS');
 await page.getByRole('tab',{name:'Обороти періоду',exact:true}).focus();await page.keyboard.press('ArrowRight');await wait(async()=>await page.locator('[data-report-section="stock"][aria-selected=true]').count()===1&&await page.locator('#boundedReportRows tbody tr').count()===30);assert(await page.getByRole('tab',{name:'Залишки на дату',exact:true}).evaluate(e=>e===document.activeElement));
 assert.equal(await page.getByRole('heading',{name:'Поточна заборгованість',exact:true}).count(),0);
 await page.locator('[data-report-section="stock"]').focus();await page.keyboard.press('End');await wait(async()=>await page.locator('[data-report-section="payroll_debts"][aria-selected=true]').count()===1&&await page.locator('#boundedReportRows tbody tr').count()===30);
 stage('mode/section keyboard and payroll page PASS');
 const all=page.waitForEvent('download');await page.locator('[data-report-summary] [data-report-export]').click();const allCsv=fs.readFileSync(await(await all).path(),'utf8');assert(allCsv.includes('Касир064'));assert(allCsv.includes('Партія')===false);assert(allCsv.includes('Покупець'));assert(allCsv.includes('Постачальник'));
 for(const width of [1440,320]){
  await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overflow '+width);
  await page.locator('[data-report-section="stock"]').click();await wait(async()=>await page.locator('#boundedReportRows tbody tr').count()===30);const filename=path.join(data,`balances-${width}.png`);await page.screenshot({path:filename,fullPage:true});artifacts.push(filename);
  await page.getByRole('tab',{name:'Обороти періоду',exact:true}).click();await wait(async()=>await page.locator('[data-report-section="products"][aria-selected=true]').count()===1&&await page.locator('#boundedReportRows tbody tr').count()===30);const period=path.join(data,`period-${width}.png`);await page.screenshot({path:period,fullPage:true});artifacts.push(period);
  if(width===1440){await page.getByRole('tab',{name:'Залишки на дату',exact:true}).click();await wait(async()=>await page.locator('#boundedReportRows tbody tr').count()===30);}
 }
 await sourcesProof();await recoveryProof();
 await page.goto('about:blank');await page.context().clearCookies();await require('./browser-login.cjs')(page,base,password);await page.goto(base+'/#trade/reports');await wait(async()=>await page.locator('#boundedReportRows tbody tr').count()===30);
 await tailProof();
 fs.writeFileSync(path.join(data,'requests.json'),JSON.stringify(calls,null,2));
 assert.equal(calls.filter(x=>/\/api\/erp\/(report\?|state)/.test(x.url)||x.url.endsWith('/api/state')).length,0);
 assert.equal(calls.filter(x=>x.method!=='GET'&&!x.url.endsWith('/api/login')&&!x.url.endsWith('/api/v1/trading/directories/details')).length,0);assert.deepEqual(errors,[]);
 await page.context().clearCookies();await require('./browser-login.cjs')(page,base,password);await page.goto(base+'/#trade/reports');await expiryProof();assert.deepEqual(errors,[]);
 console.log('BOUNDED REPORTS UI PASS: page65/fullCSV/strict recovery/keyboard320+1440/no legacy full reads; artifacts='+JSON.stringify(artifacts));
})().catch(async error=>{console.error(error);if(page){fs.writeFileSync(path.join(data,'dom.txt'),await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(data,'failure.png'),fullPage:true}).catch(()=>{});}console.error('artifacts '+data);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();fs.closeSync(log);});
