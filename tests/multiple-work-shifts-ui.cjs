/* B04 isolated native forms: two tills/day, lost ACK retry, visible identity and payroll. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-two-tills-'));
const proof = process.env.WORK_SHIFTS_PROOF_DIR || '/tmp/tsukenya-multiple-work-shifts-proof';
fs.mkdirSync(proof, {recursive:true});
const python = process.env.PYTHON_BIN || 'python3';
const base = 'http://localhost:18484';
const password = 'isolated-workshift-test-password';
const hash = execFileSync(python, ['-c', `from server.auth import hash_password;print(hash_password('${password}'))`], {cwd:root,encoding:'utf8'}).trim();
const env = {...process.env, PORT:'18484', HOST:'127.0.0.1', DATA_DIR:data,
  ERP_DB_PATH:path.join(data,'crm.sqlite3'), OWNER_USERNAME:'tester', OWNER_PASSWORD_HASH:hash};
for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD','TSUKENYA_REQUIRE_POSTGRES']) delete env[key];
const log = fs.openSync(path.join(proof, 'server.log'), 'w');
const server = spawn(python, ['-m','server.main'], {cwd:root,env,stdio:['ignore',log,log]});
let browser;
const wait = async predicate => {
  for(let i=0;i<120;i++) {if(await predicate()) return;await new Promise(resolve=>setTimeout(resolve,100));}
  throw Error('Timed out waiting for isolated workshift UI.');
};
(async()=>{
  await wait(async()=>{try{return(await fetch(base+'/health')).ok;}catch{return false;}});
  browser = await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
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
  const go=async()=>{await page.goto(base+'/#trade/staff');await page.locator('[data-trade=work-shift]').first().waitFor();};
  const form=()=>page.locator('#tradeSimpleForm');
  const create=async(index,lostAck=false)=>{
    await page.locator('[data-trade=work-shift]').first().click();
    await form().locator('[name=employee]').selectOption(String(employee));
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
      await page.route('**/api/erp/work-shifts?*',async route=>{
        if(failRead&&new URL(route.request().url()).searchParams.get('id')===String(row.id)){
          failRead=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Актуальні умови тимчасово недоступні.'})});
        }
        return route.continue();
      });
      await page.locator('[data-work-exact-retry]').focus();await page.keyboard.press('Enter');
      await page.locator('[data-work-read-retry]').waitFor({state:'visible'});
      assert.equal(await form().locator('[name=shift_rate]').inputValue(),'');
      assert.equal(await select.inputValue(),String(tills[1]));
      assert.equal(await form().locator('[name=note]').inputValue(),'Новіші поля після втраченої відповіді');
      assert(await form().locator('[type=submit]').isDisabled());
      assert.deepEqual(intents[1],intents[0],'Exact retry freezes the whole original request, not just its UUID.');
      assert.equal((await ok('work-shifts?employee='+employee)).items.length,1);
      assert.equal((await ok('work-shifts?employee='+employee)).items[0].shift_rate,'150.00','Receipt does not overwrite another editor.');
      await page.locator('[data-work-read-retry]').focus();await page.keyboard.press('Enter');
      await page.locator('[data-work-comparison] table').waitFor();
      assert((await page.locator('[data-work-comparison]').innerText()).includes('150,00'));
      assert.equal(await form().locator('[name=shift_rate]').inputValue(),'');
      await page.setViewportSize({width:320,height:900});
      await page.locator('[data-work-confirmation]').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(proof,'recovery-comparison-320.png')});
      assert(await page.locator('[data-work-confirmation]').evaluate(element=>document.activeElement===element));
      await page.keyboard.press('Tab');
      assert(await form().locator('[type=submit]').evaluate(element=>document.activeElement===element));
      await page.screenshot({path:path.join(proof,'recovery-apply-320.png')});
      assert((await page.evaluate(()=>document.documentElement.scrollWidth))<=320);
      await page.unroute('**/api/erp/work-shifts?*');
      // The user explicitly applies a valid newer draft to the displayed fresh baseline.
      await form().locator('[name=shift_rate]').fill('175');
      await select.selectOption(String(tills[0]));
      const concurrent=(await ok('work-shifts?employee='+employee)).items[0];
      await ok('work-shifts','POST',{id:concurrent.id,revision:concurrent.revision,employee,date,cash_shift:tills[0],
        units:'1',shift_rate:'160',bonus_percent:'10',bonus_basis:'store',note:'Ще новіші умови іншої вкладки'});
      await form().locator('[type=submit]').focus();await page.keyboard.press('Enter');
      await page.locator('[data-work-read-retry]').waitFor({state:'visible'});
      assert(await form().locator('[type=submit]').isDisabled());
      assert.equal(await form().locator('[name=shift_rate]').inputValue(),'175');
      assert.equal((await ok('work-shifts?employee='+employee)).items[0].shift_rate,'160.00');
      await page.locator('[data-work-read-retry]').focus();await page.keyboard.press('Enter');
      await page.locator('[data-work-comparison] table').waitFor();
      assert((await page.locator('[data-work-comparison]').innerText()).includes('160,00'));
      assert.equal(await form().locator('[name=shift_rate]').inputValue(),'175');
      await form().locator('[type=submit]').focus();await page.keyboard.press('Enter');
    }
    await page.locator('.trade-dialog[open]').waitFor({state:'hidden'});
    if(lostAck) {assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.match(keys[0],/^[0-9a-f-]{36}$/);await page.unroute('**/api/erp/work-shifts');}
    await page.locator(`[data-shift-history=work] button[data-trade=work-shift]`).first().waitFor();
  };
  await go();await create(0,true);await page.setViewportSize({width:320,height:900});await create(1);
  const rows=(await ok('work-shifts?employee='+employee)).items;
  assert.equal(rows.length,2);assert.equal(new Set(rows.map(row=>row.date)).size,1);
  await wait(async()=>{const visible=await page.locator('[data-shift-history=work]').innerText();return tills.every(till=>visible.includes('Касова зміна № '+till));});
  const geometry=[];
  for(const width of [1440,320]) {
    await page.setViewportSize({width,height:900});
    await page.screenshot({path:path.join(proof,'tabell-'+width+'.png')});
    await page.locator('[data-shift-history=work] [data-shift-results]').screenshot({path:path.join(proof,'tabell-rows-'+width+'.png')});
    const measured=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth}));
    assert(measured.documentWidth<=width+1,JSON.stringify(measured));geometry.push(measured);
  }
  await page.locator('[data-trade=new-voucher][data-kind=payroll]').click();
  const payroll=page.locator('#tradeVoucherForm');await payroll.locator('[name=employee]').selectOption(String(employee));
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
  fs.writeFileSync(path.join(proof,'report.json'),JSON.stringify({pass:true,tills,rows:rows.map(row=>({id:row.id,date:row.date,cash_shift:row.cash_shift_id})),payroll:wages.total,geometry,checks:['native select and keyboard Tab/submit/checkbox','lost ACK frozen whole intent','invalid newer draft survives exact retry','GET-only recovery after confirmed receipt','current server comparison before explicit update','two same-day rows','distinct payroll sources','600.00 actual posting','1440/320 no document overflow']},null,2));
  console.log('PASS: B04 two same-day tills, immutable lost-ACK retry with newer draft and current-server comparison, keyboard and 320px, payroll 600.00. Proof '+proof);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(browser) await browser.close();server.kill('SIGTERM');
  await new Promise(resolve=>server.once('exit',resolve));fs.closeSync(log);fs.rmSync(data,{recursive:true,force:true});
});
