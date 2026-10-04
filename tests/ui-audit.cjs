/* Isolated trading workflow, UI forms, access controls and responsive layouts. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-ui-audit-')),python=process.env.PYTHON_BIN||'python3',port=Number(process.env.QA_PORT||18215),base=`http://localhost:${port}`,password='isolated-crm-test-password';
const hash=execFileSync(python,['-c','from server.auth import hash_password;print(hash_password("isolated-crm-test-password"))'],{cwd:root,encoding:'utf8'}).trim();
const auditEnv={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};for(const k of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])delete auditEnv[k];
const server=spawn(python,['-m','server.main'],{cwd:root,env:auditEnv,stdio:'ignore'});
let browser;
const wait=async f=>{for(let i=0;i<120;i++){if(await f())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out');};
(async()=>{
await wait(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}});
browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});const ctx=await browser.newContext({viewport:{width:1440,height:1050}}),page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());
await require('./browser-login.cjs')(page,base,password);
const api=(endpoint,method='GET',body)=>page.evaluate(async({endpoint,method,body})=>{const s=await(await fetch('/api/state')).json(),r=await fetch('/api/erp/'+endpoint,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json()};},{endpoint,method,body});
const ok=async(...args)=>{const r=await api(...args);assert(r.status<300,JSON.stringify(r));return r.data;};
const state=await ok('state'),store=state.stores[0].id,wh=state.warehouses[0].id,cash=state.accounts.find(a=>a.kind==='cash').id;
const supplier=(await ok('entities/parties','POST',{name:'Тестовий постачальник',kind:'supplier'})).id;
const customer=(await ok('entities/parties','POST',{name:'Тестовий покупець',kind:'customer',phone:'0000'})).id;
const employee=(await ok('entities/employees','POST',{name:'Працівник тесту',store,shift_rate:400,bonus_percent:5,bonus_basis:'store'})).id;
const p=await page.evaluate(async()=>{const s=await(await fetch('/api/state')).json();return s.data.products[0].id;});
const go=async tab=>{await page.goto(base+'/#trade/'+tab);await wait(async()=>!(await page.locator('#main').innerText()).includes('Завантаження обліку'));assert(!(await page.locator('#main').innerText()).includes('Цей розділ недоступний'));};
const date=await page.evaluate(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
const voucher=async body=>{const v=await ok('vouchers','POST',{store,warehouse:wh,date,...body});return ok('vouchers/'+v.id+'/post','POST',{});};
await voucher({kind:'cash_opening',amount:1000,account:cash});

if(process.env.QA_ORDER_RESERVES_ONLY){await require('./order-reserves-ui.cjs')(page,base,wait,auditEnv,python);assert.deepEqual(errors,[]);return;}
if(process.env.QA_NATIVE_ONLY){await require('./native-work-ux.cjs')(page,base,wait);assert.deepEqual(errors,[]);return;}
if(process.env.QA_BROWSE_ONLY){await require('./erp-browse-ui.cjs')(page,base,wait);assert.deepEqual(errors,[]);return;}
if(process.env.QA_SHIFT_BROWSE_ONLY){await require('./shift-browse-ui.cjs')(page,base,wait,auditEnv,python);assert.deepEqual(errors,[]);return;}
if(process.env.QA_BUSINESS_AUDIT_ONLY){await require('./business-audit-ui.cjs')(page,base,wait,auditEnv,python);assert.deepEqual(errors,[]);return;}
if(process.env.QA_FINANCE_ONLY){await require('./finance-browse-ui.cjs')(page,base,wait,auditEnv,python);assert.deepEqual(errors,[]);return;}
if(process.env.QA_AUTH_ONLY){await require('./auth-ux.cjs')(page,base,wait);assert.deepEqual(errors,[]);return;}
if(process.env.QA_TRADE_ONLY){await require('./trade-dialog-ux.cjs')(page,base,wait);assert.deepEqual(errors,[]);return;}
if(process.env.QA_UX_ONLY){await require('./trade-dialog-ux.cjs')(page,base,wait);await require('./auth-ux.cjs')(page,base,wait);assert.deepEqual(errors,[]);return;}
const AxeBuilder=require('@axe-core/playwright').default;
const output=process.env.QA_OUTPUT_DIR||path.join(os.tmpdir(),'tsukenya-ui-audit');fs.mkdirSync(output,{recursive:true});const reportPath=path.join(output,'report.json'),results=process.env.QA_CAPTURE_RESUME&&fs.existsSync(reportPath)?JSON.parse(fs.readFileSync(reportPath,'utf8')).results:[];
await voucher({kind:'receipt',party:supplier,lines:[{product:p,quantity:10,price:10}]});
const shift=(await ok('shifts','POST',{account:cash,employee})).id;
await voucher({kind:'sale',party:customer,employee,shift,lines:[{product:p,quantity:1,price:20}],payload:{payments:[{account:cash,amount:20}]}});
await page.evaluate(async()=>{const s=await(await fetch('/api/state')).json();for(const [col,id,value] of [['expenses','audit_rent',{name:'Оренда',group:'fixed',amount:10000,order:1}],['expenses','audit_long',{name:'Обслуговування обладнання та регулярна підтримка торговельної мережі',group:'fixed',amount:1500.67,order:2}],['tasks','audit_task',{title:'Перевірити актуальність цін і надрукувати оновлені цінники',scope:'operations',status:'todo',order:1}]]){const r=await fetch(`/api/docs/${col}/${id}`,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify(value)});if(!r.ok)throw Error('Audit fixture write failed');}});
await page.reload({waitUntil:'domcontentloaded'});
async function inspect(label, width, screenshot=true){
 if(results.some(result=>result.label===label&&result.width===width))return;
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,dialogOverflow:[...document.querySelectorAll('dialog[open]')].some(d=>d.scrollWidth>d.clientWidth+1),tiny:[...document.querySelectorAll('button,a.btn')].filter(el=>{const b=el.getBoundingClientRect();return b.width&&b.height&&getComputedStyle(el).visibility!=='hidden'&&(b.height<44||b.width<44)&&!el.closest('[aria-hidden=true]');}).map(el=>({text:el.textContent.trim().slice(0,70),width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}))}));
 const axe=width===1440?await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze():null;
 results.push({label,width,...geometry,violations:axe?.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))||[]});
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({errors,results},null,2));
 if(screenshot)await page.screenshot({path:path.join(output,label.replace(/[^a-z0-9-]/gi,'-')+'-'+width+'.png'),fullPage:true});
}
const routes=['operations/overview','operations/products','operations/tags','operations/work','operations/expenses','development/devOverview','development/ideas','development/tasks','trade/purchases','trade/stock','trade/sales','trade/finance','trade/staff','trade/customers','trade/reports','trade/setup'];
for(const route of routes){
 if(process.env.QA_CAPTURE_FROM&&routes.indexOf(route)<routes.indexOf(process.env.QA_CAPTURE_FROM))continue;
 await page.goto(base+'/#'+route,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.querySelector('#main')?.textContent.trim()&&!document.querySelector('#main')?.textContent.includes('Завантаження обліку')&&!document.querySelector('#main > .panel > p[role=status]')?.textContent.trim());
 if(route==='operations/products')await page.locator('.tk-product-table').waitFor();
 if(route==='operations/tags')await page.getByRole('tablist').waitFor();
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await inspect(route,width);}
}
for(const [route,kinds] of Object.entries({purchases:['purchase_order','receipt','supplier_return'],stock:['opening','transfer','writeoff','inventory','production'],sales:['sale','customer_return','customer_order'],finance:['payment','expense','cash_opening','debt_opening','cash_transfer'],staff:['payroll','payroll_payment']})){
 await page.setViewportSize({width:1440,height:1000});await go(route);
 for(const kind of kinds){
  await page.locator(`[data-trade=new-voucher][data-kind=${kind}]`).click();await page.locator('#tradeVoucherForm').waitFor();
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await inspect('form-'+kind,width);}
  await page.locator('.trade-dialog [data-trade=close]').click();
 }
}
async function inspectModal(label){await page.locator('.trade-dialog[open]').waitFor();for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await inspect(label,width);}if(await page.locator('.trade-dialog[open]').getAttribute('data-dirty')==='1')page.once('dialog',d=>d.accept());await page.locator('.trade-dialog[open] :is([data-trade=close],[data-finance-close])').click();await page.setViewportSize({width:1440,height:1000});}
await go('setup');
for(const key of ['stores','warehouses','accounts','parties']){await page.locator(`[data-trade=entity][data-entity=${key}]`).first().click();await inspectModal('entity-'+key);}
for(const action of ['period','fiscal','audit']){await page.locator(`[data-trade=${action}]`).click();await inspectModal('setup-'+action);}
await page.locator('[data-trade=users]').click();await page.locator('.trade-dialog [data-trade=user-edit]').waitFor();for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await inspect('setup-users',width);}await page.locator('.trade-dialog [data-trade=user-edit]').click();await inspectModal('setup-user-editor');
await go('staff');await page.locator('[data-trade=entity][data-entity=employees]:not([data-id])').click();await inspectModal('entity-employees');await page.locator('[data-trade=work-shift]').click();await inspectModal('staff-work-shift');
await go('sales');await page.locator('[data-trade=shift-open]').click();await inspectModal('sales-open-shift');await page.locator('[data-trade=shift-close]').click();await inspectModal('sales-close-shift');
await go('stock');await page.locator('[data-trade=recipe]').click();await page.locator('[data-trade=add-recipe]').click();await inspectModal('stock-recipe');
await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/account',{waitUntil:'domcontentloaded'});await wait(async()=>!(await page.locator('#out').isDisabled()));await inspect('account',1440);await page.setViewportSize({width:390,height:1000});await inspect('account',390);
await ctx.clearCookies();await page.goto(base,{waitUntil:'domcontentloaded'});await page.setViewportSize({width:1440,height:1000});await inspect('login',1440);await page.setViewportSize({width:390,height:1000});await inspect('login',390);
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({errors,results},null,2));
console.log('AUDIT CAPTURE:',output,'surfaces:',results.length,'overflow:',results.filter(r=>r.overflow||r.dialogOverflow).map(r=>r.label+'@'+r.width),'axe:',results.filter(r=>r.violations.length).map(r=>({label:r.label,issues:r.violations.map(v=>v.id)})),'runtime errors:',errors);
})().catch(async e=>{console.error(e);const failedPage=browser?.contexts()[0]?.pages()[0];if(failedPage)await failedPage.screenshot({path:path.join(os.tmpdir(),'tsukenya-ui-audit-failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(data,{recursive:true,force:true});});
