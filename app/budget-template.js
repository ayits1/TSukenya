/* One versioned catalogue-budget value. Reads/comparison never write. */
(()=>{'use strict';
let active=null;
const adapter=()=>{if(!window.NativeBudgetTemplateEditor||!window.NativeConflictComparison)throw Error('Компонент узгодження ще не завантажений. Повторіть читання.');return window.NativeBudgetTemplateEditor;};
async function request(method,body,signal){
 const a=adapter(),session=await window.PortalApi.session(signal);
 let r;try{r=await fetch('/api/v1/portal/budget-template',{method,credentials:'same-origin',cache:'no-store',signal,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:body===undefined?undefined:JSON.stringify(body)});}catch(e){if(e.name==='AbortError')throw e;throw Object.assign(Error('Результат не підтверджено. Прочитайте поточну кількість; чернетка збережена.'),{uncertain:method!=='GET'});}
 let v;try{v=await r.json();}catch{throw Object.assign(Error('Некоректна відповідь сервера. Повторіть читання.'),{uncertain:method!=='GET'});}
 if(!r.ok)throw Object.assign(Error(typeof v?.error==='string'?v.error:'Дія недоступна. Чернетка збережена.'),{status:r.status,uncertain:method!=='GET'&&r.status>=500});
 try{return a.decodeBudgetTemplate(v);}catch(e){e.uncertain=method!=='GET';throw e;}
}
function open(){
 if(active?.open){active.focus();return;}
 const opener=document.activeElement,d=document.createElement('dialog');active=d;d.className='trade-dialog small';d.setAttribute('aria-labelledby','budgetTemplateTitle');
 d.innerHTML='<div class="trade-dialog-head"><h2 id="budgetTemplateTitle">Планова кількість магазинів</h2><button type="button" class="btn soft" data-close aria-label="Закрити редактор">×</button></div><div class="trade-dialog-body"><p class="trade-caption">Це кількість для орієнтира за каталогом. Вона не змінює ERP-магазини чи підписи цінників. Зміни зберігаються лише кнопкою.</p><form><label class="trade-caption">Кількість магазинів<input name="budgetStores" type="number" inputmode="numeric" required min="1" max="1000" step="1"></label><div class="row trade-section-title"><button class="btn" type="submit">Зберегти кількість</button></div></form><p role="status" aria-live="polite" data-status></p><p role="alert" class="trade-error" data-error tabindex="-1"></p><div class="row trade-section-title"><button type="button" class="btn soft" data-read>Повторити читання</button><button type="button" class="btn soft" data-cancel hidden>Скасувати читання</button></div><div class="tk-root" data-comparison></div></div>';
 const form=d.querySelector('form'),input=form.elements.budgetStores,save=form.querySelector('[type=submit]'),read=d.querySelector('[data-read]'),cancel=d.querySelector('[data-cancel]'),close=d.querySelector('[data-close]'),status=d.querySelector('[data-status]'),error=d.querySelector('[data-error]'),host=d.querySelector('[data-comparison]');
 let baseline=null,review=false,reading=false,busy=false,dirty=false,sequence=0,controller=null,comparison=null;
 const live=()=>active===d&&d.open;
 const sync=()=>{input.disabled=!baseline||reading||busy;save.disabled=!baseline||review||reading||busy||!dirty;close.disabled=busy;read.hidden=reading||busy||!!comparison;read.textContent=baseline?'Порівняти з поточною версією':'Повторити читання';cancel.hidden=!reading;};
 const stop=()=>{sequence++;controller?.abort();controller=null;comparison?.unmount();comparison=null;host.replaceChildren();reading=false;sync();};
 const shut=()=>{if(busy)return false;if(dirty&&!confirm('Відкинути незбережену кількість магазинів?'))return false;d.close();return true;};
 close.onclick=shut;d.addEventListener('cancel',e=>{e.preventDefault();shut();});
 d.addEventListener('close',()=>{stop();if(active===d)active=null;d.remove();if(opener?.isConnected)opener.focus();},{once:true});
 input.oninput=()=>{dirty=true;error.textContent='';status.textContent=review?'Чернетка збережена. Потрібно узгодити поточну версію.':'Є незбережені зміни. Натисніть «Зберегти кількість».';sync();};
 cancel.onclick=()=>{stop();status.textContent='Читання скасовано. Чернетка збережена.';read.focus();};
 async function latest(){
  if(reading||busy||comparison)return;
  const local={budgetStores:input.value===''?'':Number(input.value)},requestId=++sequence;controller=new AbortController();reading=true;error.textContent='';status.textContent='Читаємо поточну кількість магазинів…';sync();
  try{const fresh=await request('GET',undefined,controller.signal);if(!live()||requestId!==sequence)return;
   if(!baseline){baseline=structuredClone(fresh);input.value=String(fresh.budgetStores);reading=false;status.textContent=fresh.source==='legacy'?'Показано кількість із наявних legacy налаштувань. Читання нічого не записує.':'Поточну кількість прочитано.';sync();input.focus();return;}
   review=true;reading=false;status.textContent='Порівняння готове. Узгодьте зміни; збереження виконується окремо.';
   comparison=window.NativeConflictComparison.mount(host,{base:adapter().budgetTemplateProjection(baseline),mine:local,server:adapter().budgetTemplateProjection(fresh),fields:adapter().budgetTemplateFields(),title:'Узгодити кількість магазинів',onCancel:()=>{if(!live()||requestId!==sequence)return;stop();status.textContent='Чернетка збережена. Прочитайте поточну версію перед збереженням.';read.focus();},onApply:merged=>{if(!live()||requestId!==sequence)return;let validated;try{validated=adapter().decodeBudgetTemplate({...fresh,...merged});}catch(e){error.textContent='Введіть ціле число від 1 до 1000 або виберіть актуальне значення сервера.';error.focus();return;}stop();baseline=structuredClone(fresh);input.value=String(validated.budgetStores);review=false;dirty=true;status.textContent='Зміни узгоджено в чернетці. Натисніть «Зберегти кількість».';sync();save.focus();}});sync();input.disabled=true;
  }catch(e){if(!live()||requestId!==sequence||e.name==='AbortError')return;stop();if(baseline)review=true;error.textContent=e.message;status.textContent='Поточну кількість не підтверджено. Чернетка збережена.';sync();read.focus();}
 }
 read.onclick=latest;
 form.onsubmit=async e=>{e.preventDefault();if(!live()||!baseline||review||reading||busy||comparison||!dirty||!form.reportValidity())return;const body={budgetStores:Number(input.value),revision:baseline.revision};busy=true;error.textContent='';status.textContent='Збереження…';sync();try{const saved=await request('PATCH',body);if(!live())return;if(saved.budgetStores!==body.budgetStores)throw Object.assign(Error('Результат не підтверджено. Повторіть читання.'),{uncertain:true});baseline=saved;dirty=false;status.textContent='Кількість збережено.';busy=false;sync();d.close();await window.TSUKENYA_REFRESH_AFTER_WRITE?.().catch(()=>{});}catch(e){if(live()){review=e.status===409||e.status===428||e.status===403||e.uncertain;error.textContent=e.message;status.textContent='Чернетка збережена.';}}finally{busy=false;if(live()){sync();if(review)read.focus();}}};
 document.body.append(d);d.showModal();sync();void latest();
 window.BudgetTemplate.canLeave=()=>!active?.open||shut();
}
window.addEventListener('beforeunload',e=>{if(active?.open){e.preventDefault();e.returnValue='';}});
document.addEventListener('click',e=>{if(e.target.closest('[data-budget-template-edit]'))open();});
window.BudgetTemplate={open,canLeave:()=>!active?.open};
})();
