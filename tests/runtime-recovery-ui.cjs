/* Native portal saved-write/read-failure recovery; isolated data only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-runtime-ui-')),python=process.env.PYTHON_BIN||'python3',base='http://localhost:18220',password='isolated-runtime-password';
const hash=execFileSync(python,['-c','from server.auth import hash_password;print(hash_password("isolated-runtime-password"))'],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:'18220',HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])delete env[key];
const server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:'ignore'});let browser,page;
const wait=async(fn,label='Timed out')=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);};
(async()=>{
 await wait(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}});
 browser=await chromium.launch({ headless: true });page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());
 await require('./browser-login.cjs')(page,base,password);
 // Cold-start failure must reconnect settings/project subscriptions, not just
 // hide the banner after a GET. Exercise the production proxy's ETag shape too.
 let bootstrapFails=true;const bootstrapWrites=[];
 const recordWrite=r=>{if(!['GET','HEAD'].includes(r.method()))bootstrapWrites.push(r.method());};page.on('request',recordWrite);
 await page.route('**/api/v1/portal/metadata',async route=>{
   if(bootstrapFails)return route.fulfill({status:503,json:{error:'isolated startup failure'}});
   const response=await route.fetch(),headers=response.headers();
   if(response.status()===200){headers.etag=headers.etag.replace(/"$/,'-gzip"');const value=await response.json();value.data['settings/main'].chainName='QA відновлена мережа';return route.fulfill({response,headers,json:value});}
   return route.fulfill({response});
 });
 await page.goto(base+'/#operations/work');await page.reload();await page.locator('#refreshNotice').waitFor({state:'visible'});
 assert(await page.locator('#noDb').isHidden());assert.doesNotMatch(await page.locator('#refreshError').innerText(),/останній отриманий стан/);
 await page.locator('#retryRefresh').focus();await page.keyboard.press('Enter');await wait(()=>page.locator('#retryRefresh').isEnabled());
 assert(await page.locator('#refreshError').evaluate(el=>document.activeElement===el));
 bootstrapFails=false;await page.locator('#retryRefresh').focus();await page.keyboard.press('Enter');
 await page.getByText('QA відновлена мережа',{exact:true}).waitFor();await page.locator('#refreshNotice').waitFor({state:'hidden'});
 assert(await page.locator('#noDb').isHidden());
 await page.route('**/runtime.js',async route=>{
   const response=await route.fetch();
   const injection=`;(() => { const use=window.claude.use.bind(window.claude); let fail=true; window.__qaSubscriptions=0;
     window.claude.use=async name=>{const value=await use(name);if(name!=='db')return value;return {...value,doc(path){const doc=value.doc(path);return {...doc,onSnapshot(callback){
       if(path==='project/state'&&fail){fail=false;throw Error('isolated partial subscription failure');}
       const off=doc.onSnapshot(callback);window.__qaSubscriptions++;return ()=>{window.__qaSubscriptions--;off();};
     }};}};};})();`;
   await route.fulfill({response,body:await response.text()+injection});
 });
 await page.reload();await page.locator('#refreshNotice').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>window.__qaSubscriptions),0,'partial bootstrap unsubscribes settings');
 await page.locator('#retryRefresh').press('Enter');await page.locator('#refreshNotice').waitFor({state:'hidden'});
 assert.equal(await page.evaluate(()=>window.__qaSubscriptions),2,'retry attaches exactly settings and project');
 assert(await page.locator('#noDb').isHidden());assert.deepEqual(bootstrapWrites,[]);page.off('request',recordWrite);
 await page.unroute('**/runtime.js');
 await page.locator('#newWork').waitFor();await page.unroute('**/api/v1/portal/metadata');
 console.log('PASS cold GET503, one truthful banner, failed keyboard retry, compressed200 and partial-subscription recovery with zero writes');
 let failRead=false,writes=0;await page.route('**/api/v1/portal/metadata',async route=>{if(failRead)await route.fulfill({status:503,contentType:'application/json',body:'{"error":"isolated read failure"}'});else await route.continue();});
 await page.route('**/api/tasks',async route=>{if(route.request().method()==='POST'){writes++;const response=await route.fetch();assert.equal(response.status(),200);failRead=true;await route.fulfill({response});}else await route.continue();});
 await page.locator('#newWork').fill('QA підтверджена задача');await page.locator('#newWork').press('Enter');await page.locator('#refreshNotice').waitFor({state:'visible'});await wait(async()=>await page.locator('#newWork').inputValue()==='');
 assert.equal(writes,1);const confirmed=await(await page.request.get(base+'/api/state')).json();assert.equal(confirmed.data.tasks.filter(t=>t.data.title==='QA підтверджена задача').length,1);
 const retry=page.locator('#retryRefresh');if(!process.env.QA_RUNTIME_FROM){await retry.click();await wait(async()=>await retry.isEnabled());assert(await page.locator('#refreshError').evaluate(el=>document.activeElement===el));assert.equal(writes,1);
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#refreshNotice').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(os.tmpdir(),'tsukenya-runtime-recovery-'+width+'.png')});}
 }
 failRead=false;await retry.focus();await page.keyboard.press('Enter');await page.locator('#refreshNotice').waitFor({state:'hidden'});await page.locator('[data-task-id="'+confirmed.data.tasks.find(t=>t.data.title==='QA підтверджена задача').id+'"] .t').waitFor();assert.equal(writes,1);assert(await page.locator('#pageTitle').evaluate(el=>document.activeElement===el));
 // A genuine write failure preserves the draft and remains a write failure.
 await page.unroute('**/api/tasks');await page.route('**/api/tasks',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"isolated write failure"}'}));await page.locator('#newWork').fill('QA незбережена чернетка');await page.locator('#newWork').press('Enter');await page.getByText('Не вдалося зберегти, спробуйте ще раз',{exact:true}).waitFor();assert.equal(await page.locator('#newWork').inputValue(),'QA незбережена чернетка');assert.equal((await(await page.request.get(base+'/api/state')).json()).data.tasks.filter(t=>t.data.title==='QA незбережена чернетка').length,0);
 // A business refusal (4xx) shows the server's Ukrainian reason instead of the generic text.
 await page.unroute('**/api/tasks');await page.route('**/api/tasks',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Недостатньо прав для редагування.'})}));await page.waitForTimeout(2300);await page.getByRole('button',{name:'Повторити початковий запит',exact:true}).press('Enter');await page.getByText('Недостатньо прав для редагування.',{exact:true}).waitFor();assert.equal(await page.locator('#newWork').inputValue(),'QA незбережена чернетка');
 assert.deepEqual(errors,[]);console.log('PASS: confirmed native task POST + GET503 clears draft without duplicate; persistent banner1440/390/320, failed and successful keyboard GET-only retries/focus; actual write failure preserves draft; a 4xx refusal shows the server reason.');
})().catch(async e=>{console.error(e);await page?.screenshot({path:path.join(os.tmpdir(),'tsukenya-runtime-ui-failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(data,{recursive:true,force:true});});
