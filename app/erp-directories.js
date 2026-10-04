/* Actual native directory tables: server search and 30-row pages, never a bootstrap slice. */
(()=>{'use strict';
function create({esc,amount,quantity,name,table,role}){
 const labels={stores:'Магазини',warehouses:'Склади',accounts:'Рахунки',employees:'Працівники',parties:'Контрагенти'};
 function mount(host){
  const type=host.dataset.directoryTable,purpose=host.dataset.directoryPurpose||'browse';let page=1,pages=1,token=0,controller,failed=false,busy=false;
  host.innerHTML=`<form class="trade-toolbar"><label>Пошук у довіднику<input name="q" type="search" maxlength="250" placeholder="Назва, телефон або email"></label><button class="btn soft" type="submit">Знайти</button></form><p class="trade-error" role="alert" data-directory-error></p><div data-directory-results></div><div class="trade-pagination"><button class="btn soft" type="button" data-directory-page="prev">Назад</button><span role="status" aria-live="polite" tabindex="-1" data-directory-status></span><button class="btn soft" type="button" data-directory-page="next">Далі</button><button class="btn soft" type="button" data-directory-retry hidden>Повторити</button></div>`;
  const form=host.querySelector('form'),results=host.querySelector('[data-directory-results]'),status=host.querySelector('[data-directory-status]');
  const live=id=>host.isConnected&&id===token;
  function buttons(){host.querySelector('[data-directory-page=prev]').disabled=busy||failed||page<=1;host.querySelector('[data-directory-page=next]').disabled=busy||failed||page>=pages;host.querySelector('[data-directory-retry]').hidden=!failed;}
  const edit=x=>role==='owner'||type==='parties'&&['manager','accountant'].includes(role)?`<button class="btn soft" type="button" data-trade="entity" data-entity="${type}" data-id="${esc(x.id)}">Редагувати</button>`:'—';
  function rows(items){
   if(type==='employees')return table(['Працівник','Магазин','Ставка за зміну','Відсоток','До виплати','Дії'],items.map(x=>[esc(x.name)+(x.active?'':'<span class="muted">Неактивний</span>'),esc(name('stores',x.store_id)),amount(x.shift_rate)+' грн',quantity(x.bonus_percent)+' %',amount(x.payroll_debt)+' грн',edit(x)]));
   if(type==='accounts'&&purpose==='finance')return table(['Рахунок','Магазин','Тип','Залишок','Дії'],items.map(x=>[esc(x.name),esc(name('stores',x.store_id)),esc(({cash:'Готівка',bank:'Банк',terminal:'Термінал'})[x.kind]),amount(x.balance)+' грн',edit(x)]));
   return table(['Назва','Тип / магазин','Стан','Дії'],items.map(x=>[esc(x.name),esc(x.store_id?name('stores',x.store_id):({supplier:'Постачальник',customer:'Покупець',cash:'Готівка',bank:'Банк',terminal:'Термінал'})[x.kind]||'Магазин'),x.active===false?'Неактивний':'Активний',edit(x)]));
  }
  async function read(focus=false){
   const id=++token;controller?.abort();controller=new AbortController();busy=true;failed=false;buttons();status.textContent='Завантажуємо '+labels[type].toLocaleLowerCase('uk')+'…';results.setAttribute('aria-busy','true');results.querySelectorAll('button').forEach(b=>b.disabled=true);host.querySelector('[data-directory-error]').textContent='';
   try{const data=await window.TradeDirectories.api.list(type,{q:form.elements.q.value,page,purpose,...(host.dataset.directoryKind?{kind:host.dataset.directoryKind}:{})},controller.signal);if(!live(id))return;await window.TradeDirectories.hydrateCaptions(data);if(!live(id))return;window.TradeDirectories.remember(type,data.items);page=data.page;pages=data.pages;results.innerHTML=rows(data.items);status.textContent=`Сторінка ${page} з ${pages} · ${data.total} записів`;if(focus)status.focus();}
   catch(error){if(error.name==='AbortError'||!live(id))return;failed=true;results.innerHTML='';status.textContent='Список не завантажено';host.querySelector('[data-directory-error]').textContent=error.message;}
   finally{if(live(id)){busy=false;results.removeAttribute('aria-busy');buttons();}}
  }
  form.onsubmit=event=>{event.preventDefault();page=1;void read();};host.addEventListener('click',event=>{const button=event.target.closest('[data-directory-page],[data-directory-retry]');if(!button||button.disabled)return;if(button.dataset.directoryPage)page+=button.dataset.directoryPage==='next'?1:-1;void read(true);});void read();return{cancel(){++token;controller?.abort();}};
 }
 return{mount};
}
window.TradeDirectoryTables={create};
})();
