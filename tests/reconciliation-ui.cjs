/* One isolated native read-only journal path, keyboard/paging/recovery/reflow. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port=process.env.QA_RECONCILE_PORT||'18232',base=`http://localhost:${port}`,password='isolated-reconciliation-password';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-reconciliation-ui-'));
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:port,HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD','TSUKENYA_REQUIRE_POSTGRES'])delete env[key];
const server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:'ignore'});let browser;
const wait=async fn=>{for(let n=0;n<150;n++){if(server.exitCode!==null)throw Error('Isolated server exited');if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');};
const fixture=source=>execFileSync(python,['-c',`import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')\nimport django;django.setup()\n${source}`],{cwd:root,env,encoding:'utf8'});
(async()=>{await wait(async()=>{try{return(await fetch(base+'/health')).ok;}catch{return false;}});
 const seed=JSON.parse(fixture(`import json,uuid,copy
from django.utils import timezone
from server.erp.reconcile import reconcile
from server.erp.reconcile_journal import record
from server.erp.models import *
base=reconcile();now=timezone.now()
for n in range(30):record(uuid.uuid4(),'manual',base,now,now)
report=copy.deepcopy(base);report['checks']['lot_balance']['issues']=[{'check':'lot_balance','subject':f'stocklot/{n}','message':'Синтетична розбіжність кількості','expected':'100.001','actual':'99.999'} for n in range(205)];report['issues']=205
saved=record(uuid.uuid4(),'scheduler',report,now,now)
print(json.dumps({'id':str(saved.pk),'counts':[Voucher.objects.count(),StockEntry.objects.count(),CashEntry.objects.count(),AuditEvent.objects.count()]}))`));

 browser=await chromium.launch({ headless: true });
 const context=await browser.newContext({viewport:{width:320,height:1000}}),page=await context.newPage();const errors=[],methods=[];
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/reconciliation-runs'))methods.push(r.method());});
 await require('./browser-login.cjs')(page,base,password);await page.goto(base+'/#trade/setup');const opener=page.locator('[data-trade=reconciliation]');await opener.waitFor();await opener.focus();await page.keyboard.press('Enter');
 const dialog=page.locator('.trade-dialog[open]'),host=dialog.locator('[data-reconcile]');await host.locator('[data-reconcile-status]').filter({hasText:'Перевірок: 31'}).waitFor();
 await host.locator('[data-reconcile-next]').focus();await page.keyboard.press('Enter');await host.locator('[data-reconcile-status]').filter({hasText:'Сторінка 2 з 2'}).waitFor();
 await host.locator('[data-reconcile-prev]').click();await host.locator('[data-reconcile-id]').first().waitFor();await host.locator(`[data-reconcile-id="${seed.id}"]`).focus();await page.keyboard.press('Enter');
 await host.locator('[data-reconcile-status]').filter({hasText:'Розбіжностей: 205'}).waitFor();assert.equal(await host.locator('tbody tr').count(),107);
 for(let n=0;n<2;n++){await host.locator('[data-reconcile-next]').focus();await page.keyboard.press('Enter');await host.locator('[data-reconcile-status]').filter({hasText:`Сторінка ${n+2} з 3`}).waitFor();}
 assert.equal(await host.locator('tbody tr').count(),12);assert(await host.innerText().then(s=>s.includes('stocklot/204')));
 for(const width of [320,1440]){await page.setViewportSize({width,height:1000});assert.equal(await dialog.evaluate(d=>d.scrollWidth>d.clientWidth+1),false,'dialog overflow '+width);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'page overflow '+width);const shot=path.join(data,`journal-${width}.png`);await page.screenshot({path:shot});console.log('Screenshot '+shot);}
 await page.route('**/api/erp/reconciliation-runs/*/issues?*',r=>r.fulfill({status:200,contentType:'application/json',body:'{}'}));await host.locator('[data-reconcile-refresh]').click();await host.locator('[data-reconcile-error]').filter({hasText:'неповний журнал'}).waitFor();assert.equal(await host.locator('[data-reconcile-id]').count(),0);assert.equal(await host.locator('tbody tr').count(),0);assert.equal(await host.locator('[data-reconcile-error]').evaluate(e=>e===document.activeElement),true);
 await page.unroute('**/api/erp/reconciliation-runs/*/issues?*');await host.locator('[data-reconcile-refresh]').click();await host.locator('[data-reconcile-status]').filter({hasText:'Сторінка 3 з 3'}).waitFor();await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await opener.evaluate(e=>e===document.activeElement),true,'focus returns to opener without dirty prompt');
 const counts=JSON.parse(fixture(`import json
from server.erp.models import Voucher,StockEntry,CashEntry,AuditEvent
print(json.dumps([Voucher.objects.count(),StockEntry.objects.count(),CashEntry.objects.count(),AuditEvent.objects.count()]))`));assert.deepEqual(counts,seed.counts);assert(methods.every(m=>m==='GET'));assert.deepEqual(errors,[]);
 console.log('reconciliation native UI PASS: 31 runs/205 findings, keyboard/GET retry/focus, 320+1440, unchanged accounting');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill('SIGTERM');});
