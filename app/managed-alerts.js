/* Server-owned alert work; temporary form input never overwrites an uncertain first intent. */
(()=>{'use strict';
const states={open:'Не прийнято',accepted:'Прийнято в роботу',deferred:'Відкладено',completed:'Роботу виконано',resolved:'Причину усунено'};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const intents=new Map(),messages=new Map(),pending=new Set(),readFailures=new Set();let configured;
function system(t){return !!(t._alertKey||t._priceTask);}
function state(t){return t._alertWorkState||(t.status==='done'?'completed':t.status==='doing'?'accepted':'open');}
function row(t){
 if(!system(t))return '';
 const current=state(t),active=t._alertKey?!!t._alertActive:t.status!=='done',edit=t.permissions?.canEdit;
 return `<small class="task-date">${esc(states[current]||states.open)}${t._alertKey?' · '+(active?'Облікова умова активна':'Причину усунено'):''}${t._alertAcceptedBy?' · '+esc(t._alertAcceptedBy):''}</small>${current==='deferred'?`<small class="task-date">Повернутися ${esc(t._alertDeferredUntil)} · ${esc(t._alertDeferReason)}</small>`:''}${edit&&(active||t._priceTask)?`<span class="managed-alert-actions"><button type="button" class="btn soft" data-alert-action="${current==='completed'?'resume':current==='accepted'?'complete':'accept'}" data-alert-id="${esc(t.id)}" ${pending.has(t.id)?'disabled':''}>${current==='completed'?'Повернути в роботу':current==='accepted'?'Виконано':'Прийняти'}</button>${active?`<button type="button" class="btn soft" data-alert-action="defer" data-alert-id="${esc(t.id)}" ${pending.has(t.id)?'disabled':''}>Відкласти</button>`:''}</span>`:''}${readFailures.has(t.id)?`<button type="button" class="btn soft" data-alert-action="refresh" data-alert-id="${esc(t.id)}">Оновити список без повтору дії</button>`:''}${messages.has(t.id)?`<small class="task-date" role="alert">${esc(messages.get(t.id))}</small>`:''}`;
}
async function api(id,body){
 const sessionResponse=await fetch('/api/state',{credentials:'same-origin'});if(!sessionResponse.ok)throw Error('Не вдалося прочитати сеанс. Оновіть список.');const session=await sessionResponse.json();
 let response;try{response=await fetch(`/api/erp/alerts/tasks/${encodeURIComponent(id)}/actions`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify(body)});}catch{throw Error('Відповідь не отримано. Повторіть дію: її ключ та первісні умови збережено.');}
 let data;try{data=await response.json();}catch{throw Error('Відповідь не отримано. Повторіть первісну дію.');}
 if(!response.ok)throw Object.assign(Error(data.error||'Не вдалося змінити роботу над задачею.'),{status:response.status,code:data.code});
 if(!data?.task||data.task.id!==id||typeof data.task.revision!=='string'||!data.task.data||typeof data.task.data!=='object'||typeof data.replayed!=='boolean')throw Error('Некоректна відповідь. Первісну дію можна повторити.');return data;
}
async function apply(t,operation,extra={}){
 if(pending.has(t.id))return;const key=t.id+':'+operation;let intent=intents.get(key);if(!intent){intent={action:operation,revision:t.revision,idempotencyKey:crypto.randomUUID(),...extra};intents.set(key,intent);}
 pending.add(t.id);configured.render();
 try{const result=await api(t.id,intent);intents.delete(key);messages.delete(t.id);try{await configured.refresh();readFailures.delete(t.id);}catch{readFailures.add(t.id);messages.set(t.id,'Дію підтверджено сервером. Список не вдалося оновити; повторіть лише читання.');}configured.toast(result.replayed?'Первісну дію підтверджено. Показано актуальний стан задачі.':'Стан роботи збережено');return {result,intent};}
 catch(error){if(error.status>=400&&error.status<500)intents.delete(key);messages.set(t.id,error.message);throw error;}
 finally{pending.delete(t.id);configured.render();}
}
function defer(t){
 const opener=document.activeElement,d=document.createElement('dialog');d.className='trade-dialog small';d.setAttribute('aria-labelledby','managedAlertTitle');
 d.innerHTML=`<div class="trade-dialog-head"><h2 id="managedAlertTitle">Відкласти роботу</h2><button type="button" class="btn soft" data-alert-close>Закрити</button></div><div class="trade-dialog-body"><p>${esc(t.title)}</p><p class="trade-caption">Облікова умова залишається видимою. Задача повернеться у роботу під час першої перевірки в обрану дату за Києвом.</p><form id="managedAlertForm"><label class="form-field">Повернутися до задачі<input name="until" type="date" required></label><label class="form-field">Причина відкладення<textarea name="reason" required maxlength="500" rows="3"></textarea></label></form><p data-alert-error class="trade-error" role="alert" tabindex="-1"></p><p data-alert-status role="status" aria-live="polite"></p></div><div class="trade-dialog-foot"><button type="submit" form="managedAlertForm" class="btn">Відкласти до дати</button><button type="button" class="btn soft" data-alert-reload hidden>Оновити умови</button></div>`;
 document.body.append(d);const form=d.querySelector('form'),error=d.querySelector('[data-alert-error]'),reload=d.querySelector('[data-alert-reload]');let current=t,dirty=false,busy=false;
 const problem=e=>{error.textContent=e.message;error.focus({preventScroll:true});error.scrollIntoView({block:'nearest'});};
 const close=()=>{if(busy)return;if(!dirty||confirm('Закрити без збереження відкладення?'))d.close();};
 d.addEventListener('input',()=>dirty=true);d.addEventListener('cancel',event=>{event.preventDefault();close();});d.querySelector('[data-alert-close]').onclick=close;
 d.addEventListener('close',()=>{d.remove();if(opener?.isConnected)opener.focus();else document.querySelector(`[data-task-id="${CSS.escape(t.id)}"]`)?.focus();},{once:true});
 reload.onclick=async()=>{if(busy)return;busy=true;reload.disabled=true;try{await configured.refresh();const fresh=configured.tasks().find(task=>task.id===t.id);if(!fresh)throw Error('Задача недоступна. Збережіть введення й оновіть список.');current=fresh;error.textContent='';reload.hidden=true;d.querySelector('[type=submit]').disabled=false;form.elements.until.focus();}catch(e){problem(e);}finally{busy=false;reload.disabled=false;}};
 form.onsubmit=async event=>{event.preventDefault();if(busy)return;const draft={until:form.elements.until.value,reason:form.elements.reason.value};busy=true;for(const control of d.querySelectorAll('button,input,textarea'))control.disabled=true;d.querySelector('[data-alert-status]').textContent='Зберігаємо явне відкладення…';
 try{const saved=await apply(current,'defer',draft);if(!saved)return;if(saved.intent.until!==draft.until||saved.intent.reason!==draft.reason){current={...current,revision:saved.result.task.revision,...saved.result.task.data};problem(Error('Первісне відкладення підтверджено. Нове введення збережено; застосуйте його окремою дією.'));}else{dirty=false;d.close();}}
 catch(e){problem(e);if(e.status>=400&&e.status<500){reload.hidden=false;d.querySelector('[type=submit]').dataset.blocked='1';}}
 finally{busy=false;for(const control of d.querySelectorAll('button,input,textarea'))control.disabled=false;d.querySelector('[type=submit]').disabled=d.querySelector('[type=submit]').dataset.blocked==='1'&&!reload.hidden;d.querySelector('[data-alert-status]').textContent='';}
 };
 d.showModal();form.elements.until.focus();return d;
}
function configure(options){configured=options;}
async function handle(element){if(!configured)return;const id=element.dataset.alertId,t=configured.tasks().find(task=>task.id===id);if(!t||!t.permissions?.canEdit||pending.has(id))return;if(element.dataset.alertAction==='refresh'){pending.add(id);configured.render();try{await configured.refresh();readFailures.delete(id);messages.delete(id);}catch{configured.toast('Не вдалося оновити список. Підтверджена дія не повторювалася.');}finally{pending.delete(id);configured.render();}return;}if(element.dataset.alertAction==='defer')return defer(t);try{await apply(t,element.dataset.alertAction);}catch{configured.toast(messages.get(id));}}
window.ManagedAlerts={row,system,configure,handle};
})();
