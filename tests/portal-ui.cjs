/* Browser regression suite. Starts an isolated server; never touches the live database. */
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-ui-'));
const port=18199,base=`http://localhost:${port}`,password='isolated-browser-test-password';
const python=process.env.PYTHON_BIN||'python3';
const hash=execFileSync(python,['-c','from server.main import hash_password; print(hash_password("isolated-browser-test-password"))'],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])delete env[key];
const server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:'ignore'});
let browser;
async function check(condition,message){for(let i=0;i<80;i++){if(await condition())return;await new Promise(r=>setTimeout(r,100));}throw Error(message);}
(async()=>{
 await check(async()=>{try{return (await fetch(base+'/health')).ok}catch{return false}},'server startup');
 const executable=process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
 browser=await chromium.launch({executablePath:executable,headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await require('./browser-login.cjs')(page,base,password);
 const state=()=>page.evaluate(async()=> (await (await fetch('/api/state')).json()).data);
 const go=async(route)=>{await page.goto(base+'/#'+route);await page.waitForSelector(route==='operations/products'?'.tk-catalog':route==='operations/tags'?'.tk-studio':'#main .panel');if(route==='operations/tags')await page.getByRole('combobox',{name:'Товар для перегляду',exact:true}).waitFor();};
 await go('operations/products');await check(async()=>await page.locator('.tk-product-table tbody tr').count()===20,'catalog initial page');
 await page.getByRole('button',{name:'Далі',exact:true}).click();await check(async()=>/21–40/.test(await page.locator('.tk-catalog-pagination').innerText()),'page two');
 await page.getByRole('searchbox',{name:'Пошук товару'}).fill('Американо');await check(async()=>await page.locator('.tk-product-table tbody tr').count()===1,'search');
 await page.getByRole('button',{name:'Скинути фільтри'}).click();await page.getByRole('button',{name:'Додати товар'}).click();
 const form=page.getByRole('dialog');await form.getByRole('textbox',{name:'Назва товару'}).fill('Контрольний акційний товар');await form.getByRole('textbox',{name:'Категорія',exact:true}).fill('Тест');await form.getByRole('textbox',{name:'Пакування',exact:true}).fill('Штучно');await form.getByText('Задати ціну продажу вручну',{exact:true}).click();await form.getByRole('textbox',{name:'Продаж: гривні',exact:true}).fill('45');await form.getByText('Акція — показувати позначку на ціннику',{exact:true}).click();await form.getByRole('button',{name:'Зберегти товар'}).click();await check(async()=>await page.getByRole('dialog').count()===0,'product save dialog');
 let dataNow=await state(),product=dataNow.products.find(p=>p.data.name==='Контрольний акційний товар');assert(product);assert.equal(product.data.promotion,true);
 await page.reload();await page.waitForSelector('.tk-product-table');await page.getByRole('searchbox',{name:'Пошук товару'}).fill('Контрольний акційний товар');await page.getByRole('button',{name:'Акція для Контрольний акційний товар'}).waitFor();assert.equal(await page.getByRole('button',{name:'Акція для Контрольний акційний товар'}).getAttribute('aria-pressed'),'true');
 // Catalogue changes appear in the same React label renderer. Deep label persistence,
 // conflicts and physical PDF/print checks live in labels-ui.cjs and domain tests.
 await go('operations/tags');
 const combo=page.getByRole('combobox',{name:'Товар для перегляду',exact:true});
 await combo.fill('Американо');await page.getByRole('option',{name:'Американо',exact:true}).waitFor();await combo.press('ArrowDown');await combo.press('Enter');
 await check(async()=>await page.locator('.tk-studio-canvas [data-field=name]').innerText()==='Американо','keyboard preview commit');
 await combo.fill('Такого товару немає');await page.getByText('Нічого не знайдено',{exact:true}).waitFor();await combo.press('Escape');
 assert.equal(await combo.inputValue(),'Американо');assert.equal(await page.locator('.tk-studio-canvas [data-field=name]').innerText(),'Американо');
 await combo.fill('Контрольний акційний товар');await page.getByRole('option',{name:'Контрольний акційний товар',exact:true}).click();
 assert.equal(await page.locator('.tk-studio-canvas .t-promo').innerText(),'Акція');
 const keys=await page.locator('[data-label-field]').evaluateAll(nodes=>nodes.map(node=>node.dataset.labelField));assert.equal(keys.length,12);
 for(const key of keys){await page.locator(`[data-label-field="${key}"]`).click();assert.equal(await page.getByLabel('Розмір, pt',{exact:true}).count(),1);}
 await page.locator('.tk-studio-canvas [data-field=price]').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.tk-studio-properties h3').innerText(),'Ціна');
 await go('operations/work');await page.locator('#newWork').fill('Щоденна контрольна задача');await page.locator('#newWorkDue').fill('2026-10-01');await page.locator('[data-act=addWork]').click();await check(async()=> (await page.locator('#main').innerText()).includes('Щоденна контрольна задача'),'work created');
 await go('development/tasks');assert(!(await page.locator('#main').innerText()).includes('Щоденна контрольна задача'));await page.locator('#newTask').fill('Розробити облік');await page.locator('[data-act=addTask]').click();await check(async()=> (await page.locator('#main').innerText()).includes('Розробити облік'),'development task created');await go('operations/work');assert(!(await page.locator('#main').innerText()).includes('Розробити облік'));
 await go('development/ideas');await page.locator('#newIdea').fill('Впровадити складський облік');await page.locator('[data-act=addIdea]').click();await check(async()=>await page.locator('[data-react]').count()===2,'idea saved');await page.locator('[data-v=yes]').click();await page.locator('[data-idea-task]').click();await page.locator('.idea a').waitFor();await go('development/tasks');assert.match(await page.locator('#main').innerText(),/Впровадити складський облік/);
 for(const width of [1440,1024,768,390,320]){await page.setViewportSize({width,height:844});for(const route of ['operations/products','operations/tags','operations/work','operations/expenses','development/ideas','development/tasks']){await go(route);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${route} overflow at ${width}`);}}
 await page.setViewportSize({width:390,height:844});await go('operations/products');await page.screenshot({path:path.join(os.tmpdir(),'tsukenya-mobile-catalog-viewport.png')});await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});await go('operations/tags');await page.locator('.tk-studio').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(os.tmpdir(),'tsukenya-mobile-tags-dark.png')});

 await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({colorScheme:'light'});await go('operations/tags');await page.locator('.tk-studio').screenshot({path:path.join(os.tmpdir(),'tsukenya-builder-desktop.png')});
 await go('operations/products');await page.getByRole('button',{name:'Додати товар'}).click();await page.getByRole('dialog').screenshot({path:path.join(os.tmpdir(),'tsukenya-product-editor.png')});await page.getByRole('button',{name:'Закрити редактор'}).click();
 // Saved layout migration and physical output are exercised in the dedicated label suite.
 assert.deepEqual(errors,[]);console.log('PASS: product CRUD/promotion → React label preview, combobox keyboard/cancel, 12 element inspectors, scoped tasks/ideas, keyboard and 5 viewport sizes.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(r=>server.once('exit',r));fs.rmSync(data,{recursive:true,force:true});});
