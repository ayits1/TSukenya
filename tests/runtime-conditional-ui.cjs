/* Native browser conditional poll + confirmed-write barrier + React draft, isolated SQLite. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-conditional-ui-')),python=process.env.PYTHON_BIN||'python3',base='http://127.0.0.1:18234',password='isolated-polling-password';
const hash=execFileSync(python,['-c','from server.auth import hash_password;print(hash_password("isolated-polling-password"))'],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:'18234',HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD','TSUKENYA_REQUIRE_POSTGRES'])delete env[key];
let server,browser,page;const wait=async(fn,label='Timed out')=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label)};
(async()=>{
 try{await fetch(base+'/health');throw Error('QA port occupied')}catch(e){if(!e.cause)throw e}
 server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:'ignore'});await wait(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}});
 browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[],stateResponses=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url()===base+'/api/v1/portal/metadata')stateResponses.push(r.status())});
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());await require('./browser-login.cjs')(page,base,password);
 await page.goto(base+'/#operations/work');await page.locator('#newWork').waitFor();
 await page.evaluate(()=>window.TSUKENYA_REFRESH());assert(stateResponses.includes(304),'real unchanged fetch returns304');
 // Keep a genuine old304 poll pending until POST has committed; post-write GET must follow it.
 let release,held=false,writes=0,savedTitle='QA conditional confirmed write';const gate=new Promise(resolve=>release=resolve);let hold=true;
 await page.route('**/api/v1/portal/metadata',async route=>{if(hold && route.request().headers()['if-none-match']){hold=false;const old=await route.fetch();assert.equal(old.status(),304);held=true;await gate;await route.fulfill({response:old})}else await route.continue()});
 await page.evaluate(()=>{void window.TSUKENYA_REFRESH()});await wait(()=>held,'old poll started');
 await page.route('**/api/tasks',async route=>{writes++;const reply=await route.fetch();assert.equal(reply.status(),200);await route.fulfill({response:reply});release()});
 await page.locator('#newWork').fill(savedTitle);await page.locator('#newWork').press('Enter');await page.locator('.task .t').filter({hasText:savedTitle}).waitFor();assert.equal(writes,1);assert.equal(await page.locator('#newWork').inputValue(),'');
 await page.unroute('**/api/v1/portal/metadata');await page.unroute('**/api/tasks');
 // Real React editor stays mounted and keeps an unsaved field through304 and task-only200.
 await page.goto(base+'/#operations/products');await page.getByRole('button',{name:'Додати товар',exact:true}).waitFor();await page.getByRole('button',{name:'Додати товар',exact:true}).click();
 const name=page.getByRole('textbox',{name:'Назва товару',exact:true});await name.fill('QA unsaved React draft');
 await page.evaluate(()=>window.TSUKENYA_REFRESH());assert.equal(await name.inputValue(),'QA unsaved React draft');
 await page.evaluate(async()=>{const s=await(await fetch('/api/state')).json();const r=await fetch('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({title:'QA other session task',scope:'operations',status:'todo'})});if(!r.ok)throw Error('Synthetic create failed');await window.TSUKENYA_REFRESH_AFTER_WRITE()});
 assert.equal(await name.inputValue(),'QA unsaved React draft');assert.deepEqual(errors,[]);console.log('PASS: native304 cache, nativePOST + stale pending304 followed by fresh200, onewrite, React unsaved draft persists304/task-only200');
})().catch(async e=>{console.error(e);await page?.screenshot({path:path.join(os.tmpdir(),'tsukenya-conditional-ui-failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1}).finally(async()=>{await browser?.close();if(server){server.kill('SIGTERM');if(server.exitCode===null)await new Promise(r=>server.once('exit',r))}fs.rmSync(data,{recursive:true,force:true})});
