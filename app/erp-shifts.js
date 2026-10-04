/* Paged shift controls. Requests are read-only and tied to their mounted form. */
(() => {
  'use strict';
  function create({api, esc, amount, quantity, name, table, option, calendarDay}) {
    const historyStates = new Map();
    const range = data => data.total ? `${(data.page - 1) * 30 + 1}–${Math.min(data.page * 30, data.total)} із ${data.total}` : '0 записів';
    const pager = '<div class="trade-pagination"><span role="status" aria-live="polite" data-shift-status></span><div class="row"><button class="btn soft" type="button" data-shift-page="prev">Назад</button><button class="btn soft" type="button" data-shift-page="next">Далі</button></div></div>';
    function loader(host, resource, params, render, initialPage = 1) {
      let page = initialPage, pages = 1, request = 0, controller, busy = false, failed = false;
      const body = host.querySelector('[data-shift-results]'), status = host.querySelector('[data-shift-status]'), error = host.querySelector('[data-shift-error]');
      for(const [direction,label] of [['prev','Попередня'],['next','Наступна']]) host.querySelector(`[data-shift-page=${direction}]`).setAttribute('aria-label',`${label} сторінка ${resource==='shifts'?'касових':'робочих'} змін`);
      const buttons = () => {
        host.querySelector('[data-shift-page=prev]').disabled = busy || failed || page <= 1;
        host.querySelector('[data-shift-page=next]').disabled = busy || failed || page >= pages;
      };
      async function load(focus = false) {
        controller?.abort(); controller = new AbortController(); const token = ++request;
        busy = true; failed = false; buttons(); body.setAttribute('aria-busy','true'); error.textContent = ''; status.textContent = 'Завантажуємо зміни…';
        body.querySelectorAll('button,input,select').forEach(control => control.disabled = true);
        try {
          const query = params();
          if(query?.from && query.to && query.from > query.to) throw Error('Початкова дата не може бути пізнішою за кінцеву.');
          const data = query === null ? {items:[],page:1,pages:1,total:0} : await api(resource + '?' + new URLSearchParams({...query,page:String(page)}), 'GET', undefined, controller.signal);
          if(!host.isConnected || token !== request) return;
          page = data.page; pages = data.pages; render(data,body); status.textContent = range(data);
          if(focus) {const target = body.querySelector('button,input,select') || status; if(target === status) target.tabIndex = -1; target.focus();}
        } catch(e) {
          if(e.name === 'AbortError' || token !== request || !host.isConnected) return;
          failed = true; error.textContent = e.message; status.textContent = 'Список не завантажено.';
          body.innerHTML = '<button class="btn soft" type="button" data-shift-retry>Завантажити повторно</button>';
          if(focus) body.querySelector('button').focus();
        } finally {if(token === request) {busy = false; body.removeAttribute('aria-busy'); buttons();}}
      }
      host.addEventListener('click', event => {
        const button = event.target.closest('[data-shift-page],[data-shift-retry]');
        if(!button || button.disabled) return;
        if(button.dataset.shiftPage) page += button.dataset.shiftPage === 'next' ? 1 : -1;
        void load(true);
      });
      return {load, reset(){page = 1; return load();}, get ready(){return !busy && !failed;}, cancel(){controller?.abort();request++;}};
    }
    function history(host, kind, {role, username}) {
      const form = host.querySelector('form');
      const state = historyStates.get(kind) || {params:{},page:1};historyStates.set(kind,state);
      Object.entries(state.params).forEach(([key,value])=>{if(form.elements[key])form.elements[key].value=value;});
      const control = loader(host,kind === 'cash' ? 'shifts' : 'work-shifts',()=>Object.fromEntries(new FormData(form)),(data,body)=>{
        state.page=data.page;state.params=Object.fromEntries(new FormData(form));
        if(kind === 'cash') body.innerHTML = table(['Зміна','Магазин','Каса','Працівник','Стан','Дії'],data.items.map(s=>[
          `№ ${s.id}<span class="muted">${new Date(s.opened_at).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv'})}</span>`,esc(name('stores',s.store_id)),esc(name('accounts',s.account_id)),esc(name('employees',s.employee_id)),
          s.closed_at ? `Закрита<span class="muted">Різниця ${amount(Number(s.counted_cash)-Number(s.expected_cash))} грн</span>` : 'Відкрита',
          s.closed_at ? '—' : role === 'cashier' && s.opened_by !== username ? '<span class="muted">Інший касир</span>' : `<button class="btn soft" type="button" data-trade="shift-close" data-id="${s.id}" aria-label="Закрити касову зміну № ${s.id}">Закрити</button>`
        ]));
        else body.innerHTML = table(['Дата','Працівник','Магазин','Змін','Умови','Нараховано','Стан'],data.items.map(s=>[
          `${esc(s.date)}<span class="muted">Табель № ${s.id} · ${s.cash_shift_id?'Касова зміна № '+s.cash_shift_id:'Без касової зміни'}</span>`,esc(name('employees',s.employee_id)),esc(name('stores',s.store_id)),quantity(s.units),`${amount(s.shift_rate)} грн + ${quantity(s.bonus_percent)} %`,amount(s.accrued)+' грн',
          s.payroll_id ? `<button class="btn soft" type="button" data-trade="view" data-id="${s.payroll_id}" aria-label="Нарахування № ${s.payroll_id} для ${esc(name('employees',s.employee_id))}">Нарахування</button>` : host.dataset.closedThrough && s.date <= host.dataset.closedThrough ? 'Закритий період' : `<button class="btn soft" type="button" data-trade="work-shift" data-id="${s.id}" aria-label="Редагувати табель № ${s.id} ${esc(name('employees',s.employee_id))} за ${esc(s.date)}${s.cash_shift_id?' · касова зміна № '+s.cash_shift_id:' · без касової зміни'}">Редагувати</button>`
        ]));
      },state.page);
      form.onsubmit = event => {event.preventDefault();void control.reset();};
      form.addEventListener('change',()=>void control.reset());
      void control.load(); return control;
    }
    function shell(filters = '') {
      return filters+'<p role="alert" class="trade-error" data-shift-error></p><div data-shift-results></div>'+pager;
    }
    function cashChoice(host, {store, day, selected, changed, required = () => false}) {
      let query = {store,day}, current = String(selected || ''), selectedItem = null, lookup = 0, pending = true, lookupFailed = false;
      host.innerHTML = shell();
      const label = s => `№ ${s.id} · ${name('accounts',s.account_id)} · ${calendarDay(s.opened_at)}${s.closed_at?' · закрита':' · відкрита'}`;
      const control = loader(host,'shifts',()=>query,(data,body)=>{
        const values = data.items.map(s=>({id:s.id,name:label(s)}));
        if(current && selectedItem && !values.some(s=>String(s.id)===current)) values.unshift({id:selectedItem.id,name:label(selectedItem)});
        body.innerHTML = '<label>Касова зміна<select data-cash-choice '+(required()?'required':'')+'>'+option(values,current,'Без касової зміни')+'</select></label>';
        body.querySelector('select').onchange = event => {current=event.target.value;selectedItem=data.items.find(s=>String(s.id)===current)||selectedItem;changed(current);};
      });
      async function update({store,day,selected:selection = current}) {
        const token = ++lookup; control.cancel();pending = true;lookupFailed = false;
        host.querySelectorAll('button,input,select').forEach(field=>field.disabled=true);
        query = {store,day}; current = String(selection || ''); selectedItem = null;
        if(current) {
          try {const data = await api('shifts?'+new URLSearchParams({...query,id:current}));if(token!==lookup||!host.isConnected)return;selectedItem=data.items[0]||null;if(!selectedItem){current='';changed('');}}
          catch(e) {if(token===lookup&&host.isConnected){lookupFailed=true;pending=false;host.querySelector('[data-shift-error]').textContent=e.message;host.querySelector('[data-shift-results]').innerHTML='<button class="btn soft" type="button" data-cash-retry>Завантажити повторно</button>';return;}}
        }
        if(!store || !day) {current='';changed('');pending=false;query=null;await control.reset();return;}
        await control.reset();
        if(token===lookup)pending=false;
      }
      host.addEventListener('click',event=>{if(event.target.closest('[data-cash-retry]'))void update({...query,selected:current});});
      void update({store,day,selected});
      return {update, updateRequired(){const select=host.querySelector('[data-cash-choice]');if(select)select.required=required();},get ready(){return !pending&&!lookupFailed&&control.ready;}, get value(){return current;}, cancel(){lookup++;control.cancel();}};
    }
    function payroll(host,{employee,store,to,selected,changed}) {
      let query = {employee,store,to,eligible:'payroll'}, chosen = new Set((selected||[]).map(String)), onlySelected = false;
      host.innerHTML = shell('<div class="row"><button class="btn soft" type="button" data-payroll-selected>Показати вибрані</button><button class="btn soft" type="button" data-payroll-clear>Зняти вибір</button><span role="status" data-payroll-count></span></div>');
      const count = () => {host.querySelector('[data-payroll-count]').textContent=`Вибрано: ${chosen.size}`;host.querySelector('[data-payroll-clear]').disabled=!chosen.size;host.querySelector('[data-payroll-selected]').textContent=onlySelected?'Показати доступні':'Показати вибрані';};
      const control = loader(host,'work-shifts',()=>!query.employee||onlySelected&&!chosen.size?null:onlySelected?{employee:query.employee,store:query.store,ids:[...chosen].join(',')}:query,(data,body)=>{
        body.innerHTML = data.items.length ? '<div class="trade-checkbox-list">'+data.items.map(s=>`<label><input type="checkbox" name="shift_ids" value="${s.id}" data-payroll-id="${s.id}" ${chosen.has(String(s.id))?'checked':''}>${esc(s.date)} · Табель № ${s.id} · ${s.cash_shift_id?'Касова зміна № '+s.cash_shift_id:'Без касової зміни'} · ${quantity(s.units)} зміна · ${amount(s.shift_rate)} грн + ${quantity(s.bonus_percent)} %${s.date>query.to?' · Після дати документа':''}${s.payroll_id?' · Уже нарахована':''}</label>`).join('')+'</div>' : '<p class="muted">Немає змін за цими умовами.</p>';
        body.querySelectorAll('input').forEach(input=>input.onchange=()=>{if(input.checked)chosen.add(input.dataset.payrollId);else chosen.delete(input.dataset.payrollId);count();changed();});
      });
      host.addEventListener('click',event=>{
        if(event.target.closest('[data-payroll-selected]')){onlySelected=!onlySelected;count();void control.reset();}
        if(event.target.closest('[data-payroll-clear]')){chosen.clear();onlySelected=false;count();changed();void control.reset();}
      });
      count();void control.load();
      return {get ids(){return [...chosen].map(Number);},get ready(){return control.ready;},update(values){if(values.employee!==query.employee||values.store!==query.store){chosen.clear();onlySelected=false;}query={...values,eligible:'payroll'};count();return control.reset();},cancel:control.cancel};
    }
    return {history,shell,cashChoice,payroll};
  }
  window.TradeShifts = {create};
})();
