/* Conditional reads and confirmed-write barrier; synthetic VM, no network/DB. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const domains=['products','references','tasks','ideas','expenses','settings/main','project/state'];
function body(n=1){return {contract:'portal-metadata-v1',networkOwner:false,data:{tasks:[{id:'t',data:{title:'T'+n},permissions:{canEdit:true,canDelete:true}}],ideas:[],expenses:[],'settings/main':{},'project/state':{}},role:'manager',csrf:'csrf',labelRevision:'label',stateVersions:Object.fromEntries(domains.map(d=>[d,(d==='tasks'?String(n):'a').repeat(64)]))};}
const tag=n=>'"tsukenya-portal-v1-'+String(n).repeat(64)+'"';
function reply(status,value,etag){return {status,ok:status===200,headers:{get:()=>etag||null},json:async()=>structuredClone(value)}};
function setup(){const window=new EventTarget();window.PortalApi=require('../app/portal-api.js');const queue=[],calls=[],intervals=[],events=[],notices=[];
window.addEventListener('tsukenya:data-changed',e=>events.push(e.detail));window.addEventListener('tsukenya:refresh-failed',e=>notices.push(e.detail));
vm.runInNewContext(fs.readFileSync('server/runtime.js','utf8'),{window,location:{href:'/'},document:{hidden:false},Event,CustomEvent,structuredClone,crypto:{randomUUID:()=> 'fake-create-key'},setInterval:fn=>intervals.push(fn),setTimeout,Blob,URL,
fetch:async(url,options)=>{calls.push({url,...options});assert(queue.length,'specified request');const next=queue.shift();return typeof next==='function'?next():next}});
return {window,queue,calls,events,intervals,notices};}
(async()=>{
 const r=setup();r.queue.push(reply(200,body(),tag(1)));const db=await r.window.claude.use('db');let notices=0,productNotices=0,latest;
 db.collection('tasks').onSnapshot(s=>{notices++;latest=s});assert.throws(()=>db.collection('products').onSnapshot(()=>productNotices++),/unavailable/);
 r.queue.push(reply(304,null,tag(1)));await r.window.TSUKENYA_REFRESH();assert.equal(r.calls.at(-1).headers['If-None-Match'],tag(1));assert.equal(notices,1);assert.equal(productNotices,0);assert.equal(r.events.length,1);
 r.queue.push(reply(200,body(2),tag(2)));await r.window.TSUKENYA_REFRESH();assert.equal(notices,2);assert.equal(productNotices,0);assert.deepEqual(Array.from(r.events.at(-1).domains),['tasks']);assert.equal(latest.docs[0].data().title,'T2');
 // Malformed 200 never replaces cached validator, permissions or dirty local state.
 const draft={title:'unsaved'},bad=body(3);bad.stateVersions.tasks={};r.queue.push(reply(200,bad,tag(3)));await assert.rejects(r.window.TSUKENYA_REFRESH(),/Invalid database/);assert.equal(latest.docs[0].data().title,'T2');assert.equal(draft.title,'unsaved');
 r.queue.push(reply(304,null,tag(2)));await r.window.TSUKENYA_REFRESH();assert.equal(r.calls.at(-1).headers['If-None-Match'],tag(2));
 // An older in-flight poll cannot satisfy the read after a confirmed write.
 let release;r.queue.push(()=>new Promise(resolve=>release=()=>resolve(reply(304,null,tag(2)))));r.intervals[0]();await Promise.resolve();
 r.queue.push(reply(200,{ok:true}),reply(200,body(3),tag(3)));const write=db.doc('tasks/t').update({title:'T3'});await Promise.resolve();await Promise.resolve();release();await write;
 assert.equal(latest.docs[0].data().title,'T3');assert.equal(r.calls.filter(c=>c.method==='PATCH').length,1);assert.deepEqual(r.calls.slice(-3).map(c=>c.method||'GET'),['GET','PATCH','GET']);
 // Confirmed unrelated write followed by 304 is success; GET failure retry never repeats write.
 r.queue.push(reply(200,{ok:true}),reply(503,null));await db.doc('tasks/t').update({title:'T4'});r.queue.push(reply(304,null,tag(3)));await r.window.TSUKENYA_REFRESH();assert.equal(r.calls.filter(c=>c.method==='PATCH').length,2);
 r.queue.push(reply(304,null,tag(4)));await assert.rejects(r.window.TSUKENYA_REFRESH(),/Invalid database validator/);
 const empty=setup();empty.queue.push(reply(304,null,tag(1)));await assert.rejects(empty.window.claude.use('db'),/Invalid database validator/);
 console.log('RUNTIME CONDITIONAL PASS: 304, scoped notifications, malformed validator, cached permissions, GET retry and confirmed-write barrier');
})().catch(error=>{console.error(error);process.exitCode=1});
