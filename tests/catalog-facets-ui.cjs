/* Parent-filter latency against real APIs in a disposable local SQLite only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port=18228,base=`http://localhost:${port}`,password='isolated-facets-password';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-facets-db-')),output=path.join(os.tmpdir(),'tsukenya-facets-qa');fs.mkdirSync(output,{recursive:true});
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of Object.keys(env))if(/^DB_|^PG/.test(key)||['DATABASE_URL','POSTGRES_URL'].includes(key))delete env[key];
const log=fs.openSync(path.join(data,'server.log'),'a'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});fs.closeSync(log);let browser,page;
const errors=[],writes=[],checks=[];const wait=async(fn,label)=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {resolve,promise};};
async function openFilter(scope,label){await scope.locator(`[aria-label="Відкрити список: ${label}"]`).click();}
async function inspect(route,width){
 await page.setViewportSize({width,height:1000});await page.goto(base+'/?facets='+route+'-'+width+'#operations/'+route);if(route==='tags')await page.getByRole('tab',{name:/^Товари для друку/}).click();
 const scope=page.locator(route==='products'?'.tk-catalog-filters':'.tk-studio-product-filters'),category=scope.getByRole('combobox',{name:'Категорія',exact:true}),group=scope.getByRole('combobox',{name:'Група',exact:true});await group.waitFor();
 await wait(async()=>await group.inputValue()==='Усі групи'&&await group.isEnabled(),'initial filters '+route+' '+width);
 const seen=deferred(),release=deferred();let held=false,aborted=false;
 const failed=request=>{if(new URL(request.url()).pathname==='/api/v1/catalog/products')aborted=true;};page.on('requestfailed',failed);
 const handler=async route=>{if(new URL(route.request().url()).searchParams.get('type')==='Напої контроль'&&!held){held=true;const response=await route.fetch();seen.resolve();await release.promise;try{await route.fulfill({response});}catch(error){if(!aborted)throw error;}}else await route.continue();};
 await page.route('**/api/v1/catalog/products?**',handler);
 await openFilter(scope,'Група');await page.getByRole('option',{name:'Напої контроль',exact:true}).click();await seen.promise;
 try{
  assert(await category.isDisabled(),route+' category disabled while stale');assert(await scope.locator('[aria-label="Відкрити список: Категорія"]').isDisabled());
  if(route==='products'){assert(await scope.getByRole('combobox',{name:'Пакування',exact:true}).isDisabled());assert(await scope.locator('[aria-label="Відкрити список: Пакування"]').isDisabled());assert(await page.getByRole('button',{name:'Скинути фільтри'}).isEnabled());}
  assert(await group.isEnabled());assert(await scope.getByRole('searchbox').isEnabled());
  await group.focus();await page.keyboard.press('Escape');await page.keyboard.press('Tab');assert(await scope.locator('.tk-select-trigger').evaluate(el=>el===document.activeElement),'Tab skips stale child filters');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page fits '+width);await page.screenshot({path:path.join(output,`${route}-pending-${width}.png`)});
 }finally{release.resolve();}
 await wait(async()=>await category.isEnabled(),'fresh dependent facets');await openFilter(scope,'Категорія');await page.getByRole('option',{name:'Кава контроль',exact:true}).waitFor();assert.equal(await page.getByRole('option',{name:'Шоколад контроль',exact:true}).count(),0,'old category gone');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');assert.equal(await category.inputValue(),'Кава контроль');
 await wait(async()=>await category.isEnabled(),'category query');
 if(route==='products'){const pack=scope.getByRole('combobox',{name:'Пакування',exact:true});await openFilter(scope,'Пакування');await page.getByRole('option',{name:'Стакан',exact:true}).waitFor();assert.equal(await page.getByRole('option',{name:'Коробка',exact:true}).count(),0,'old pack gone');await page.keyboard.press('Escape');assert.equal(await pack.inputValue(),'Усе пакування');}
 await page.unroute('**/api/v1/catalog/products?**',handler);page.off('requestfailed',failed);checks.push(`${route}${width}: real delayedGET, input/toggle disabled, Tab skips stale children, parent/search/reset usable, fresh facets keyboard commit`);
}
(async()=>{try{
 await wait(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(data,'server.log'),'utf8').slice(-2000));try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');
 execFileSync(python,['-c',`import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')\nimport django;django.setup()\nfrom server.erp.models import Document\nfrom django.utils import timezone\nDocument.objects.filter(path__startswith='products/').delete()\nfor id,name,group,category,pack in [('facets_coffee','Кава контрольна','Напої контроль','Кава контроль','Стакан'),('facets_chocolate','Шоколад контрольний','Солодощі контроль','Шоколад контроль','Коробка')]:\n Document.objects.create(path='products/'+id,data={'name':name,'type':group,'category':category,'pack':pack,'unit':'шт','manualPrice':True,'price':21.99,'cost':12.50,'markup':30,'promotion':False,'priceAt':str(timezone.localdate())})`],{cwd:root,env});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')&&r.method()!=='GET'&&!r.url().endsWith('/api/login'))writes.push(r.url());});await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());await require('./browser-login.cjs')(page,base,password);
 for(const route of ['products','tags'])for(const width of [1440,320])await inspect(route,width);
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);const result={checks,errors,writes,scope:'Actual compiled app, real Django GET, synthetic SQLite fixtures, no business POST or production/shared Sheet'};fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));fs.rmSync(data,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
