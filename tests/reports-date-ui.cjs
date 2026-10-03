/* B17 isolated reports UI: tabs, historical cutoff, allocation, CSV, keyboard and responsive layout. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'b17-reports-ui-')),python=process.env.PYTHON_BIN||'python3',port=18232,base=`http://localhost:${port}`,password='isolated-b17-owner-password';
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'test.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])delete env[key];
const server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:'ignore'});let browser;
const wait=async fn=>{for(let n=0;n<100;n++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out');};
(async()=>{
 await wait(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}});
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await require('./browser-login.cjs')(page,base,password);
 const api=(endpoint,method='GET',value)=>page.evaluate(async({endpoint,method,value})=>{const s=await(await fetch('/api/state')).json();const response=await fetch('/api/'+endpoint,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:value===undefined?undefined:JSON.stringify(value)});return{status:response.status,value:await response.json()};},{endpoint,method,value});
 const ok=async(...args)=>{const result=await api(...args);assert(result.status<300,JSON.stringify(result));return result.value;};
 const state=await ok('erp/state'),store=state.stores[0].id,warehouse=state.warehouses[0].id,account=state.accounts[0].id;
 const current=await page.evaluate(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
 const lastMonth=new Date(current+'T12:00:00Z');lastMonth.setUTCDate(0);const cutoff=lastMonth.toISOString().slice(0,10),prefix=cutoff.slice(0,7),currentMonth=current.slice(0,7)+'-01';
 const customer=(await ok('erp/entities/parties','POST',{name:'Історичний покупець',kind:'customer'})).id;
 const supplier=(await ok('erp/entities/parties','POST',{name:'Історичний постачальник',kind:'supplier'})).id;
 const product=(await ok('v1/catalog/products','POST',{name:'B17 історичний товар',cost:'5',markup:'100'})).id;
 const voucher=async body=>{const v=await ok('erp/vouchers','POST',{store,warehouse,...body});return ok(`erp/vouchers/${v.id}/post`,'POST',{});};
 await voucher({kind:'receipt',date:prefix+'-27',party:supplier,lines:[{product,quantity:10,price:5}]});
 const sale=await voucher({kind:'sale',date:prefix+'-28',party:customer,lines:[{product,quantity:2,price:10}]});
 await voucher({kind:'payment',date:currentMonth,reference:sale.id,account,amount:10});
 await page.goto(base+'/#trade/reports');await page.getByRole('tab',{name:'Обороти періоду'}).waitFor();
 await page.getByRole('tab',{name:'Обороти періоду'}).focus();await page.keyboard.press('ArrowRight');await page.getByRole('tab',{name:'Залишки на дату'}).waitFor();
 await wait(async()=>await page.getByRole('tab',{name:'Залишки на дату'}).getAttribute('aria-selected')==='true');
 assert(await page.getByRole('tab',{name:'Залишки на дату'}).evaluate(el=>el===document.activeElement));
 await page.locator('#tradeReportForm [name=as_of]').fill(cutoff);await page.locator('#tradeReportForm button[type=submit]').click();await page.getByRole('tabpanel').getByText(`Стан на кінець ${cutoff}`,{exact:false}).waitFor();
 const result=page.getByRole('tabpanel');assert((await result.innerText()).includes('20,00'));assert((await result.innerText()).includes('8'));
 assert.equal(await page.getByRole('heading',{name:'Поточна заборгованість',exact:true}).count(),0);
 const downloadPromise=page.waitForEvent('download');await page.locator('[data-trade=report-csv]').click();const csv=fs.readFileSync(await(await downloadPromise).path(),'utf8');assert(csv.includes('Історичний покупець'));assert(csv.includes('20.00'));
 for(const width of [1440,390]){await page.setViewportSize({width,height:950});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`balances overflow ${width}`);await page.getByRole('tab',{name:'Обороти періоду'}).click();await wait(async()=>await page.getByRole('tab',{name:'Обороти періоду'}).getAttribute('aria-selected')==='true');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`period overflow ${width}`);await page.getByRole('tab',{name:'Залишки на дату'}).click();await wait(async()=>await page.getByRole('tab',{name:'Залишки на дату'}).getAttribute('aria-selected')==='true');assert.equal(await page.locator('#tradeReportForm [name=as_of]').inputValue(),cutoff);}
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/#trade/finance');await page.locator('[data-trade=new-voucher][data-kind=expense]').waitFor();await page.locator('[data-trade=new-voucher][data-kind=expense]').click();const form=page.locator('#tradeVoucherForm');await form.locator('[name=expense_scope]').selectOption('network');await form.locator('[name=amount]').fill('1');await page.locator('[type=submit][form=tradeVoucherForm][value=post]').click();await page.getByRole('heading',{name:/Витрата · №/}).waitFor();assert((await page.locator('.trade-dialog').innerText()).includes('мережева, без розподілу'));await page.locator('.trade-dialog [data-trade=close]').click();
 await page.goto(base+'/#trade/reports');await page.getByRole('tab',{name:'Обороти періоду'}).click();await wait(async()=>await page.getByRole('tab',{name:'Обороти періоду'}).getAttribute('aria-selected')==='true');assert((await page.getByRole('tabpanel').innerText()).includes('Мережеві нерозподілені витрати: 1,00 грн'));
 assert.deepEqual(errors,[]);console.log('REPORTS DATE UI PASS: historical debt, tabs, keyboard focus, retained date, CSV, network expense and 2 layouts');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();server.kill();fs.rmSync(data,{recursive:true,force:true});});
