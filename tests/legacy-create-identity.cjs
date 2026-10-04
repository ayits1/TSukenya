/* Read-only receipt boundary and ACK binding; no network or database. */
const assert=require('node:assert/strict'),api=require('../app/portal-api.js');
const key='isolated-identity-key',collection='tasks',record={collection,id:'first',revision:'a'.repeat(32),data:{title:'Початкова',scope:'operations',status:'todo',order:123},permissions:{canEdit:true,canDelete:true},managed:false,initiative:null};
const receipt={collection,createKey:key,confirmed:true,id:'first',state:'unchanged',original:record,current:record};
assert.equal(api.decodeCreateIdentity(receipt,collection,key),receipt);
for(const state of ['changed','deleted'])assert.equal(api.decodeCreateIdentity({...receipt,state,current:state==='deleted'?null:record},collection,key).state,state);
assert.equal(api.decodeCreateIdentity({...receipt,original:null},collection,key).original,null);
assert.equal(api.decodeCreateIdentity({collection,createKey:key,confirmed:false},collection,key).confirmed,false);
for(const bad of [{...receipt,createKey:'other'},{...receipt,collection:'ideas'},{...receipt,state:['changed']},{...receipt,current:null},{...receipt,current:{...record,id:'other'}},{...receipt,original:{...record,revision:[record.revision]}},{...receipt,original:{...record,data:{title:'',store:1}}},{...receipt,current:{...record,data:{...record.data,dueDate:'2026-02-30'}}},{...receipt,current:{...record,data:{...record.data,password:{nested:'private'}}}},{collection,createKey:key,confirmed:false,id:'inferred'}])assert.throws(()=>api.decodeCreateIdentity(bad,collection,key));
const ack={ok:true,collection,createKey:key,id:'first',original:record},payload=structuredClone(record.data);
assert.equal(api.decodeCreateAcknowledgement(ack,collection,key,payload),ack);
for(const bad of [{...ack,createKey:'other'},{...ack,original:null},{...ack,original:{...record,data:{...record.data,title:'Інший зміст'}}},{...ack,id:'other'}])assert.throws(()=>api.decodeCreateAcknowledgement(bad,collection,key,payload));
const expense={collection:'expenses',id:'e1',revision:'a'.repeat(32),data:{name:'Оренда',group:'fixed',amount:'10.00'},permissions:{canEdit:true,canDelete:true},managed:false,initiative:null};
api.decodeCreateAcknowledgement({ok:true,collection:'expenses',createKey:key,id:'e1',original:expense},'expenses',key,{name:' Оренда ',group:'fixed',amount:10});
assert.throws(()=>api.decodeCreateIdentity({collection:'expenses',createKey:key,confirmed:true,id:'e1',state:'unchanged',original:expense,current:{...expense,data:{...expense.data,category:'unknown'}}},'expenses',key));
for(const amount of ['10.001','999999999.99',10])assert.throws(()=>api.decodeCreateAcknowledgement({ok:true,collection:'expenses',createKey:key,id:'e1',original:{...expense,data:{...expense.data,amount}}},'expenses',key,{name:'Оренда',group:'fixed',amount:10}));
console.log('PASS: legacy receipt states, resource/key/id/semantic DTO, absent/historical nullable snapshot and normalized exact ACK binding.');
