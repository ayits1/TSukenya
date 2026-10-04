/* Immutable reconciliation journal. All requests here are GET; no accounting repair. */
(()=>{'use strict';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const iso=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v));
const nullable=v=>v===null||typeof v==='string';
const bad=()=>{throw Error('Сервер повернув неповний журнал звірки. Повторіть завантаження.');};
function run(v){
 if(!object(v)||!uuid(v.id)||!['manual','scheduler'].includes(v.source)||!['clean','discrepancies','failed'].includes(v.status)||!integer(v.checksVersion)||v.checksVersion<1||!iso(v.startedAt)||!iso(v.finishedAt)||!iso(v.recordedAt)||Date.parse(v.finishedAt)<Date.parse(v.startedAt)||!integer(v.issues)||typeof v.reportHash!=='string'||!/^[0-9a-f]{64}$/.test(v.reportHash)||!nullable(v.errorCode)||!object(v.summary)||!object(v.summary.counts)||!object(v.summary.checks))bad();
 if(v.status==='failed'){if(v.errorCode!=='snapshot_failed')bad();return v;}
 if(v.errorCode!==null||v.status!==(v.issues?'discrepancies':'clean')||v.summary.issues!==v.issues)bad();
 for(const key of ['lots','vouchers','stock_entries','cash_entries'])if(!integer(v.summary.counts[key]))bad();
 let issues=0;for(const c of Object.values(v.summary.checks)){if(!object(c)||typeof c.title!=='string'||!integer(c.issues_count))bad();issues+=c.issues_count;}
 const c=v.summary.coverage;if(!object(c)||!nullable(c.closed_through)||c.closed_through!==null&&!/^\d{4}-\d{2}-\d{2}$/.test(c.closed_through))bad();
 for(const key of ['protected_drafts','unknown_operations','known_operations','invalid_period_events'])if(!integer(c[key]))bad();
 if(issues!==v.issues)bad();return v;
}
function page(v,decode,size){if(!object(v)||!Array.isArray(v.items)||!integer(v.total)||!integer(v.page)||v.page<1||!integer(v.pages)||v.pages!==Math.max(1,Math.ceil(v.total/size))||v.page>v.pages||v.items.length!==Math.min(size,Math.max(0,v.total-(v.page-1)*size)))bad();v.items.forEach(decode);return v;}
function finding(v){if(!object(v)||!integer(v.ordinal)||v.ordinal<1||typeof v.check!=='string'||typeof v.subject!=='string'||typeof v.message!=='string'||!nullable(v.expected)||!nullable(v.actual))bad();return v;}
const decodeRuns=v=>page(v,run,30),decodeFindings=v=>page(v,finding,100);
window.TradeReconciliation={decodeRun:run,decodeRuns,decodeFindings,create({api,esc,table,modal}){
 const statuses={clean:'Розбіжностей немає',discrepancies:'Є розбіжності',failed:'Перевірку не завершено'};
 const stamp=v=>new Date(v).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv'});
 function open(){
  const d=modal('Звірка регістрів',`<div data-reconcile><p class="trade-caption">Журнал завершених перевірок. Записи не виправляють облік. Новий запуск виконується серверною командою, розклад тут не налаштовується.</p><form class="trade-browse-filters"><label>З дати<input name="from" type="date"></label><label>По дату<input name="to" type="date"></label><label>Результат<select name="status"><option value="">Усі результати</option>${Object.entries(statuses).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label><button class="btn" type="submit">Показати</button></form><div class="trade-toolbar"><button type="button" class="btn soft" data-reconcile-back hidden>До журналу</button><button type="button" class="btn soft" data-reconcile-refresh>Оновити</button></div><p class="trade-error" role="alert" tabindex="-1" data-reconcile-error></p><div data-reconcile-results></div><div class="trade-pagination"><p role="status" aria-live="polite" tabindex="-1" data-reconcile-status></p><div class="row"><button class="btn soft" type="button" data-reconcile-prev>Назад</button><button class="btn soft" type="button" data-reconcile-next>Далі</button></div></div></div>`);
  const host=d.querySelector('[data-reconcile]'),form=host.querySelector('form'),results=host.querySelector('[data-reconcile-results]'),error=host.querySelector('[data-reconcile-error]'),status=host.querySelector('[data-reconcile-status]'),back=host.querySelector('[data-reconcile-back]');
  let params={},currentPage=1,pages=1,selected=null,listPage=1,controller,serial=0,busy=false;
  const buttons=()=>{host.querySelector('[data-reconcile-prev]').disabled=busy||currentPage<=1;host.querySelector('[data-reconcile-next]').disabled=busy||currentPage>=pages;};
  host.addEventListener('input',e=>e.stopPropagation());host.addEventListener('change',e=>e.stopPropagation());
  function caption(r){const c=r.summary.coverage;return `<h3 tabindex="-1" data-reconcile-heading>${esc(statuses[r.status])} · ${esc(stamp(r.startedAt))}</h3><p>Закрито по: ${esc(c?.closed_through||'період відкритий')}. Знімок на момент перевірки.</p>${r.status==='failed'?'<p class="trade-error">Перевірка не завершилась. Цей запис не засвідчує узгодженість обліку.</p>':`<p class="trade-caption">Порядок відомий для ${c.known_operations} операцій; невідомий для ${c.unknown_operations}. Некоректних подій закриття: ${c.invalid_period_events}. Заблокованих чернеток: ${c.protected_drafts} (це не доказ незаконного проведення).</p><details><summary style="min-height:44px;padding:12px 0;box-sizing:border-box;cursor:pointer">Перевірки: ${Object.keys(r.summary.checks).length} · розбіжностей: ${r.issues}</summary>${table(['Перевірка','Розбіжності'],Object.values(r.summary.checks).map(c=>[esc(c.title),String(c.issues_count)]))}</details>`}`;}
  async function load(focus=false){controller?.abort();controller=new AbortController();const token=++serial,live=()=>token===serial&&d.open&&d.isConnected;busy=true;buttons();results.innerHTML='<p class="muted">Завантаження…</p>';results.setAttribute('aria-busy','true');error.textContent='';status.textContent='Завантажуємо журнал…';
   try{if(selected){const r=run(await api('reconciliation-runs/'+selected.id,'GET',undefined,controller.signal));if(!live())return;if(r.id!==selected.id)bad();const found=decodeFindings(await api('reconciliation-runs/'+r.id+'/issues?page='+currentPage,'GET',undefined,controller.signal));if(!live())return;if(found.total!==r.issues)bad();selected=r;currentPage=found.page;pages=found.pages;results.innerHTML=caption(r)+table(['Об’єкт','Перевірка / пояснення','Очікувано','Фактично'],found.items.map(x=>[esc(x.subject),esc(x.message),esc(x.expected??'—'),esc(x.actual??'—')]),r.status==='failed'?'Результат звірки невідомий.':'Розбіжностей не знайдено.');status.textContent=`Розбіжностей: ${found.total}. Сторінка ${currentPage} з ${pages}.`;
    }else{const data=decodeRuns(await api('reconciliation-runs?'+new URLSearchParams({...params,page:currentPage}),'GET',undefined,controller.signal));if(!live())return;currentPage=data.page;pages=data.pages;results.innerHTML=table(['Час / джерело','Результат','Розбіжності','Дії'],data.items.map(r=>[esc(stamp(r.startedAt))+`<span class="muted">${r.source==='scheduler'?'За розкладом':'Вручну'}</span>`,esc(statuses[r.status]),String(r.issues),`<button class="btn soft" type="button" data-reconcile-id="${esc(r.id)}">Переглянути</button>`]));status.textContent=`Перевірок: ${data.total}. Сторінка ${currentPage} з ${pages}.`;}
    if(focus)(results.querySelector('[data-reconcile-heading]')||status).focus();
   }catch(e){if(live()&&e.name!=='AbortError'){results.innerHTML='';error.textContent=e.message;status.textContent='Не вдалося завантажити журнал.';error.focus();pages=1;}}
   finally{if(live()){busy=false;results.removeAttribute('aria-busy');buttons();}}
  }
  form.addEventListener('submit',e=>{e.preventDefault();e.stopPropagation();params=Object.fromEntries(new FormData(form));selected=null;back.hidden=true;currentPage=1;load(true);});
  host.addEventListener('click',e=>{const target=e.target.closest('button');if(!target||busy)return;if(target.hasAttribute('data-reconcile-id')){listPage=currentPage;selected={id:target.dataset.reconcileId};currentPage=1;form.hidden=true;back.hidden=false;load(true);}else if(target.hasAttribute('data-reconcile-back')){selected=null;currentPage=listPage;form.hidden=false;back.hidden=true;load(true);}else if(target.hasAttribute('data-reconcile-refresh'))load(true);else if(target.hasAttribute('data-reconcile-prev')||target.hasAttribute('data-reconcile-next')){currentPage+=target.hasAttribute('data-reconcile-prev')?-1:1;load(true);}});
  d.addEventListener('close',()=>{controller?.abort();serial++;},{once:true});load();return d;
 }
 return {open};
}};
})();
