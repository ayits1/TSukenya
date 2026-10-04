/* Owner-only, server-calculated bulk prices with an explicit review step. */
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const formatter=new Intl.NumberFormat('uk-UA',{minimumFractionDigits:2,maximumFractionDigits:2}),money=value=>formatter.format(value);
  let getConfig = () => ({markup:30,rounding:.5,categories:[],selectIds:() => []}), state = null;
  let draft = {markup:null,scope:'',resetManualPrices:false,updateDefault:true,rounding:null};
  const locked = () => !!(state?.saving || state?.uncertain);
  const button = (action,title,disabled=false) => `<button type="button" class="btn soft" data-catalog-pricing="${action}" ${disabled?'disabled':''}>${title}</button>`;
  function render(focus) {
    const host = document.querySelector('#bulkBox');if(!host)return;host.innerHTML=html();
    if(focus){const target=host.querySelector(focus);target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest'});}
  }
  function html() {
    const config=getConfig();
    if(!state)return `<div class="pricing-sections"><section><h3>Націнка товарів</h3><p class="muted">Спочатку перегляньте поточні та майбутні ціни. Пакет зберігається цілком. Для окремої категорії виберіть її у фільтрах каталогу. Максимум — 1000 товарів.</p><form id="bulkMarkupForm"><div class="pricing-fields"><label class="form-field">Націнка, %<input id="bulkM" name="markup" type="number" inputmode="decimal" required min="0" max="99999999.99" step="0.0001" value="${esc(draft.markup??config.markup)}"></label><label class="form-field">Застосувати до<select id="bulkC" name="scope"><option value="" ${draft.scope===''?'selected':''}>Усі активні товари</option><option value="__f" ${draft.scope==='__f'?'selected':''}>Товари за поточними фільтрами</option>${config.categories.map(category=>`<option value="${esc(category)}" ${draft.scope===category?'selected':''}>${esc(category)}</option>`).join('')}</select></label></div><label class="pricing-check"><input name="resetManualPrices" type="checkbox" ${draft.resetManualPrices?'checked':''}>Перерахувати також ручні ціни</label><label class="pricing-check"><input name="updateDefault" type="checkbox" ${draft.updateDefault&&draft.scope===''?'checked':''} ${draft.scope!==''?'disabled':''}>Використовувати цю націнку для нових товарів</label><button class="btn" type="submit">Переглянути зміни націнки</button></form></section><section><h3>Округлення розрахункових цін</h3><p class="muted">Застосовується до всього каталогу, включно з прихованими товарами. Ручні ціни зберігаються.</p><form id="bulkRoundingForm"><label class="form-field">Округлення<select id="rounding" name="rounding">${[['0.01','До копійки'],['0.1','До 10 коп.'],['0.5','До 50 коп.'],['1','До гривні']].map(([value,label])=>`<option value="${value}" ${Number(draft.rounding??config.rounding)===Number(value)?'selected':''}>${label}</option>`).join('')}</select></label><button class="btn" type="submit">Переглянути зміни округлення</button></form></section></div>`;
    const preview=state.preview,busy=state.loading||state.saving,summary=preview?.summary,entries=preview?.entries||[],pages=Math.max(1,Math.ceil(entries.length/20)),page=state.page||1;
    const labels={update:'Буде оновлено',unchanged:'Без змін',skip:'Ручна ціна збережена',error:'Помилка'};
    const cards=entries.slice((page-1)*20,page*20).map(entry=>`<li class="pricing-item ${entry.action==='error'?'warn':''}"><div class="row"><strong>${esc(entry.name)}</strong><span class="badge">${labels[entry.action]}</span>${entry.hidden?'<span class="badge">Прихований</span>':''}</div><dl class="pricing-comparison"><div><dt>Звичайна ціна</dt><dd>${money(entry.before.regularPrice)} → <strong>${money(entry.after.regularPrice)} грн</strong></dd></div><div><dt>Діюча ціна</dt><dd>${money(entry.before.salePrice)} → <strong>${money(entry.after.salePrice)} грн</strong></dd></div></dl>${entry.error?`<p role="alert">${esc(entry.error)}</p>`:''}</li>`).join('');
    const settings=preview?.settings,scope=preview?.scope;
    const detail=scope?.kind==='filter'?` · ${scope.count} відповідних товарів · ${scope.storeName||'Мережева ціна'}${scope.filters.category?' · Категорія: '+scope.filters.category:''}${scope.filters.promotion?' · Акція: '+(scope.filters.promotion==='yes'?'Так':'Ні'):''}`:'';
    return `<h3 tabindex="-1" id="pricingReviewTitle">${state.payload.kind==='markup'?'Перевірка націнки':'Перевірка округлення'}</h3><p class="muted">${esc(state.scopeLabel+detail)}${state.payload.kind==='markup'?` · Націнка ${esc(state.payload.markup)}% · ${state.payload.resetManualPrices?'Ручні ціни буде перераховано':'Ручні ціни зберігаються'}`:''}</p>
      <p role="status" aria-live="polite">${state.saving?'Зберігаємо зміни цін…':state.loading?'Розраховуємо зміни на сервері…':state.completed?`Зміни збережено. Цін змінено: ${state.completed.summary.changedPrices}.`:summary?`Товарів у перегляді: ${summary.candidates} · Цін зміниться: ${summary.changedPrices} · Ручних цін збережено: ${summary.skippedManual} · Помилок: ${summary.errors}`:'Потрібно розрахувати зміни.'}</p>
      ${settings?`<p class="muted">Націнка нових товарів: ${esc(settings.before.defaultMarkup)} → ${esc(settings.after.defaultMarkup)}%. Округлення: ${money(settings.before.rounding)} → ${money(settings.after.rounding)} грн.</p>`:''}
      ${state.failure?`<p class="form-error" role="alert" tabindex="-1" id="pricingError">${esc(state.failure)}</p>`:''}
      ${cards?`<ul class="pricing-list">${cards}</ul><nav class="catalog-import-pagination" aria-label="Сторінки зміни цін">${button('previous','Попередня',page<=1||busy)}<span>${page} / ${pages}</span>${button('next','Наступна',page>=pages||busy)}</nav>`:''}
      <div class="row pricing-actions">${state.completed?(state.refreshFailed?button('refresh','Оновити каталог',busy):''):button(state.uncertain?'commit':state.conflict||!preview?.valid?'preview':'commit',state.uncertain?'Перевірити результат / повторити':state.conflict?'Оновити попередній перегляд':preview?.valid?'Зберегти зміни':'Розрахувати повторно',busy)}${button('reset',state.completed?'Завершити':'Змінити параметри',locked())}</div>`;
  }
  function validDecimal(value){return typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)&&Number.isFinite(Number(value));}
  function decode(data,path,payload) {
    const summary=data?.summary,settings=data?.settings;
    const summaryValid=summary&&['candidates','changedPrices','changedRecords','skippedManual','errors'].every(key=>Number.isInteger(summary[key])&&summary[key]>=0&&summary[key]<=1000);
    const settingsValid=settings&&['before','after'].every(key=>settings[key]&&['defaultMarkup','rounding'].every(field=>validDecimal(settings[key][field])));
    const entriesValid=Array.isArray(data?.entries)&&data.entries.length<=1000&&data.entries.every(entry=>entry&&typeof entry.id==='string'&&['update','unchanged','skip','error'].includes(entry.action));
    const valid=entriesValid&&(path==='preview'?typeof data.valid==='boolean'&&/^[a-f0-9]{64}$/.test(data.snapshot||'')&&data.entries.every(entry=>typeof entry.name==='string'&&typeof entry.hidden==='boolean'&&['before','after'].every(key=>entry[key]&&validDecimal(entry[key].regularPrice)&&validDecimal(entry[key].salePrice))&&(entry.action!=='error'||typeof entry.error==='string')):data?.ok===true&&data.idempotencyKey===payload.idempotencyKey&&data.entries.every(entry=>typeof entry.revision==='string'));
    const consistent=entriesValid&&summaryValid&&summary.candidates===data.entries.length&&new Set(data.entries.map(entry=>entry.id)).size===data.entries.length&&summary.changedPrices<=summary.candidates&&summary.changedRecords<=summary.candidates&&summary.skippedManual<=summary.candidates&&(path!=='preview'||summary.errors===data.entries.filter(entry=>entry.action==='error').length&&data.valid===(summary.errors===0));
    const scopeValid=!payload.selection||path!=='preview'||data.scope?.kind==='filter'&&Number.isInteger(data.scope.count)&&data.scope.count>=0&&data.scope.count<=1000&&(data.scope.storeName===null||typeof data.scope.storeName==='string')&&data.scope.filters&&Object.keys(payload.selection).every(k=>data.scope.filters[k]===payload.selection[k]);
    if(!scopeValid||!summaryValid||!settingsValid||!valid||!consistent||data.kind!==payload.kind)throw Error('Сервер повернув некоректний результат розрахунку. Повторіть спробу.');
    return data;
  }
  async function request(path,payload,signal){
    const sessionResponse=await fetch('/api/v1/session',{credentials:'same-origin',cache:'no-store',signal});
    if(!sessionResponse.ok)throw Error(sessionResponse.status===401?'Сеанс завершився. Увійдіть знову.':'Не вдалося перевірити сеанс.');
    const session=await sessionResponse.json(),response=await fetch('/api/v1/catalog/pricing/'+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify(payload),signal});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){const error=Error(data.error||'Сервер не підтвердив результат.');error.status=response.status;error.code=data.code;throw error;}
    return decode(data,path,payload);
  }
  async function preview(){
    if(!state||state.loading||locked()||state.completed)return;
    const current=state;current.preview=null;current.failure='';current.conflict=false;current.loading=true;current.page=1;current.controller=new AbortController();current.commitPayload=null;render();
    const timer=setTimeout(()=>current.controller.abort(),30000);
    try{current.preview=await request('preview',current.payload,current.controller.signal);}
    catch(error){if(state===current)current.failure=error.name==='AbortError'?'Розрахунок не завершився. Повторіть спробу.':error.message;}
    finally{clearTimeout(timer);current.loading=false;if(state===current)render(current.failure?'#pricingError':'#pricingReviewTitle');}
  }
  async function start(payload,scopeLabel){
    if(locked()||window.CatalogImport?.dirty())return;
    state?.controller?.abort();state={payload:structuredClone(payload),scopeLabel,page:1};await preview();
  }
  async function refresh(){
    if(!state?.completed||state.loading)return;const current=state;current.loading=true;render();
    try{await window.TSUKENYA_REFRESH();current.refreshFailed=false;current.failure='';}
    catch(_){current.refreshFailed=true;current.failure='Зміни цін збережено. Каталог не оновився — повторіть лише оновлення.';}
    finally{current.loading=false;if(state===current)render(current.failure?'#pricingError':'#pricingReviewTitle');}
  }
  async function commit(){
    if(!state?.preview?.valid||state.loading||state.saving||state.completed||state.conflict)return;
    if(window.CatalogImport?.dirty()){window.alert('Спершу перевірте результат незавершеного імпорту.');return;}
    const current=state;current.commitPayload||={...structuredClone(current.payload),snapshot:current.preview.snapshot,idempotencyKey:crypto.randomUUID()};current.saving=true;current.failure='';render();
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    try{current.completed=await request('commit',current.commitPayload,controller.signal);current.uncertain=false;}
    catch(error){if(error.status>=400&&error.status<500){current.uncertain=false;current.conflict=true;current.failure=error.message+' Зміни не збережено.';}else{current.uncertain=true;current.failure='Немає підтвердження запису. Перевірте результат / повторіть із тим самим пакетом; повтор не змінить ціни вдруге.';}}
    finally{clearTimeout(timer);current.saving=false;if(state===current)render(current.failure?'#pricingError':'#pricingReviewTitle');}
    if(current.completed)await refresh();
  }
  const api={configure:callback=>getConfig=callback,html,pending:()=>!!state?.saving,dirty:()=>!!(state?.saving||state?.uncertain),decode};
  if(typeof window!=='undefined')window.CatalogPricing=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(typeof document!=='undefined'){
    document.addEventListener('submit',event=>{
      const form=event.target;if(!['bulkMarkupForm','bulkRoundingForm'].includes(form.id))return;event.preventDefault();if(locked())return;
      if(window.CatalogImport?.dirty()){window.alert('Спершу перевірте результат незавершеного імпорту.');return;}
      if(form.id==='bulkRoundingForm'){draft.rounding=form.elements.rounding.value;void start({kind:'rounding',rounding:draft.rounding},'Увесь каталог, включно з прихованими товарами');}
      else{draft={...draft,markup:form.elements.markup.value,scope:form.elements.scope.value,resetManualPrices:form.elements.resetManualPrices.checked,updateDefault:form.elements.scope.value===''?form.elements.updateDefault.checked:draft.updateDefault};
        const selected=getConfig().selection?.(draft.scope);
        const ids=selected?null:draft.scope===''?null:getConfig().selectIds(draft.scope);
        if(ids!==null&&!ids.length){window.alert('За вибраними умовами товарів немає. Змініть фільтри або категорію.');return;}
        void start({kind:'markup',...(selected?{selection:selected}:{ids}),markup:draft.markup,resetManualPrices:draft.resetManualPrices,updateDefault:draft.scope===''&&draft.updateDefault},draft.scope===''?'Усі активні товари':draft.scope==='__f'?'За поточними фільтрами: усі відповідні товари, кількість визначить сервер':`Категорія: ${draft.scope} · ${ids.length} товарів`);
      }
    });
    document.addEventListener('change',event=>{
      if(event.target.id!=='bulkC'||state)return;const checkbox=document.querySelector('#bulkMarkupForm [name=updateDefault]');draft.scope=event.target.value;checkbox.disabled=draft.scope!=='';checkbox.checked=draft.scope===''&&draft.updateDefault;
    });
    document.addEventListener('click',event=>{
      const target=event.target.closest('[data-catalog-pricing]');if(!target||target.disabled)return;const action=target.dataset.catalogPricing;
      if(action==='preview')void preview();else if(action==='commit')void commit();else if(action==='refresh')void refresh();
      else if(action==='reset'&&!locked()){state?.controller?.abort();state=null;render('#bulkM');}
      else if(state&&['previous','next'].includes(action)){state.page=Math.max(1,(state.page||1)+(action==='next'?1:-1));render('[data-catalog-pricing='+action+']');}
    });
  }
})();
