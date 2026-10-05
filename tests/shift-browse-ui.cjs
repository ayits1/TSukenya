const staff=require('./staff-navigation.cjs');
/* Historical shift lookup and payroll selection, using isolated Django fixtures. */
const assert=require('node:assert/strict'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
module.exports=async function shiftBrowse(page,base,wait,env,python){
 const fixture=JSON.parse(execFileSync(python,['-c',`
import os,json
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from datetime import timedelta
from django.utils import timezone
from django.contrib.auth.models import User
from server.erp.models import CashShift,WorkShift,Employee,CashAccount
employee=Employee.objects.first();second=Employee.objects.create(name='Другий працівник',store=employee.store,shift_rate='400',bonus_percent='3',bonus_basis='store');account=CashAccount.objects.filter(kind='cash').first();owner=User.objects.get(username='tester')
now=timezone.now();today=timezone.localdate()
cash=CashShift.objects.bulk_create([CashShift(store=employee.store,account=account,employee=employee,opened_by=owner,opening_cash='0',closed_at=now if i else None,expected_cash='0' if i else None,counted_cash='0' if i else None) for i in range(130)])
CashShift.objects.all().update(opened_at=now-timedelta(days=600))
work=WorkShift.objects.bulk_create([WorkShift(employee=employee,store=employee.store,date=today-timedelta(days=519-i),cash_shift=cash[1],units='1',shift_rate='400',bonus_percent='5' if i==0 else '0',bonus_basis='store') for i in range(520)])
second_row=WorkShift.objects.create(employee=second,store=employee.store,date=today,cash_shift=cash[1],units='1',shift_rate='400',bonus_percent='3',bonus_basis='store')
print(json.dumps({'second':second.pk,'second_row':second_row.pk,'employee':employee.pk,'active':cash[0].pk,'cash':cash[1].pk,'work':work[0].pk,'oldDate':str(work[0].date),'today':str(today)}))
`],{env,encoding:'utf8'}));
 const go=async route=>{await page.goto(base+'/#trade/'+route,{waitUntil:'domcontentloaded'});if(route==='sales'){await page.getByRole('tab',{name:'Касові зміни',exact:true}).click();await page.getByRole('heading',{name:'Касові зміни',exact:true}).waitFor();}else await staff.tab(page,'work');};
 const loaded=async host=>wait(async()=>(await host.locator('[data-shift-results]').getAttribute('aria-busy'))!=='true'&&(await host.locator('[data-shift-status]').innerText())!=='');
 const modal=()=>page.locator('.trade-dialog[open]');
 await go('sales');const cashWorkspace=page.locator('[data-react-sales]');await cashWorkspace.getByText('1 / 5 · записів 130',{exact:true}).waitFor();
 for(let i=0;i<4;i++){await cashWorkspace.getByRole('button',{name:'Далі',exact:true}).click();await cashWorkspace.getByText(`${i+2} / 5 · записів 130`,{exact:true}).waitFor();}
 assert.equal(await cashWorkspace.getByRole('button',{name:`Закрити зміну № ${fixture.active}`,exact:true}).count(),1);
 await cashWorkspace.getByRole('tab',{name:'Документи',exact:true}).click();await page.getByRole('button',{name:'+ Продаж',exact:true}).click();await modal().locator('[name=shift]').waitFor({state:'attached'});const cashChoice=modal().getByRole('combobox',{name:'Касова зміна',exact:true});await cashChoice.waitFor();await cashChoice.click();const oldActive=page.getByRole('option',{name:new RegExp('^Зміна № '+fixture.active+' ·')});await oldActive.waitFor();await oldActive.click();assert.equal(await modal().locator('[name=shift]').inputValue(),String(fixture.active),'old active cash remains selectable through bounded lookup');page.once('dialog',d=>d.accept());await modal().locator('[data-trade=close]').click();
 await go('staff');await staff.assertPage(page,1,521);
 await staff.setDate(page,'З дати',fixture.oldDate);await staff.setDate(page,'По дату',fixture.oldDate);await staff.host(page).getByRole('button',{name:'Знайти',exact:true}).click();await staff.ready(page);await staff.assertPage(page,1,1);await staff.openEdit(page,fixture.work);
 const cashHost=modal().locator('#tradeWorkCashChoice');await loaded(cashHost);assert.equal(await modal().locator('[name=employee]').inputValue(),String(fixture.employee));assert.equal(await modal().locator('[name=date]').inputValue(),fixture.oldDate);assert.equal(await cashHost.locator('[data-cash-choice]').inputValue(),String(fixture.cash));assert.equal(await modal().locator('[name=cash_shift]').inputValue(),String(fixture.cash));
 await wait(async()=>(await modal().locator('[data-percent-hint]').innerText())!=='');assert.match(await modal().locator('[data-percent-hint]').innerText(),/Другий працівник — 3 %.*ще один відсоток від того самого виторгу.*зменшити відсоток у цьому записі/);await modal().locator('[name=bonus_percent]').fill('0');await wait(async()=>(await modal().locator('[data-percent-hint]').innerText())==='');await modal().locator('[name=bonus_percent]').fill('5');await wait(async()=>(await modal().locator('[data-percent-hint]').innerText())!=='');
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await modal().evaluate(el=>el.scrollWidth>el.clientWidth+1),false);await page.screenshot({path:path.join(os.tmpdir(),`tsukenya-work-history-${width}.png`)});}
 await modal().locator('[name=note]').fill('Стара зміна, чернетка');await cashHost.locator('[data-shift-page=next]').click();await loaded(cashHost);assert.equal(await cashHost.locator('[data-cash-choice]').inputValue(),String(fixture.cash),'off-page selection retained');assert.equal(await modal().locator('[name=note]').inputValue(),'Стара зміна, чернетка');await modal().locator('button[type=submit]').click();await wait(async()=>!(await modal().count()));await staff.ready(page);await staff.assertDate(page,'З дати',fixture.oldDate);await staff.assertDate(page,'По дату',fixture.oldDate);await staff.assertPage(page,1,1);
 await staff.openCreate(page);await loaded(modal().locator('#tradeWorkCashChoice'));await modal().locator('[name=bonus_percent]').fill('0');assert.equal(await modal().locator('[data-cash-choice]').getAttribute('required'),null);await modal().locator('[name=bonus_percent]').fill('5');assert.equal(await modal().locator('[data-cash-choice]').getAttribute('required'),'');page.once('dialog',d=>d.accept());await modal().locator('[data-trade=close]').click();
 await page.setViewportSize({width:1440,height:1000});await staff.payroll(page).click();await staff.nativeEmployee(page,fixture.employee,'Працівник тесту');const payroll=modal().locator('#tradePayrollShifts');await loaded(payroll);assert.match(await payroll.locator('[data-shift-status]').innerText(),/із 520/);
 const first=payroll.locator('[data-payroll-id]').first(),firstID=await first.getAttribute('data-payroll-id');await first.check();await payroll.locator('[data-shift-page=next]').click();await loaded(payroll);await payroll.locator('[data-payroll-id]').first().check();assert.equal(await payroll.locator('[data-payroll-count]').innerText(),'Вибрано: 2');await payroll.locator('[data-payroll-selected]').click();await loaded(payroll);assert.equal(await payroll.locator('[data-payroll-id]:checked').count(),2);assert.equal(await payroll.locator(`[data-payroll-id="${firstID}"]`).isChecked(),true);
 // A late page response cannot refill the list after the employee is cleared.
 let release;const gate=new Promise(resolve=>release=resolve);await page.route('**/api/erp/work-shifts?*',async route=>{await gate;await route.continue();});await payroll.locator('[data-payroll-selected]').click();
 // Deliberate native ID-change stress: required ComboBox has no public Clear action.
 await modal().locator('[name=employee]').selectOption('',{force:true});release();await loaded(payroll);assert.equal(await payroll.locator('[data-payroll-id]').count(),0);assert.equal(await payroll.locator('[data-payroll-count]').innerText(),'Вибрано: 0');await page.unroute('**/api/erp/work-shifts?*');page.once('dialog',d=>d.accept());await modal().locator('[data-trade=close]').click();
 console.log('PASS:130cash/520work history, old active cash, old attendance lookup, selected cash across pages, 320–1440px, payroll multi-page selection and stale response guard.');
};
