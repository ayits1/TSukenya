/* Scoped financial reads. State belongs to the list, never to an accounting draft. */
(() => {
  'use strict';
  const actions = {posted:'Проведення документа',reversed:'Скасування проведення',draft_saved:'Збереження чернетки',draft_deleted:'Видалення чернетки',catalog_changed:'Зміна товару',catalog_reference_created:'Новий запис довідника товарів',legacy_changed:'Зміна даних порталу',entity_saved:'Зміна довідника обліку',label_layout_changed:'Зміна макета цінника',shift_opened:'Відкриття касової зміни',shift_closed:'Закриття касової зміни',work_shift_saved:'Зміна табеля',user_saved:'Зміна доступу користувача',password_changed:'Зміна пароля',period_changed:'Зміна облікового періоду',fiscal_mode_changed:'Зміна режиму ПРРО',recipe_saved:'Зміна рецептури',alerts_updated:'Оновлення контролю операцій'};
  let activeAudit = null;
  function create({api,esc,amount,name,table,option,kinds,getState}) {
    function auditSummary(event) {
      const detail=event.detail;
      if(!detail||typeof detail!=='object'||Array.isArray(detail))return 'Опис події доступний у технічних подробицях.';
      if(['user_saved','user_created','user_updated'].includes(event.action)) {
        const roles={owner:'Власник',manager:'Керівник магазину',cashier:'Касир',warehouse:'Склад',accountant:'Бухгалтер'};
        const parts=[];
        if(Object.hasOwn(detail,'role'))parts.push(typeof detail.role==='string'&&Object.hasOwn(roles,detail.role)?`Роль: ${roles[detail.role]}.`:'Роль не розпізнано.');
        if(typeof detail.active==='boolean')parts.push(`Стан: ${detail.active?'Активний':'Заблокований'}.`);
        if(parts.length)return parts.join(' ');
      }
      if(event.action==='recipe_saved'&&Array.isArray(detail.recipe))return `Інгредієнтів у рецептурі: ${detail.recipe.length}.`;
      if(event.action==='catalog_pricing_changed') {
        const labels={candidates:'Товарів у перевірці',changedPrices:'Товарів зі зміненою ціною',changedRecords:'Змінено записів товарів',skippedManual:'Пропущено товарів із ручною ціною',errors:'Помилок'};
        const parts=Object.entries(labels).filter(([key])=>Number.isSafeInteger(detail[key])&&detail[key]>=0).map(([key,label])=>`${label}: ${detail[key]}.`);
        if(parts.length)return parts.join(' ');
      }
      return 'Опис події доступний у технічних подробицях.';
    }
    function auditDetails(event) {
      return `<div data-audit-summary>${esc(auditSummary(event))}</div><details data-audit-technical><summary aria-label="Технічні подробиці події № ${esc(event.id)}" style="min-height:44px;padding:10px 0;box-sizing:border-box;cursor:pointer;scroll-margin-block:8px">Технічні подробиці</summary><div class="trade-history" style="text-align:left">Дія: ${esc(event.action)}</div><pre class="trade-history" style="margin:8px 0 0;text-align:left;font:12px/1.5 ui-monospace,monospace">${esc(JSON.stringify(event.detail,null,2))}</pre></details>`;
    }
    function auditAction(event) {
      const label=Object.hasOwn(actions,event.action)?actions[event.action]:event.action==='catalog_pricing_changed'?'Групова зміна цін':'Інша подія';
      return `<span style="display:block;min-width:80px">${esc(label)}</span>`;
    }
    const states = new Map();
    const titles = {debts:'боргів',ledger:'грошових операцій',audit:'журналу змін'};
    const input = (key,type='text',attrs='') => `<input name="${key}" type="${type}" ${attrs}>`;
    const field = (label,control) => `<label>${label}${control}</label>`;
    const select = (key,values,empty) => `<select name="${key}">${option(values,'',empty)}</select>`;
    function shell(resource,key,{store='',fixedStore=false}={}) {
      const E=getState();
      const filters = field(resource==='audit'?'Пошук за подією, користувачем або об’єктом':resource==='ledger'?'Пошук за документом, рахунком або контрагентом':'Пошук за документом або контрагентом',input('q','search','maxlength="250" autocomplete="off"'))+
        (resource==='audit'?field('Користувач',`<select name="user" disabled>${option([],'','Завантажуємо користувачів…')}</select>`)+field('Дія',select('action',Object.entries(actions).map(([id,name])=>({id,name})),'Усі дії')):
          (!fixedStore?field('Магазин',select('store',E.stores,'Усі магазини')):`<input name="store" type="hidden" value="${esc(store)}">`)+
          field(resource==='ledger'?'Рахунок':'Контрагент',select(resource==='ledger'?'account':'party',resource==='ledger'?E.accounts:E.parties,resource==='ledger'?'Усі рахунки':'Усі контрагенти')))+
        field(resource==='audit'?'Події з дати':'Документи з дати',input('from','date'))+field('По дату',input('to','date'));
      const due = resource==='debts'?field('Строк оплати з',input('due_from','date'))+field('Строк оплати по',input('due_to','date'))+field('Стан оплати',select('status',[{id:'overdue',name:'Прострочені'},{id:'not_overdue',name:'Без прострочення'}],'Усі борги')):'';
      return `<div data-finance="${resource}" data-finance-key="${key}" data-fixed-store="${fixedStore?'1':''}"><form class="trade-browse-filters">${filters}${due}<button class="btn" type="submit">Показати</button><button class="btn soft" type="button" data-finance-reset>Скинути</button></form>${resource==='audit'?'<p class="trade-error" role="alert" data-finance-users-error></p>':''}<p class="trade-error" role="alert" tabindex="-1" data-finance-error></p><div data-finance-totals></div><div data-finance-results></div><div class="trade-pagination"><span role="status" aria-live="polite" tabindex="-1" data-finance-status></span><div class="row"><button class="btn soft" type="button" data-finance-page="prev" aria-label="Попередня сторінка ${titles[resource]}">Назад</button><button class="btn soft" type="button" data-finance-page="next" aria-label="Наступна сторінка ${titles[resource]}">Далі</button></div></div></div>`;
    }
    function mount(host,{store=''}={}) {
      const resource=host.dataset.finance,key=host.dataset.financeKey,form=host.querySelector('form');
      const state=states.get(key)||{params:{...(resource!=='audit'?{store:String(store)}:{})},page:1};states.set(key,state);
      if(host.dataset.fixedStore==='1'&&state.params.store!==String(store)){state.params.store=String(store);state.page=1;}
      Object.entries(state.params).forEach(([key,value])=>{if(form.elements[key])form.elements[key].value=value;});
      const results=host.querySelector('[data-finance-results]'),status=host.querySelector('[data-finance-status]'),error=host.querySelector('[data-finance-error]'),totals=host.querySelector('[data-finance-totals]');
      let controller,userController,request=0,pages=1,busy=false,failed=false,timer,cancelled=false;
      const live=()=>!cancelled&&host.isConnected&&(!host.closest('dialog')||host.closest('dialog').open);
      const capture=()=>{const values=Object.fromEntries(new FormData(form));if(resource==='audit'&&form.elements.user.disabled)values.user=state.params.user||'';state.params=values;};
      function paging() {for(const direction of ['prev','next']){const button=host.querySelector(`[data-finance-page=${direction}]`);button.disabled=!busy&&(failed||(direction==='prev'?state.page<=1:state.page>=pages));button.setAttribute('aria-disabled',String(busy||button.disabled));}}
      function invalidate() {clearTimeout(timer);controller?.abort();request++;busy=true;failed=false;results.setAttribute('aria-busy','true');results.innerHTML='<p class="trade-caption">Завантаження…</p>';totals.innerHTML='';error.textContent='';status.textContent='Завантажуємо '+titles[resource]+'…';paging();}
      function render(data) {
        if(resource==='debts') {
          totals.innerHTML=`<p class="trade-caption">За вибраними умовами: нам винні <strong>${amount(data.debt_totals.owed_to_us)} грн</strong>; ми винні <strong>${amount(data.debt_totals.owed_by_us)} грн</strong>.</p>`;
          results.innerHTML=table(['Документ','Дата / магазин','Контрагент','Сума боргу','Строк оплати','Дії'],data.items.map(d=>[
            `№ ${esc(d.number)}<span class="muted">${d.kind==='receipt'?'Ми винні':'Нам винні'}</span>`,esc(d.date)+`<span class="muted">${esc(name('stores',d.store))}</span>`,esc(d.party),amount(d.amount)+' грн',esc(d.due_date||'Не задано')+(d.overdue?'<span class="muted trade-error">Прострочено</span>':''),
            `<button class="btn soft" type="button" data-trade="pay-debt" data-id="${d.voucher}" aria-label="Оплатити борг за документом № ${esc(d.number)}">Оплатити</button>`
          ]),'Боргів за вибраними умовами немає.');
        } else if(resource==='ledger') results.innerHTML=table(['Дата / документ','Рахунок / магазин','Операція','Сума','Дії'],data.entries.map(x=>[
          esc(x.date)+`<span class="muted">№ ${String(x.voucher).padStart(6,'0')}</span>`,esc(x.account)+`<span class="muted">${esc(name('stores',x.store_id))}</span>`,esc(kinds[x.kind])+(x.reversal?' · скасування':'')+(x.note?`<span class="muted">${esc(x.note)}</span>`:''),amount(x.amount)+' грн',`<button class="btn soft" type="button" data-trade="view" data-id="${x.voucher}" aria-label="Відкрити документ № ${x.voucher}">Документ</button>`
        ]),'Грошових операцій за вибраними умовами немає.');
        else results.innerHTML=table(['Подія / час','Користувач','Дія','Об’єкт','Подробиці'],data.events.map(e=>[
          `№ ${e.id}<span class="muted">${esc(new Date(e.at).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv'}))}</span>`,esc(e.user__username),auditAction(e),esc(e.subject),auditDetails(e)
        ]),'Подій за вибраними умовами немає.');
      }
      async function load(focus=false) {
        invalidate();controller=new AbortController();const token=request;capture();
        try {
          if(state.params.from&&state.params.to&&state.params.from>state.params.to)throw Error('Початкова дата не може бути пізнішою за кінцеву.');
          if(state.params.due_from&&state.params.due_to&&state.params.due_from>state.params.due_to)throw Error('Початковий строк оплати не може бути пізнішим за кінцевий.');
          const data=await api(resource+'?'+new URLSearchParams({...state.params,page:String(state.page)}),'GET',undefined,controller.signal);
          if(!live()||token!==request)return;
          state.page=data.page;pages=data.pages;render(data);status.textContent=data.total?`${(data.page-1)*30+1}–${Math.min(data.page*30,data.total)} із ${data.total} · сторінка ${data.page} з ${data.pages}`:'0 записів';
          if(focus)(results.querySelector('button')||status).focus({preventScroll:true});
        } catch(e) {
          if(e.name==='AbortError'||token!==request||!live())return;
          failed=true;error.textContent=e.message;status.textContent='Не вдалося завантажити список.';results.innerHTML='<button class="btn soft" type="button" data-finance-retry>Завантажити повторно</button>';
          if(focus)results.querySelector('button').focus({preventScroll:true});
        } finally {if(token===request&&live()){busy=false;results.removeAttribute('aria-busy');paging();}}
      }
      const resetPage=()=>{state.page=1;capture();void load();};
      form.onsubmit=event=>{event.preventDefault();state.page=1;void load(true);};
      form.addEventListener('change',resetPage);
      form.addEventListener('input',event=>{capture();if(event.target.name==='q'){state.page=1;invalidate();timer=setTimeout(()=>void load(),250);}});
      host.addEventListener('click',event=>{
        const button=event.target.closest('[data-finance-page],[data-finance-retry],[data-finance-reset],[data-finance-users-retry]');if(!button||button.disabled)return;
        if(button.hasAttribute('data-finance-users-retry')){void loadUsers();return;}
        if(button.hasAttribute('data-finance-page')){if(busy||failed)return;state.page+=button.dataset.financePage==='next'?1:-1;void load(true);}
        if(button.hasAttribute('data-finance-retry'))void load(true);
        if(button.hasAttribute('data-finance-reset')){const fixed=state.params.store;for(const control of form.elements)if(control.name)control.value='';if(host.dataset.fixedStore==='1')form.elements.store.value=fixed;state.page=1;void load();form.elements.q.focus();}
      });
      async function loadUsers() {
        userController?.abort();userController=new AbortController();const lookup=userController,user=form.elements.user,message=host.querySelector('[data-finance-users-error]');
        user.disabled=true;message.textContent='';
        try {const data=await api('users','GET',undefined,lookup.signal);if(!live()||lookup!==userController)return;user.innerHTML=option(data.users.map(u=>({id:u.id,name:u.username})),state.params.user||'','Усі користувачі');}
        catch(e){if(e.name==='AbortError'||!live()||lookup!==userController)return;message.innerHTML=esc(e.message)+' <button class="btn soft" type="button" data-finance-users-retry>Повторити завантаження користувачів</button>';}
        finally {if(live()&&lookup===userController)user.disabled=false;}
      }
      if(resource==='audit')void loadUsers();
      void load();
      return {cancel(){cancelled=true;clearTimeout(timer);controller?.abort();userController?.abort();request++;},setStore(value){const next=String(value||'');if(form.elements.store.value===next)return;form.elements.store.value=next;state.page=1;void load();}};
    }
    function audit() {
      activeAudit?.close();const opener=document.activeElement,d=document.createElement('dialog');d.className='trade-dialog';d.dataset.financeAudit='';d.setAttribute('aria-labelledby','tradeFinanceAuditTitle');
      d.innerHTML=`<div class="trade-dialog-head"><h2 id="tradeFinanceAuditTitle">Журнал змін</h2><button class="btn soft" type="button" data-finance-close>Закрити</button></div><div class="trade-dialog-body">${shell('audit','audit')}</div>`;
      document.body.append(d);activeAudit=d;d.showModal();const control=mount(d.querySelector('[data-finance]'));
      d.querySelector('[data-finance-close]').onclick=()=>d.close();d.addEventListener('click',event=>{if(event.target!==d)return;const rect=d.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)d.close();});
      d.addEventListener('close',()=>{control.cancel();if(activeAudit===d)activeAudit=null;d.remove();if(opener?.isConnected)opener.focus({preventScroll:true});},{once:true});formFocus(d);
    }
    const formFocus=d=>d.querySelector('[name=q]').focus();
    return {shell,mount,audit,closeAudit(){activeAudit?.close();}};
  }
  window.TradeFinance={create};
})();
