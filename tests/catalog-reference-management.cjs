/* B30 proof against catalog-ui.cjs's disposable local database only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const readReferences=require('./reference-pages.cjs');
const path = require('node:path');
module.exports = async (page, until, {archiveOnly=false}={}) => {
 const recoveryTail=process.env.QA_REFERENCE_MANAGEMENT_FROM==='recovery';assert([undefined,'recovery'].includes(process.env.QA_REFERENCE_MANAGEMENT_FROM),'Unknown reference recovery stage');
 const artifacts=process.env.QA_ARTIFACT_DIR || '/tmp/tsukenya-reference-management-proof';fs.mkdirSync(artifacts,{recursive:true});
 const request=async(method,url,body)=>page.evaluate(async({method,url,body})=>{
  const csrf=(await(await fetch('/api/v1/session')).json()).csrf;
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
 },{method,url,body});
 const ref=async(field,value,parentType)=>{const result=await request('POST','/api/v1/catalog/references',{field,value,...(parentType?{parentType}:{})});assert([200,201].includes(result.status),JSON.stringify(result));return result.data;};
 const source=await ref('type','B30 Напої'),target=await ref('type','B30 Подарункові набори із довгою цільовою назвою');
 const category=await ref('category','B30 Кава',source.value);await ref('category','B30 Чай',source.value);const targetCategory=await ref('category','B30 Кава',target.value);
 const pack=await ref('pack','B30 Пакет');
 const create=async(name,category)=>{const result=await request('POST','/api/v1/catalog/products',{name,type:source.value,category,pack:pack.value,unit:'шт',cost:'10.01'});assert.equal(result.status,201,JSON.stringify(result));return result.data;};
 const coffee=await create('B30 Кава контрольна','B30 Кава'),tea=await create('B30 Чай контрольний','B30 Чай');
 const calls=[];page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/catalog/recovery/execute'&&r.postDataJSON().operation==='reference_commit')calls.push(r.postDataJSON().request);});
 const dialog=page.getByRole('dialog');
 const select=async(label,name)=>{name=name.replace(/ · (Активний|Архівований)$/,'');const input=dialog.getByRole('combobox',{name:new RegExp(label)});if(await input.count()){await until(()=>input.isEnabled(),label+' ready');await input.fill(name);const option=page.getByRole('listbox').getByRole('option').filter({hasText:name});await option.waitFor();assert.equal(await option.count(),1);await option.click();await until(async()=>await input.inputValue()===name||await input.inputValue()===name+' · Архівований',label+' committed');}else{await dialog.getByRole('button',{name:new RegExp(label)}).click();await page.getByRole('option',{name,exact:true}).click();}};
 const open=async()=>{const button=page.getByRole('button',{name:'Довідники',exact:true});await until(()=>button.isEnabled(),'dictionary trigger ready');await button.focus();await page.keyboard.press('Enter');await dialog.waitFor();await until(()=>dialog.getByRole('combobox',{name:/Запис довідника/}).isEnabled(),'dictionary loaded');};
 const preview=async()=>{const button=dialog.getByRole('button',{name:'Переглянути вплив',exact:true});await until(()=>button.isEnabled(),'preview ready');await button.focus();await page.keyboard.press('Enter');const heading=dialog.getByRole('heading',{name:'Перевірений вплив'});await heading.waitFor();assert(await heading.evaluate(el=>el===document.activeElement),'preview heading receives keyboard focus');};
 const confirm=async()=>{const button=dialog.getByRole('button',{name:'Підтвердити зміну довідника',exact:true});await until(()=>button.isEnabled(),'reviewed commit ready');await button.focus();await page.keyboard.press('Space');};
 const success=async()=>until(async()=>/Зміну довідника збережено/.test(await dialog.getByRole('status').innerText()),'dictionary saved');
 const geometry=async(label)=>{
  const results=[];
  for(const width of [1440,320]){
   await page.setViewportSize({width,height:1000});await dialog.locator('.tk-reference-impact').scrollIntoViewIfNeeded();
   const result=await dialog.evaluate(el=>({document:document.documentElement.scrollWidth<=innerWidth+1,dialog:el.scrollWidth<=el.clientWidth+1,targets:[...el.querySelectorAll('button')].filter(el=>!el.disabled).map(el=>el.getBoundingClientRect().height)}));
   assert(result.document&&result.dialog,`${label} fits ${width}`);assert(result.targets.every(height=>height>=44),`${label} targets ${width}`);results.push({width,...result});
   await page.screenshot({path:path.join(artifacts,`${label}-${width}.png`)});
  }return results;
 };
 let renamed=coffee,renameGeometry=[],mergeGeometry=[];
 if(!archiveOnly){
 await open();
 if(!recoveryTail){await select('Запис довідника',source.value+' · Активний');
 await dialog.getByRole('textbox',{name:'Нова назва'}).fill('B30 Гарячі напої');await preview();assert.equal(calls.length,0,'preview never commits');
 renameGeometry=await geometry('rename-review');
 const current=(await request('GET','/api/v1/catalog/products/'+coffee.id)).data;
 assert.equal((await request('PATCH','/api/v1/catalog/products/'+coffee.id,{revision:current.revision,name:'B30 Кава змінена паралельно'})).status,200);
 await confirm();await dialog.getByRole('alert').filter({hasText:/Вплив.*змінився/}).waitFor();await require('./catalog-recovery-navigation.cjs').access(page);
 assert.equal(await dialog.getByRole('textbox',{name:'Нова назва'}).inputValue(),'B30 Гарячі напої','409 keeps local input');
 assert.equal(await dialog.getByRole('heading',{name:'Перевірений вплив'}).count(),0,'stale review cleared');
 await preview();await confirm();await success();
 renamed=(await request('GET','/api/v1/catalog/products/'+coffee.id)).data;
 assert.equal(renamed.type,'B30 Гарячі напої');assert.equal(renamed.referenceIds.type,source.id);assert.equal(renamed.referenceIds.category,category.id);
 }
 await select('Запис довідника',(recoveryTail?source.value:'B30 Гарячі напої')+' · Активний');await select('Дія','Об’єднати');
 assert(!await dialog.getByRole('button',{name:'Переглянути вплив'}).isEnabled(),'merge requires explicit target');
 await select('Цільова група',target.value+' · Активний');await preview();
 assert.match(await dialog.locator('.tk-reference-impact').innerText(),/B30 Кава → B30 Подарункові/);
 mergeGeometry=await geometry('merge-review');
 let lost=false;await page.route('**/api/v1/catalog/recovery/execute',async route=>{if(!lost){lost=true;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');}else await route.continue();});
 await confirm();await dialog.getByRole('button',{name:'Повторити саме первісну дію'}).waitFor();await require('./catalog-recovery-navigation.cjs').access(page);const frozen=(await require('./catalog-recovery-navigation.cjs').raw(page))[0].firstIntent.body;const beforeIdentity=calls.length;await dialog.getByRole('button',{name:'Повторити саме первісну дію'}).press('Enter');await dialog.getByRole('button',{name:'Застосувати узгоджені зміни'}).waitFor();assert.equal(calls.length,beforeIdentity,'positive creator identity never repeats committed B30 POST');assert.deepEqual((await require('./catalog-recovery-navigation.cjs').raw(page))[0].confirmation.envelope,frozen);await dialog.getByRole('button',{name:'Застосувати узгоджені зміни'}).click();await page.unroute('**/api/v1/catalog/recovery/execute');
 renamed=(await request('GET','/api/v1/catalog/products/'+coffee.id)).data;
 assert.equal(renamed.type,target.value);assert.equal(renamed.referenceIds.type,target.id);assert.equal(renamed.referenceIds.category,targetCategory.id);
 const teaAfter=(await request('GET','/api/v1/catalog/products/'+tea.id)).data;assert.equal(teaAfter.type,target.value);
 }else await open();
 await select('Довідник','Пакування');await select('Запис довідника',pack.value+' · Активний');await select('Дія','Архівувати');await preview();
 const archiveGeometry=await geometry('archive-review');await confirm();await success();
 let references=await readReferences(page);
 assert(!references.items.some(item=>item.id===pack.id));assert(references.archivedItems.some(item=>item.id===pack.id));
 const invalid=await request('POST','/api/v1/catalog/products',{name:'B30 Заборонений новий архів',pack:pack.value,unit:'шт'});assert.equal(invalid.status,400);
 await dialog.getByRole('button',{name:'Закрити довідники',exact:true}).focus();await page.keyboard.press('Escape');await until(async()=>await dialog.count()===0,'Escape closes management');
 await until(async()=>await page.getByRole('button',{name:'Довідники',exact:true}).evaluate(el=>el===document.activeElement),'focus restored to trigger');
 await page.getByRole('searchbox',{name:'Пошук товару'}).fill(renamed.name);await until(async()=>await page.locator('.tk-product-link').count()===1,'existing archived product');await page.locator('.tk-product-link').click();
 await until(async()=>/B30 Пакет · Архівований/.test(await dialog.getByRole('combobox',{name:'Пакування',exact:true}).inputValue()),'archived reference label loaded');
 await dialog.getByText(/«B30 Пакет» архівовано/).waitFor();
 await dialog.getByRole('textbox',{name:'Назва товару'}).fill('B30 Збережено з архівованим пакуванням');const save=dialog.getByRole('button',{name:'Зберегти товар'});await until(()=>save.isEnabled(),'archived unchanged editor save');await save.click();await until(async()=>await dialog.count()===0,'existing archived value preserved');
 const saved=(await request('GET','/api/v1/catalog/products/'+coffee.id)).data;assert.equal(saved.pack,pack.value);assert.equal(saved.referenceIds.pack,pack.id);
 await open();await select('Довідник','Пакування');await select('Стан записів','Архівований');await select('Запис довідника',pack.value+' · Архівований');await preview();await confirm();await success();
 references=await readReferences(page);assert(references.items.some(item=>item.id===pack.id));
 await page.keyboard.press('Escape');
 fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({checks:[...(!archiveOnly&&!recoveryTail?['read-only preview','stable group/category IDs after rename','stale snapshot preserves input','explicit target group/coalesced category','lost response exact idempotent retry']:[]),'archive suppresses legacy selection','unchanged archived editor save','restore keeps ID','keyboard Enter/Space/Escape/focus restoration'],archiveOnly,recoveryTail,renameGeometry,mergeGeometry,archiveGeometry,commitRequests:calls.length},null,2));
 console.log(recoveryTail?'PASS: B30 merge/lostACK/creator identity/archive/unchanged editor/restore keyboard tail.':archiveOnly?'PASS: B30 affected archive/unchanged editor/restore keyboard tail.':'PASS: B30 stable references, reviewed atomic actions, 409/retry/archive/restore and 1440/320 keyboard/layout proof.');
};
