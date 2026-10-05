/* Transport lifetime checks; lifecycle/pinning/reload are covered by actual managed UI scopes. */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const actor={draftOwner:'a',draftSession:'b',role:'owner',storeId:null,networkOwner:true,csrf:'test'},body={action:'accept',revision:'c'.repeat(32),idempotencyKey:'11111111-1111-4111-8111-111111111111'};
let session=async()=>actor,fetcher,live=true,rechecks=0,revokes=0;
const window={addEventListener:()=>{},dispatchEvent:()=>revokes++,PortalApi:{session:(...args)=>session(...args)},NativeDraftRecovery:{controller:{check:async()=>rechecks++}}};
const source=fs.readFileSync('app/managed-alerts.js','utf8').replace('window.ManagedAlerts = {','window.ManagedAlertProbe = {request}; window.ManagedAlerts = {');
vm.runInNewContext(source,{window,DOMException,Event,fetch:(...args)=>fetcher(...args)});
const request=()=>window.ManagedAlertProbe.request('/api/erp/alerts/tasks/auto_'+ 'a'.repeat(32)+'/actions','POST',body,actor,undefined,()=>live);
(async()=>{
 let release,posts=0;session=()=>new Promise(r=>release=r);fetcher=async()=>{posts++;};const pending=request();live=false;release(actor);await assert.rejects(pending,{name:'AbortError'});assert.equal(posts,0,'closed preflight must not POST');
 live=true;session=async()=>actor;fetcher=async()=>({status:200,ok:true,json:()=>new Promise(r=>release=r)});const late=request();await new Promise(r=>setImmediate(r));live=false;release({ok:true});await assert.rejects(late,{name:'AbortError'});
 live=true;fetcher=()=>new Promise(r=>release=r);const late401=request();await new Promise(r=>setImmediate(r));live=false;release({status:401,ok:false,json:async()=>({})});await assert.rejects(late401,{name:'AbortError'});assert.equal(revokes,0,'obsolete401 cannot revoke');
 live=true;fetcher=async()=>({status:401,ok:false,json:async()=>{throw Error('bad JSON');}});await assert.rejects(request(),{status:401});assert.equal(revokes,1,'current401 revokes even malformed JSON');
 session=async()=>({...actor,storeId:2});await assert.rejects(request(),{name:'AbortError'});assert.equal(rechecks,1,'session mismatch requires current P0 check');
 session=async()=>actor;const sent=[];fetcher=async(_,opts)=>{sent.push(JSON.parse(opts.body));throw Error('offline');};await assert.rejects(request(),/Відповідь не отримано/);fetcher=async(_,opts)=>{sent.push(JSON.parse(opts.body));return {status:409,ok:false,json:async()=>({error:'later409'})};};await assert.rejects(request(),/later409/);assert.deepEqual(sent[0],sent[1]);assert.deepEqual(sent[0],body);
 const notices=[];window.ManagedAlerts.configure({lookup:()=>({_alertKey:'stock'}),tasks:()=>[],toast:s=>notices.push(s)});await window.ManagedAlerts.handle({dataset:{alertId:'auto_'+'a'.repeat(32),alertAction:'accept'}});assert.equal(notices.length,1,'unavailable persistence is a visible refusal, not an unhandled action');
 console.log('MANAGED TRANSPORT PASS: final-session/JSON lifetime, current vs obsolete401, scope mismatch, unknown/later409 exact body');
})().catch(e=>{console.error(e);process.exitCode=1;});
