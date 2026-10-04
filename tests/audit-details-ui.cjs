/* Audit descriptions against disposable SQLite; UI performs financial reads only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port='18227',base=`http://localhost:${port}`,password='isolated-audit-details-password';
const from=process.env.QA_AUDIT_DETAILS_FROM||'all';assert(['all','content','layout'].includes(from),'Unknown QA_AUDIT_DETAILS_FROM');
const output=process.env.QA_OUTPUT_DIR||path.join(os.tmpdir(),'tsukenya-audit-details-qa'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-audit-details-db-'));
fs.mkdirSync(output,{recursive:true});
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:port,HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of ['DATABASE_URL','DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])delete env[key];
const fd=fs.openSync(path.join(data,'server.log'),'a'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',fd,fd]});fs.closeSync(fd);
let browser,page,zoomContext,zoomProfile;const results=[],screenshots=[],errors=[];let writes=0;
const wait=async(fn,label)=>{for(let i=0;i<120;i++){if(await fn())return;if(server.exitCode!==null)throw Error('Server exited: '+fs.readFileSync(path.join(data,'server.log'),'utf8').slice(-2000));await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);};
const fixture=source=>execFileSync(python,['-c',`import os,json\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')\nimport django;django.setup()\n${source}`],{cwd:root,env,encoding:'utf8'});
const modal=target=>target.locator('[data-finance-audit]');
const host=target=>target.locator('[data-finance-key=audit]');
const row=(target,subject)=>host(target).locator('tbody tr').filter({has:target.locator('td[data-label="Об’єкт"]').filter({hasText:new RegExp('^'+subject+'$')})});
const loaded=async target=>wait(async()=>await host(target).locator('[data-finance-results]').getAttribute('aria-busy')!=='true'&&!!await host(target).locator('[data-finance-status]').innerText(),'audit read');
async function go(target){await target.goto(base+'/#trade/setup');await target.locator('[data-trade=audit]').waitFor();}
async function open(target){await target.locator('[data-trade=audit]').click();await loaded(target);await wait(async()=>await host(target).locator('[name=user]').isEnabled(),'user filter');}
async function close(target){await target.keyboard.press('Escape');await modal(target).waitFor({state:'detached'});assert(await target.locator('[data-trade=audit]').evaluate(el=>el===document.activeElement),'Escape returns focus to opener');}
async function filter(target,query){await host(target).locator('[name=q]').fill(query);await host(target).locator('[type=submit]').click();await loaded(target);}
async function shot(target,label,cdp=false){const filename=path.join(output,`tsukenya-audit-details-${label}.png`);if(cdp){const session=await zoomContext.newCDPSession(target),image=await session.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(filename,Buffer.from(image.data,'base64'));await session.detach();}else await target.screenshot({path:filename});screenshots.push(filename);}
async function geometry(target,label){const g=await modal(target).evaluate(d=>({width:innerWidth,left:d.getBoundingClientRect().left,right:d.getBoundingClientRect().right,fits:d.scrollWidth<=d.clientWidth+1,summaries:[...d.querySelectorAll('summary')].map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})),pres:[...d.querySelectorAll('details[open] pre')].map(el=>el.scrollWidth<=el.clientWidth+1)}));assert(g.fits&&g.left>=-1&&g.right<=g.width+1,'audit dialog fits '+label);assert(g.summaries.length&&g.summaries.every(s=>s.width>=44&&s.height>=44),'44px disclosure '+label);assert(g.pres.every(Boolean),'full JSON wraps '+label);}
(async()=>{
 await wait(async()=>{try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');
 const events=JSON.parse(fixture(`from django.contrib.auth.models import User
from server.erp.models import AuditEvent
u=User.objects.get(username='tester')
values=[]
for role in ['owner','manager','cashier','warehouse','accountant']:
 values.append(('user_saved','audit-detail-role-'+role,{'role':role,'active':role!='cashier'}))
values += [('user_created','audit-detail-created',{'role':'cashier','active':True}),('user_updated','audit-detail-updated',{'role':'manager','active':False}),('user_saved','audit-detail-unknown-role',{'role':'toString','active':False}),('recipe_saved','audit-detail-recipe-full',{'recipe':[{'product':'ingredient_'+('ДовгийID'*28),'quantity':'1.125'},{'product':'<img src=x onerror=window.auditInjected=1>','quantity':'2'}]}),('recipe_saved','audit-detail-recipe-empty',{'recipe':[]}),('catalog_pricing_changed','audit-detail-pricing-full',{'candidates':1000,'changedPrices':777,'changedRecords':888,'skippedManual':12,'errors':0}),('catalog_pricing_changed','audit-detail-pricing-partial',{'changedPrices':3}),('unknown_action','audit-detail-unknown',{'note':'Повна українська примітка '+('НеподільнийТекст'*25)+' <script>window.auditInjected=1</script>','active':'not-a-boolean','nested':{'x':[1,2,3]}}),('recipe_saved','audit-detail-unknown-shape',{'recipe':None})]
result={}
for action,subject,detail in values:
 e=AuditEvent.objects.create(user=u,action=action,subject=subject,detail=detail)
 result[subject]={'id':e.pk,'detail':detail}
print(json.dumps(result))`));
 browser=await chromium.launch({ headless: true });
 const context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/erp/')&&r.method()!=='GET')writes++;});
 await require('./browser-login.cjs')(page,base,password);await go(page);await open(page);
 if(from!=='layout'){
 const roles={owner:'Власник',manager:'Керівник магазину',cashier:'Касир',warehouse:'Склад',accountant:'Бухгалтер'};
 for(const [role,title] of Object.entries(roles)){const text=await row(page,'audit-detail-role-'+role).locator('[data-audit-summary]').innerText();assert.equal(text,`Роль: ${title}. Стан: ${role==='cashier'?'Заблокований':'Активний'}.`);}
 assert.equal(await row(page,'audit-detail-created').locator('[data-audit-summary]').innerText(),'Роль: Касир. Стан: Активний.');
 assert.equal(await row(page,'audit-detail-updated').locator('[data-audit-summary]').innerText(),'Роль: Керівник магазину. Стан: Заблокований.');
 assert.equal(await row(page,'audit-detail-unknown-role').locator('[data-audit-summary]').innerText(),'Роль не розпізнано. Стан: Заблокований.');
 assert.equal(await row(page,'audit-detail-recipe-full').locator('[data-audit-summary]').innerText(),'Інгредієнтів у рецептурі: 2.');assert.equal(await row(page,'audit-detail-recipe-empty').locator('[data-audit-summary]').innerText(),'Інгредієнтів у рецептурі: 0.');
 assert.equal(await row(page,'audit-detail-pricing-full').locator('[data-audit-summary]').innerText(),'Товарів у перевірці: 1000. Товарів зі зміненою ціною: 777. Змінено записів товарів: 888. Пропущено товарів із ручною ціною: 12. Помилок: 0.');
 assert.equal(await row(page,'audit-detail-pricing-partial').locator('[data-audit-summary]').innerText(),'Товарів зі зміненою ціною: 3.','absent counts are never invented');
 for(const subject of ['audit-detail-unknown','audit-detail-unknown-shape'])assert.equal(await row(page,subject).locator('[data-audit-summary]').innerText(),'Опис події доступний у технічних подробицях.');
 assert.equal(await row(page,'audit-detail-unknown').locator('td[data-label="Дія"]').innerText(),'Інша подія');
 for(const [subject,event] of Object.entries(events)){const r=row(page,subject);assert.equal(await r.locator('details').getAttribute('open'),null,'technical JSON initially collapsed');assert.deepEqual(JSON.parse(await r.locator('pre').textContent()),event.detail,'full original JSON retained');assert.equal(await r.locator('img,script').count(),0,'untrusted details escaped');}
 assert.equal(await page.evaluate(()=>window.auditInjected),undefined);
 results.push('Five real user_saved roles/states, compatible user_created/user_updated payloads, unknown role/shape/action fallback, recipe0/2 and pricing full/partial counts, HTML escaping and complete JSON: PASS');
 // Reach the native disclosure in the regular keyboard sequence after filter actions.
 await host(page).locator('[type=submit]').focus();await page.keyboard.press('Tab');assert(await host(page).locator('[data-finance-reset]').evaluate(el=>el===document.activeElement));await page.keyboard.press('Tab');const first=host(page).locator('summary').first();assert(await first.evaluate(el=>el===document.activeElement),'Tab reaches disclosure');await page.keyboard.press('Enter');assert(await first.locator('..').evaluate(el=>el.open));await page.keyboard.press('Space');assert.equal(await first.locator('..').evaluate(el=>el.open),false);await close(page);
 results.push('Native disclosure Tab/Enter/Space and Escape opener focus: PASS');
 }else await close(page);
 if(from!=='content'){
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await open(page);await filter(page,'audit-detail-unknown');const summary=row(page,'audit-detail-unknown').locator('summary');await summary.focus();await page.keyboard.press('Enter');await geometry(page,String(width));await shot(page,String(width));await close(page);}
 results.push('Expanded long Ukrainian JSON+long token and disclosure44px at1440/390/320: PASS');
 // A single read-error scenario checks long Ukrainian wrapping and keyboard recovery.
 await open(page);let failed=true;const longError='Не вдалося прочитати журнал змін. '+('ДовгийУкраїнськийТекст'.repeat(18));await page.route('**/api/erp/audit?*',route=>failed?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:longError})}):route.continue());await filter(page,'audit-detail-recipe');assert.equal(await host(page).locator('[data-finance-error]').innerText(),longError);assert(await host(page).locator('[data-finance-retry]').evaluate(el=>el===document.activeElement));assert(await modal(page).evaluate(d=>d.scrollWidth<=d.clientWidth+1),'long read error fits320');await shot(page,'error-320');failed=false;await page.keyboard.press('Enter');await loaded(page);assert.equal(await host(page).locator('[data-audit-summary]').count(),2);assert(await host(page).locator('[data-finance-status]').evaluate(el=>el===document.activeElement));await page.unroute('**/api/erp/audit?*');await close(page);
 results.push('Single long read503 at320, keyboard GET retry and status focus: PASS');
 if(process.platform==='darwin'){
  zoomProfile=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-audit-zoom-'));fs.mkdirSync(path.join(zoomProfile,'Default'));fs.writeFileSync(path.join(zoomProfile,'Default','Preferences'),JSON.stringify({partition:{default_zoom_level:{x:Math.log(2)/Math.log(1.2)}}}));
  zoomContext=await chromium.launchPersistentContext(zoomProfile,{ headless: true, viewport:null, args:['--window-size=1440,1000'] });const zoom=zoomContext.pages()[0];zoom.setDefaultTimeout(12000);zoom.on('pageerror',e=>errors.push(e.message));await require('./browser-login.cjs')(zoom,base,password);assert.equal(await zoom.evaluate(()=>devicePixelRatio),2);assert.equal(await zoom.evaluate(()=>innerWidth),720);await go(zoom);await open(zoom);await filter(zoom,'audit-detail-unknown');await row(zoom,'audit-detail-unknown').locator('summary').focus();await zoom.keyboard.press('Enter');await geometry(zoom,'zoom200');await shot(zoom,'zoom200',true);await close(zoom);await zoomContext.close();zoomContext=null;fs.rmSync(zoomProfile,{recursive:true,force:true});zoomProfile=null;results.push('Actual Chrome200% expanded details geometry and Escape focus: PASS');
 }
 }
 assert.equal(writes,0,'audit UI sends no ERP mutation');assert.deepEqual(errors,[],'browser errors');const report={scope:from,results,screenshots};fs.writeFileSync(path.join(output,`results-${from}.json`),JSON.stringify(report,null,2));console.log('PASS:',JSON.stringify(report,null,2));
})().catch(async e=>{if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});console.error(e);process.exitCode=1;}).finally(async()=>{await zoomContext?.close();if(zoomProfile)fs.rmSync(zoomProfile,{recursive:true,force:true});await browser?.close();if(server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(resolve,3000);server.once('exit',()=>{clearTimeout(timer);resolve();});});}if(process.exitCode)fs.copyFileSync(path.join(data,'server.log'),path.join(output,'server.log'));fs.rmSync(data,{recursive:true,force:true});});
