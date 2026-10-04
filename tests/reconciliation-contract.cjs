const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const window={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/reconciliation.js'),'utf8'),{window});
const api=window.TradeReconciliation;
const run={id:'61f5b6a1-f80c-4ae2-b414-38cda35292bf',source:'manual',status:'clean',checksVersion:1,startedAt:'2026-10-04T10:00:00+00:00',finishedAt:'2026-10-04T10:01:00+00:00',recordedAt:'2026-10-04T10:01:01+00:00',issues:0,reportHash:'a'.repeat(64),errorCode:null,summary:{issues:0,counts:{lots:1,vouchers:2,stock_entries:3,cash_entries:4},checks:{closed_period:{title:'Закриті періоди',issues_count:0}},coverage:{closed_through:null,protected_drafts:1,unknown_operations:2,known_operations:3,invalid_period_events:0}}};
assert.equal(api.decodeRun(run),run);assert.equal(api.decodeRuns({items:[run],page:1,pages:1,total:1}).items[0],run);
for(const mutate of [v=>delete v.summary.coverage,v=>v.issues=1,v=>v.summary.counts.vouchers='2',v=>v.finishedAt='bad',v=>v.reportHash='short',v=>v.errorCode='private',v=>v.summary.coverage.protected_drafts=-1]){const v=structuredClone(run);mutate(v);assert.throws(()=>api.decodeRun(v));}
assert.throws(()=>api.decodeRuns({items:[],page:1,pages:1,total:1}));
assert.throws(()=>api.decodeFindings({items:[{ordinal:1,check:'lot_balance',subject:'stocklot/1',message:'Партія',expected:1,actual:'2.00'}],total:1,page:1,pages:1}));
const failed={...run,status:'failed',errorCode:'snapshot_failed',summary:{checks:{},counts:{},issues:0,error:'snapshot_failed'}};assert.equal(api.decodeRun(failed),failed);
console.log('reconciliation DTO contract PASS: complete results, failed coverage, malformed/stale pages rejected');
