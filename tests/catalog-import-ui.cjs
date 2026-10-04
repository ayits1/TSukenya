/* Atomic catalogue import through the real UI on a disposable local DB. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-import-ui-')),python=process.env.PYTHON_BIN||'python3',base='http://localhost:18219',password='isolated-import-password';
const hash=execFileSync(python,['-c','from server.auth import hash_password;print(hash_password("isolated-import-password"))'],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:'18219',HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])delete env[key];
const server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:'ignore'});let browser,page;
const wait=async(fn,message='Timed out')=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(message);};
(async()=>{
 await wait(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}},'Server startup');
 browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());
 await require('./browser-login.cjs')(page,base,password);await page.goto(base+'/#operations/products');await page.locator('.tk-product-table').waitFor();
 const disclosure=page.locator('[data-disclosure=import]');await disclosure.locator('summary').click();
 const state=async()=>await(await page.request.get(base+'/api/state')).json();
 const before=await state();
 const upload=async(content,name='synthetic.csv')=>{await page.locator('#impFile').setInputFiles({name,mimeType:'text/csv',buffer:Buffer.from(content)});};
 const button=action=>page.locator(`[data-catalog-import=${action}]`);
 if(process.env.QA_IMPORT_FROM==='contract'){
   let malformedPreview=true;await page.route('**/api/v1/catalog/import/preview',async route=>{if(malformedPreview){malformedPreview=false;await route.fulfill({status:200,contentType:'application/json',body:'{}'});}else await route.continue();});
   await upload('Назва;Закупівля\nQA contract;10');await page.getByText(/Сервер повернув некоректний результат/).waitFor();assert.equal(await button('commit').count(),0);
   await button('preview').click();await button('commit').waitFor();let malformedCommit=true;const payloads=[];
   await page.route('**/api/v1/catalog/import/commit',async route=>{payloads.push(route.request().postDataJSON());if(malformedCommit){malformedCommit=false;const response=await route.fetch();assert.equal(response.status(),200);await route.fulfill({status:200,contentType:'application/json',body:'{}'});}else await route.continue();});
   await button('commit').click();await page.getByText(/Немає підтвердження збереження/).waitFor();await button('commit').click();await page.getByText('Імпорт збережено: додано 1, оновлено 0.',{exact:true}).waitFor();assert.deepEqual(payloads[0],payloads[1]);assert.equal((await state()).data.products.filter(p=>p.data.name==='QA contract').length,1);
   assert.deepEqual(errors,[]);console.log('PASS: malformed preview blocks commit; malformed successful-write reply retains exact retry payload and creates no duplicates.');return;
 }
 if(process.env.QA_IMPORT_FROM==='cancel'){
   let release;const gate=new Promise(resolve=>release=resolve);
   await page.route('**/api/v1/catalog/import/preview',async route=>{if(route.request().postDataJSON().entries[0].values.name==='QA cancelled'){await gate;await route.continue().catch(()=>{});}else await route.continue();});
   await upload('Назва;Закупівля\nQA cancelled;10');await page.getByText('Перевіряємо товари на сервері…',{exact:true}).waitFor();
   assert(await button('reset').isEnabled());await button('reset').click();release();
   await upload('Назва;Закупівля\nQA latest;10');await button('commit').waitFor();
   await page.locator('#catalogImportMarkup').fill('0.5');await page.locator('#catalogImportMarkup').press('Tab');
   assert.equal(await button('commit').count(),0,'Changing an option invalidates reviewed snapshot');
   let payload;await page.route('**/api/v1/catalog/import/preview',async route=>{payload=route.request().postDataJSON();await route.continue();});
   await button('preview').click();await button('commit').waitFor();assert.equal(payload.defaultMarkup,'0.5');
   assert(await page.getByText('Рядок 2: QA latest',{exact:true}).isVisible());assert.equal(await page.getByText('Рядок 2: QA cancelled',{exact:true}).count(),0);
   await page.setViewportSize({width:320,height:1000});await page.locator('#impBox').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(os.tmpdir(),'tsukenya-import-top-320.png')});
   assert.deepEqual(errors,[]);console.log('PASS: cancel pending preview, latest file wins, option invalidates snapshot, 0.5% stays 0.5%, mobile import view.');return;
 }
 await upload('Назва;Закупівля;Акція\nПогана ціна;12oops;Так\nДобрий товар;10;Ні');
 await page.getByText('Рядок 2: Погана ціна',{exact:true}).waitFor();assert.equal(await button('commit').count(),0);assert.equal((await state()).data.products.length,before.data.products.length);
 await upload('Назва;Закупівля\nПовтор;10\nПовтор;20');await page.getByText('Помилок: 2',{exact:false}).waitFor();assert.equal(await button('commit').count(),0);assert.equal(await page.getByText(/Назва повторюється у файлі/).count(),2);
 await upload('Назва;Закупівля\n"Незакритий товар;10');await page.getByText(/У CSV не закрито лапки/).waitFor();
 const content='Назва;Закупівля;Звичайна ціна;Акційна ціна;Акція\n'+Array.from({length:25},(_,i)=>`QA імпорт ${i};10;20;18;Так`).join('\n');
 await upload(content);await button('commit').waitFor();assert.equal(await page.locator('.catalog-import-item').count(),20);
 await button('next').click();assert.equal(await page.locator('.catalog-import-item').count(),5);assert(await button('next').isDisabled());await button('previous').click();
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Import overflow '+width);await page.screenshot({path:path.join(os.tmpdir(),'tsukenya-import-review-'+width+'.png'),fullPage:true});}
 // An actual isolated commit completes; intentionally lose its response and retry the same payload.
 const payloads=[];let lose=true;
 await page.route('**/api/v1/catalog/import/commit',async route=>{payloads.push(route.request().postDataJSON());if(lose){lose=false;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');}else await route.continue();});
 await button('commit').click();await page.getByText(/Немає підтвердження збереження/).waitFor();assert(await page.locator('#catalogImportMarkup').isDisabled());assert(await button('reset').isDisabled());
 await button('commit').click();await page.getByText('Імпорт збережено: додано 25, оновлено 0.',{exact:true}).waitFor();assert.deepEqual(payloads[0],payloads[1]);
 let saved=await state();assert.equal(saved.data.products.filter(p=>p.data.name.startsWith('QA імпорт ')).length,25);assert.deepEqual(errors,[]);
 await page.unroute('**/api/v1/catalog/import/commit');await button('reset').click();
 // Snapshot change must produce an explicit review step, without silently overwriting.
 await upload('Назва;Закупівля\nQA імпорт 0;12');await button('commit').waitFor();
 const identifier=saved.data.products.find(p=>p.data.name==='QA імпорт 0').id;
 const mutation=await page.request.patch(base+'/api/docs/products/'+identifier,{headers:{Origin:base,'X-CSRF-Token':saved.csrf,'If-Match':saved.data.products.find(p=>p.id===identifier).revision},data:{cost:11}});assert.equal(mutation.status(),200);
 await button('commit').click();await page.getByText(/Каталог або налаштування цін уже змінено/).waitFor();assert.equal((await state()).data.products.find(p=>p.id===identifier).data.cost,11);
 await button('preview').click();await button('commit').waitFor();
 // Save and subsequent read have separate outcomes; refresh retry must not issue another POST.
 let commits=0,failRefresh=true;await page.route('**/api/v1/portal/state',async route=>{if(failRefresh)await route.fulfill({status:503,contentType:'application/json',body:'{"error":"isolated refresh failure"}'});else await route.continue();});
 await page.route('**/api/v1/catalog/import/commit',async route=>{commits++;await route.continue();});
 await button('commit').click();await page.getByText(/Імпорт збережено. Каталог поки не оновився/).waitFor();assert.equal(commits,1);assert.equal((await state()).data.products.find(p=>p.id===identifier).data.cost,12);
 failRefresh=false;await button('refresh').click();await wait(async()=>await button('refresh').count()===0);assert.equal(commits,1);await page.unroute('**/api/v1/portal/state');await page.unroute('**/api/v1/catalog/import/commit');await button('reset').click();
 // During commit, route changes cannot hide the pending result or launch a second write.
 await upload('Назва;Закупівля\nQA pending;10');await button('commit').waitFor();let release;const gate=new Promise(r=>release=r);await page.route('**/api/v1/catalog/import/commit',async route=>{await gate;await route.continue();});
 await button('commit').click();await page.getByText('Зберігаємо весь пакет…',{exact:true}).waitFor();await page.evaluate(()=>location.hash='operations/work');await wait(async()=>new URL(page.url()).hash==='#operations/products');assert(await button('commit').isDisabled());release();await page.getByText('Імпорт збережено: додано 1, оновлено 0.',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('PASS: strict file errors, duplicates, 25-row pagination, 1440/390/320, actual commit + lost-response exact retry, snapshot conflict/review, saved-write/read failure with GET-only retry, pending route guard; disposable local DB.');
})().catch(async error=>{console.error(error);await page?.screenshot({path:path.join(os.tmpdir(),'tsukenya-import-ui-failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(data,{recursive:true,force:true});});
