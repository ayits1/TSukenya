/* Actual bounded catalogue workflows, own matching build/disposable SQLite only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
assert([undefined,'impact','export','layout','references','management','management-archive'].includes(process.env.QA_BOUNDED_CATALOGUE_FROM),'Unknown QA_BOUNDED_CATALOGUE_FROM');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-catalogue-bounded-')),python=process.env.PYTHON_BIN||'python3',port=18663,base=`http://localhost:${port}`,password='isolated-catalogue-bounded-password';
const env={...process.env};for(const key of Object.keys(env))if(/^(?:DB_|PG|DATABASE_URL$|POSTGRES_URL$|OWNER_PASSWORD|DJANGO_SETTINGS_MODULE$|DJANGO_SECRET_KEY$|TSUKENYA_REQUIRE_POSTGRES$)/.test(key))delete env[key];
Object.assign(env,{PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'qa.sqlite3'),OWNER_USERNAME:'tester',DJANGO_SETTINGS_MODULE:'server.settings',DJANGO_SECRET_KEY:'isolated-bounded-catalogue-ui-secret-key-at-least-fifty-characters'});
env.OWNER_PASSWORD_HASH=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,env,encoding:'utf8'}).trim();
const log=fs.openSync(path.join(data,'server.log'),'w'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});let browser,page;
const report={pass:false,base:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),stage:process.env.QA_BOUNDED_CATALOGUE_FROM||'whole',checks:[],artifacts:[],errors:[],reads:[],posts:[]};
async function until(fn,label){for(let n=0;n<240;n++){if(server.exitCode!==null||server.signalCode!==null)throw Error('Isolated server exited: '+label);if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);}
const check=text=>{report.checks.push(text);console.log('PASS '+text);};
(async()=>{
 await until(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}},'readiness');
 execFileSync(python,['-c',`import django;django.setup()
from server.erp.models import Document
for i in range(65):
 g=f'Група bounded {i:03}'
 Document.objects.create(path=f'catalog_refs/bounded_group_{i:03}',data={'field':'type','value':g})
 Document.objects.create(path=f'catalog_refs/bounded_category_{i:03}',data={'field':'category','value':f'Категорія bounded {i:03}','parentType':g,'parentId':f'bounded_group_{i:03}'})
 Document.objects.create(path=f'catalog_refs/bounded_pack_{i:03}',data={'field':'pack','value':f'Пакування bounded {i:03} — довга українська назва'})
 Document.objects.create(path=f'products/bounded_{i:03}',data={'name':f'Bounded товар {i:03}','type':'Група bounded 000','category':'Категорія bounded 000','pack':'Пакування bounded 000 — довга українська назва','unit':'шт','cost':0 if i==0 else 10,'markup':0.5,'manualPrice':i==1,'price':12.34 if i==1 else None,'referenceIds':{'type':'bounded_group_000','category':'bounded_category_000','pack':'bounded_pack_000'}})
Document.objects.create(path='catalog_refs/bounded_size',data={'field':'size','value':'Об’єм bounded 0,5 л'})
Document.objects.create(path='catalog_refs/bounded_unit',data={'field':'unit','value':'порція bounded'})
`],{cwd:root,env});
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(12000);
 page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/')){if(r.method()==='GET')report.reads.push(r.url().replace(base,''));else report.posts.push({url:r.url().replace(base,''),method:r.method()});}});
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());await require('./browser-login.cjs')(page,base,password);await page.goto(base+'/#operations/products');await page.locator('.tk-product-table').waitFor();
 const from=process.env.QA_BOUNDED_CATALOGUE_FROM;
 if(from==='references'||from==='management'||from==='management-archive'){
  env.QA_ARTIFACT_DIR=data;process.env.QA_ARTIFACT_DIR=data;
  await require(from==='references'?'./catalog-references.cjs':'./catalog-reference-management.cjs')(page,until,{archiveOnly:from==='management-archive'});
  assert.deepEqual(report.errors,[]);check('Changed legacy '+from+' assertions preserved against actual bounded controls');report.pass=true;return;
 }
 if(!from){
  await page.getByRole('button',{name:'Додати товар',exact:true}).click();const form=page.getByRole('dialog',{name:'Новий товар'});
  const choose=async(label,text)=>{const input=form.getByRole('combobox',{name:label,exact:true});await until(()=>input.isEnabled(),label+' enabled');await input.fill(text);const option=page.getByRole('listbox').getByRole('option').filter({hasText:text});await option.waitFor();assert.equal(await option.count(),1);await option.click();await until(async()=>await input.inputValue()===text,label+' committed');};
  await form.getByRole('textbox',{name:'Назва товару',exact:true}).fill('Bounded редактор actual');
  const pack=form.getByRole('combobox',{name:'Пакування',exact:true});await until(()=>pack.isEnabled(),'pack enabled');await pack.click();await page.getByText(/записів · 1 \/ /).waitFor();pack.focus();await page.keyboard.press('Alt+PageDown');await page.getByText(/записів · 2 \/ /).waitFor();assert.equal(await page.getByRole('listbox').getByRole('option').count(),30,'only one bounded option page');await page.keyboard.press('Escape');
  await choose('Група','Група bounded 064');await choose('Категорія','Категорія bounded 064');await choose('Пакування','Пакування bounded 064 — довга українська назва');await choose('Об’єм / вага','Об’єм bounded 0,5 л');await choose('Одиниця','порція bounded');
  const unit=form.getByRole('combobox',{name:'Одиниця',exact:true});await unit.fill('неіснуючий текст');await page.keyboard.press('Escape');assert.equal(await unit.inputValue(),'порція bounded');
  await until(()=>form.getByRole('button',{name:'Зберегти товар',exact:true}).isEnabled(),'five fields save');await form.getByRole('button',{name:'Зберегти товар',exact:true}).click();await until(async()=>await form.count()===0,'editor saved');
  check('Actual five fields search beyond first30; keyboard paging/Escape retains committed values; separate Save');
 }
 if(!from||from==='impact'){
  await page.getByRole('button',{name:'Довідники',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Керування довідниками'}),source=dialog.getByRole('combobox',{name:'Запис довідника',exact:true});await until(()=>source.isEnabled(),'manager loaded');await source.fill('Група bounded 000');await page.getByRole('option',{name:'Група bounded 000',exact:true}).click();await dialog.getByRole('textbox',{name:'Нова назва'}).fill('Група bounded перейменована');await until(()=>dialog.getByRole('button',{name:'Переглянути вплив',exact:true}).isEnabled(),'preview ready');await dialog.getByRole('button',{name:'Переглянути вплив',exact:true}).click();await dialog.getByRole('heading',{name:'Перевірений вплив',exact:true}).waitFor();
  const details=dialog.getByRole('button',{name:'Показати весь вплив',exact:true});await details.click();await dialog.getByText(/Сторінка 1 із 3/).waitFor();const pager=dialog.getByRole('region',{name:'Деталі повного впливу',exact:true});await pager.getByRole('button',{name:'Наступна сторінка впливу',exact:true}).click();await pager.getByText(/Сторінка 2 із 3/).waitFor();await pager.getByRole('button',{name:'Наступна сторінка впливу',exact:true}).click();await pager.getByText(/Сторінка 3 із 3/).waitFor();assert.equal(await pager.locator('li').count(),5);
  await dialog.getByRole('button',{name:'Підтвердити зміну довідника',exact:true}).click();await dialog.getByText(/Зміну довідника збережено/).waitFor();await dialog.getByRole('button',{name:'Закрити довідники',exact:true}).click();
  check('Full65-product B30 impact pages30/30/5 + separate atomic commit, no first-page truncation');
 }
 if(!from||from==='impact'||from==='export'){
  const search=page.getByRole('searchbox',{name:'Пошук товару',exact:true});await search.fill('Bounded товар');await until(async()=>await page.locator('.tk-catalog').getAttribute('aria-busy')==='false'&&await page.locator('.tk-product-link').count()===20,'export confirmed filter');
  const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Експортувати весь фільтр CSV',exact:true}).click();const download=await downloadEvent,file=path.join(data,'filtered.csv');await download.saveAs(file);const csv=fs.readFileSync(file,'utf8');assert.equal(csv.trim().split('\n').length,66);assert(csv.includes('0.5'));assert(csv.includes('12.34'));
  check('Actual filtered export returns all65 rows, fractional markup/manual price, not visible20');
  let held,downloads=0;const onDownload=()=>downloads++;page.on('download',onDownload);await page.route('**/api/v1/portal/catalogue.csv?**',r=>{held=r;});await page.getByRole('button',{name:'Експортувати весь фільтр CSV',exact:true}).click();await until(async()=>!!held,'CSV in flight');await search.fill('Bounded товар 064');await held.fulfill({status:200,contentType:'text/csv',headers:{'Content-Length':'2'},body:'a\n'}).catch(()=>{});await until(async()=>await page.locator('.tk-product-link').count()===1,'new filter');await page.waitForTimeout(100);assert.equal(downloads,0);page.off('download',onDownload);await page.unroute('**/api/v1/portal/catalogue.csv?**');
  check('Filter change cancels stale CSV; no Blob URL/download from obsolete context');
 }
 for(const width of [1440,320]){await page.setViewportSize({width,height:1000});await page.getByRole('button',{name:'Додати товар',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Новий товар'}),input=dialog.getByRole('combobox',{name:'Пакування',exact:true});await until(()=>input.isEnabled(),'layout picker');await input.click();await page.getByRole('listbox').waitFor();await page.getByText(/записів · 1 \/ /).waitFor();const geometry=await page.evaluate(()=>{const pop=document.querySelector('.tk-popover'),b=pop.getBoundingClientRect(),d=document.querySelector('[role=dialog]').getBoundingClientRect();return {left:b.left,right:b.right,bottom:b.bottom,dialogBottom:d.bottom,documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,footerHeight:pop.querySelector('[data-reference-paging]').getBoundingClientRect().height,buttons:[...pop.querySelectorAll('[data-reference-paging] button')].map(el=>el.getBoundingClientRect().height)};});assert(geometry.left>=0&&geometry.right<=width+1);assert(geometry.documentWidth<=width+1);assert(geometry.buttons.every(h=>h>=44));const png=path.join(data,'editor-popup-'+width+'.png');await page.screenshot({path:png});report.artifacts.push({png,width,...geometry});await page.keyboard.press('Escape');await dialog.getByRole('button',{name:'Закрити редактор'}).click();}
 check('Actual editor popup1440/320, long captions/paging44px/no horizontal overflow');
 assert(!report.reads.some(url=>/^\/api\/v1\/catalog\/references(?:\/manage)?$/.test(url)));assert.deepEqual(report.errors,[]);check('No active full-reference GET or page errors');report.pass=true;
})().catch(async error=>{report.error=String(error);console.error(error);process.exitCode=1;if(page)await page.screenshot({path:path.join(data,'failure.png')}).catch(()=>{});}).finally(async()=>{fs.writeFileSync(path.join(data,'report.json'),JSON.stringify(report,null,2));console.log('proof='+data);await browser?.close();if(server.exitCode===null&&server.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>server.kill('SIGKILL'),5000);server.once('exit',()=>{clearTimeout(timer);resolve();});server.kill('SIGTERM');});fs.closeSync(log);});
