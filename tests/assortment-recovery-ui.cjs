/* Actual ReactStock/P0, disposable SQLite, bundled headless Chromium only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const stage=process.env.QA_ASSORTMENT_FROM||'raw';assert(['raw','unknown','rejected','privacy','scope','ack'].includes(stage));
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-assortment-p0-')),port=Number(process.env.QA_PORT||18415),base='http://localhost:'+port;
const output=process.env.QA_OUTPUT_DIR||path.join(data,'proof');fs.mkdirSync(output,{recursive:true});
const env={...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:data,ERP_DB_PATH:path.join(data,'qa.sqlite3'),OWNER_USERNAME:'tester',DJANGO_SECRET_KEY:'isolated-assortment-ui-secret-not-production-1234567890'};
for(const key of Object.keys(env))if(/^DB_|^PG/.test(key)||['TSUKENYA_REQUIRE_POSTGRES','DATABASE_URL','POSTGRES_URL','DJANGO_SETTINGS_MODULE','OWNER_PASSWORD','OWNER_PASSWORD_HASH'].includes(key))delete env[key];
env.DJANGO_SETTINGS_MODULE='server.settings';const password='isolated-assortment-p0';env.OWNER_PASSWORD_HASH=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,env,encoding:'utf8'}).trim();
const log=fs.openSync(path.join(output,'server.log'),'w'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});fs.closeSync(log);
let browser,page;const errors=[],checks=[],writes=[];
const record=s=>{checks.push(s);console.log(s);fs.writeFileSync(path.join(output,stage+'-partial.json'),JSON.stringify({checks,errors},null,2));};
const wait=async(fn,label)=>{for(let i=0;i<180;i++){if(server.exitCode!==null||server.signalCode!==null)throw Error('Disposable server exited');if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label||'Assortment condition timed out');};
const py=source=>execFileSync(python,['-c','import django;django.setup();'+source],{cwd:root,env,encoding:'utf8'}).trim();
const button=(name,where=page)=>where.getByRole('button',{name,exact:true});
const payloads=()=>page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('tsukenya:draft:v1:assortment_')).map(k=>({id:k.slice('tsukenya:draft:v1:'.length),...JSON.parse(sessionStorage.getItem(k)).payload})));
const payload=async(wh,product='alpha')=>(await payloads()).find(p=>p.baseline.warehouse===wh&&p.baseline.row.product===product);
const editor=(wh,product='alpha')=>page.locator(`[data-stock-draft="${wh}:${product}"]`);
const input=(wh,product='alpha')=>editor(wh,product).getByRole('textbox');
const ready=async()=>{await page.locator('[data-react-stock] .stock-cards').waitFor();await wait(async()=>!await button('Скасувати перевірку асортименту').count(),'assortment ready');};
const open=async()=>{await page.goto(base+'/#trade/stock');await ready();const b=button('Асортимент складу');if(await b.getAttribute('aria-expanded')!=='true')await b.click();};
let warehouses;
const choose=async wh=>{const toggle=button('Асортимент складу');if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();const combo=page.getByRole('combobox',{name:'Склад асортименту',exact:true}),name=warehouses.find(w=>w.id===wh).name;await combo.fill(name);if(await combo.getAttribute('aria-expanded')!=='true')await combo.press('ArrowDown');await page.getByRole('option',{name,exact:true}).click();await input(wh).waitFor();};
const restore=async(wh,product='alpha')=>{const p=await payload(wh,product);assert(p,'stored pair');const card=page.locator('[data-assortment-offer='+JSON.stringify(p.id)+']');await button('Відновити чернетку',card).press('Enter');await input(wh,product).waitFor();await ready();};
const apply=async wh=>{const e=editor(wh);const mine=e.getByRole('radio',{name:'Залишити мої зміни'});if(await mine.count()){await mine.focus();await mine.press('Space');}await button('Застосувати узгоджені зміни',e).press('Enter');};
const save=async wh=>{await button('Зберегти',editor(wh)).press('Enter');};
const counts=()=>JSON.parse(py("import json;from server.erp.models import AuditEvent,Document;print(json.dumps({'audit':AuditEvent.objects.filter(action='assortment_saved').count(),'receipts':Document.objects.filter(path__startswith='assortment_action_receipts/').count()}))"));
(async()=>{
 await wait(async()=>{try{return(await fetch(base+'/health')).ok;}catch{return false;}},'isolated server');
 warehouses=JSON.parse(py("import json;from server.erp.models import Document,Store,Warehouse;Warehouse.objects.create(store=Store.objects.first(),name='Другий склад');Document.objects.create(path='products/alpha',data={'name':'Альфа','unit':'шт','minStock':2});Document.objects.create(path='products/beta',data={'name':'Бета','unit':'шт','minStock':3});print(json.dumps(list(Warehouse.objects.order_by('id').values('id','name'))))"));
 const wh=warehouses[0].id,other=warehouses[1].id;
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/assortment/execute'))writes.push(r.postDataJSON());});
 await page.addInitScript(()=>{const native=window.fetch;window.fetch=async(input,init)=>{if(window._assortmentHold&&String(input).includes('/assortment/recovery-context')){window._assortmentHold=false;window._assortmentHeld=true;await new Promise(r=>window._assortmentRelease=r);return new Response('late unauthorized',{status:401});}return native(input,init);};});
 await require('./browser-login.cjs')(page,base,password);await open();await choose(wh);
 if(stage==='raw'){
  await input(wh).fill('1,');await input(wh,'beta').fill('7');assert.equal((await payload(wh)).draft.minimum,'1,');
  await choose(other);await input(other,'beta').fill('invalid');assert.equal((await payload(other,'beta')).draft.minimum,'invalid');assert.equal(writes.length,0);
  await page.getByRole('textbox',{name:'Пошук товару',exact:true}).fill('Альфа');await ready();assert.equal(await input(other,'beta').inputValue(),'invalid','off-filter pinned raw');
  await page.reload();await ready();assert.equal(await page.locator('[data-stock-draft] input').count(),0,'cold raw not automatically revealed');
  await restore(wh);assert.equal(await input(wh).inputValue(),'1,');assert.equal(writes.length,0);
  await input(wh).fill('1.25');await apply(wh);assert.equal(writes.length,0,'Apply local only');await save(wh);await wait(async()=>counts().receipts===1);await ready();assert.equal(await payload(wh),undefined);
  await restore(other,'beta');assert.equal(await input(other,'beta').inputValue(),'invalid');assert.equal((await payload(wh,'beta')).draft.minimum,'7','other row untouched');
  record('Actual multirow/two-warehouse/off-filter raw capture, cold explicit Restore Enter, Apply0POST/separate Save, other drafts retained');
  for(const width of [1440,320]){await page.setViewportSize({width,height:1000});await editor(other,'beta').scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const buttons=await editor(other,'beta').getByRole('button').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width})));assert(buttons.every(b=>b.height>=43.5&&b.width>=44));await page.screenshot({path:path.join(output,`assortment-${width}.png`)});}
  record('Actual1440/320 controls fit with44px actions');
 }
 if(stage==='unknown'){
  await input(wh).fill('2.5');let release,seen=false;
  await page.route('**/assortment/execute',async route=>{const response=await route.fetch();assert.equal(response.status(),200);seen=true;await new Promise(r=>release=r);await route.fulfill({status:503,contentType:'text/plain',body:'lost ACK'});});
  await save(wh);await wait(()=>seen);assert.equal(await input(wh).isDisabled(),false);await input(wh).fill('later invalid,');release();await ready();const original=(await payload(wh)).firstIntent;assert(original);assert.equal(counts().audit,1);
  await page.unroute('**/assortment/execute');await page.reload();await ready();
  await page.route('**/assortment/current?*',r=>r.fulfill({status:503,contentType:'text/plain',body:'current read unavailable'}));
  const card=page.locator('.stock-editor').filter({hasText:'Альфа'}).filter({has:button('Відновити чернетку')}).first();await button('Відновити чернетку',card).press('Enter');
  await wait(async()=>(await payload(wh))?.firstIntent===null,'identity durable before failed current');assert.equal((await payload(wh)).confirmation.key,original.key);assert.equal((await payload(wh)).draft.minimum,'later invalid,');
  await page.unroute('**/assortment/current?*');await page.reload();await ready();await restore(wh);assert.equal(await input(wh).inputValue(),'later invalid,');assert.equal(writes.length,1);assert.deepEqual(counts(),{audit:1,receipts:1});assert.equal(await button('Повторити первісний запит',editor(wh)).count(),0);
  record('Committed lostACK/newer invalid raw/cold identity-before-current503/reload GET-only; one audit/receipt/POST');
 }
 if(stage==='ack'){
  await input(wh).fill('2.5');let release,seen=false;
  await page.route('**/assortment/current?*',async r=>{const response=await r.fetch();seen=true;await new Promise(resolve=>release=resolve);await r.fulfill({response});});
  await save(wh);await wait(()=>seen);assert.equal((await payload(wh)).firstIntent,null,'ACK durable before current GET');assert((await payload(wh)).confirmation);assert.equal(await input(wh).isDisabled(),false);await input(wh).fill('new input after ACK,');release();await ready();assert.equal((await payload(wh)).draft.minimum,'new input after ACK,');assert.equal(writes.length,1);
  await page.unroute('**/assortment/current?*');await page.reload();await ready();await restore(wh);assert.equal(await input(wh).inputValue(),'new input after ACK,');assert.equal(writes.length,1);assert.deepEqual(counts(),{audit:1,receipts:1});
  record('Actual durable ACK then held current GET/newer invalid raw remains after response and cold Restore; one POST/audit/receipt');
 }
 if(stage==='rejected'){
  await input(wh).fill('6');let first=true;
  await page.route('**/assortment/execute',async route=>{if(first){first=false;py(`from server.erp.models import Assortment;Assortment.objects.create(warehouse_id=${wh},product_id='products/alpha',sold=False,min_stock=8)`);}await route.continue();});
  await save(wh);await ready();assert.equal((await payload(wh)).firstIntent,null);const key=writes[0].key;assert.equal(counts().audit,0);
  await page.reload();await ready();await restore(wh);await apply(wh);assert.equal(writes.length,1);await save(wh);await ready();assert.notEqual(writes[1].key,key);assert.equal(counts().audit,1);
  await choose(wh);await input(wh).fill('9');py("from server.erp.models import Document;d=Document.objects.get(pk='products/alpha');d.data['unit']='кг';d.save()");await save(wh);await ready();assert.equal((await payload(wh)).firstIntent,null);await button('Порівняти поточний стан',editor(wh)).press('Enter');await ready();assert(await input(wh).isDisabled());assert.equal(await button('Застосувати узгоджені зміни',editor(wh)).count(),0);
  record('Initial revision409 survives reload; local Apply/separate new UUID Save; changed unit gives correction boundary without automatic quantity rebinding');
 }
 if(stage==='scope'){
  await input(wh,'beta').fill('other private raw');await input(wh).fill('5');
  await page.route('**/assortment/recovery-context?*',r=>r.fulfill({status:403,contentType:'text/plain',body:'denied'}));
  await save(wh);await wait(async()=>await page.locator('[data-react-stock] .stock-cards').count()===0,'current403 clears private stock');assert.equal(await page.locator('[data-stock-draft] input:visible').count(),0);assert.equal(writes.length,0);await wait(async()=>!(await payload(wh)),'P0 removes denied resource after fresh session');assert.equal((await payload(wh,'beta')).draft.minimum,'other private raw','unrelated raw is retained');
  await page.unroute('**/assortment/recovery-context?*');await page.reload();await ready();await choose(wh);await input(wh).fill('5');
  record('Current nonJSON resource403 clears private workspace; fresh P0 revalidation removes only denied record and preserves other raw');
  let contextSeen=false,swapped=false;
  await page.route('**/assortment/recovery-context?*',async r=>{const response=await r.fetch();await r.fulfill({response});contextSeen=true;});
  await page.route('**/api/v1/session',async r=>{const response=await r.fetch();if(contextSeen){const value=await response.json();value.draftOwner='c'.repeat(64);swapped=true;await r.fulfill({response,json:value});}else await r.fulfill({response});});
  await save(wh);await wait(()=>swapped,'last-session swapped allowed owner');await wait(async()=>await page.locator('[data-react-stock] .stock-cards').count()===0,'actor mismatch clears private stock');assert.equal(await page.locator('[data-stock-draft] input:visible').count(),0);assert.equal(writes.length,0);
  record('Allowed owner identity changes after context but before identity/execute: last-session fence hides private workspace and prevents write');
 }
 if(stage==='privacy'){
  await input(wh).fill('8');await page.evaluate(()=>{window._assortmentHold=true;});await save(wh);await page.waitForFunction(()=>window._assortmentHeld);await button('Скасувати перевірку асортименту').press('Enter');await page.evaluate(()=>window._assortmentRelease());await wait(async()=>await button('Підтвердити доступ до асортименту').isEnabled());assert.equal(writes.length,0);assert((await payload(wh)).firstIntent);assert.equal(await page.locator('[data-stock-draft] input:visible').count(),0);
  await button('Підтвердити доступ до асортименту').press('Enter');await ready();assert.equal(await input(wh).inputValue(),'8');assert.equal(writes.length,0);
  record('Cancel under ignored-Abort late401 keeps raw/intent, does not revoke current session or POST');
  await page.evaluate(()=>{const original=Storage.prototype.setItem;window._assortmentStorage=original;Storage.prototype.setItem=function(k,v){if(k.startsWith('tsukenya:draft:v1:assortment_'))throw Error('QA quota');return original.call(this,k,v);};});await input(wh).fill('quota raw');assert.equal(await input(wh).inputValue(),'quota raw');await button('Повторити первісний запит',editor(wh)).press('Enter');assert.equal(writes.length,0);await page.evaluate(()=>Storage.prototype.setItem=window._assortmentStorage);await input(wh).fill('fixed invalid');assert.equal((await payload(wh)).draft.minimum,'fixed invalid');
  record('Quota keeps newer typed raw in memory and prevents exact retry until capture succeeds');
  await page.route('**/api/v1/session',r=>r.fulfill({status:401,contentType:'text/plain',body:'expired'}));await button('Повторити первісний запит',editor(wh)).press('Enter');await wait(async()=>(await payloads()).length===0);assert.equal(await page.locator('[data-stock-draft] input:visible').count(),0);assert.equal(writes.length,0);
  record('Current nonJSON401 erases P0 and hides private editor before any business write');
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,stage+'-report.json'),JSON.stringify({stage,checks,errors,writes:writes.length,source:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()},null,2));console.log('PASS '+stage+' '+output);
})().catch(async error=>{console.error(error);fs.writeFileSync(path.join(output,'failure.txt'),error.stack||String(error));if(page){fs.writeFileSync(path.join(output,'dom.txt'),await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}process.exitCode=1;}).finally(async()=>{await browser?.close();if(server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(server.exitCode===null&&server.signalCode===null)server.kill('SIGKILL');}});
