/* Strict native report protocol; no DB or browser required. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const window={};vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../app/erp-reports.js'),'utf8'),{window,Intl,BigInt,Date,Number,Object,Array,RegExp,Error,String});
const api=window.TradeReports,money=['revenue','cogs','expenses','payroll','writeoffs','inventory_adjustment','supplier_return_variance','cash_difference','cash_net','gross_profit','profit','unallocated_expenses'];
const base={contract:'trading-reports-v1',mode:'period',store:null,scope_name:'Мережа',generated_at:'2026-10-04T10:00:00+03:00',basis:'accounting_dates',reversal_policy:'kyiv_reversed_at',snapshot:'current',snapshot_notice:'Поточне читання',can_view_payroll:false,counts:{products:1,by_store:1,expenses_by_category:0,cashiers:1},from:'2026-10-01',to:'2026-10-04',cashiers_basis:'current_posted_closed_shifts',debts_basis:'current',...Object.fromEntries(money.map(x=>[x,'0.00']))};
const expected={mode:'period',store:'',from:base.from,to:base.to,section:'products'};
const row={product:'p',name:'<img onerror=alert(1)>',unit:'шт',quantity:'1.000',revenue:'100.00',cogs:'5.00',writeoff_quantity:'0.000',writeoff:'0.00',inventory:'0.00',gross_profit:'95.00',result:'95.00',margin:'95.0'};
const page={contract:base.contract,section:'products',items:[row],total:1,page:1,pages:1,limit:30,q:'',summary:base};
assert.equal(api.decodeSummary(base,expected),base);assert.equal(api.decodePage(page,expected),page);
const copy=x=>JSON.parse(JSON.stringify(x));
for(const mutate of [v=>delete v.contract,v=>v.contract='legacy',v=>v.products=[],v=>v.mode='balances',v=>v.store=2,v=>v.to='2026-02-31',v=>v.counts.products=-1,v=>v.profit=0,v=>v.debts=[]]){const v=copy(base);mutate(v);assert.throws(()=>api.decodeSummary(v,expected));}
for(const mutate of [v=>v.items=[],v=>v.total=65,v=>v.page=0,v=>v.limit=100,v=>v.q='wrong',v=>v.items[0].result='NaN',v=>v.items[0].cost='5',v=>v.summary.counts.products=0]){const v=copy(page);mutate(v);assert.throws(()=>api.decodePage(v,expected));}
const cashiers={...copy(page),section:'cashiers',items:[{employee:null,name:'Касир',shifts:1,with_difference:0,shortage:'0.00',surplus:'0.00',revenue:'10.00',hours:'1.0',revenue_per_hour:'10.00',net:'0.00'}]};
assert(api.decodePage(cashiers,{...expected,section:'cashiers'}));cashiers.items[0].late_return_bonus='1.00';assert.throws(()=>api.decodePage(cashiers,{...expected,section:'cashiers'}));cashiers.summary.can_view_payroll=true;assert(api.decodePage(cashiers,{...expected,section:'cashiers'}));
assert.equal(api.formatMoney('99999999999999.99').replace(/[\s\u00a0\u202f]/g,''),'99999999999999,99');assert.equal(api.formatMoney('-1.01'),'−1,01');assert.equal(api.formatMoney('100.00'),'100,00');
console.log('BOUNDED REPORT CONTRACT PASS: strict mode/scope/count/page/decimal, salary privacy, exact display');
