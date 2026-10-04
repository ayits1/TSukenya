/* Bounded read coordinator. Page records are not a full collection; drafts pin their own baselines. */
(()=>{'use strict';
 const states=new Map(),pins=new Map();let active=new Set(),render=()=>{},generation=0,identity='';
 const flatten=item=>({id:item.id,...item.data,revision:item.revision,permissions:item.permissions,initiative:item.initiative,managed:item.managed,...(typeof item.hasDevelopmentTask==='boolean'?{hasDevelopmentTask:item.hasDevelopmentTask}:{})});
 const key=(name,params)=>name+'?'+new URLSearchParams(params);
 function trim(){for(const [k,s] of states){if(states.size<=8)break;if(!active.has(k)){s.controller?.abort();states.delete(k);}}}
 async function load(k,s){s.controller?.abort();const controller=new AbortController(),n=++generation;s.controller=controller;s.generation=n;s.state='loading';
  try{const result=await window.PortalApi.get('collections/'+s.name+(Object.keys(s.params).length?'?'+new URLSearchParams(s.params):''),v=>s.name==='summary'?window.PortalApi.decodeCollectionSummary(v,s.params.section):window.PortalApi.decodeCollection(v,s.name,s.params),controller.signal);
   if(s.generation!==n||controller.signal.aborted||!states.has(k))return;
   if(result.context.role!==window.TSUKENYA_ROLE||result.context.store!==window.TSUKENYA_SCOPE_STORE)throw Object.assign(Error('Права змінилися. Оновіть сеанс.'),{status:403});
   s.value=result;s.state='ready';s.error='';
  }catch(error){if(s.generation!==n||controller.signal.aborted||!states.has(k))return;s.state='error';s.error=error.message||'Не вдалося прочитати список.';if([401,403].includes(error.status)){s.value=null;pins.clear();if(error.status===401&&active.has(k))location.href='/';}}
  finally{if(s.generation===n&&!controller.signal.aborted){s.controller=null;trim();if(active.has(k))render();}}
  if(s.state==='error')throw Error(s.error);
 }
 function view(name,params={}){const k=key(name,params);active.add(k);let s=states.get(k);if(!s){s={name,params:{...params},state:'idle',value:null};states.set(k,s);}states.delete(k);states.set(k,s);if(s.state==='idle'&&window.TSUKENYA_ROLE)load(k,s).catch(()=>{});return s;}
 function begin(){active=new Set();const next=window.TSUKENYA_ROLE+'|'+window.TSUKENYA_SCOPE_STORE;if(identity&&next!==identity){for(const s of states.values())s.controller?.abort();states.clear();pins.clear();}identity=next;}
 function end(){for(const [k,s] of states)if(!active.has(k)&&s.controller){s.generation=++generation;s.controller.abort();s.controller=null;s.state=s.value?'ready':'idle';}trim();}
 function record(name,id){const pinned=pins.get(name+'/'+id);if(pinned)return pinned;for(const s of states.values()){if(s.name===name){const item=s.value?.items.find(item=>item.id===id);if(item)return flatten(item);}if(name==='tasks'&&s.name==='summary'){const item=s.value?.nearest?.find(item=>item.id===id);if(item)return flatten(item);}}return null;}
 function pin(name,id){const value=record(name,id);if(value)pins.set(name+'/'+id,structuredClone(value));return value;}
 function unpin(name,id){pins.delete(name+'/'+id);}
 async function task(id){const item=await window.PortalApi.get('collections/tasks/'+encodeURIComponent(id),v=>window.PortalApi.decodeCollectionItem(v,'tasks'));return flatten(item);}
 async function refreshVisible(){const jobs=[];for(const [k,s] of states){if(active.has(k))jobs.push(load(k,s));else{s.controller?.abort();s.generation=++generation;s.state='idle';s.value=null;}}await Promise.all(jobs);}
 window.addEventListener('tsukenya:data-changed',event=>{const domains=event.detail?.domains;if(domains&&!domains.some(d=>['tasks','ideas','expenses'].includes(d)))return;for(const s of states.values()){s.controller?.abort();s.generation=++generation;s.state='idle';s.value=null;}render();});
 const api={view,begin,end,record,pin,unpin,task,flatten,refreshVisible,configure:fn=>{render=fn;},retry:()=>refreshVisible(),pinned:name=>[...pins].filter(([k])=>k.startsWith(name+'/')).map(([,v])=>v)};
 if(typeof window!=='undefined')window.PortalCollections=api;
})();
