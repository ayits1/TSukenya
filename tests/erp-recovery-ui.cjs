/* Bounded ERP recovery checks. No production writes or full regression. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port=process.env.QA_RECOVERY_PORT||'18216';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-recovery-ui-')),base=`http://localhost:${port}`,password='isolated-crm-test-password';
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:port,HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])delete env[key];
const server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:'ignore'});let browser,page;
const results=[],errors=[],from=process.env.QA_RECOVERY_FROM||'all';
const wait=async(fn,label)=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(`Timeout: ${label}`);};
const fixture=source=>execFileSync(python,['-c',`import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')\nimport django;django.setup()\n${source}`],{cwd:root,env});
const response=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
(async()=>{
 await wait(async()=>{try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');
 fixture(`from server.erp.models import Document,Counterparty,Store
Counterparty.objects.create(name='Клієнт '+('Довга назва '*13),kind='customer',phone='0'*80,email='user@example.com',notes='Примітка '*200)
Document.objects.create(path='products/recovery_ingredient',data={'name':'Інгредієнт '+('Назва '*40),'unit':'кг'})
Document.objects.create(path='products/recovery_a',data={'name':'Готовий A','unit':'шт','recipe':[{'product':'recovery_ingredient','quantity':'1'}]})
Document.objects.create(path='products/recovery_b',data={'name':'Готовий B','unit':'шт','recipe':[{'product':'recovery_ingredient','quantity':'2'}]})
Store.objects.filter(pk=Store.objects.first().pk).update(name='Магазин '+('Повна назва '*13))`);
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const ctx=await browser.newContext({viewport:{width:320,height:1000}});page=await ctx.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.route('https://fonts.googleapis.com/**',route=>route.abort());await page.route('https://fonts.gstatic.com/**',route=>route.abort());
 await require('./browser-login.cjs')(page,base,password);
 const go=async tab=>{const url=base+'/#trade/'+tab;if(page.url()===url)await page.reload({waitUntil:'domcontentloaded'});else await page.goto(url,{waitUntil:'domcontentloaded'});await page.locator('#main .panel').first().waitFor();await wait(async()=>!(await page.locator('#main').innerText()).includes('Завантаження обліку'),tab);};
 const dialog=()=>page.locator('.trade-dialog[open]');
 const noOverflow=async()=>assert.equal(await dialog().evaluate(d=>d.scrollWidth>d.clientWidth+1),false,'Dialog must fit 320px');
 if(['all','users'].includes(from)){
  // GET errors stay in their modal; retry is another GET. Unscoped owner has an explicit label.
  await go('setup');let gets=0;
  await page.route('**/api/erp/users',route=>{gets++;return gets===1?response(route,{error:'Тимчасово недоступний список користувачів'},503):route.continue();});
  await page.locator('[data-trade=users]').click();await dialog().locator('[data-users-retry]').waitFor();
  assert.match(await dialog().locator('#tradeFormError').innerText(),/Тимчасово/);assert.equal(await page.locator('#main [data-trade=users]').count(),1);
  await dialog().locator('[data-users-retry]').focus();await page.keyboard.press('Enter');await dialog().locator('[data-trade=user-edit]').first().waitFor();
  assert.equal(gets,2);assert.match(await dialog().innerText(),/Усі магазини/);assert.equal(await dialog().locator('[data-users-results]').getAttribute('aria-busy'),null);await noOverflow();
  await page.keyboard.press('Escape');await page.unroute('**/api/erp/users');
  // Both late success and late failure are harmless after cancel + route change.
  for(const status of [200,503]){
   let release,finished,waiting=false;const gate=new Promise(resolve=>release=resolve),complete=new Promise(resolve=>finished=resolve);
   await page.route('**/api/erp/users',async route=>{waiting=true;const real=status===200?await route.fetch():null;await gate;await route.fulfill({status,contentType:'application/json',body:status===200?await real.text():JSON.stringify({error:'Стара помилка users'})}).catch(()=>{});finished();});
   await page.locator('[data-trade=users]').click();await wait(async()=>waiting,'held users');assert.match(await dialog().innerText(),/Завантажуємо користувачів/);
   const aborted=page.waitForEvent('requestfailed',{predicate:request=>request.url().endsWith('/api/erp/users')});await page.keyboard.press('Escape');await aborted;await page.evaluate(()=>{location.hash='#trade/customers';});await page.getByRole('searchbox',{name:'Пошук клієнта',exact:true}).waitFor();
   // Also protect a newer dialog from the old GET.
   await page.getByRole('button',{name:'Додати клієнта',exact:true}).click();await dialog().locator('[name=name]').fill('Нова чернетка');
   release();await complete;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await dialog().locator('[name=name]').inputValue(),'Нова чернетка');assert.equal(await dialog().locator('#tradeFormError').innerText(),'');assert.equal(await page.getByRole('searchbox',{name:'Пошук клієнта',exact:true}).count(),1);
   await page.unroute('**/api/erp/users');page.once('dialog',native=>native.accept());await page.keyboard.press('Escape');await go('setup');
  }
  results.push('users GET error/retry, loading, all stores, late success/error after cancel and route/new dialog: PASS');
 }
 if(['all','saved'].includes(from)){
  for(const action of ['entity','fiscal']){
   await go(action==='entity'?'customers':'setup');const endpoint=action==='entity'?'entities/parties':'fiscal';let posts=0,reads=0;
   await page.route('**/api/erp/'+endpoint,route=>{assert.equal(route.request().method(),'POST');posts++;return response(route,action==='entity'?{id:999}:{ok:true});});
   await page.locator(action==='entity'?'.customer-toolbar .tk-button--primary':'[data-trade=fiscal]').click();
   if(action==='entity')await dialog().locator('[name=name]').fill('Вже збережений клієнт');else await dialog().locator('[name=mode]').selectOption('required');
   // The customer editor refreshes its snapshot before opening. Fail only the read after confirmed save.
   await page.route('**/api/erp/state',route=>{reads++;return reads===1?response(route,{error:'Не вдалося оновити після успішного запису'},503):route.continue();});
   await dialog().locator('[type=submit]').click();await page.locator('[data-saved-refresh] [role=alert]').waitFor();
   assert.equal(await dialog().count(),0);assert.match(await page.locator('[data-saved-refresh]').innerText(),/збережено, але список/);assert.equal(await page.locator('[data-saved-refresh] [role=alert]').evaluate(e=>e===document.activeElement),true);
   if(action==='entity')assert.equal(await page.locator('[data-saved-refresh]').getAttribute('data-saved-id'),'999');
   await page.locator('[data-trade=refresh-saved]').focus();await page.keyboard.press('Enter');await page.locator('[data-saved-refresh] [role=status]').filter({hasText:'Список оновлено'}).waitFor();
   assert.equal(posts,1,'Read retry must never repeat POST');assert.equal(reads,2);assert.equal(await page.locator('[data-saved-refresh] [role=status]').evaluate(e=>e===document.activeElement),true);
   await page.unroute('**/api/erp/state');await page.unroute('**/api/erp/'+endpoint);
  }
  results.push('entity + simpleForm saved write / failed refresh / keyboard GET retry exactly one POST: PASS');
 }
 if(['all','documents'].includes(from)){
  const documents=JSON.parse(fixture(`from datetime import date
import json
from django.contrib.auth.models import User
from server.erp.models import Voucher,Store,CashAccount
store=Store.objects.first();account=CashAccount.objects.filter(store=store).first();owner=User.objects.get(username='tester')
rows=[Voucher.objects.create(kind='expense',date=date.today(),store=store,account=account,total='21.99',note='Recovery fixture '+str(i),created_by=owner) for i in range(4)]
print(json.dumps([v.pk for v in rows]))`).toString());
  for(const [index,mode] of ['draft','save-post','post-reject','existing-post'].entries()){
   await go('finance');const id=documents[index];let saves=0,posts=0,reads=0,posted=false;
   await page.route('**/api/erp/vouchers',route=>{assert.equal(route.request().method(),'POST');saves++;assert.equal(route.request().postDataJSON().note,'Збережена чернетка документа');return response(route,{id});});
   await page.route(`**/api/erp/vouchers/${id}/post`,route=>{posts++;if(mode==='post-reject')return response(route,{error:'Ізольоване відхилення проведення'},422);posted=true;return response(route,{id,status:'posted'});});
   await page.route(`**/api/erp/vouchers/${id}`,async route=>{const raw=await route.fetch(),dto=await raw.json();if(posted)dto.status='posted';return response(route,dto);});
   await page.route('**/api/erp/state',route=>{reads++;return reads===1?response(route,{error:'Список документів тимчасово недоступний'},503):route.continue();});
   if(mode==='existing-post'){
    await page.locator(`[data-trade=view][data-id="${id}"]`).click();await dialog().locator('[data-trade=post-voucher]').click();
   }else{
    await page.locator('[data-trade=new-voucher][data-kind=expense]').click();await dialog().locator('[name=amount]').fill('21.99');await dialog().locator('[name=note]').fill('Збережена чернетка документа');
    assert.equal(await dialog().locator('form').evaluate(form=>form.checkValidity()),true);
    await dialog().locator(`[type=submit][value=${mode==='draft'?'draft':'post'}]`).click();
   }
   if(mode==='post-reject'){
    await dialog().locator('#tradeFormError').filter({hasText:'Проведення не підтверджено'}).waitFor();assert.match(await dialog().locator('#tradeFormError').innerText(),new RegExp('Чернетку № '+id+' збережено'));assert.match(await dialog().locator('#tradeFormError').innerText(),/Ізольоване відхилення/);
    assert.equal(reads,0,'A rejected post must not be presented as a complete success');assert.equal(saves,1);assert.equal(posts,1);assert.equal(await dialog().locator('[name=note]').inputValue(),'Збережена чернетка документа');assert.equal(await dialog().locator('[type=submit][value=post]').isEnabled(),true);assert.equal(await dialog().locator('#tradeFormError').evaluate(el=>el===document.activeElement),true);
    page.once('dialog',native=>native.accept());await page.keyboard.press('Escape');
   }else{
    await page.locator('[data-saved-refresh] [role=alert]').waitFor();assert.equal(await dialog().count(),0);assert.equal(await page.locator('[data-saved-refresh]').getAttribute('data-saved-id'),String(id));assert.match(await page.locator('[data-saved-refresh] [role=alert]').innerText(),mode==='draft'?/збережено/:/проведено/);assert.equal(await page.locator('[data-saved-refresh] [role=alert]').evaluate(el=>el===document.activeElement),true);
    await page.locator('[data-trade=refresh-saved]').press('Enter');await page.locator('[data-saved-refresh] [role=status]').filter({hasText:'Список оновлено'}).waitFor();
    assert.equal(reads,2);assert.equal(saves,mode==='existing-post'?0:1);assert.equal(posts,mode==='draft'?0:1,'Each document action has exactly one POST; recovery only reads');
   }
   for(const url of ['**/api/erp/vouchers',`**/api/erp/vouchers/${id}/post`,`**/api/erp/vouchers/${id}`,'**/api/erp/state'])await page.unroute(url);
  }
  results.push('documents draft save, save+post, separate post reject draft feedback, existing post action; failed refresh GET-only retry and exact write counts: PASS');
 }
 if(['all','tail','recipe'].includes(from)){
  await go('stock');await page.locator('[data-trade=recipe]').click();let prompts=0;
  const selectProduct=async value=>{await dialog().getByRole('combobox',{name:'Готовий товар',exact:true}).fill(value==='recovery_a'?'Готовий A':'Готовий B');await page.getByRole('option',{name:value==='recovery_a'?'Готовий A · шт':'Готовий B · шт',exact:true}).click();};
  const choose=async(value,accept)=>{const handle=native=>{prompts++;return accept?native.accept():native.dismiss();};page.once('dialog',handle);await selectProduct(value);page.removeListener('dialog',handle);};
  await selectProduct('recovery_a');await wait(async()=>await dialog().locator('[data-recipe=quantity]').count()===1&&await dialog().locator('[data-recipe=quantity]').inputValue()==='1.000','fresh recipe A');assert.equal(prompts,0);await dialog().locator('[data-recipe=quantity]').fill('3');
  await choose('recovery_b',false);assert.equal(await dialog().locator('[name=product]').inputValue(),'recovery_a');assert.equal(await dialog().locator('[data-recipe=quantity]').inputValue(),'3');
  await choose('recovery_b',true);await wait(async()=>await dialog().locator('[data-recipe=quantity]').count()===1&&await dialog().locator('[data-recipe=quantity]').inputValue()==='2.000'&&await dialog().locator('[type=submit]').isEnabled(),'fresh recipe B');assert.equal(await dialog().locator('[data-recipe=quantity]').inputValue(),'2.000');assert.equal(prompts,2);
  assert.equal(await dialog().locator('[data-recipe=product] option[value=recovery_b]').count(),0);
  await dialog().locator('[data-trade=add-recipe]').click();await choose('recovery_a',false);assert.equal(await dialog().locator('.trade-payment-row').count(),2);assert.equal(await dialog().locator('[name=product]').inputValue(),'recovery_b');
  await dialog().locator('[data-trade=remove-recipe]').last().click();
  const longError='Товар '+('Д'.repeat(230))+': недостатньо придатного залишку.';
  await page.route('**/api/erp/recipes',route=>response(route,{error:longError},503));await dialog().locator('[type=submit]').click();await dialog().locator('#tradeFormError').filter({hasText:longError}).waitFor();
  await noOverflow();assert.equal(await dialog().locator('#tradeFormError').evaluate(e=>e===document.activeElement),true);assert.equal(await dialog().locator('[data-recipe=quantity]').inputValue(),'2.000');assert.equal(await dialog().locator('[type=submit]').isEnabled(),false);assert.equal(await dialog().getByRole('button',{name:'Порівняти з поточною версією',exact:true}).isEnabled(),true);
  await page.screenshot({path:path.join(os.tmpdir(),'tsukenya-recovery-error-320.png')});await page.unroute('**/api/erp/recipes');page.once('dialog',native=>native.accept());await page.keyboard.press('Escape');
  results.push('recipe first selection, dirty cancel/accept/add row, self excluded, unknown POST result preserves draft/focus and blocks Save pending readonly comparison; long token 320px: PASS');
 }
 if(['all','tail','customers'].includes(from)){
  await go('customers');await page.getByRole('searchbox',{name:'Пошук клієнта',exact:true}).fill('Немає такого клієнта');await page.getByText('Клієнтів за цим пошуком не знайдено. Очистіть або змініть пошук.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Очистити пошук',exact:true}).focus();await page.keyboard.press('Enter');await page.locator('.customer-list li').first().waitFor();assert.equal(await page.getByRole('searchbox',{name:'Пошук клієнта',exact:true}).inputValue(),'');assert.equal(await page.getByRole('searchbox',{name:'Пошук клієнта',exact:true}).evaluate(e=>e===document.activeElement),true);
  fixture(`from server.erp.models import Counterparty\nCounterparty.objects.filter(kind='customer').delete()`);await go('customers');await page.getByText('Клієнтів ще немає.',{exact:true}).waitFor();
  results.push('customer no results vs empty directory, keyboard clear restores list/focus: PASS');
 }
 assert.deepEqual(errors,[]);console.log(results.join('\n'));
})().catch(async error=>{if(page)await page.screenshot({path:path.join(os.tmpdir(),'tsukenya-recovery-failure.png')}).catch(()=>{});console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));fs.rmSync(data,{recursive:true,force:true});});
