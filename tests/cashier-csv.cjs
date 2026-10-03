/* The report's exact export adapter and shared CSV writer; no browser or DB. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app/erp.js'),'utf8');
const helper=source.split('\n').find(line=>line.startsWith('function cashierExport(report)'));
assert(helper,'cashier export uses a dedicated testable adapter');
const csv=require('../app/csv.js');
const row={name:'=Синтетичний касир',shifts:0,hours:'0.0',revenue:'0.00',revenue_per_hour:null,with_difference:0,shortage:'0.00',surplus:'0.00',net:'0.00'};
for(const late of [undefined,'20.07']){
 const report={cashiers:[{...row,...(late===undefined?{}:{late_return_bonus:late})}]};
 const exported=vm.runInNewContext(helper+';cashierExport(report)',{report});
 assert.equal(exported.headers.length,late===undefined?9:10);
 assert.equal(exported.rows[0].length,exported.headers.length);
 assert.equal(exported.rows[0][4],'','missing hourly rate stays empty');
 if(late!==undefined)assert.equal(exported.rows[0][9],late,'already accrued bonus is preserved without JS arithmetic');
 const bytes=csv.serialize(exported.headers.map((label,i)=>({label,kind:exported.numeric.includes(i)?'number':'text'})),exported.rows);
 assert(bytes.includes('\t=Синтетичний касир'),'names retain shared formula-injection protection');
 if(late!==undefined)assert(bytes.includes('20.07'),'CSV includes late-return bonus in kopecks');
 else assert(!bytes.includes('Бонус із повернених'),'roles without salary fields do not receive a bonus column');
}
assert(source.includes("button('CSV по касирах','cashiers-csv')"));
assert(source.includes("if(a==='cashiers-csv'){const csv=cashierExport(lastReport);download("));
console.log('CASHIER CSV PASS: salary-visible and salary-hidden columns, exact cents, empty hourly rate and safe names');
