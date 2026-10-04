/* Budget decimal display/ACK contract only; no browser, network, DB, or postings. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const window={addEventListener(){}};
// Expose private pure functions in the VM fixture, never in the served module.
const source=fs.readFileSync(path.join(__dirname,'../app/monthly-budget.js'),'utf8').replace('window.MonthlyBudgets={shell,mount,canLeave};','window.MonthlyBudgets={normalizedDecimal,decimalEqual,money,decode};');
vm.runInNewContext(source,{window,Intl,Date,URLSearchParams,Number,BigInt,Object,Set,Map},{filename:'monthly-budget.js'});
const {normalizedDecimal,decimalEqual,money,decode}=window.MonthlyBudgets;
const compact=v=>v.replace(/[\s\u00a0\u202f]/g,'');
assert.equal(compact(money('99999999999999.99')),'99999999999999,99','aggregate kopecks are exact');
assert.equal(compact(money('99999999999999.98')),'99999999999999,98');
assert.equal(compact(money('-99999999999999.99')),'-99999999999999,99');
assert.equal(money('-0.01'),'-0,01');assert.equal(money('-0.00'),'0,00');assert.equal(money('100'),'100,00');assert.equal(money('100.0000'),'100,00');assert.equal(money('1e2'),'100,00');
assert.equal(decimalEqual('99999999999999.99','99999999999999.98'),false);
assert.equal(decimalEqual('100','100.00'),true);assert.equal(decimalEqual('1e2','100.00'),true);assert.equal(decimalEqual('1.234e2','123.40'),true);assert.equal(decimalEqual('100.0000','100.00'),true);assert.equal(decimalEqual('100,00','100.00'),true);
assert.equal(decimalEqual('1.234','1.2340',3),true);assert.equal(decimalEqual('1234e-3','1.234',3),true);assert.equal(decimalEqual('1.234','1.235',3),false);assert.equal(normalizedDecimal('1.2341',3),null);assert.equal(normalizedDecimal('NaN'),null);assert.equal(normalizedDecimal('Infinity'),null);assert.equal(decimalEqual('bad','also bad'),false);assert.equal(normalizedDecimal(true),null);
const id='11111111-1111-4111-8111-111111111111',lineID='22222222-2222-4222-8222-222222222222',category='33333333-3333-4333-8333-333333333333';
const request={month:'2026-10',store:null,planned_revenue:'1e2',idempotency_key:'synthetic',lines:[{id:lineID,category,mode:'fixed_amount',amount:'100.0000',rate:'0',base:'revenue'}]};
const result={id,revision:1,month:request.month,store:null,planned_revenue:'100.00',lines:[{...request.lines[0],category_name:'Оренда',amount:'100.00',rate:'0.000'}]};
assert.equal(decode('monthly-budgets','POST',request,result),result);
// This comparison fixture checks normalization, not an expansion of the server input limit.
const largeRequest={...request,planned_revenue:'99999999999999.99',lines:[{...request.lines[0],amount:'99999999999999.99'}]};
const largeResult={...result,planned_revenue:'99999999999999.99',lines:[{...result.lines[0],amount:'99999999999999.99'}]};
assert.equal(decode('monthly-budgets','POST',largeRequest,largeResult),largeResult);
assert.throws(()=>decode('monthly-budgets','POST',largeRequest,{...largeResult,planned_revenue:'99999999999999.98'}),/невідповідні/);
assert.throws(()=>decode('monthly-budgets','POST',largeRequest,{...largeResult,lines:[{...largeResult.lines[0],amount:'99999999999999.98'}]}),/невідповідні/);
const rateRequest={...request,lines:[{...request.lines[0],mode:'revenue_rate',amount:'0',rate:'1234e-3'}]},rateResult={...result,lines:[{...result.lines[0],mode:'revenue_rate',amount:'0.00',rate:'1.234'}]};
assert.equal(decode('monthly-budgets','POST',rateRequest,rateResult),rateResult);
assert.throws(()=>decode('monthly-budgets','POST',rateRequest,{...rateResult,lines:[{...rateResult.lines[0],rate:'1.235'}]}),/невідповідні/);
const zeroRequest={...request,planned_revenue:'-0',lines:[{...request.lines[0],amount:'-0.0000',rate:'-0'}]},zeroResult={...result,planned_revenue:'-0.00',lines:[{...result.lines[0],amount:'-0.00',rate:'-0.000'}]};assert.equal(decode('monthly-budgets','POST',zeroRequest,zeroResult),zeroResult);
console.log('B16 DECIMAL CONTRACT PASS: exact large aggregate .98/.99 display and ACK, negative fact/kopecks,100 vs100.00, scientific/zero spelling, rate3');
