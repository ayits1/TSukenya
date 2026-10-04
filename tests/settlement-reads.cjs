/* Actual native settlement decoder: no browser, network or business writes. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const window={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/settlement-reads.js'),'utf8'),{window});
const expected={party:4,store:2,from:'2026-10-01',to:'2026-10-05'},policy={role:'owner',store:null};
const statement={contract:'trading-settlement-statement-v1',policy,query:{...expected},party:4,party_name:'Постачальник',direction:'supplier',from:expected.from,to:expected.to,basis:'accounting_dates',items:[{voucher:3,number:'000003',kind:'receipt',date:'2026-10-03',store:2,amount:'-1999999999998.00',balance:'-1999999999998.00',reversal:false}],total:1,page:1,pages:1,opening_balance:'0.00',closing_balance:'-1999999999998.00',debit:'0.00',credit:'1999999999998.00',debt_total:'1999999999998.00',advance_total:'0.00',age:{no_due:'1999999999998.00',not_due:'0.00','1_30':'0.00','31_60':'0.00','61_90':'0.00',over_90:'0.00'},reconciliation:{net_documents_and_advances:'-1999999999998.00',matches:true}};
assert.equal(window.SettlementReads.decodeStatement(statement,expected,policy),statement);
for(const mutate of [v=>v.policy.role=['owner'],v=>v.policy.store=1,v=>v.query.party=99,v=>v.items[0].store=1,v=>v.total=31,v=>v.pages=2,v=>v.items=[],v=>v.items[0].date='2026-02-30',v=>v.items[0].balance=10,v=>v.age.no_due='NaN',v=>v.allocations=[],v=>{v.items.push({...v.items[0]});v.total=2;}]){
 const v=structuredClone(statement);mutate(v);assert.throws(()=>window.SettlementReads.decodeStatement(v,expected,policy));
}
const payment={voucher:2,number:'000002',store:2,party:'Постачальник',due_date:'2026-10-05',amount:'100.00'};
const summary={today:'2026-10-05',days:14,overdue:{to_us:{amount:'0.00',count:0},by_us:{amount:'10.00',count:1}},payments:[...Array(5)].map((_,i)=>({...payment,voucher:i+2,number:String(i+2).padStart(6,'0')})),payments_count:65,payments_total:'6500.00'};
assert.equal(window.SettlementReads.decodeSummary(summary),summary);
for(const mutate of [v=>v.payments_count=4,v=>v.payments.push(payment),v=>v.payments_total=6500,v=>v.payments[1]=v.payments[0],v=>v.overdue.by_us.count=-1]){const v=structuredClone(summary);mutate(v);assert.throws(()=>window.SettlementReads.decodeSummary(v));}
// The migrated consumers really use the decoder, the versioned endpoint and total count.
const ui=fs.readFileSync(path.join(__dirname,'../app/erp-payments.js'),'utf8'),portal=fs.readFileSync(path.join(__dirname,'../app/portal.js'),'utf8');
assert(ui.includes('../v1/trading/settlements/statement?'));assert(ui.includes('SettlementReads.decodeStatement'));assert(!ui.includes('party-statement?'));
assert(portal.includes('SettlementReads.decodeSummary'));assert(portal.includes('rest=d.payments_count-shown.length'));
console.log('PASS: bounded native statement/summary decoding, exact decimals, query/policy scope, malformed payload refusal and actual consumer wiring.');
