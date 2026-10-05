const reports=require('./reports-navigation.cjs');
const finance=require('./finance-navigation.cjs');
const {documentButton}=require('./trading-document-controls.cjs');
/* Financial reads against disposable Django fixtures, never a production database. */
const assert=require('node:assert/strict'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
module.exports=async function financeBrowse(page,base,wait,env,python){
 const fixture=JSON.parse(execFileSync(python,['-c',`
import os,json
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from datetime import timedelta
from django.utils import timezone
from django.contrib.auth.models import User
from server.erp.models import Voucher,CashEntry,AuditEvent,Store,CashAccount,Counterparty,Profile
owner=User.objects.get(username='tester');store=Store.objects.first();account=CashAccount.objects.filter(kind='cash').first();today=timezone.localdate()
party=Counterparty.objects.create(name='Постачальник фінансової перевірки',kind='supplier')
entries=Voucher.objects.bulk_create([Voucher(kind='expense',status='posted',date=today,store=store,account=account,total='1',note='Фінансова перевірка '+str(i),created_by=owner) for i in range(65)])
CashEntry.objects.bulk_create([CashEntry(voucher=v,account=account,amount='-1') for v in entries])
debts=Voucher.objects.bulk_create([Voucher(kind='receipt',status='posted',date=today,store=store,party=party,total='100',payload={'due_date':str(today-timedelta(days=1))},created_by=owner) for i in range(65)])
events=AuditEvent.objects.bulk_create([AuditEvent(user=owner,action='draft_saved',subject='finance-fixture/'+str(i),detail={'isolated':True}) for i in range(205)])
manager=User.objects.create_user(username='finance_manager',password='isolated-crm-test-password');Profile.objects.create(user=manager,role='manager',store=store)
salary=Voucher.objects.create(kind='payroll_payment',status='posted',date=today,store=store,account=account,total='3',note='Фінансова перевірка зарплати',created_by=owner)
CashEntry.objects.create(voucher=salary,account=account,amount='-3')
other=Store.objects.create(name='Інший магазин без боргів')
print(json.dumps({'store':store.pk,'other':other.pk,'account':account.pk,'accountName':account.name,'party':party.pk,'oldDebt':debts[0].pk,'oldEntry':entries[0].pk,'oldEvent':events[0].pk,'today':str(today),'manager':manager.pk}))
`],{env,encoding:'utf8'}));
 const host=key=>page.locator(`[data-finance-key="${key}"]`),modal=()=>page.locator('.trade-dialog[open]:not([data-finance-audit])');
 const loaded=async h=>wait(async()=>(await h.locator('[data-finance-results]').getAttribute('aria-busy'))!=='true'&&!!(await h.locator('[data-finance-status]').innerText()));
 const go=async tab=>{await page.goto(base+'/#trade/'+tab,{waitUntil:'domcontentloaded'});if(tab==='finance'){await finance.ready(page);return;}if(tab==='reports'){await reports.ready(page);await reports.debtsReady(page);return;}await page.locator('#main').getByRole('heading',{name:tab==='reports'?'Поточна заборгованість':'Магазини',exact:true}).waitFor();};
 const filter=async(h,key,value)=>{await h.locator(`[name=${key}]`).fill(value);await h.locator('[type=submit]').click();await loaded(h);};
 const next=async(h)=>{await h.locator('[data-finance-page=next]').click();await loaded(h);};
 const auditOnly=process.env.QA_FINANCE_FROM==='audit',workspaceOnly=process.env.QA_FINANCE_FROM==='workspace',layoutOnly=process.env.QA_FINANCE_FROM==='workspace-layout';
 if(!auditOnly){
 await go('finance');await finance.tab(page,'debts');
 if(!layoutOnly){
 await finance.assertPage(page,1,65);assert.match(await finance.workspace(page).locator('.finance-summary').innerText(),/6\s?500,00 грн/);
 await finance.move(page,'next');await finance.move(page,'next');await finance.assertPage(page,3,65);assert.equal(await finance.debt(page,fixture.oldDebt).count(),1);assert(await finance.pager(page).evaluate(el=>el.contains(document.activeElement)),'pager retains keyboard focus on the current page action/status');
 await finance.tab(page,'ledger');await finance.search(page,'Фінансова перевірка');await finance.directory(page,'Рахунок',fixture.accountName,new RegExp(fixture.accountName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));await finance.move(page,'next');await finance.move(page,'next');await finance.assertPage(page,3,66);assert.equal(await documentButton(page,fixture.oldEntry).count(),1);
 // Saving a draft redraws finance; each tab keeps its own filters and page.
 await finance.tab(page,'debts');await finance.debt(page,fixture.oldDebt).click();const paymentForm=modal().locator('#tradeAllocationForm');await paymentForm.waitFor();await paymentForm.getByRole('combobox',{name:'Грошовий рахунок',exact:true}).fill(fixture.accountName);await page.getByRole('option',{name:new RegExp(fixture.accountName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).click();assert.equal(await paymentForm.locator('[data-allocation]').inputValue(),'100.00');await modal().locator('[name=note]').fill('Чернетка зі старого боргу');
 page.once('dialog',d=>d.dismiss());await modal().locator('[data-trade=close]').click();assert.equal(await modal().locator('[name=note]').inputValue(),'Чернетка зі старого боргу');
 assert.equal(await modal().locator('#tradeAllocationForm').evaluate(form=>form.checkValidity()),true);
 await modal().locator('button[type=submit][value=draft]').click();await wait(async()=>!(await modal().locator('#tradeAllocationForm').count()));await modal().locator('[data-trade=close]').click();await finance.ready(page);
 await finance.assertPage(page,3,65);await finance.tab(page,'ledger');await finance.assertPage(page,3,66);assert.equal(await finance.workspace(page).getByRole('textbox',{name:'Пошук',exact:true}).inputValue(),'Фінансова перевірка');
 // Failed paging removes stale results, retains the selected page and offers keyboard Retry.
 let fail=true;await page.route('**/api/v1/trading/finance/ledger?*',route=>fail?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Ізольована помилка фінансового списку'})}):route.continue());
 await finance.move(page,'previous',{allowError:true});assert.match(await finance.workspace(page).getByRole('alert').innerText(),/Ізольована помилка/);const retry=finance.workspace(page).getByRole('button',{name:'Повторити читання',exact:true});assert(await retry.evaluate(el=>el===document.activeElement));assert.equal(await finance.region(page,'ledger').count(),0);
 fail=false;await retry.press('Enter');await finance.ready(page);await finance.assertPage(page,2,66);assert(await finance.pager(page).evaluate(el=>el.contains(document.activeElement)));await page.unroute('**/api/v1/trading/finance/ledger?*');
 // Tabs remain usable during reads; switching tabs and querying the next one fences the late old page.
 await finance.tab(page,'debts');let release,intercepted=false;const gate=new Promise(resolve=>release=resolve);await page.route('**/api/v1/trading/finance/debts?*',async route=>{if(!intercepted){intercepted=true;await gate;}await route.continue().catch(()=>{});});
 await finance.pager(page).locator('[data-page=previous]').click();await wait(async()=>intercepted);await finance.workspace(page).getByRole('tab',{name:'Рух коштів',exact:true}).click();await finance.ready(page);await finance.search(page,'Фінансова перевірка 0');release();await finance.ready(page);await finance.assertPage(page,1,1);assert.equal(await finance.region(page,'debts').count(),0);assert.equal(await documentButton(page,fixture.oldEntry).count(),1);await page.unroute('**/api/v1/trading/finance/debts?*');
 await finance.tab(page,'debts');await finance.search(page,'Жодного такого контрагента');await finance.assertPage(page,1,0);assert.equal(await finance.workspace(page).getByRole('button',{name:/^Оплатити борг № /}).count(),0);
 await finance.workspace(page).getByRole('button',{name:'Очистити фільтри',exact:true}).click();await finance.ready(page);await finance.workspace(page).getByRole('button',{name:/Стан боргу/}).click();await page.getByRole('option',{name:'Прострочені',exact:true}).click();await finance.workspace(page).getByRole('button',{name:'Знайти',exact:true}).click();await finance.ready(page);await finance.assertPage(page,1,65);
 console.log('Finance workspace paging/filter/draft/503/late-read assertions PASS');
 }
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'finance fits '+width);const sizes=await finance.workspace(page).locator('input:not([type=hidden]):not([type=date][tabindex="-1"]):visible,button:visible,[role=tab]:visible,.tk-date-group:visible').evaluateAll(elements=>elements.map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,tag:el.tagName,role:el.getAttribute('role'),label:el.getAttribute('aria-label'),html:el.outerHTML.slice(0,180)})));assert(sizes.every(s=>s.width>=44&&s.height>=44),'44px finance controls '+width+': '+JSON.stringify(sizes.filter(s=>s.width<44||s.height<44)));await page.screenshot({path:path.join(os.tmpdir(),`tsukenya-finance-${width}.png`)});}
 if(layoutOnly){console.log('PASS: React finance workspace1440/390/320 controls; other workspace assertions reused.');return;}
 await page.setViewportSize({width:1440,height:1000});await go('reports');const report=reports.currentDebts(page);await reports.debtsReady(page);assert.match(await report.innerText(),/65 записів/);const reportStore=page.locator('[data-report-form]').getByRole('combobox',{name:'Магазин',exact:true});await reportStore.fill('Інший магазин без боргів');await page.getByRole('option',{name:'Інший магазин без боргів',exact:true}).click();await page.locator('[data-report-form] [type=submit]').click();await reports.ready(page);await reports.debtsReady(page);await wait(async()=>(await reports.currentDebts(page).innerText()).includes('0 записів'));
 }
 if(workspaceOnly){console.log('PASS: React finance workspace65 debts/66 ledger, whole totals, preserved draft/filter/page, keyboard pager/retry, late-tab fencing, report store,1440/390/320; audit/manager tail not rerun.');return;}
 await go('setup');const auditOpener=page.locator('[data-trade=audit]');await auditOpener.click();const audit=host('audit');await loaded(audit);await filter(audit,'q','finance-fixture/');if(!auditOnly){assert.match(await audit.locator('[data-finance-status]').innerText(),/із 205/);for(let i=0;i<6;i++)await next(audit);assert.match(await audit.locator('[data-finance-status]').innerText(),/181–205/);assert.match(await audit.locator('[data-finance-results]').innerText(),new RegExp('№ '+fixture.oldEvent+'\\b'));
 await wait(async()=>!(await audit.locator('[name=user]').isDisabled()));await audit.locator('[name=user]').selectOption(String(fixture.manager));await loaded(audit);assert.equal(await audit.locator('[data-finance-status]').innerText(),'0 записів');await audit.locator('[name=user]').selectOption('');await loaded(audit);}
 await audit.locator('[name=action]').selectOption('draft_saved');await loaded(audit);await next(audit);
 // Invalid date ranges never reach the API; reset clears even restored user options.
 let reversedRequests=0;const countInvalid=request=>{const url=new URL(request.url());if(url.pathname==='/api/erp/audit'&&url.searchParams.get('from')>url.searchParams.get('to')&&url.searchParams.get('to'))reversedRequests++;};page.on('request',countInvalid);
 await audit.locator('[name=from]').fill('2026-10-04');await audit.locator('[name=to]').fill('2026-10-03');await audit.locator('[type=submit]').click();await loaded(audit);assert.match(await audit.locator('[data-finance-error]').innerText(),/Початкова дата/);assert.equal(reversedRequests,0);page.off('request',countInvalid);
 await audit.locator('[name=user]').selectOption(String(fixture.manager));await loaded(audit);await audit.locator('[data-finance-reset]').click();await loaded(audit);assert.equal(await audit.locator('[name=user]').inputValue(),'');assert.equal(await audit.locator('[name=q]').inputValue(),'');assert.equal(await audit.locator('[name=from]').inputValue(),'');
 await filter(audit,'q','finance-fixture/');await audit.locator('[name=action]').selectOption('draft_saved');await loaded(audit);await next(audit);
 for(const width of [390,320]){await page.setViewportSize({width,height:1000});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await page.locator('[data-finance-audit]').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'audit fits '+width);await page.screenshot({path:path.join(os.tmpdir(),`tsukenya-finance-audit-${width}.png`)});}
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('[data-finance-audit]').press('Escape');await page.locator('[data-finance-audit]').waitFor({state:'detached'});assert.equal(await page.locator('[data-finance-audit]').count(),0);assert.equal(await auditOpener.evaluate(el=>el===document.activeElement),true,'audit cancel returns focus without discard prompt');await auditOpener.click();await loaded(audit);assert.equal(await audit.locator('[name=q]').inputValue(),'finance-fixture/');assert.match(await audit.locator('[data-finance-status]').innerText(),/31–60/);
 let auditRelease,auditPending=false;const auditGate=new Promise(resolve=>auditRelease=resolve);await page.route('**/api/erp/audit?*',async route=>{auditPending=true;await auditGate;await route.continue().catch(()=>{});});await nextWithoutWait(audit);await wait(async()=>auditPending);await page.locator('[data-finance-audit]').press('Escape');await page.locator('[data-finance-audit]').waitFor({state:'detached'});auditRelease();await page.unroute('**/api/erp/audit?*');assert.equal(await page.locator('[data-finance-audit]').count(),0,'closing aborts late audit');
 const ctx=await page.context().browser().newContext({viewport:{width:390,height:1000}});
 try{const login=await ctx.request.post(base+'/api/login',{headers:{Origin:base},data:{username:'finance_manager',password:'isolated-crm-test-password'}});assert.equal(login.status(),200);const manager=await ctx.newPage();await manager.route('https://fonts.googleapis.com/**',r=>r.abort());await manager.route('https://fonts.gstatic.com/**',r=>r.abort());await manager.goto(base+'/#trade/finance');await finance.tab(manager,'ledger');await finance.search(manager,'Фінансова перевірка');await finance.assertPage(manager,1,65);for(let i=0;i<2;i++)await finance.move(manager,'next');assert.doesNotMatch(await finance.region(manager,'ledger').innerText(),/зарплати/);assert.equal((await ctx.request.get(base+'/api/erp/audit')).status(),403);}
 finally{await ctx.close();}
 console.log(auditOnly?'PASS: audit dates before GET, reset, 320/390px, read-only cancel/reopen focus/state, late-close abort, scoped manager salary exclusion.':'PASS:65 debts/65 ledger+salary/205 audit, old pages, filters, totals, draft redraw, pager/retry focus, abort/stale guards, report store, audit validation/reset/read-only cancel, scoped manager salary exclusion, 320/390/1440px.');
};
async function nextWithoutWait(host){await host.locator('[data-finance-page=next]').click();}
