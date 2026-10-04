/* Ignored AbortSignal must not confirm a cancelled result or unlock a newer read. */
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{webcrypto}=require('node:crypto');
const listeners={},host={innerHTML:'',querySelector:()=>null};
const document={querySelector:s=>s==='#bulkBox'?host:null,addEventListener:(key,fn)=>{(listeners[key]??=[]).push(fn)}};
const context=vm.createContext({structuredClone,AbortController,setTimeout,clearTimeout,crypto:webcrypto,document,console,Intl});context.window=context;
const response=data=>({ok:true,status:200,json:async()=>data});
const summary={candidates:1,changedPrices:1,changedRecords:1,skippedManual:0,errors:0},settings={before:{defaultMarkup:'30',rounding:'0.5'},after:{defaultMarkup:'40',rounding:'0.5'}};
const preview={kind:'markup',valid:true,snapshot:'a'.repeat(64),priceContext:{storeId:null,storeName:null},summary,settings,entries:[{id:'one',name:'Товар',hidden:false,action:'update',before:{regularPrice:'13.00',salePrice:'13.00'},after:{regularPrice:'14.00',salePrice:'14.00'}}]};
const payloads=[];context.CatalogPriceWorkflow={context:()=>({storeId:null}),read:async()=>({status:'completed'}),open(){}};
context.fetch=async(url,options)=>{if(url==='/api/v1/session')return response({csrf:'synthetic'});if(url.endsWith('/preview'))return response(preview);payloads.push(JSON.parse(options.body));if(payloads.length===1)throw Error('lost original');return{ok:false,status:403,json:async()=>({error:'later403'})};};
vm.runInContext(fs.readFileSync(require.resolve('../app/catalog-pricing.js'),'utf8'),context);
const click=action=>{for(const fn of listeners.click)fn({target:{closest:()=>({dataset:{catalogPricing:action},disabled:false})}})},tick=()=>new Promise(r=>setTimeout(r,1)),wait=async test=>{for(let i=0;i<40;i++){if(test())return;await tick()}throw Error('Unconfirmed fixture state')};
(async()=>{
 for(const fn of listeners.submit)fn({preventDefault(){},target:{id:'bulkMarkupForm',elements:{markup:{value:'40'},scope:{value:''},resetManualPrices:{checked:false},updateDefault:{checked:true}}}});
 await wait(()=>context.CatalogPricing.html().includes('Зберегти зміни'));click('commit');await wait(()=>context.CatalogPricing.dirty()&&!context.CatalogPricing.pending());click('commit');await wait(()=>!context.CatalogPricing.pending());assert.deepEqual(payloads[0],payloads[1]);
 let firstResolve,secondReject;context.CatalogPriceWorkflow.read=async()=>new Promise(resolve=>{firstResolve=resolve});click('read-result');click('stop-read');assert(context.CatalogPricing.dirty());
 context.CatalogPriceWorkflow.read=async()=>new Promise((resolve,reject)=>{secondReject=reject});click('read-result');firstResolve({status:'completed'});await tick();assert(context.CatalogPricing.dirty());assert.match(context.CatalogPricing.html(),/Скасувати читання результату/);assert.doesNotMatch(context.CatalogPricing.html(),/Підтверджений результат операції прочитано/);
 click('stop-read');secondReject(Error('ignored abort late rejection'));await tick();assert(context.CatalogPricing.dirty());assert.doesNotMatch(context.CatalogPricing.html(),/ignored abort late rejection/);
 context.CatalogPriceWorkflow.read=async()=>({status:'completed'});click('read-result');await wait(()=>!context.CatalogPricing.dirty());assert.match(context.CatalogPricing.html(),/Підтверджений результат операції прочитано/);assert.equal(payloads.length,2);
 console.log('PASS: pricing lostACK/later403; cancelled ignored-abort fulfilment/rejection fenced, newer read remains busy, exact intent retained and GET-only retry confirms.');
})().catch(error=>{console.error(error);process.exitCode=1;});
