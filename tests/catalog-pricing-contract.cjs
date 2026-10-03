/* Reject corrupted review/confirmation before enabling writes or clearing pending state. */
const assert=require('node:assert/strict'),{decode}=require('../app/catalog-pricing.js');
const payload={kind:'markup',idempotencyKey:'e6d179ac-b8d8-4125-a3c2-24917d258318'},summary={candidates:1,changedPrices:1,changedRecords:1,skippedManual:0,errors:0},settings={before:{defaultMarkup:'30',rounding:'0.5'},after:{defaultMarkup:'40',rounding:'0.5'}};
const preview={kind:'markup',valid:true,snapshot:'a'.repeat(64),summary,settings,entries:[{id:'one',name:'Товар',hidden:false,action:'update',before:{regularPrice:'13.50',salePrice:'13.50'},after:{regularPrice:'14.50',salePrice:'14.50'}}]};
const commit={kind:'markup',ok:true,idempotencyKey:payload.idempotencyKey,summary,settings,entries:[{id:'one',action:'update',revision:'b'.repeat(64)}]};
assert.equal(decode(preview,'preview',payload),preview);assert.equal(decode(commit,'commit',payload),commit);
const clone=value=>JSON.parse(JSON.stringify(value));
for(const [stage,change] of [['preview',v=>v.valid='true'],['preview',v=>v.entries[0].after.salePrice=NaN],['preview',v=>v.entries[0].hidden=undefined],['preview',v=>v.entries[0].action='created'],['preview',v=>v.entries[0].before=null],['preview',v=>v.snapshot='wrong'],['preview',v=>v.entries.push(clone(v.entries[0]))],['preview',v=>v.entries[0].action='error'],['preview',v=>v.summary.errors=1],['commit',v=>v.ok=false],['commit',v=>v.idempotencyKey='another'],['commit',v=>v.entries[0].revision=undefined],['commit',v=>v.summary.changedPrices=-1],['commit',v=>v.settings.after.rounding=1]]){const candidate=clone(stage==='preview'?preview:commit);change(candidate);assert.throws(()=>decode(candidate,stage,payload),/некоректний результат/);}
for(const data of [undefined,null,{},[],{...preview,kind:'rounding'}])assert.throws(()=>decode(data,'preview',payload));
console.log('PASS: strict price preview/commit decoder; malformed or contradictory results cannot confirm writes.');
