/* Scoped financial reads. State belongs to the list, never to an accounting draft. */
(() => {
  'use strict';
  const actions = {posted:'Проведення документа',reversed:'Скасування проведення',draft_saved:'Збереження чернетки',draft_deleted:'Видалення чернетки',catalog_changed:'Зміна товару',catalog_reference_created:'Новий запис довідника товарів',legacy_changed:'Зміна даних порталу',entity_saved:'Зміна довідника обліку',label_layout_changed:'Зміна макета цінника',shift_opened:'Відкриття касової зміни',shift_closed:'Закриття касової зміни',work_shift_saved:'Зміна табеля',user_saved:'Зміна доступу користувача',password_changed:'Зміна пароля',period_changed:'Зміна облікового періоду',fiscal_mode_changed:'Зміна режиму ПРРО',recipe_saved:'Зміна рецептури',alerts_updated:'Оновлення контролю операцій',order_reserve:'Резервування замовлення',order_release:'Звільнення резерву',order_expire:'Звільнення простроченого резерву',order_close:'Закриття замовлення',order_expected_date:'Зміна очікуваної поставки'};
  Object.assign(actions,{initiative_create:'Створення проєкту з ідеї',initiative_edit:'Зміна плану проєкту',initiative_start:'Початок проєкту',initiative_complete:'Завершення проєкту',initiative_result_edit:'Виправлення результату',initiative_cancel:'Скасування проєкту',initiative_task_create:'Нова задача проєкту',initiative_task_link:'Пов’язування задачі з проєктом',initiative_task_update:'Стан задачі проєкту',initiative_expense_attach:'Пов’язування витрати з проєктом',initiative_expense_detach:'Відв’язування витрати від проєкту'});
  let activeAudit = null, activeSources = null;
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
      if(event.action.startsWith('initiative_'))return 'План, результат і пов’язані записи показано у змінах вище. Пов’язування не створює фінансових проводок.';
      return 'Опис події доступний у технічних подробицях.';
    }
    const businessLabels={name:'Назва',kind:'Вид документа',status:'Стан',date:'Облікова дата',store_id:'Магазин',warehouse_id:'Склад',target_id:'Склад призначення',party_id:'Контрагент',employee_id:'Працівник',account_id:'Рахунок',shift_id:'Касова зміна',cash_shift_id:'Касова зміна',reference_id:'Документ-підстава',total:'Сума, грн',cost:'Собівартість, грн',note:'Примітка',revision:'Версія',posted_at:'Час проведення',reversed_at:'Час скасування',type:'Група',category:'Категорія',pack:'Фасування',size:'Розмір',unit:'Одиниця',barcode:'Штрихкод',markup:'Націнка, %',price:'Звичайна ціна, грн',manualPrice:'Ручна ціна',promotion:'Акція',promotionPrice:'Акційна ціна, грн',priceAt:'Дата перегляду ціни',minStock:'Мінімальний залишок',hidden:'Приховано',active:'Активний',shift_rate:'Ставка за зміну, грн',bonus_percent:'Бонус, %',bonus_basis:'База бонусу',units:'Кількість змін',payroll_id:'Нарахування',basis_amount:'Сума бази бонусу, грн',accrued:'Нараховано, грн',lines:'Рядки документа',allocations:'Розподіли платежу',payload:'Умови документа',defaultMarkup:'Типова націнка, %',rounding:'Крок округлення',budgetStores:'Магазинів у бюджеті',stores:'Магазини (старе налаштування)',storeNames:'Назви магазинів',staleDays:'Строк перевірки ціни',group:'Група витрат',amount:'Сума, грн',state:'Стан виконання замовлення',expected_date:'Очікувана поставка',minimum_order_amount:'Мінімальна сума постачальника, грн',order_lines:'Виконання та резерв товарів',reservation:'Звільнення резерву'};
    Object.assign(businessLabels,{title:'Назва',state:'Стан',problem:'Проблема',hypothesis:'Гіпотеза',responsible_id:'Відповідальний (номер користувача)',planned_budget:'План бюджету, грн',actual_expenses:'Пов’язані проведені витрати, грн',metric:'Показник',metric_unit:'Одиниця показника',target_value:'Ціль',fact_value:'Фактичний показник',result_summary:'Опис результату',result_date:'Дата результату',cancel_reason:'Причина скасування',project_task_count:'Пов’язаних задач',project_expense_count:'Пов’язаних витрат',task:'Задача',phase:'Етап проєкту',voucher:'Документ витрати',attached:'Пов’язано з проєктом'});
    function businessValue(key,value) {
      if(value===undefined||value===null)return '—';
      if(typeof value==='boolean')return value?'Так':'Ні';
      if(key==='kind')return kinds[value]||({supplier:'Постачальник',customer:'Покупець',cash:'Готівка',bank:'Банк',terminal:'Термінал'})[value]||String(value);
      if(key==='bonus_basis')return ({store:'Виторг магазину',personal:'Особистий виторг',profit:'Валовий прибуток магазину'})[value]||String(value);
      if(key==='group')return ({fixed:'Постійні',variable:'Змінні'})[value]||String(value);
      if(key==='state')return ({draft:'Чернетка',approved:'Погоджено',partial:'Частково виконано',fulfilled:'Виконано',closed:'Закрито',cancelled:'Скасовано',planned:'Заплановано',active:'У роботі',completed:'Завершено'})[value]||String(value);
      if(key==='order_lines'&&Array.isArray(value))return value.map(row=>`${row.name||'Товар'}: замовлено ${row.quantity||'0'} ${row.unit||''}; виконано ${row.fulfilled||'0'}; залишилось ${row.remaining||'0'}; резерв ${row.reserved||'0'}`).join('\n')||'Немає товарів';
      if(key==='reservation'&&typeof value==='object')return `Партія ${value.code||'Без коду'}: ${value.quantity||'0'} ${value.unit||'од.'}; використано ${value.used||'0'}; звільнено ${value.released||'0'}; строк ${value.expires_on||'—'}; створив ${value.owner||'—'}`;
      if(key==='status')return ({todo:'Не почато',doing:'У роботі',done:'Готово',draft:'Чернетка',posted:'Проведено',reversed:'Скасовано'})[value]||String(value);
      const refs={store_id:'stores',warehouse_id:'warehouses',target_id:'warehouses',party_id:'parties',employee_id:'employees',account_id:'accounts'};
      if(refs[key])return name(refs[key],value)||String(value);
      if(key==='lines'&&Array.isArray(value))return value.map(row=>`${row.name||'Товар'}: ${row.quantity||'0'} ${row.unit||''} × ${row.price||'0'} грн; сума ${row.amount||'0'} грн; собівартість ${row.cost||'0'} грн${row.lot?'; партія '+row.lot:''}${row.expiry?'; придатний до '+row.expiry:''}${row.reference_line_id?'; вихідний рядок № '+row.reference_line_id:''}`).join('\n')||'Немає рядків';
      if(key==='allocations'&&Array.isArray(value))return value.map(row=>`Документ № ${row.source_id}: ${row.amount} грн із платежу № ${row.payment_id}`).join('\n')||'Немає розподілів';
      if(key==='payload'&&typeof value==='object') {
        const terms={category:'Стаття витрат',expense_scope:'Належність витрати',due_date:'Строк оплати',discount_reason:'Причина знижки',additional_cost:'Додаткові витрати',difference:'Касове розходження',fiscal_ref:'Номер чека',expected_date:'Очікувана поставка',minimum_order_amount:'Мінімум постачальника',order_revision:'Перевірена версія замовлення'};
        const lines=Object.entries(terms).filter(([field])=>Object.hasOwn(value,field)).map(([field,label])=>`${label}: ${field==='expense_scope'?(value[field]==='network'?'Мережа':'Магазин'):value[field]}`);
        if(Array.isArray(value.payments))lines.push(...value.payments.map(row=>`Оплата: ${name('accounts',row.account)||'Рахунок'} — ${row.amount} грн`));
        if(Array.isArray(value.differences))lines.push(...value.differences.map(row=>`Складське коригування: ${row.quantity} од.; ${row.value} грн`));
        if(Array.isArray(value.calculation))lines.push(...value.calculation.map(row=>`Нарахування за ${row.date}: ${row.units} змін × ${row.rate} грн, ${row.percent}% від ${row.basis_amount} грн; разом ${row.accrued} грн`));
        return lines.join('\n')||'Немає додаткових умов';
      }
      if(Array.isArray(value))return value.join(', ');
      if(typeof value==='object')return '—';
      return String(value);
    }
    function businessChanges(detail) {
      if(!detail||(!Object.hasOwn(detail,'before')&&!Object.hasOwn(detail,'after')))return '';
      const before=detail.before||{},after=detail.after||{};
      const numeric=new Set(['total','cost','markup','price','promotionPrice','minStock','shift_rate','bonus_percent','units','basis_amount','accrued','defaultMarkup','rounding','amount','minimum_order_amount']);
      const changed=key=>numeric.has(key)&&before[key]!==undefined&&after[key]!==undefined&&decimalKey(before[key])!==null&&decimalKey(after[key])!==null?decimalKey(before[key])!==decimalKey(after[key]):['lines','allocations','order_lines'].includes(key)?businessValue(key,before[key])!==businessValue(key,after[key]):JSON.stringify(before[key])!==JSON.stringify(after[key]);
      const rows=Object.entries(businessLabels).filter(([key])=>changed(key)).map(([key,label])=>[esc(label),`<span class="trade-business-value">${esc(businessValue(key,before[key]))}</span>`,`<span class="trade-business-value">${esc(businessValue(key,after[key]))}</span>`]);
      return `<div data-business-changes><p><strong>${detail.before===null?'Створено запис':detail.after===null?'Видалено запис':'Зміни бізнесових даних'}</strong></p>${rows.length?table(['Поле','Було','Стало'],rows):'<p class="muted">Бізнесові поля не змінилися.</p>'}${detail.expires_on?`<p>Резерв діє включно до ${esc(detail.expires_on)} за Києвом.</p>`:''}${detail.reason?`<p>Причина: ${esc(detail.reason)}</p>`:''}${detail.observed_revision!==undefined?`<p class="muted">Зміна спиралася на перевірену версію запису.</p>`:''}</div>`;
    }
    function auditDetails(event) {
      return `${businessChanges(event.detail)}${event.action.startsWith('initiative_')&&event.detail?.related_change?`<h4>Пов’язана задача або витрата</h4>${businessChanges(event.detail.related_change)}`:''}<div data-audit-summary>${esc(auditSummary(event))}</div><details data-audit-technical><summary aria-label="Технічні подробиці події № ${esc(event.id)}" style="min-height:44px;padding:10px 0;box-sizing:border-box;cursor:pointer;scroll-margin-block:8px">Технічні подробиці</summary><div class="trade-history" style="text-align:left">Дія: ${esc(event.action)}</div><pre class="trade-history" style="margin:8px 0 0;text-align:left;font:12px/1.5 ui-monospace,monospace">${esc(JSON.stringify(event.detail,null,2))}</pre></details>`;
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
    const sourceLabels={revenue:'Виторг',cogs:'Собівартість',expenses:'Витрати',payroll:'Зарплата',writeoffs:'Списання',inventory_adjustment:'Інвентаризація',supplier_return_variance:'Повернення постачальнику',cash_difference:'Касове розходження',cash_net:'Рух коштів',unallocated_expenses:'Мережеві витрати',stock:'Товар',cash:'Кошти'};
    const decimalKey=value=>{const match=/^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));if(!match)return null;return (match[1]&&BigInt(match[2]+(match[3]||''))!==0n?'-':'')+match[2].replace(/^0+(?=\d)/,'')+'.'+(match[3]||'').replace(/0+$/,'');};
    function sourceData(data) {
      const positive=value=>Number.isSafeInteger(value)&&value>0;
      if(!data||data.snapshot!=='current'||typeof data.title!=='string'||typeof data.formula!=='string'||typeof data.snapshot_notice!=='string'||typeof data.amount!=='string'||decimalKey(data.amount)===null||!positive(data.page)||!positive(data.pages)||!Number.isSafeInteger(data.total)||data.total<0||!Array.isArray(data.items)||data.items.length>30||!data.items.every(row=>row&&['voucher','aggregate'].includes(row.type)&&typeof row.amount==='string'&&decimalKey(row.amount)!==null&&typeof row.metric==='string'&&typeof row.canOpen==='boolean'&&(row.type==='aggregate'?typeof row.label==='string'&&!row.canOpen:typeof row.kind==='string'&&typeof row.date==='string'&&typeof row.reversal==='boolean'&&(!row.canOpen||positive(row.voucher)&&typeof row.number==='string'))))throw Error('Сервер повернув некоректну розшифровку. Повторіть завантаження.');
      return data;
    }
    function reportSources(params,expected,onOpen) {
      activeSources?.close();const opener=document.activeElement,d=document.createElement('dialog');d.className='trade-dialog';d.dataset.reportSources='';d.setAttribute('aria-labelledby','tradeReportSourcesTitle');
      d.innerHTML='<div class="trade-dialog-head"><h2 id="tradeReportSourcesTitle" tabindex="-1">Розшифровка показника</h2><button class="btn soft" type="button" data-source-close>Закрити</button></div><div class="trade-dialog-body"><p role="alert" tabindex="-1" data-source-error class="trade-error"></p><div data-source-content></div><div class="trade-pagination"><span role="status" aria-live="polite" tabindex="-1" data-source-status></span><div class="row"><button class="btn soft" type="button" data-source-page="prev">Назад</button><button class="btn soft" type="button" data-source-page="next">Далі</button></div></div></div>';
      document.body.append(d);activeSources=d;d.showModal();d.querySelector('h2').focus();
      const content=d.querySelector('[data-source-content]'),status=d.querySelector('[data-source-status]'),error=d.querySelector('[data-source-error]');let page=1,pages=1,controller,generation=0,busy=false,failed=false;
      const live=()=>d.open&&d.isConnected&&activeSources===d;
      const paging=()=>d.querySelectorAll('[data-source-page]').forEach(button=>button.disabled=busy||failed||(button.dataset.sourcePage==='prev'?page<=1:page>=pages));
      async function load(focus=false) {
        controller?.abort();controller=new AbortController();const token=++generation;busy=true;failed=false;content.setAttribute('aria-busy','true');content.innerHTML='';error.textContent='';status.textContent='Завантажуємо джерела…';paging();
        try {
          const data=sourceData(await api('report/drilldown?'+new URLSearchParams({...params,page:String(page)}),'GET',undefined,controller.signal));
          if(!live()||token!==generation)return;page=data.page;pages=data.pages;d.querySelector('h2').textContent=data.title+' — джерела';
          const changed=decimalKey(expected)!==null&&decimalKey(expected)!==decimalKey(data.amount);
          content.innerHTML=`<p><strong>Поточна сума: ${amount(data.amount)} грн</strong></p>${changed?`<p class="trade-source-changed" role="status">Дані змінилися: у відкритому звіті було ${amount(expected)} грн. Оновіть звіт для актуальних показників.</p>`:''}<p>${esc(data.formula)}</p><p class="trade-caption">${esc(data.snapshot_notice)} Сторно враховано київською датою скасування. Знак суми показує внесок у вибраний показник.</p>${table(['Джерело / дата','Складова','Внесок','Дія'],data.items.map(row=>[row.type==='aggregate'?esc(row.label):`${esc(kinds[row.kind]||'Документ')}${row.number?' № '+esc(row.number):''}<span class="muted">${esc(row.date)}${row.reversal?' · скасування':''}</span>`,esc(sourceLabels[row.metric]||row.metric),amount(row.amount)+' грн',row.canOpen?`<button class="btn soft" type="button" data-source-voucher="${row.voucher}" aria-label="Відкрити документ № ${esc(row.number)}">Документ</button>`:'<span class="muted">Сукупна сума або обмежений доступ</span>']))}`;
          status.textContent=data.total?`Сторінка ${page} з ${pages} · джерел ${data.total}`:'За умовами немає джерел.';if(focus)status.focus({preventScroll:true});
        }catch(e){if(e.name==='AbortError'||!live()||token!==generation)return;failed=true;error.textContent=e.message;content.innerHTML='<button class="btn soft" type="button" data-source-retry>Завантажити повторно</button>';status.textContent='Не вдалося завантажити джерела.';if(focus)error.focus({preventScroll:true});}
        finally {if(live()&&token===generation){busy=false;content.removeAttribute('aria-busy');paging();}}
      }
      d.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled)return;if(button.hasAttribute('data-source-close'))d.close();else if(button.hasAttribute('data-source-retry'))void load(true);else if(button.hasAttribute('data-source-page')){page+=button.dataset.sourcePage==='next'?1:-1;void load(true);}else if(button.hasAttribute('data-source-voucher')){const id=Number(button.dataset.sourceVoucher);d.close();void onOpen(id);}});
      d.addEventListener('close',()=>{controller?.abort();generation++;if(activeSources===d)activeSources=null;d.remove();if(opener?.isConnected)opener.focus({preventScroll:true});},{once:true});void load();
    }
    const formFocus=d=>d.querySelector('[name=q]').focus();
    return {shell,mount,audit,reportSources,closeAudit(){activeAudit?.close();activeSources?.close();}};
  }
  window.TradeFinance={create};
})();
