/* Synthetic coordinator proof: no database, server, browser or business writes. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const window=new EventTarget(),document=new EventTarget();document.visibilityState='visible';
vm.runInNewContext(fs.readFileSync('app/trading-freshness.js','utf8'),{window,document,fetch:()=>{throw Error('No global transport');},location:{assign:()=>{throw Error('No global redirect');}},setInterval:()=>0,Event,AbortController,URLSearchParams,Date,console});
const {create,decode,validator}=window.TradingFreshness;
const tag=n=>'"tsukenya-trading-v1-'+String(n).repeat(64)+'"';
const value=(n=1,resource='stock',store=1)=>({contract:'trading-versions-v1',identity:{role:'manager',scopeStore:1,store,session:'a'.repeat(64)},day:'2026-10-05',versions:{[resource]:String(n).repeat(64)}});
const reply=(status,data,etag)=>({status,ok:status===200,headers:{get:()=>etag||null},json:async()=>structuredClone(data)});
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function setup(){const queue=[],calls=[],notices=[],invalid=[],ctx={store:1,resources:['stock']};let stamp=0,blocked=false,visible=true,reads=0,denied=0;
 const reg={name:'stock',identity:{role:'manager',scopeStore:1},context:()=>ctx,readStamp:()=>stamp,blocked:()=>blocked,refresh:async()=>{reads++;stamp++;return true;},deny:()=>denied++};
 const c=create({visible:()=>visible,transport:async(url,options)=>{calls.push({url,...options});assert(queue.length,'explicit response fixture');const next=queue.shift();return typeof next==='function'?next():next;},notice:(job,text,retry)=>notices.push({text,retry}),invalidated:status=>invalid.push(status)});
 return {queue,calls,notices,invalid,ctx,reg,c,setBlocked:v=>blocked=v,setVisible:v=>visible=v,bump:()=>stamp++,get reads(){return reads;},get denied(){return denied;}};
}
(async()=>{
 assert.equal(validator('W/'+tag(1).slice(0,-1)+'-gzip"'),'1'.repeat(64));
 assert.equal(validator('"tsukenya-portal-v2-'+ '1'.repeat(64)+'"'),null);
 const schema=JSON.parse(fs.readFileSync('contracts/trading-freshness.openapi.json'));
 assert.deepEqual(Object.keys(schema.components.schemas.TradingIdentity.properties),['role','scopeStore','store','session']);
 for(const patch of [{contract:'portal-metadata-v2'},{products:[]},{day:'2026-99-99'},{identity:{...value().identity,store:2}},{versions:{stock:'a'.repeat(64),private:'b'.repeat(64)}}])assert.throws(()=>decode({...value(),...patch},{store:1,resources:['stock']}));
 const r=setup();r.queue.push(reply(200,value(),tag(1)));const leave=r.c.register(r.reg);await tick();assert.equal(r.reads,1);
 r.queue.push(reply(304,null,tag(1)));await r.c.poll();assert.equal(r.reads,1);assert.equal(r.calls.at(-1).headers['If-None-Match'],tag(1));
 const raw={minimum:'invalid,raw',key:'frozen-first-key',body:{amount:'invalid'}};
 r.setBlocked(true);r.queue.push(reply(200,value(2),tag(2)));await r.c.poll();assert.equal(r.reads,1);assert(r.notices.at(-1).text);assert.equal(raw.minimum,'invalid,raw');
 r.queue.push(reply(304,null,tag(2)));r.setBlocked(false);await r.c.poll(true);assert.equal(r.reads,2);assert.equal(raw.key,'frozen-first-key');assert.equal(r.calls.filter(c=>c.method && c.method!=='GET').length,0);
 // Older issued 401 after a confirmed local reader generation is not authority.
 const late=deferred();r.queue.push(()=>late.promise);const polling=r.c.poll();await tick();r.bump();late.resolve(reply(401));await polling;assert.deepEqual(r.invalid,[]);assert.equal(r.denied,0);
 r.queue.push(reply(200,value(3),tag(3)));await r.c.poll();assert.equal(r.reads,3);assert.equal(r.calls.at(-1).headers['If-None-Match'],undefined);
 // Route/context/hidden cancellation cannot hide another reader or late-redirect.
 const old=deferred();r.queue.push(()=>old.promise);const pending=r.c.poll();await tick();leave();old.resolve(reply(403));await pending;assert.deepEqual(r.invalid,[]);
 const q=setup();q.queue.push(reply(200,value(),tag(1)));q.c.register(q.reg);await tick();q.setVisible(false);await q.c.poll();assert.equal(q.calls.length,1);
 q.setVisible(true);q.queue.push(reply(200,{...value(2),contract:'wrong'},tag(2)));await q.c.poll();assert.equal(q.reads,1);assert(q.notices.at(-1).retry);
 q.queue.push(reply(304,null,tag(1)));await q.c.poll();assert.equal(q.reads,1);
 q.queue.push(reply(403));await q.c.poll();assert.equal(q.denied,1);assert.deepEqual(q.invalid,[403]);
 const session=setup();session.queue.push(reply(200,value(),tag(1)));session.c.register(session.reg);await tick();session.queue.push(reply(401));await session.c.poll();assert.deepEqual(session.invalid,[401]);assert.equal(session.denied,1);
 // A commit between version selection and current read must be checked again;
 // a captured older conditional reply never satisfies the newer current read.
 const barrier=setup(),read=deferred();barrier.reg.refresh=async()=>{barrier.bump();await read.promise;return true;};barrier.queue.push(reply(200,value(),tag(1)));barrier.c.register(barrier.reg);await tick();read.resolve();await tick();
 let latest=0;barrier.reg.refresh=async()=>{barrier.bump();latest++;return true;};barrier.queue.push(reply(200,value(2),tag(2)));await barrier.c.poll();assert.equal(latest,1);
 barrier.queue.push(reply(304,null,tag(2)));await barrier.c.poll();assert.equal(latest,1);
 // Revalidation rejected after an independent newer read is obsolete as well.
 const racing=setup();racing.queue.push(reply(200,value(),tag(1)));racing.c.register(racing.reg);await tick();const auth=deferred();racing.reg.revalidate=()=>auth.promise;racing.queue.push(reply(200,value(2),tag(2)));const race=racing.c.poll();await tick();racing.bump();auth.reject({status:403});await race;assert.deepEqual(racing.invalid,[]);
 console.log('TRADING FRESHNESS PASS: scoped strict304, dirty/unknown hold, current/obsolete401403, hidden/leave fences, confirmed-read barrier, GET-only retry');
})().catch(error=>{console.error(error);process.exitCode=1;});
