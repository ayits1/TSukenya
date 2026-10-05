const staff=require('./staff-navigation.cjs');
/* B06 native workshift recovery; primary retains B04 exact receipt and actual payroll. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
if(!process.env.WORK_CONFLICT_FROM){for(const stage of ['primary','existing','semantic'])execFileSync(process.execPath,[__filename],{cwd:root,env:{...process.env,WORK_CONFLICT_FROM:stage},stdio:'inherit'});process.exit(0);}
assert(['primary','existing','semantic'].includes(process.env.WORK_CONFLICT_FROM),'Unknown workshift QA stage.');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-two-tills-'));
const proof = process.env.WORK_SHIFTS_PROOF_DIR || '/tmp/tsukenya-work-shift-conflict-proof';
fs.mkdirSync(proof, {recursive:true});
const python = process.env.PYTHON_BIN || 'python3';
const base = 'http://localhost:18510';
const password = 'isolated-workshift-test-password';
const hash = execFileSync(python, ['-c', `from server.auth import hash_password;print(hash_password('${password}'))`], {cwd:root,encoding:'utf8'}).trim();
const env = {...process.env, PORT:'18510', HOST:'127.0.0.1', DATA_DIR:data,
  ERP_DB_PATH:path.join(data,'crm.sqlite3'), OWNER_USERNAME:'tester', OWNER_PASSWORD_HASH:hash};
for(const key of Object.keys(env))if(/^DB_|^PG/.test(key)||key==='TSUKENYA_REQUIRE_POSTGRES')delete env[key];
env.DJANGO_SECRET_KEY='isolated-workshift-conflict-only-secret-with-at-least-fifty-characters';
const log = fs.openSync(path.join(proof, 'server.log'), 'w');
const server = spawn(python, ['-m','server.main'], {cwd:root,env,stdio:['ignore',log,log]});
let browser;
const wait = async predicate => {
  for(let i=0;i<120;i++) {if(await predicate()) return;await new Promise(resolve=>setTimeout(resolve,100));}
  throw Error('Timed out waiting for isolated workshift UI.');
};
(async()=>{
  await wait(async()=>{try{return(await fetch(base+'/health')).ok;}catch{return false;}});
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({viewport:{width:1440,height:1050}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await require('./browser-login.cjs')(page,base,password);
  const api = (endpoint, method='GET', body) => page.evaluate(async args=>{
    const state=await(await fetch('/api/state')).json();
    const response=await fetch('/api/erp/'+args.endpoint,{method:args.method,
      headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
      body:args.body===undefined?undefined:JSON.stringify(args.body)});
    return {status:response.status,data:await response.json()};
  },{endpoint,method,body});
  const ok=async(...args)=>{const response=await api(...args);assert(response.status>=200&&response.status<300,JSON.stringify(response));return response.data;};
  const state=await ok('state'),store=state.stores[0].id,warehouse=state.warehouses[0].id;
  const cash=state.accounts.find(a=>a.kind==='cash').id;
  const bank=(state.accounts.find(a=>a.kind==='bank') || await ok('entities/accounts','POST',{name:'Ізольований банк',store,kind:'bank'})).id;
  const employee=(await ok('entities/employees','POST',{name:'Працівник двох касових змін',store,shift_rate:100,bonus_percent:10,bonus_basis:'store'})).id;
  const supplier=(await ok('entities/parties','POST',{name:'Ізольований постачальник',kind:'supplier'})).id;
  const product=await page.evaluate(async()=>{const state=await(await fetch('/api/state')).json();return state.data.products[0].id;});
  const date=await page.evaluate(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
  const voucher=async body=>{const draft=await ok('vouchers','POST',{date,store,warehouse,...body});return ok('vouchers/'+draft.id+'/post','POST',{revision:draft.revision});};
  await voucher({kind:'cash_opening',account:cash,amount:1000});
  await voucher({kind:'receipt',party:supplier,lines:[{product,quantity:20,price:5}]});
  const tills=[];
  for(const total of [100,300]) {
    const till=(await ok('shifts','POST',{account:cash,employee})).id;tills.push(till);
    await voucher({kind:'sale',shift:till,employee,lines:[{product,quantity:1,price:total}],payload:{payments:[{account:bank,amount:String(total)}]}});
    await ok('shifts','POST',{id:till,action:'close',counted:1000});
  }
  const go=async()=>{await page.goto(base+'/#trade/staff');await staff.tab(page,'work');};
  const form=()=>page.locator('#tradeSimpleForm');
  const privateReadRecovery=async()=>{await wait(async()=>await page.evaluate(()=>window.NativeDraftRecovery.controller.snapshot().state==='error'));assert(await form().evaluate(f=>f.closest('.trade-dialog-body').hidden));const before=writes;await page.locator('[data-workshift-access]').getByRole('button',{name:'Перевірити доступ до форми',exact:true}).click();await wait(async()=>await form().evaluate(f=>!f.closest('.trade-dialog-body').hidden));assert.equal(writes,before);};
  const pickEmployee=async(host,label)=>{const input=host.getByRole('combobox',{name:'Працівник',exact:true});await input.fill(label);await page.getByRole('option',{name:new RegExp(label)}).click();};
  let writes=0;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/erp/work-shifts')writes++;});
  const chooseMine=async()=>{for(const radio of await page.getByRole('radio',{name:'Залишити мої зміни',exact:true}).all()){await radio.focus();await page.keyboard.press('Space');}};
  const apply=()=>page.getByRole('button',{name:'Застосувати узгоджені зміни',exact:true});
  const create=async(index,lostAck=false)=>{
    await staff.openCreate(page);
    await pickEmployee(form(), 'Працівник двох касових змін');
    const select=form().locator('[data-cash-choice]');await select.waitFor();
    await wait(async()=>await select.isEnabled());
    await select.selectOption(String(tills[index]));
    await select.focus();await page.keyboard.press('Tab');
    assert.equal(await select.inputValue(),String(tills[index]),'The native select retains its distinct till.');
    assert(await select.evaluate(element=>document.activeElement!==element),'Keyboard Tab leaves the native selector.');
    await form().locator('[name=units]').fill(index===0?'1':'2');
    await form().locator('[name=shift_rate]').fill(index===0?'100':'200');
    await form().locator('[name=bonus_percent]').fill(index===0?'10':'5');
    if(index===1) {
      await page.screenshot({path:path.join(proof,'work-form-320.png')});
      const bounds=await page.locator('.trade-dialog[open]').boundingBox();
      assert(bounds.x>=0&&bounds.x+bounds.width<=320,'Work-shift form fits 320px.');
      assert((await form().locator('[type=submit]').boundingBox()).height>=44);
    }
    const keys=[],intents=[];
    if(lostAck) await page.route('**/api/erp/work-shifts',async route=>{
      if(route.request().method()!=='POST') return route.continue();
      const body=route.request().postDataJSON();
      if(!body.idempotency_key) return route.continue();
      keys.push(body.idempotency_key);intents.push(body);
      if(keys.length===1) {const response=await route.fetch();assert.equal(response.status(),200);return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Втрачена відповідь після запису. Повторіть збереження.'})});}
      return route.continue();
    });
    await form().locator('[type=submit]').focus();await page.keyboard.press('Enter');
    if(lostAck) {
      await page.locator('#tradeFormError').filter({hasText:'Втрачена відповідь'}).waitFor();
      assert.equal(await form().locator('[name=shift_rate]').inputValue(),'100');
      assert(await form().locator('[type=submit]').isDisabled());
      // A different device changed the confirmed row; a retry cannot silently adopt its revision.
      const row=(await ok('work-shifts?employee='+employee)).items[0];
      await ok('work-shifts','POST',{id:row.id,revision:row.revision,employee,date,cash_shift:tills[0],
        units:'1',shift_rate:'150',bonus_percent:'10',bonus_basis:'store',note:'Умови іншої вкладки'});
      // Newer draft is intentionally invalid and selects another till. Exact retry must ignore its validity.
      await form().locator('[name=shift_rate]').fill('');
      await select.selectOption(String(tills[1]));
      await form().locator('[name=note]').fill('Новіші поля після втраченої відповіді');
      let failRead=true;
      await page.route('**/api/v1/trading/work-shifts/current?*',async route=>{
        if(failRead&&new URL(route.request().url()).searchParams.get('id')===String(row.id)){
          failRead=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Актуальні умови тимчасово недоступні.'})});
        }
        return route.continue();
      });
      await page.locator('[data-work-exact-retry]').focus();await page.keyboard.press('Enter');
      await privateReadRecovery();await page.locator('[data-work-read-retry]').waitFor({state:'visible'});
      assert.equal(await form().locator('[name=shift_rate]').inputValue(),'');
      assert.equal(await select.inputValue(),String(tills[1]));
      assert.equal(await form().locator('[name=note]').inputValue(),'Новіші поля після втраченої відповіді');
      assert(await form().locator('[type=submit]').isDisabled());
      assert.deepEqual(intents[1],intents[0],'Exact retry freezes the whole original request, not just its UUID.');
      assert.equal((await ok('work-shifts?employee='+employee)).items.length,1);
      assert.equal((await ok('work-shifts?employee='+employee)).items[0].shift_rate,'150.00','Receipt does not overwrite another editor.');
      await page.locator('[data-work-read-retry]').focus();await page.keyboard.press('Enter');
      await page.locator('[data-work-baseline]').filter({hasText:'Нараховано'}).waitFor();
      assert.equal(await form().locator('[name=shift_rate]').inputValue(),'');
      assert.equal(await page.getByRole('radio').count(),0,'Invalid newer draft does not block GET or enter actionable merge.');
      assert(await form().locator('[type=submit]').isDisabled());
      await page.unroute('**/api/v1/trading/work-shifts/current?*');
      await form().locator('[name=shift_rate]').fill('175');await select.selectOption(String(tills[0]));
      const beforeCompare=writes;
      await page.locator('[data-work-read-retry]').click();await apply().waitFor();
      assert(await apply().isDisabled());assert.equal(writes,beforeCompare);
      await page.setViewportSize({width:320,height:900});
      await page.locator('[data-work-comparison]').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(proof,'recovery-comparison-320.png')});
      assert((await page.evaluate(()=>document.documentElement.scrollWidth))<=320);
      await chooseMine();await apply().focus();await page.keyboard.press('Enter');
      await apply().waitFor({state:'hidden'});assert.equal(writes,beforeCompare,'Apply changes only local baseline.');
      await page.screenshot({path:path.join(proof,'recovery-apply-320.png')});
      const concurrent=(await ok('work-shifts?employee='+employee)).items[0];
      await ok('work-shifts','POST',{id:concurrent.id,revision:concurrent.revision,employee,date,cash_shift:tills[0],
        units:'1',shift_rate:'160',bonus_percent:'10',bonus_basis:'store',note:'Ще новіші умови іншої вкладки'});
      await wait(async()=>await select.isEnabled());
      await form().locator('[type=submit]').click();
      await page.locator('[data-work-read-retry]').waitFor({state:'visible'});
      assert(await form().locator('[type=submit]').isDisabled());assert.equal(await form().locator('[name=shift_rate]').inputValue(),'175');
      const beforeSecond=writes;await page.locator('[data-work-read-retry]').click();await apply().waitFor();
      assert((await page.locator('[data-work-comparison]').innerText()).includes('160.00'));
      await chooseMine();await apply().click();await apply().waitFor({state:'hidden'});assert.equal(writes,beforeSecond);
      await wait(async()=>await select.isEnabled());await form().locator('[type=submit]').click();
    }
    await page.locator('.trade-dialog[open]').waitFor({state:'hidden'});
    if(lostAck) {assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.match(keys[0],/^[0-9a-f-]{36}$/);await page.unroute('**/api/erp/work-shifts');}
    await staff.tab(page,'work');
  };
  if(['existing','semantic'].includes(process.env.WORK_CONFLICT_FROM)){
    const extraEmployee=(await ok('entities/employees','POST',{name:'Історичний працівник для узгодження',store,shift_rate:'10',bonus_percent:'0',bonus_basis:'store'})).id;
    const saved=(await ok('work-shifts','POST',{employee:extraEmployee,date,cash_shift:tills[0],units:'1',shift_rate:'10',bonus_percent:'0',bonus_basis:'store',note:'Початок'})).id;
    const employeeMeta=(await page.evaluate(async id=>{const session=await(await fetch('/api/v1/trading/bootstrap')).json();return(await(await fetch('/api/v1/trading/directories/details',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify({ids:[{type:'employees',id:String(id)}],purpose:'manage'})})).json()).items[0];},extraEmployee));
    await ok('entities/employees','POST',{id:extraEmployee,revision:employeeMeta.revision,name:employeeMeta.name,store,shift_rate:'999',bonus_percent:'99',bonus_basis:'store',active:false});
    const existingChecks=[];
    const open=async()=>{await go();await staff.openEdit(page,saved);await form().waitFor();assert.equal(await form().locator('[name=shift_rate]').inputValue(),(await row()).shift_rate);};
    const row=async()=> (await ok('work-shifts?id='+saved)).items[0];
    const update=async changes=>{const before=await row();return ok('work-shifts','POST',{id:saved,revision:before.revision,employee:extraEmployee,date,cash_shift:before.cash_shift_id,units:before.units,shift_rate:before.shift_rate,bonus_percent:before.bonus_percent,bonus_basis:before.bonus_basis,note:before.note,...changes});};
    const review=async()=>{await page.locator('[data-work-read-retry]').click();await apply().waitFor();};
    const close=async()=>{page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Закрити вікно'}).click();await page.locator('dialog[open]').waitFor({state:'hidden'});};
    if(process.env.WORK_CONFLICT_FROM==='semantic'){
      await open();await form().locator('[name=note]').fill('Збережена новіша примітка');await update({shift_rate:'15'});await form().locator('[type=submit]').click();await page.locator('[data-work-read-retry]').waitFor({state:'visible'});
      const malformed={...await row(),units:'0.00'};await page.route('**/api/v1/trading/work-shifts/current?*',route=>new URL(route.request().url()).searchParams.get('id')===String(saved)?route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({total:1,page:1,pages:1,items:[malformed]})}):route.continue());
      const before=writes;await page.locator('[data-work-read-retry]').click();await privateReadRecovery();
      assert.equal(await form().locator('[name=note]').inputValue(),'Збережена новіша примітка');assert.equal(await form().locator('[name=units]').inputValue(),'1.00');assert(await form().locator('[type=submit]').isDisabled());assert.equal(await apply().count(),0);assert((await page.locator('#tradeFormError').innerText()).length>0);assert.equal(writes,before);
      await page.unroute('**/api/v1/trading/work-shifts/current?*');
      await page.evaluate(()=>{const mount=window.NativeConflictComparison.mount;window.NativeConflictComparison.mount=(host,props)=>{window.qaWorkComparison=props;return mount(host,props);};});
      await review();await page.evaluate(()=>window.qaWorkComparison.onApply({...window.qaWorkComparison.mine,units:'0'}));
      assert.equal(await form().locator('[name=units]').inputValue(),'1.00');assert(await form().locator('[type=submit]').isDisabled());assert.equal(writes,before);assert(await apply().isVisible());
      await apply().click();await apply().waitFor({state:'hidden'});assert.equal(writes,before);await wait(async()=>await form().locator('[data-cash-choice]').isEnabled());await form().locator('[type=submit]').click();await page.locator('dialog[open]').waitFor({state:'hidden'});assert.equal((await row()).note,'Збережена новіша примітка');assert.deepEqual(errors,[]);
      await page.route('**/api/v1/trading/directories/employees?*',async route=>{const response=await route.fetch();const data=await response.json();for(const item of data.items){delete item.shift_rate;delete item.bonus_percent;delete item.bonus_basis;}return route.fulfill({response,json:data});});
      const beforeOpening=writes;await staff.openCreate(page);await page.getByRole('alert').filter({hasText:'Умови працівника неповні'}).waitFor();assert.equal(await page.locator('dialog[open] #tradeSimpleForm').count(),0);assert.equal(writes,beforeOpening);await page.unroute('**/api/v1/trading/directories/employees?*');
      fs.writeFileSync(path.join(proof,'semantic-report.json'),JSON.stringify({pass:true,checks:['malformed server units0 and invalid merge refused without draft/revision adoption or POST','fresh valid comparison and separate Save after refusal','new employee missing private terms refuses opening instead of inventing zeros']},null,2));console.log('PASS: B06 malformed semantic terms refusal.');return;
    }
    await open();assert((await form().getByRole('combobox',{name:'Працівник',exact:true}).inputValue()).includes('неактивний'));
    assert.equal(await form().locator('[name=shift_rate]').inputValue(),'10.00','Historical terms do not adopt current employee rate999.');
    await form().locator('[name=note]').fill('Моя незалежна примітка');await update({shift_rate:'15'});
    await form().locator('[type=submit]').click();await page.locator('[data-work-read-retry]').waitFor({state:'visible'});
    let before=writes;await review();assert.equal(await page.getByRole('radio').count(),0);assert.equal(writes,before);
    await apply().click();await apply().waitFor({state:'hidden'});assert.equal(writes,before);
    assert.equal(await form().locator('[name=shift_rate]').inputValue(),'15.00');assert.equal(await form().locator('[name=note]').inputValue(),'Моя незалежна примітка');
    await wait(async()=>await form().locator('[data-cash-choice]').isEnabled());await form().locator('[type=submit]').click();await page.locator('dialog[open]').waitFor({state:'hidden'});
    assert.equal((await row()).note,'Моя незалежна примітка');existingChecks.push('existing UPDATE409 independent note + server terms, inactive pinned, no eager POST');
    await open();await form().locator('[name=units]').fill('2');await update({shift_rate:'20'});
    await form().locator('[type=submit]').click();await page.locator('[data-work-read-retry]').waitFor({state:'visible'});before=writes;await review();assert(await apply().isDisabled());
    for(const width of [1440,320]){await page.setViewportSize({width,height:1050});await page.locator('[data-work-comparison]').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(proof,'existing-comparison-'+width+'.png')});assert((await page.evaluate(()=>document.documentElement.scrollWidth))<=width);}
    await page.getByRole('radio',{name:'Взяти зміни сервера',exact:true}).focus();await page.keyboard.press('Space');await apply().focus();await page.keyboard.press('Enter');await apply().waitFor({state:'hidden'});assert.equal(writes,before);
    assert.equal(await form().locator('[name=units]').inputValue(),'1.00');assert.equal(await form().locator('[name=shift_rate]').inputValue(),'20.00');
    await wait(async()=>await form().locator('[data-cash-choice]').isEnabled());await form().locator('[type=submit]').click();await page.locator('dialog[open]').waitFor({state:'hidden'});existingChecks.push('conservative whole terms choice + separate Save + keyboard1440/320');
    await open();await form().locator('[name=shift_rate]').fill('25');await update({note:'Інша вкладка'});await form().locator('[type=submit]').click();await page.locator('[data-work-read-retry]').waitFor({state:'visible'});
    const current=await row();let fault='resource';
    const reader=async route=>{if(new URL(route.request().url()).searchParams.get('id')!==String(saved))return route.continue();
      if(fault==='503'||fault==='403')return route.fulfill({status:Number(fault),contentType:'application/json',body:JSON.stringify({error:'Перевірка '+fault})});
      const bad=fault==='resource'?{id:saved,name:'Це довідник'}:fault==='other-id'?{...current,id:saved+100}:fault==='store'?{...current,store_id:store+100}:fault==='semantic'?{...current,units:'0.00'}:{...current,date:'2024-01-01'};
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({total:1,page:1,pages:1,items:[bad]})});};
    await page.route('**/api/v1/trading/work-shifts/current?*',reader);before=writes;
    for(const issue of ['resource','other-id','store','date','semantic','503']){fault=issue;await page.locator('[data-work-read-retry]').click();await privateReadRecovery();assert.equal(await form().locator('[name=shift_rate]').inputValue(),'25');assert(await form().locator('[type=submit]').isDisabled());assert.equal(await apply().count(),0);assert((await page.locator('#tradeFormError').innerText()).length>0);}
    assert.equal(writes,before);await page.unroute('**/api/v1/trading/work-shifts/current?*',reader);existingChecks.push('strict wrong resource/ID/immutable scope/date + GET503 preserve draft behind authorization-only retry');
    await review();await page.getByRole('button',{name:'Повернутися до чернетки'}).click();await apply().waitFor({state:'hidden'});assert(await form().locator('[type=submit]').isDisabled());assert.equal(await form().locator('[name=shift_rate]').inputValue(),'25');
    let release,started=false;const delayed=async route=>{if(new URL(route.request().url()).searchParams.get('id')!==String(saved))return route.continue();const response=await route.fetch();started=true;await new Promise(resolve=>release=resolve);try{await route.fulfill({response});}catch{}};
    await page.route('**/api/v1/trading/work-shifts/current?*',delayed);await page.locator('[data-work-read-retry]').click();await wait(()=>started);await page.locator('[data-workshift-read-cancel]').click();release();await page.unroute('**/api/v1/trading/work-shifts/current?*',delayed);await new Promise(resolve=>setTimeout(resolve,150));assert.equal(await apply().count(),0);assert.equal(await form().locator('[name=shift_rate]').inputValue(),'25');await page.locator('[data-workshift-access]').getByRole('button',{name:'Перевірити доступ до форми',exact:true}).click();await wait(async()=>await form().evaluate(f=>!f.closest('.trade-dialog-body').hidden));existingChecks.push('cancel aborted GET discards late response without baseline adoption');
    await close();await open();await form().locator('[name=note]').fill('Після зовнішнього нарахування');
    await voucher({kind:'payroll',employee:extraEmployee,payload:{shift_ids:[saved]}});await form().locator('[type=submit]').click();await page.locator('[data-work-read-retry]').waitFor({state:'visible'});await page.locator('[data-work-read-retry]').click();await page.locator('[data-work-recovery-status]').filter({hasText:'включено в нарахування'}).waitFor();
    assert(await form().locator('[type=submit]').isDisabled());assert.equal(await apply().count(),0);assert.equal(await form().locator('[name=note]').inputValue(),'Після зовнішнього нарахування');existingChecks.push('actual external posted payroll refuses Apply and Save');
    await page.route('**/api/v1/trading/work-shifts/current?*',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Немає доступу до табеля'})}));
    await page.locator('[data-work-read-retry]').click();await wait(async()=>await page.evaluate(()=>window.NativeDraftRecovery.controller.snapshot().state==='error'));assert(await form().evaluate(f=>f.closest('.trade-dialog-body').hidden));assert.equal(await page.locator('.trade-dialog[open] #tradeDialogTitle').innerText(),'Локальна чернетка призупинена');assert(await page.evaluate(()=>!window.NativeDraftRecovery.store.entries().some(e=>e.id.startsWith('workshift_'))));await page.unroute('**/api/v1/trading/work-shifts/current?*');existingChecks.push('current resource403 hides private fields and removes only denied timesheet record; no stale salary edit');
    await close();assert.deepEqual(errors,[]);fs.writeFileSync(path.join(proof,'existing-report.json'),JSON.stringify({pass:true,checks:existingChecks},null,2));console.log('PASS: B06 existing workshift recovery '+existingChecks.length+' groups.');return;
  }
  await go();await create(0,true);await page.setViewportSize({width:320,height:900});await create(1);
  const rows=(await ok('work-shifts?employee='+employee)).items;
  assert.equal(rows.length,2);assert.equal(new Set(rows.map(row=>row.date)).size,1);
  await wait(async()=>{const visible=await staff.host(page).innerText();return tills.every(till=>visible.includes('Касова зміна № '+till));});
  const geometry=[];
  for(const width of [1440,320]) {
    await page.setViewportSize({width,height:900});
    await page.screenshot({path:path.join(proof,'tabell-'+width+'.png')});
    await staff.host(page).getByRole('region',{name:'Табель робочих змін',exact:true}).screenshot({path:path.join(proof,'tabell-rows-'+width+'.png')});
    const measured=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth}));
    assert(measured.documentWidth<=width+1,JSON.stringify(measured));geometry.push(measured);
  }
  await staff.payroll(page).click();
  const payroll=page.locator('#tradeVoucherForm');await pickEmployee(payroll, 'Працівник двох касових змін');
  await wait(async()=>await payroll.locator('[name=shift_ids]').count()===2);
  for(const row of rows) {
    const checkbox=payroll.locator(`[name=shift_ids][value="${row.id}"]`);
    assert((await checkbox.locator('..').innerText()).includes('Касова зміна № '+row.cash_shift_id));
    await checkbox.focus();await page.keyboard.press('Space');assert(await checkbox.isChecked());
  }
  await page.screenshot({path:path.join(proof,'payroll-selected-320.png')});
  const total=page.locator('#tradeDraftTotal');assert.equal(await total.innerText(),'Нарахування — після проведення');
  await page.locator('[form=tradeVoucherForm][value=post]').focus();await page.keyboard.press('Enter');
  await page.locator('.trade-dialog-head h2').filter({hasText:'Нарахування зарплати ·'}).waitFor();
  const wages=(await ok('vouchers?kind=payroll')).items[0];assert.equal(wages.total,'600.00');
  for(const till of tills) assert((await page.locator('.trade-dialog[open]').innerText()).includes('Касова зміна № '+till));
  await page.screenshot({path:path.join(proof,'payroll-result-320.png')});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(proof,'report.json'),JSON.stringify({pass:true,tills,rows:rows.map(row=>({id:row.id,date:row.date,cash_shift:row.cash_shift_id})),payroll:wages.total,geometry,checks:['native select and keyboard Tab/submit/checkbox','lost ACK frozen whole intent','invalid newer draft survives exact retry','GET-only recovery after confirmed receipt','shared comparison Apply without POST, separate Save and repeated409','two same-day rows','distinct payroll sources','600.00 actual posting','1440/320 no document overflow']},null,2));
  console.log('PASS: B04 two same-day tills, immutable lost-ACK retry with newer draft and current-server comparison, keyboard and 320px, payroll 600.00. Proof '+proof);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(browser) await browser.close();server.kill('SIGTERM');
  await new Promise(resolve=>server.once('exit',resolve));fs.closeSync(log);fs.rmSync(data,{recursive:true,force:true});
});
