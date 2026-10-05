/* Physical holds belong to an approved source order. Financial writes stay on Django. */
(()=>{'use strict';
const states={draft:'Чернетка',approved:'Погоджено',partial:'Частково виконано',fulfilled:'Виконано',closed:'Закрито',cancelled:'Скасовано'};
const decimal=v=>typeof v==='string'&&/^\d+(?:\.\d{1,3})?$/.test(v);
const unused=r=>{const scaled=v=>BigInt(v.split('.')[0])*1000n+BigInt((v.split('.')[1]||'').padEnd(3,'0'));const n=scaled(r.quantity)-scaled(r.used)-scaled(r.released);return `${n/1000n}.${String(n%1000n).padStart(3,'0')}`;};
const id=v=>Number.isSafeInteger(v)&&v>0;
function decode(value){
 const o=value?.order;
 if(!o||!id(value.id)||!id(o.revision)||typeof o.canManage!=='boolean'||typeof o.state!=='string'||!Object.hasOwn(states,o.state)||!Array.isArray(o.lines)||!Array.isArray(o.reservations)||!o.history||!id(o.history.page)||!id(o.history.pages)||!Number.isSafeInteger(o.history.total)||o.history.total<0||o.lines.some(l=>!id(l.line)||typeof l.name!=='string'||typeof l.unit!=='string'||!['quantity','fulfilled','remaining','reserved'].every(k=>decimal(l[k])))||o.reservations.some(r=>!id(r.id)||!id(r.line)||typeof r.code!=='string'||typeof r.owner!=='string'||typeof r.active!=='boolean'||!['quantity','used','released','available'].every(k=>decimal(r[k]))||typeof r.expires_on!=='string'))throw Error('Сервер повернув некоректний стан замовлення. Оновіть дані.');
 return o;
}
function create({api,esc,quantity,amount,table,field,input,num,button,modal,date,busyDialog,formError,getDialog,afterWrite,onView,canClose,getSource}){
 const attrs=(v,extra='')=>`data-id="${v.id}" data-order-revision="${v.order.revision}" ${extra}`;
 function panel(v){
  const o=decode(v),open=v.status==='posted'&&!['closed','cancelled'].includes(o.state),manage=o.canManage&&open;
  let html=`<section data-order-panel><h3 class="trade-section-title">Виконання замовлення</h3><p><strong>${esc(states[o.state])}</strong>${o.expected_date?' · очікувана поставка '+esc(o.expected_date):''}${o.minimum_order_amount?' · мінімум постачальника '+amount(o.minimum_order_amount)+' грн':''}</p>${table(['Товар','Замовлено','Виконано','Залишилось','Зарезервовано'],o.lines.map(l=>[esc(l.name),quantity(l.quantity)+' '+esc(l.unit),quantity(l.fulfilled),quantity(l.remaining),quantity(l.reserved)]))}`;
  if(manage)html+=`<div class="row trade-order-actions">${v.kind==='customer_order'&&o.lines.some(l=>Number(l.remaining)>Number(l.reserved))?button('Резервувати товар','order-reserve',attrs(v),true):''}${v.kind==='purchase_order'?button('Очікувана дата','order-date',attrs(v)):''}${button('Звільнити прострочені резерви','order-expire',attrs(v))}${button('Закрити замовлення','order-close',attrs(v))}</div>`;
  if(v.kind==='customer_order')html+=`<h3 class="trade-section-title">Історія резервів</h3><p class="trade-caption">Строк включає вибраний день за Києвом. Резерв не створює складського чи грошового проведення; звільняється тільки невикористана частина.</p>${table(['Товар / партія','Строк','Кількість','Використано','Звільнено','Стан / дія'],o.reservations.map(r=>[esc(o.lines.find(l=>l.line===r.line)?.name||'—')+'<br>'+esc(r.code||'Без коду')+(r.lot_expiry?'<span class="muted">Придатний до '+esc(r.lot_expiry)+'</span>':''),esc(r.expires_on)+'<span class="muted">Створив: '+esc(r.owner)+'</span>',quantity(r.quantity),quantity(r.used),quantity(r.released),(r.active?'Чинний':Number(r.quantity)===Number(r.used)+Number(r.released)?'Використано / звільнено':'Строк минув')+(manage&&Number(r.quantity)>Number(r.used)+Number(r.released)?'<div class="trade-order-actions">'+button('Звільнити','order-release',attrs(v,`data-reservation="${r.id}"`))+'</div>':'')]))}${o.history.pages>1?`<div class="trade-pagination trade-order-actions">${button('Назад','order-history',attrs(v,`data-page="${o.history.page-1}" ${o.history.page===1?'disabled':''}`))}<span role="status">${o.history.page} / ${o.history.pages} · записів ${o.history.total}</span>${button('Далі','order-history',attrs(v,`data-page="${o.history.page+1}" ${o.history.page===o.history.pages?'disabled':''}`))}</div>`:''}`;
  return html+'</section>';
 }
 async function createAction(el,stillCurrent){
  const source=getDialog(),kind=el.dataset.trade,identifier=Number(el.dataset.id),observed=Number(el.dataset.orderRevision),page=el.dataset.page;
  if(kind==='order-refresh'){if(canClose(source))await onView(identifier);return;}
  const action={'order-reserve':'reserve','order-release':'release','order-expire':'expire','order-close':'close','order-date':'expected_date'}[kind];
  if(action){
   const v=getSource(source);if(!v||v.id!==identifier)throw Error('Прочитайте замовлення перед відкриттям дії.');
   const captured={id:identifier,kind:v.kind,store:v.store,revision:observed,...(action==='release'?{reservation:Number(el.dataset.reservation)}:{})};
   source.querySelector('#tradeDialogTitle').textContent='Перевірка доступу до дії замовлення';
   source.querySelector('.trade-dialog-body').hidden=true;
   source.querySelector('.trade-dialog-foot')?.setAttribute('hidden','');
   try{return await window.TradeOrderRecovery.open(captured,action,null,null,()=>stillCurrent()&&source.open);}
   catch(error){if(stillCurrent()&&source.open){
    let notice=source.querySelector('[data-order-open-error]');if(!notice){notice=document.createElement('section');notice.className='trade-dialog-body';notice.dataset.orderOpenError='';source.append(notice);}
    notice.replaceChildren();const message=document.createElement('p');message.setAttribute('role','alert');message.textContent=error.message;notice.append(message);
    const retry=document.createElement('button');retry.type='button';retry.className='btn soft';retry.textContent='Повторити перевірку доступу';retry.onclick=()=>{retry.disabled=true;void createAction(el,stillCurrent).finally(()=>{if(retry.isConnected)retry.disabled=false;});};notice.append(retry);
   }}
   return;
  }
  const finish=busyDialog(source,'Завантаження стану замовлення…');if(!finish)return;let response;
  try{response=await api(`orders/${identifier}?${new URLSearchParams(kind==='order-history'?{page}:kind==='order-reserve'?{purpose:'reserve'}:{})}`);if(!stillCurrent())return;decode(response);if(kind!=='order-history'&&response.order.revision!==observed)throw Error('Замовлення вже змінено. Оновіть його й перевірте залишок перед новою дією.');}
  catch(error){if(stillCurrent())formError(error,source);return;}finally{finish();}
  if(!stillCurrent())return;
  if(kind==='order-history'){const host=source.querySelector('[data-order-panel]');host.outerHTML=panel({id:identifier,kind:'customer_order',status:'posted',order:response.order});source.querySelector(`[data-trade="order-history"][data-page="${Number(page)+1}"]`)?.focus();return;}

 }
 return {panel,action:createAction};
}
window.TradeOrders={create,decode};
})();
