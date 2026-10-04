/* Isolated real Django + React catalogue. Synthetic product; no production/Sheet. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'), data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-hidden-ui-'));
const output=process.env.QA_OUTPUT||'/tmp/tsukenya-hidden-proof';fs.mkdirSync(output,{recursive:true});
const python=process.env.PYTHON_BIN||'python3',base='http://localhost:18439',password='isolated-hidden-ui-password';
const env={...process.env};for(const key of Object.keys(env))if(/^(?:DB_|PG|DATABASE_URL$|DJANGO_SETTINGS_MODULE$|DJANGO_SECRET_KEY$|TSUKENYA_REQUIRE_POSTGRES$)/.test(key))delete env[key];
Object.assign(env,{DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),PORT:'18439',HOST:'127.0.0.1',OWNER_USERNAME:'tester',DJANGO_SECRET_KEY:'isolated-hidden-review-key-not-production-at-least-fifty-characters'});
env.OWNER_PASSWORD_HASH=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password(${JSON.stringify(password)}))`],{cwd:root,env,encoding:'utf8'}).trim();
const server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:'ignore'});let browser;
const proof=[];const mark=x=>{proof.push(x);console.log(x);};
async function until(fn,label){for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error(label);}
(async()=>{
 await until(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}},'startup');
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH||process.platform==='darwin'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());
 page.on('dialog',d=>d.accept());await require('./browser-login.cjs')(page,base,password);
 const session=await(await page.request.get(base+'/api/v1/session')).json(),headers={'X-CSRF-Token':session.csrf,'Origin':base};
 const api=async(method,url,body)=>{const response=await page.request.fetch(base+url,{method,headers,...(body?{data:body}:{})});assert.equal(response.status(),200,url+': '+await response.text());return response.json();};
 const created=await page.request.post(base+'/api/v1/catalog/products',{headers,data:{name:'Синтетичний товар видимості',cost:'10',manualPrice:true,price:'21.99'}});assert.equal(created.status(),201);const first=await created.json(),url='/api/v1/catalog/products/'+first.id;
 await page.goto(base+'/#operations/products');await page.getByRole('searchbox',{name:'Пошук товару'}).fill(first.name);
 await page.getByRole('button',{name:first.name,exact:true}).click();const dialog=page.getByRole('dialog'),name=dialog.getByRole('textbox',{name:'Назва товару'});
 await name.fill('Моя незбережена назва');
 if(process.env.QA_HIDDEN_STAGE==='layout'){
  await page.setViewportSize({width:320,height:850});
  await dialog.getByRole('button',{name:'Приховати товар',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,'actions-320.png')});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  for(const text of ['Приховати товар','Видалити товар','Зберегти товар']){const box=await dialog.getByRole('button',{name:text,exact:true}).boundingBox();assert(box.height>=44);assert(box.width<=320);}
  mark('actual editor actions320 touch44/no overflow');
  fs.writeFileSync(path.join(output,'report-layout.json'),JSON.stringify({status:'PASS',proof},null,2));return;
 }

 if(process.env.QA_HIDDEN_STAGE==='tail'){
  await name.fill('');
  let current=await api('PATCH',url+'/visibility',{revision:first.revision,hidden:true});
  current=await api('PATCH',url,{revision:current.revision,name:'Серверна назва',barcode:'server-1'});
  await dialog.getByRole('button',{name:'Приховати товар',exact:true}).click();
  await until(async()=>await dialog.getByRole('button',{name:'Порівняти зміни',exact:true}).count()===1,'external visibility409');
  assert.equal(await name.inputValue(),'');assert(await dialog.getByRole('button',{name:'Зберегти товар',exact:true}).isDisabled());
  let malformed=true;
  await page.route('**'+url+'?includeHidden=true',async route=>{if(malformed){malformed=false;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...current,id:'unrelated'})});}return route.continue();});
  await dialog.getByRole('button',{name:'Порівняти зміни',exact:true}).click();await dialog.getByText('Сервер повернув дані невідомого формату.',{exact:true}).waitFor();assert.equal(await name.inputValue(),'');
  await dialog.getByRole('button',{name:'Порівняти зміни',exact:true}).click();await dialog.getByText(/Поточний стан на сервері: прихований/).waitFor();
  assert(await dialog.getByRole('button',{name:'Застосувати узгоджені зміни',exact:true}).isDisabled());
  const mine=dialog.getByRole('radio',{name:'Залишити мої зміни'});await mine.focus();await page.keyboard.press('Space');
  await dialog.getByRole('button',{name:'Застосувати узгоджені зміни',exact:true}).click();assert.equal(await name.inputValue(),'');assert.equal(await dialog.getByRole('textbox',{name:'Штрихкод'}).inputValue(),'server-1');
  current=await api('PATCH',url+'/visibility',{revision:current.revision,hidden:false});
  current=await api('PATCH',url,{revision:current.revision,barcode:'server-2'});
  await dialog.getByRole('button',{name:'Відновити товар',exact:true}).click();await dialog.getByRole('button',{name:'Порівняти зміни',exact:true}).click();
  await dialog.getByText(/Поточний стан на сервері: активний/).waitFor();await dialog.getByRole('button',{name:'Застосувати узгоджені зміни',exact:true}).click();assert.equal(await name.inputValue(),'');assert.equal(await dialog.getByRole('textbox',{name:'Штрихкод'}).inputValue(),'server-2');
  mark('external hide while open + metadata409; malformed unrelated GET rejected; same-name conflict explicit keyboard choice; invalid newer name retained; second external restore409 safely reread/apply');
  // Current permissions are authoritative even when the modal opened with owner rights.
  execFileSync(python,['manage.py','shell','-c',"from server.erp.models import Profile;Profile.objects.filter(user__username='tester').update(role='cashier')"],{cwd:root,env,stdio:'ignore'});
  await dialog.getByRole('button',{name:'Приховати товар',exact:true}).click();await dialog.getByRole('button',{name:'Порівняти зміни',exact:true}).click();
  await dialog.getByText('Поточні права не дозволяють редагувати товар. Чернетку збережено.',{exact:true}).waitFor();
  assert.equal(await name.inputValue(),'');assert(await dialog.getByRole('button',{name:'Зберегти товар',exact:true}).isDisabled());assert(await dialog.getByRole('button',{name:'Приховати товар',exact:true}).isDisabled());
  mark('current revoked role rejects metadata write; latest readonly canEdit=false blocks Apply/Save and keeps invalid draft');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'report-tail.json'),JSON.stringify({status:'PASS',proof},null,2));return;
 }

 let payload,visibilityWrites=0;
 await page.route('**'+url+'/visibility',async route=>{if(route.request().method()!=='PATCH')return route.continue();visibilityWrites++;payload=route.request().postDataJSON();await route.fetch();await route.abort('failed');});
 await dialog.getByRole('button',{name:'Приховати товар',exact:true}).click();await until(async()=>await dialog.getByRole('button',{name:'Порівняти зміни',exact:true}).count()===1,'lost ACK recovery');
 assert.deepEqual(payload,{revision:first.revision,hidden:true});assert.equal(await name.inputValue(),'Моя незбережена назва');assert(await dialog.getByRole('button',{name:'Зберегти товар',exact:true}).isDisabled());
 let current=await api('GET',url+'?includeHidden=true');assert(current.hidden);assert.equal(current.name,first.name);assert.equal(current.cost,first.cost);
 current=await api('PATCH',url,{revision:current.revision,barcode:'external-barcode'});
 let failRead=true;
 await page.route('**'+url+'?includeHidden=true',async route=>{if(failRead){failRead=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Тимчасово недоступно'})});}return route.continue();});
 await dialog.getByRole('button',{name:'Порівняти зміни',exact:true}).click();await dialog.getByText('Тимчасово недоступно',{exact:true}).waitFor();assert.equal(await name.inputValue(),'Моя незбережена назва');
 await dialog.getByRole('button',{name:'Порівняти зміни',exact:true}).click();await dialog.getByText(/Поточний стан на сервері: прихований/).waitFor();
 await dialog.getByRole('button',{name:'Повернутися до чернетки',exact:true}).click();assert.equal(await name.inputValue(),'Моя незбережена назва');assert(await dialog.getByRole('button',{name:'Зберегти товар',exact:true}).isDisabled());
 await dialog.getByRole('button',{name:'Порівняти зміни',exact:true}).click();await dialog.getByRole('button',{name:'Застосувати узгоджені зміни',exact:true}).click();
 assert.equal(await name.inputValue(),'Моя незбережена назва');assert.equal(await dialog.getByRole('textbox',{name:'Штрихкод'}).inputValue(),'external-barcode');assert.equal(visibilityWrites,1);
 mark('lost ACK -> real committed hidden; readonly503/retry/cancel/localApply keeps dirty name + unrelated barcode; no implicit save');
 await page.unroute('**'+url+'/visibility');await dialog.getByRole('button',{name:'Відновити товар',exact:true}).click();await dialog.getByRole('button',{name:'Приховати товар',exact:true}).waitFor();
 assert.equal(await name.inputValue(),'Моя незбережена назва');current=await api('GET',url);assert.equal(current.name,first.name);assert.equal(current.cost,first.cost);assert.equal(current.hidden,false);
 await page.setViewportSize({width:320,height:850});await page.screenshot({path:path.join(output,'editor-320.png')});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await dialog.getByRole('button',{name:'Зберегти товар',exact:true}).click();await dialog.waitFor({state:'hidden'});current=await api('GET',url);assert.equal(current.name,'Моя незбережена назва');assert.equal(current.barcode,'external-barcode');mark('confirmed restore preserves draft; only explicit Save commits draft; narrow editor no overflow');
 // Fresh mode switch never relabels old active data. Read error keeps the mode accessible.
 await page.getByRole('button',{name:'Скинути фільтри',exact:true}).click();let delayed,modeReads=0;
 await page.route('**/api/v1/catalog/products?*',async route=>{const u=new URL(route.request().url());if(u.searchParams.get('visibility')!=='hidden')return route.continue();modeReads++;if(modeReads===1){await new Promise(r=>{delayed=r});return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Список прихованих тимчасово недоступний'})});}return route.continue();});
 const select=page.getByRole('button',{name:/Стан товарів/});await select.focus();await page.keyboard.press('Enter');await page.getByRole('listbox').waitFor();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
 await until(async()=>!!delayed,'hidden request delayed');assert.equal(await page.locator('.tk-product-table').count(),0);await page.screenshot({path:path.join(output,'loading-320.png')});delayed();
 await page.getByText('Список прихованих тимчасово недоступний',{exact:true}).waitFor();assert.equal(await page.locator('.tk-product-table').count(),0);await page.getByRole('button',{name:'Повторити',exact:true}).click();
 await page.getByRole('heading',{name:'Прихованих товарів не знайдено',exact:true}).waitFor();await page.screenshot({path:path.join(output,'hidden-empty-320.png')});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 // Hide from another device and show bounded hidden list in the current mode.
 current=await api('PATCH',url+'/visibility',{revision:current.revision,hidden:true});await page.reload();await page.goto(base+'/#operations/products');
 // Filter persistence is in-session; after reload select the mode explicitly again.
 await page.getByRole('button',{name:/Стан товарів/}).focus();await page.keyboard.press('Enter');await page.getByRole('listbox').waitFor();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
 await page.getByRole('searchbox',{name:'Пошук товару'}).fill(current.name);await page.getByRole('button',{name:current.name,exact:true}).waitFor();
 await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(output,'hidden-1440.png')});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));mark('keyboard mode pending/error/retry/empty and reload hidden read; old active rows absent while hidden mode loads');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({status:'PASS',proof,viewports:[1440,320],productId:first.id,limitations:['synthetic isolated SQLite; no physical mobile/device claim']},null,2));
})().catch(error=>{fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error.stack,proof},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill('SIGTERM');fs.rmSync(data,{recursive:true,force:true});});
