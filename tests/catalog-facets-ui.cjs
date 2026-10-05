/* Parent-filter latency against real APIs in a disposable local SQLite only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const stage=process.env.QA_FACETS_FROM||'all';assert(['all','tail'].includes(stage),'Unknown QA_FACETS_FROM before temp resources');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port=18228,base=`http://localhost:${port}`,password='isolated-facets-password';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-facets-db-')),output=path.join(os.tmpdir(),'tsukenya-facets-qa');fs.mkdirSync(output,{recursive:true});
const env={...process.env};
for(const key of Object.keys(env))if(/^(DB_|PG|OWNER_|DJANGO_|TSUKENYA_REQUIRE_POSTGRES)|^(DATABASE_URL|POSTGRES_URL)$/.test(key))delete env[key];
Object.assign(env,{PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',DJANGO_SETTINGS_MODULE:'server.settings',DJANGO_SECRET_KEY:'isolated-facets-only-secret-key-at-least-fifty-characters'});
env.OWNER_PASSWORD_HASH=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,env,encoding:'utf8'}).trim();
const log=fs.openSync(path.join(output,'server.log'),'w'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});fs.closeSync(log);let browser,page;
const errors=[],writes=[],checks=[];const wait=async(fn,label)=>{for(let i=0;i<120;i++){if(server.exitCode!==null||server.signalCode!==null)throw Error('QA server exited');if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {resolve,promise};};
async function openFilter(scope,label){await scope.locator(`[aria-label="Відкрити список: ${label}"]`).click();}
async function inspect(route,width){
 await page.setViewportSize({width,height:1000});await page.goto(base+'/?facets='+route+'-'+width+'#operations/'+route);if(route==='tags')await page.getByRole('tab',{name:/^Товари для друку/}).click();
 const scope=page.locator(route==='products'?'.tk-catalog-filters':'.tk-studio-product-filters'),category=scope.getByRole('combobox',{name:'Категорія',exact:true}),group=scope.getByRole('combobox',{name:'Група',exact:true});await group.waitFor();
 await wait(async()=>await group.inputValue()===''&&await group.getAttribute('placeholder')==='Усі групи'&&await group.isEnabled(),'initial filters '+route+' '+width);
 const seen=deferred(),release=deferred();let held=false,aborted=false;
 const failed=request=>{if(new URL(request.url()).pathname==='/api/v1/catalog/selection/page')aborted=true;};page.on('requestfailed',failed);
 const handler=async route=>{if(new URL(route.request().url()).searchParams.get('type')==='Напої контроль'&&!held){held=true;const response=await route.fetch();seen.resolve();await release.promise;try{await route.fulfill({response});}catch(error){if(!aborted)throw error;}}else await route.continue();};
 await page.route('**/api/v1/catalog/selection/page?**',handler);
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
 if(route==='products'){const pack=scope.getByRole('combobox',{name:'Пакування',exact:true});await openFilter(scope,'Пакування');await page.getByRole('option',{name:'Стакан',exact:true}).waitFor();assert.equal(await page.getByRole('option',{name:'Коробка',exact:true}).count(),0,'old pack gone');await page.keyboard.press('Escape');assert.equal(await pack.inputValue(),'');assert.equal(await pack.getAttribute('placeholder'),'Усе пакування');}
 await page.unroute('**/api/v1/catalog/selection/page?**',handler);page.off('requestfailed',failed);checks.push(`${route}${width}: real delayedGET, input/toggle disabled, Tab skips stale children, parent/search/reset usable, fresh facets keyboard commit`);
}
async function pagingTail(){
 execFileSync(python,['-c',`import django;django.setup()\nfrom server.erp.models import Document\nDocument.objects.bulk_create([Document(path=f'products/paged-{n:03}',data={'name':f'Посторінковий товар {n:03}','type':'Посторінкові','category':f'Категорія {n:03}','pack':'Пакет','unit':'шт','cost':'10','markup':30}) for n in range(65)])`],{cwd:root,env});
 await page.addInitScript(()=>{const original=window.fetch;window.fetch=(url,options)=>original(url,String(url).includes('facetQ=late')?{...options,signal:undefined}:options);});
 await page.goto(base+'/?pagedtail=1#operations/products');const scope=page.locator('.tk-catalog-filters'),category=scope.getByRole('combobox',{name:'Категорія',exact:true});await scope.waitFor();
 await openFilter(scope,'Група');await page.getByRole('option',{name:'Посторінкові',exact:true}).click();await wait(()=>category.isEnabled(),'paged category ready');await openFilter(scope,'Категорія');await page.getByRole('option',{name:'Категорія 000',exact:true}).waitFor();
 await page.getByRole('button',{name:'Наступні значення: Категорія'}).press('Enter');await page.getByRole('option',{name:'Категорія 030',exact:true}).waitFor();await wait(()=>category.evaluate(el=>el===document.activeElement),'paging returns keyboardfocus');
 await page.getByRole('button',{name:'Наступні значення: Категорія'}).press('Enter');await page.getByRole('option',{name:'Категорія 064',exact:true}).waitFor();
 await category.fill('064');await page.getByRole('option',{name:'Категорія 064',exact:true}).waitFor();await category.press('ArrowDown');await category.press('Enter');await page.getByRole('button',{name:'Посторінковий товар 064',exact:true}).waitFor();assert.equal(await category.inputValue(),'Категорія 064');
 const seen=deferred(),release=deferred();let issued=false;
 const handler=async route=>{const parameters=new URL(route.request().url()).searchParams;if(parameters.get('facetQ')==='late'){issued=true;seen.resolve();await release.promise;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({contract:'catalog-facets-v1',field:'category',q:'late',items:['OLDPRIVATE'],total:1,page:1,pages:1,limit:30})}).catch(()=>{});}return route.continue();};
 await page.route('**/api/v1/catalog/selection/facets?**',handler);await openFilter(scope,'Категорія');await category.fill('late');await seen.promise;assert(issued);await category.fill('064');await page.getByRole('option',{name:'Категорія 064',exact:true}).waitFor();release.resolve();await page.waitForTimeout(100);assert.equal(await page.getByRole('option',{name:'OLDPRIVATE',exact:true}).count(),0);await category.press('Escape');assert.equal(await category.inputValue(),'Категорія 064');await page.unroute('**/api/v1/catalog/selection/facets?**',handler);
 for(const width of [1440,320]){await page.setViewportSize({width,height:1000});await openFilter(scope,'Категорія');await page.getByRole('button',{name:'Усі категорії',exact:true}).waitFor();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));for(const button of await page.locator('.tk-paging-footer button').all())assert((await button.boundingBox()).height>=44);await page.screenshot({path:path.join(output,`paged-filter-${width}.png`)});await category.press('Escape');}
 checks.push('Actual65-category fulluniverse paging+keyboardcommit; typed search vs committedID; ignored-abort late validDTO fenced; Escape retains64;1440/320 overlay44px/nooverflow; zero businesswrites');
}
(async()=>{try{
 await wait(async()=>{try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');
 execFileSync(python,['-c',`import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')\nimport django;django.setup()\nfrom server.erp.models import Document\nfrom django.utils import timezone\nDocument.objects.filter(path__startswith='products/').delete()\nfor id,name,group,category,pack in [('facets_coffee','Кава контрольна','Напої контроль','Кава контроль','Стакан'),('facets_chocolate','Шоколад контрольний','Солодощі контроль','Шоколад контроль','Коробка')]:\n Document.objects.create(path='products/'+id,data={'name':name,'type':group,'category':category,'pack':pack,'unit':'шт','manualPrice':True,'price':21.99,'cost':12.50,'markup':30,'promotion':False,'priceAt':str(timezone.localdate())})`],{cwd:root,env});
 browser=await chromium.launch({ headless: true });page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')&&r.method()!=='GET'&&!r.url().endsWith('/api/login'))writes.push(r.url());});await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());await require('./browser-login.cjs')(page,base,password);
 if(stage==='all')for(const route of ['products','tags'])for(const width of [1440,320])await inspect(route,width);
 if(stage==='all'||stage==='tail')await pagingTail();
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);const result={checks,errors,writes,stage,scope:'Actual compiled app, real Django GET, synthetic SQLite fixtures, no business POST or production/shared Sheet'};fs.writeFileSync(path.join(output,'results-'+stage+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){if(page){fs.writeFileSync(path.join(output,'failure.txt'),await page.locator('body').innerText());await page.screenshot({path:path.join(output,'failure.png')});}throw error;
}finally{await browser?.close();if(server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);if(server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}}fs.rmSync(data,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
