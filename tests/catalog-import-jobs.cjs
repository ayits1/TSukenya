/* Runtime contract/recovery on synthetic payloads. No application database. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const api=require('../app/catalog-import-jobs.js');
const limits={maxRows:100000,uploadRows:200,workerRows:100,maxEntryBytes:16384,maxTotalBytes:52428800,maxChunkBytes:1048576};
const uuid='00000000-0000-4000-8000-000000000001',hex='a'.repeat(64),stamp='2026-10-04T09:00:00Z';
const row={ordinal:1,line:2,status:'planned',action:'create',id:null,revision:null,currentRevision:null,values:{name:'Кава'},regularPrice:'10.00',salePrice:'10.00',error:null};
const baseRun={id:uuid,mode:'chunked',fileName:'synthetic.csv',expectedRows:1001,uploadedRows:0,inputBytes:0,inputHash:null,sourceHash:hex,defaultMarkup:'30',genericAs:'cost',planRevision:null,status:'uploading',phase:'uploading',progress:{done:0,total:1001},counts:{created:0,updated:0,skipped:0,conflicted:0,failed:0,invalid:0,pending:1001},planned:{create:0,update:0,skip:0},canApply:false,canResume:false,canCancel:true,createdAt:stamp,updatedAt:stamp,startedAt:null,finishedAt:null,error:null,limits};
assert.equal(api.decodeRun({...baseRun,priceContext:{storeId:null,storeName:null}}).priceContext.storeId,null);
for(const priceContext of [{storeId:[],storeName:'X'},{storeId:1,storeName:null},{storeId:null,storeName:'X'}])assert.throws(()=>api.decodeRun({...baseRun,priceContext}));
const create={ok:true,id:uuid,status:'uploading',expectedRows:1001,sourceHash:hex,limits,priceContext:{storeId:1,storeName:'Store'}};assert.throws(()=>api.decodeAck(create,'create',{idempotencyKey:uuid,expectedRows:1001,sourceHash:hex,priceContext:{storeId:2}},null));
const worker={status:'available',lastSeen:stamp,staleAfterSeconds:45};assert.equal(api.decodeWorker(worker).status,'available');
for(const patch of [{status:['available']},{status:'secret'},{lastSeen:'SQL secret'},{lastSeen:null},{staleAfterSeconds:'45'}])assert.throws(()=>api.decodeWorker({...worker,...patch}));
assert.equal(api.decodeRun({...baseRun,worker}).worker.status,'available');
assert.throws(()=>api.decodeRun({...baseRun,worker:{...worker,status:'bad'}}));
assert.equal(api.decodeRun(structuredClone(baseRun)).status,'uploading');assert.equal(api.decodeRow(row).line,2);
assert.equal(api.decodeAck(baseRun,'cancel',{},uuid).id,uuid);for(const kind of ['cancel','resume'])assert.throws(()=>api.decodeAck({...baseRun,id:'00000000-0000-4000-8000-000000000002'},kind,{},uuid));
for(const patch of [{status:['ready']},{counts:{...baseRun.counts,pending:'1001'}},{mode:['chunked']},{sourceHash:'bad'},{genericAs:['cost']},{progress:{done:2,total:1}},{canApply:1},{createdAt:'secret'}])assert.throws(()=>api.decodeRun({...baseRun,...patch}));
for(const patch of [{status:['planned']},{action:['create']},{salePrice:10},{values:null},{ordinal:0},{error:{code:'x',message:null}}])assert.throws(()=>api.decodeRow({...row,...patch}));
assert.throws(()=>api.decodePage({items:Array(31).fill(baseRun),total:31,page:1,pages:2},api.decodeRun,30));
assert.throws(()=>api.chunks([{line:2,values:{name:'x'.repeat(16384)}}]),/16 КіБ/);
const entries=Array.from({length:1001},(_,i)=>({line:i+2,values:{name:'Товар '+i,cost:'10',promotion:false}}));assert.deepEqual(api.chunks(entries).map(c=>c.entries.length),[200,200,200,200,200,1]);
const large=api.chunks(Array.from({length:100},(_,i)=>({line:i+2,values:{name:'x'.repeat(15000)}})));assert(large.every(c=>Buffer.byteLength(JSON.stringify(c))<=1048576));assert.equal(large.flatMap(c=>c.entries).length,100);
function runtime(server){
 const listeners={};const host={innerHTML:'',contains:()=>false,closest:()=>({open:false}),querySelector:()=>({focus(){}})};
 const document={visibilityState:'hidden',activeElement:null,querySelector:s=>s==='#catalogImportJobs'?host:s==='#impFile'?{click(){}}:null,addEventListener:(type,fn)=>{(listeners[type]??=[]).push(fn)}};
 const context=vm.createContext({console,TextEncoder,Uint8Array,AbortController,structuredClone,setTimeout,clearTimeout,crypto:webcrypto,fetch:server,document,window:{confirm:()=>true,addEventListener(){}}});vm.runInContext(fs.readFileSync(require.resolve('../app/catalog-import-jobs.js'),'utf8'),context);return {api:context.window.CatalogImportJobs,click:action=>listeners.click.forEach(fn=>fn({target:{closest:()=>({dataset:{importJob:action},disabled:false})}})),host};
}
const response=data=>({ok:true,status:200,json:async()=>structuredClone(data)});
(async()=>{
 assert.equal(api.canonicalJSON({z:'Кава',a:{'2':'two','10':'ten'}}),'{"a":{"10":"ten","2":"two"},"z":"Кава"}');
 const file={name:'synthetic.csv',arrayBuffer:async()=>Buffer.from('synthetic full file 1001 rows')};let run=null,stored=[],calls=[],lost=new Set(['runs','chunks','seal','apply']);const acknowledgements={};
 const fetch=async(url,options={})=>{
  if(url==='/api/v1/session')return response({csrf:'synthetic-csrf'});
  const path=url.replace('/api/v1/catalog/import/',''),body=options.body?JSON.parse(options.body):null;
  if(options.method!=='POST'){
   if(path.startsWith('history'))return response({items:run?[run]:[],total:run?1:0,page:1,pages:1});
   if(path.includes('/rows'))return response({items:[row],total:1001,page:1,pages:11});
   if(path.includes('/chunks'))return response({items:stored,total:stored.length,page:1,pages:1});
   return response(run);
  }
  calls.push({path,body});const kind=path==='runs'?'runs':path.split('/').at(-1);let ack;
  if(kind==='runs'){run??={...structuredClone(baseRun),id:body.idempotencyKey,sourceHash:body.sourceHash};ack={ok:true,id:run.id,status:'uploading',expectedRows:1001,sourceHash:body.sourceHash,limits};}
  else if(kind==='chunks'){ack=stored.find(r=>r.offset===body.offset);if(!ack){ack={ok:true,id:run.id,offset:body.offset,count:body.entries.length,uploadedRows:body.offset+body.entries.length,chunkHash:await api.chunkHash(body)};stored.push(ack);run.uploadedRows=ack.uploadedRows;}}
  else if(kind==='seal'){run={...run,status:'queued',phase:'indexing',inputHash:hex};ack={ok:true,id:run.id,inputHash:hex,status:'queued',phase:'indexing'};}
  else if(kind==='apply'){run={...run,status:'completed',phase:'finished',canApply:false,counts:{...run.counts,created:1001,pending:0},progress:{done:1001,total:1001}};ack={ok:true,id:run.id,planRevision:body.planRevision,status:'queued',phase:'applying'};}
  acknowledgements[kind]=ack;if(lost.delete(kind))throw Error('Lost ACK');return response(ack);
 };
 const first=runtime(fetch);await assert.rejects(first.api.start({file,entries,defaultMarkup:'30',genericAs:'cost'}));assert(first.api.dirty());
 await first.api.retry();assert(first.api.dirty(),'lost chunk retains intent');await first.api.retry();assert(first.api.dirty(),'lost seal retains intent');await first.api.retry();assert.equal(first.api.dirty(),false);assert.equal(stored.length,6);
 for(const kind of ['runs','chunks','seal']){const pair=calls.filter(c=>kind==='runs'?c.path==='runs':c.path.endsWith('/'+kind)).slice(0,2);assert.deepEqual(pair[0].body,pair[1].body,kind+' immutable retry');}
 run={...run,status:'ready',phase:'validating',planRevision:hex,canApply:true,planned:{create:1001,update:0,skip:0}};await first.api.refresh();await first.api.action('apply');const beforeRead=calls.length;await first.api.refresh();assert.equal(calls.length,beforeRead,'result refresh is GET only');assert(first.api.dirty(),'read completed outcome does not substitute exact apply receipt');await first.api.retry();assert.equal(first.api.dirty(),false);assert.equal(run.counts.created,1001);assert.deepEqual(calls.filter(c=>c.path.endsWith('/apply')).map(c=>c.body),[{planRevision:hex},{planRevision:hex}]);
 // A later 403 cannot prove the initial apply was rolled back: keep its frozen intent.
 let tries=0,attempts=[];run={...run,status:'ready',phase:'validating',planRevision:hex,canApply:true};const unknown=runtime(async(url,options={})=>{if(url==='/api/v1/session')return response({csrf:'synthetic'});if(options.method==='POST'){attempts.push(JSON.parse(options.body));tries++;if(tries===1)throw Error('lost original apply');if(tries===2)return {ok:false,status:403,json:async()=>({error:'later403'})};return response({ok:true,id:run.id,status:'queued',phase:'applying',planRevision:hex});}if(url.includes('/rows'))return response({items:[row],total:1001,page:1,pages:11});return response(run);});await unknown.api.open(run.id);await unknown.api.action('apply');await unknown.api.retry();assert(unknown.api.dirty());assert(unknown.api.html().includes('Результат початкової дії невідомий'));await unknown.api.retry();assert.equal(unknown.api.dirty(),false);assert.deepEqual(attempts,[{planRevision:hex},{planRevision:hex},{planRevision:hex}]);
 // Reload midway: whole raw-file digest must agree, not merely filename/count/uploaded prefix.
 stored=stored.slice(0,1);run={...run,status:'uploading',phase:'uploading',uploadedRows:200,planRevision:null,canApply:false};const reload=runtime(fetch);await reload.api.open(run.id);reload.click('file');const beforeWrong=calls.length;
 await assert.rejects(reload.api.start({file:{name:file.name,arrayBuffer:async()=>Buffer.from('same prefix different suffix')},entries,defaultMarkup:'30',genericAs:'cost'}),/інший файл/);assert.equal(calls.length,beforeWrong);
 await reload.api.start({file,entries,defaultMarkup:'30',genericAs:'cost'});assert.equal(calls.filter(c=>c.path.endsWith('/chunks')&&c.body.offset===0).length,2,'reload verifies receipt without POST replay of prefix');assert.equal(run.uploadedRows,1001);
 const wrong=runtime(fetch);run={...run,status:'uploading',phase:'uploading',uploadedRows:200};stored=stored.slice(0,1);await wrong.api.open(run.id);wrong.click('file');await assert.rejects(wrong.api.start({file,entries:[{...entries[0],values:{name:'Changed normalized prefix'}},...entries.slice(1)],defaultMarkup:'30',genericAs:'cost'}),/Порції не збігаються/);
 // Resume lost ACK is resolved by reading an already resumed server state, not by writing again.
 let resumes=0;run={...baseRun,status:'failed',phase:'applying',uploadedRows:1001,planRevision:hex,canResume:true,counts:{...baseRun.counts,created:100,pending:901},progress:{done:100,total:1001}};const resumed=runtime(async(url,options={})=>{if(url==='/api/v1/session')return response({csrf:'test'});if(options.method==='POST'){assert.deepEqual(JSON.parse(options.body),{planRevision:hex});resumes++;run={...run,status:'queued',canResume:false};throw Error('resume lost ACK');}if(url.includes('/rows'))return response({items:[row],total:1001,page:1,pages:11});return response(run);});await resumed.api.open(run.id);await resumed.api.action('resume');assert(resumed.api.dirty());await resumed.api.retry();assert.equal(resumes,1);assert.equal(resumed.api.dirty(),false);
 // An acknowledged create followed by an unavailable read must never replay create.
 let newCreates=0,readFails=true;const getFailure=runtime(async(url,options={})=>{if(url==='/api/v1/session')return response({csrf:'test'});if(options.method==='POST'){const b=JSON.parse(options.body);newCreates++;run={...baseRun,id:b.idempotencyKey,sourceHash:b.sourceHash};return response({ok:true,id:run.id,status:'uploading',expectedRows:1001,sourceHash:b.sourceHash,limits});}if(url.endsWith('/rows?page=1'))return response({items:[],page:1,pages:1,total:1001});if(readFails){readFails=false;throw Error('GET503');}return response(run);});await assert.rejects(getFailure.api.start({file,entries,defaultMarkup:'30',genericAs:'cost'}),/GET503/);assert(getFailure.api.html().includes('Імпорт створено'));assert(getFailure.api.dirty());const blockedHtml=getFailure.api.html();assert.match(blockedHtml,/data-import-job="history"[^>]*disabled/);await getFailure.api.open(uuid);getFailure.api.close();await getFailure.api.loadHistory();assert(getFailure.api.html().includes('Імпорт створено'),'pending confirmedID survives attempts to open/close/history');await getFailure.api.refresh();assert.equal(newCreates,1);assert.equal(getFailure.api.dirty(),false);
 console.log('PASS: strict DTOs; 200/1MiB/16KiB boundaries; immutable create/chunk/seal/apply lost ACK; GET-only outcomes; reload full-file + chunk receipt verification and mismatched suffix/prefix rejection.');
})().catch(e=>{console.error(e);process.exitCode=1;});
