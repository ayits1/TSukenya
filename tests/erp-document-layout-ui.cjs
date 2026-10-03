/* Only the ERP populated document table; isolated read fixtures, no mutation tests. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port=process.env.QA_DOCUMENT_LAYOUT_PORT||'18216';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-document-layout-')),base=`http://localhost:${port}`,password='isolated-crm-test-password';
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:port,HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])delete env[key];
const server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:'ignore'});let browser,page,zoomContext,zoomProfile;
const errors=[];
const wait=async(fn,label)=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(`Timeout: ${label}`);};
const fixture=source=>execFileSync(python,['-c',`import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')\nimport django;django.setup()\n${source}`],{cwd:root,env,encoding:'utf8'});
const zoomShot=async(page,filename)=>{const cdp=await page.context().newCDPSession(page);try{const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(os.tmpdir(),filename),Buffer.from(shot.data,'base64'));}finally{await cdp.detach();}};
const noFonts=async page=>{await page.route('https://fonts.googleapis.com/**',route=>route.abort());await page.route('https://fonts.gstatic.com/**',route=>route.abort());page.on('pageerror',error=>errors.push(error.message));};
(async()=>{
 await wait(async()=>{if(server.exitCode!==null)throw Error('Isolated server failed to start');try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');

 const seed=JSON.parse(fixture(`import json
from django.contrib.auth.models import User
from django.utils import timezone
from server.erp.models import Store,Voucher,Counterparty,CashAccount
owner=User.objects.get(username='tester');store=Store.objects.first();store.name='Основний магазин на Володимирській';store.save();account=CashAccount.objects.filter(store=store).first();party=Counterparty.objects.create(name='Постачальник кондитерських виробів Львів',kind='supplier')
rows=[Voucher.objects.create(kind='expense',status='draft',date=timezone.localdate(),store=store,account=account,party=party,total=amount,note='Layout record '+str(i),created_by=owner) for i,amount in enumerate(['987654.32','21999.50','21.99'])]
print(json.dumps({'ids':[v.pk for v in rows],'date':str(timezone.localdate())}))`));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});page=await ctx.newPage();await noFonts(page);await require('./browser-login.cjs')(page,base,password);
 await page.goto(base+'/#trade/finance');const table=page.locator('.trade-table-wrap').filter({has:page.locator('td[data-label="Контрагент / працівник"]')});await table.locator('tbody tr').first().waitFor();
 const inspect=async(page,label,columns)=>{
  const wrapper=page.locator('.trade-table-wrap').filter({has:page.locator('td[data-label="Контрагент / працівник"]')}),rows=wrapper.locator('tbody tr');
  await rows.first().waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await rows.count(),3);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,label+' page overflow');assert.equal(await wrapper.evaluate(el=>el.scrollWidth>el.clientWidth+1),false,label+' table overflow');
  const metrics=await wrapper.evaluate(el=>{const row=el.querySelector('tbody tr'),date=row.querySelector('[data-label="Дата"] .trade-cell'),range=document.createRange();range.selectNodeContents(date);const header=el.querySelector('thead'),cells=[...row.cells];return{content:el.clientWidth,layout:getComputedStyle(row).display,dateLines:range.getClientRects().length,headerDisplay:getComputedStyle(header).display,headerWidth:header.getBoundingClientRect().width,cellRects:cells.map(cell=>{const r=cell.getBoundingClientRect();return{label:cell.dataset.label,x:r.x,y:r.y,width:r.width,height:r.height};})};});
  assert.equal(metrics.layout,columns?'table-row':'grid',label+' layout');assert.equal(metrics.dateLines,1,label+' date is one line');assert.notEqual(metrics.headerDisplay,'none',label+' headers remain accessible');if(!columns)assert(metrics.headerWidth<=1,label+' header visually hidden');
  assert.equal(await wrapper.getByRole('columnheader',{name:'Дата',exact:true}).count(),1,label+' native column header');
  if(!columns){const rects=metrics.cellRects,doc=rects.find(r=>r.label==='Документ'),party=rects.find(r=>r.label==='Контрагент / працівник'),date=rects.find(r=>r.label==='Дата'),store=rects.find(r=>r.label==='Магазин');assert(Math.abs(doc.width-metrics.content)<=1,label+' document full row');assert(Math.abs(party.width-metrics.content)<=1,label+' counterparty full row');assert.equal(date.y,store.y,label+' date/store metadata pair');assert(date.width>=100,label+' readable metadata width');}
  const button=wrapper.locator('[data-trade=view]').first(),r=await button.boundingBox();assert(r.width>=44&&r.height>=44,label+' touch target');await button.focus();assert.equal(await button.evaluate(el=>el===document.activeElement),true,label+' keyboard action');assert.equal(await button.evaluate(el=>{const r=el.getBoundingClientRect(),wrap=el.closest('.trade-table-wrap').getBoundingClientRect(),style=getComputedStyle(el),ring=parseFloat(style.outlineWidth)+parseFloat(style.outlineOffset);return r.left-ring>=wrap.left-1&&r.right+ring<=wrap.right+1;}),true,label+' focus ring stays inside horizontal clip');
  console.log(label+': '+JSON.stringify({content:metrics.content,layout:metrics.layout,dateLines:metrics.dateLines}));return metrics;
 };
 for(const width of [1440,1024,768,720,320]){await page.setViewportSize({width,height:1000});await inspect(page,String(width),width===1440);await table.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(os.tmpdir(),`tsukenya-documents-${width}.png`)});}
 // Keyboard activation uses the real existing view GET without mutating a document.
 await table.locator('[data-trade=view]').first().press('Enter');await page.locator('.trade-dialog[open]').locator('[data-trade=edit-voucher]').waitFor();await page.keyboard.press('Escape');assert.equal(await table.locator('[data-trade=view]').first().evaluate(el=>el===document.activeElement),true);
 zoomProfile=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-document-zoom-'));fs.mkdirSync(path.join(zoomProfile,'Default'));fs.writeFileSync(path.join(zoomProfile,'Default','Preferences'),JSON.stringify({partition:{default_zoom_level:{x:Math.log(2)/Math.log(1.2)}}}));zoomContext=await chromium.launchPersistentContext(zoomProfile,{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,viewport:null,args:['--window-size=1440,1000']});const zoom=zoomContext.pages()[0];await noFonts(zoom);await require('./browser-login.cjs')(zoom,base,password);assert.equal(await zoom.evaluate(()=>devicePixelRatio),2);assert.equal(await zoom.evaluate(()=>innerWidth),720);await zoom.goto(base+'/#trade/finance');await inspect(zoom,'actual200%',false);await zoom.locator('.trade-table-wrap').filter({has:zoom.locator('td[data-label="Контрагент / працівник"]')}).scrollIntoViewIfNeeded();await zoomShot(zoom,'tsukenya-documents-200.png');
 assert.deepEqual(errors,[]);console.log('Populated ERP document table1440/1024/sidebar/768/720/320 + actual200%, stable date/labels/currency/action and keyboard: PASS');
})().catch(async error=>{const target=zoomContext?.pages()[0]||page;if(target)await target.screenshot({path:path.join(os.tmpdir(),'tsukenya-document-layout-failure.png')}).catch(()=>{});console.error(error);process.exitCode=1;}).finally(async()=>{await zoomContext?.close();if(zoomProfile)fs.rmSync(zoomProfile,{recursive:true,force:true});await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));fs.rmSync(data,{recursive:true,force:true});});
