/* Stable native create keys: isolated VM, no network/database. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../server/runtime.js'),'utf8');
const state={contract:'portal-metadata-v2',scopeStore:null,networkOwner:true,labelRevision:'label',role:'owner',csrf:'isolated',data:{'settings/main':{},'project/state':{}}};
const response=(status,value)=>({status,ok:status>=200&&status<300,json:async()=>structuredClone(value)});
const window=new EventTarget(),queue=[],calls=[];window.PortalApi=require('../app/portal-api.js');let keys=0;
vm.runInNewContext(source,{window,document:{hidden:false},location:{href:'/'},Event,CustomEvent,structuredClone,
 crypto:{randomUUID:()=>`isolated-create-key-${++keys}`},setInterval(){},setTimeout,Blob,URL,
 fetch:async(url,options={})=>{calls.push({url,...options});assert(queue.length,'specify response for '+url);const next=queue.shift();if(next instanceof Error)throw next;return next;} });
function ack(collection,createKey,data,id){if(collection==='expenses')data={...data,amount:String(data.amount)};return {ok:true,id,collection,createKey,original:{collection,id,revision:'a'.repeat(32),data,permissions:{canEdit:true,canDelete:true},managed:false,initiative:null}};}
(async()=>{
 queue.push(response(200,state));const db=await window.claude.use('db');
 for(const collection of ['tasks','ideas','expenses']){
   const payload=collection==='expenses'?{name:'Початковий зміст',group:'fixed',amount:0,order:123}:{title:'Початковий зміст',order:123};
   queue.push(new Error('Lost response'));
   await assert.rejects(db.collection(collection).add(payload),/Lost/);
   const first=calls.at(-1);payload[collection==='expenses'?'name':'title']='Новий зміст';payload.order=456;
   queue.push(response(200,ack(collection,first.headers['Idempotency-Key'],JSON.parse(first.body),'confirmed')),response(200,state));
   const saved=await db.collection(collection).add(payload);
   assert.equal(saved.id,'confirmed');const retry=calls.at(-2);
   assert.equal(retry.headers['Idempotency-Key'],first.headers['Idempotency-Key']);
   assert.equal(retry.body,first.body,'default add freezes payload while acknowledgement is uncertain');
 }
 const payload={title:'Ідея',order:789},key='explicit-draft-create-key';
 queue.push(response(200,{unexpected:'Malformed acknowledgement'}));
 await assert.rejects(db.collection('ideas').add(payload,{createKey:key}),/Unconfirmed/);
 assert.equal(calls.at(-1).headers['Idempotency-Key'],key);
 queue.push(response(200,ack('ideas',key,payload,'same-id')),response(200,state));
 await db.collection('ideas').add(structuredClone(payload),{createKey:key});
 assert.equal(calls.at(-2).headers['Idempotency-Key'],key,'human retry with a new JS object uses the explicit draft key');
 for(const code of ['create_changed','create_deleted','create_payload_conflict']){
   queue.push(response(409,{error:'Запис уже змінено або видалено.',code}));
   await assert.rejects(db.collection('tasks').add({title:'Задача'},{createKey:key}),e=>e.status===409&&e.code===code&&e.serverMessage==='Запис уже змінено або видалено.');
 }
 assert.equal(queue.length,0);console.log('PASS: tasks/ideas/expenses lost-response repeat keeps key and immutable payload; malformed acknowledgement, explicit human retry and safe changed/deleted conflict codes.');
})().catch(error=>{console.error(error);process.exitCode=1;});
