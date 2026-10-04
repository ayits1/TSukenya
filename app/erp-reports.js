/* Independent bounded reads; accounting, roles and CSV remain authoritative on Django. */
(()=>{'use strict';
const contract='trading-reports-v1',moneyKeys=['revenue','cogs','expenses','payroll','writeoffs','inventory_adjustment','supplier_return_variance','cash_difference','cash_net','gross_profit','profit','unallocated_expenses'];
const sections={period:['products','by_store','expenses_by_category','cashiers'],balances:['stock','cash','debts','advances','payroll_debts']};
const titles={products:'Товари',by_store:'Магазини',expenses_by_category:'Статті витрат',cashiers:'Касири',stock:'Товарні залишки',cash:'Кошти',debts:'Історичні борги',advances:'Аванси',payroll_debts:'Борги із зарплати'};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min,string=v=>typeof v==='string',decimal=(v,scale=2)=>string(v)&&new RegExp('^-?[0-9]+\\.[0-9]{'+scale+'}$').test(v),nullable=(v,check)=>v===null||check(v);
const fail=()=>{throw Error('Сервер повернув некоректний звіт. Повторіть читання.');};
const keys=(v,required,optional=[])=>object(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const day=v=>string(v)&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
const textFields={products:['product','name','unit'],by_store:['name'],expenses_by_category:['category','scope'],cashiers:['name'],stock:['code','warehouse_name','product','name','unit'],cash:['name','kind'],debts:['number','kind','original_kind','date','party','due_date'],advances:['number','party','direction','date'],payroll_debts:['name']};
const numericFields={products:['quantity','revenue','cogs','writeoff_quantity','writeoff','inventory','gross_profit','result'],by_store:moneyKeys.filter(k=>k!=='unallocated_expenses'),expenses_by_category:['amount'],cashiers:['shortage','surplus','revenue','hours','net'],stock:['quantity','value'],cash:['amount'],debts:['total','amount'],advances:['amount'],payroll_debts:['amount']};
const idFields={products:[],by_store:['store'],expenses_by_category:['store'],cashiers:['employee'],stock:['lot','warehouse','store'],cash:['account','store'],debts:['voucher','store','party_id'],advances:['payment','store','party_id'],payroll_debts:['employee','store']};
const extras={products:['margin'],by_store:[],expenses_by_category:['store_name'],cashiers:['shifts','with_difference','revenue_per_hour'],stock:['expiry','expired'],cash:[],debts:['overdue'],advances:[],payroll_debts:[]};
function summary(v,expected={}){
 const common=['contract','mode','store','scope_name','generated_at','basis','reversal_policy','snapshot','snapshot_notice','counts','can_view_payroll'];
 if(!object(v)||!sections[v.mode])fail();
 const required=v.mode==='period'?[...common,'from','to',...moneyKeys,'cashiers_basis','debts_basis']:[...common,'as_of','stock_value','cash_total','debt_totals','advance_totals'];
 if(!keys(v,required)||v.contract!==contract||v.basis!=='accounting_dates'||v.reversal_policy!=='kyiv_reversed_at'||v.snapshot!=='current'||!string(v.scope_name)||!string(v.snapshot_notice)||!string(v.generated_at)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v.generated_at)||!Number.isFinite(Date.parse(v.generated_at))||!nullable(v.store,x=>integer(x,1))||typeof v.can_view_payroll!=='boolean')fail();
 if(expected.mode&&v.mode!==expected.mode||Object.hasOwn(expected,'store')&&v.store!==(expected.store?Number(expected.store):null))fail();
 const available=sections[v.mode].filter(s=>s!=='payroll_debts'||v.can_view_payroll);
 if(!keys(v.counts,available)||!Object.values(v.counts).every(x=>integer(x)))fail();
 if(v.mode==='period'){
  if(!day(v.from)||!day(v.to)||v.from>v.to||!moneyKeys.every(k=>decimal(v[k]))||v.cashiers_basis!=='current_posted_closed_shifts'||v.debts_basis!=='current'||expected.from&&v.from!==expected.from||expected.to&&v.to!==expected.to)fail();
 }else if(!day(v.as_of)||expected.as_of&&v.as_of!==expected.as_of||!decimal(v.stock_value)||!decimal(v.cash_total)||!keys(v.debt_totals,['owed_to_us','owed_by_us'])||!Object.values(v.debt_totals).every(x=>decimal(x))||!keys(v.advance_totals,['customer','supplier'])||!Object.values(v.advance_totals).every(x=>decimal(x)))fail();
 return v;
}
function row(v,section,canPayroll){
 const required=[...textFields[section],...numericFields[section],...idFields[section],...extras[section]];
 if(!keys(v,required,section==='cashiers'&&canPayroll?['late_return_bonus']:[]))fail();
 if(!textFields[section].every(k=>string(v[k]))||!numericFields[section].every(k=>decimal(v[k],k==='quantity'||k==='writeoff_quantity'?3:k==='hours'?1:2)))fail();
 if(!idFields[section].every(k=>nullable(v[k],x=>integer(x,1))&&(v[k]!==null||section==='cashiers'||section==='expenses_by_category')))fail();
 if(section==='products'&&!nullable(v.margin,x=>decimal(x,1))||section==='cashiers'&&(!integer(v.shifts)||!integer(v.with_difference)||!nullable(v.revenue_per_hour,decimal)||canPayroll&&!decimal(v.late_return_bonus))||section==='stock'&&(!nullable(v.expiry,day)||typeof v.expired!=='boolean')||section==='debts'&&(!day(v.date)||v.due_date&&!day(v.due_date)||!['sale','receipt'].includes(v.kind)||!['sale','receipt','debt_opening'].includes(v.original_kind)||typeof v.overdue!=='boolean')||section==='advances'&&(!day(v.date)||!['customer','supplier'].includes(v.direction))||section==='expenses_by_category'&&(!['store','network'].includes(v.scope)||!nullable(v.store_name,string)))fail();
 return v;
}
function page(v,expected){
 if(!keys(v,['contract','section','items','total','page','pages','limit','q','summary'])||v.contract!==contract||v.section!==expected.section||!integer(v.total)||!integer(v.page,1)||!integer(v.pages,1)||v.limit!==30||v.pages!==Math.max(1,Math.ceil(v.total/30))||v.page>v.pages||!string(v.q)||v.q!==(expected.q||'').trim()||!Array.isArray(v.items)||v.items.length!==Math.min(30,Math.max(0,v.total-(v.page-1)*30)))fail();
 summary(v.summary,expected);if(!Object.hasOwn(v.summary.counts,v.section)||v.total>v.summary.counts[v.section]||!v.q&&v.total!==v.summary.counts[v.section])fail();
 v.items.forEach(x=>row(x,v.section,v.summary.can_view_payroll));
 const identity=r=>v.section==='expenses_by_category'?JSON.stringify([r.store,r.category]):v.section==='cashiers'?JSON.stringify([r.employee,r.employee===null?r.name:null]):String(r[({products:'product',by_store:'store',stock:'lot',cash:'account',debts:'voucher',advances:'payment',payroll_debts:'employee'})[v.section]]);
 if(new Set(v.items.map(identity)).size!==v.items.length)fail();return v;
}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function money(v){
 if(!decimal(v))fail();const negative=v.startsWith('-'),[whole,fraction]=v.replace(/^-/,'').split('.');
 return (negative?'−':'')+new Intl.NumberFormat('uk-UA',{maximumFractionDigits:0}).format(BigInt(whole))+','+fraction;
}
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const fieldLabel=k=>({revenue:'Виторг',cogs:'Собівартість',expenses:'Витрати',payroll:'Зарплата',writeoffs:'Списання',inventory_adjustment:'Інвентаризаційне коригування',supplier_return_variance:'Різниця повернень постачальнику',cash_difference:'Касове розходження',cash_net:'Чистий рух коштів',gross_profit:'Валовий прибуток',profit:'Операційний результат',unallocated_expenses:'Мережеві нерозподілені витрати'})[k];
function table(headers,rows){return rows.length?`<div class="trade-table-wrap"><table class="trade-table"><thead><tr>${headers.map(x=>`<th scope="col">${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map((c,i)=>`<td data-label="${esc(headers[i])}"><div class="trade-cell">${c}</div></td>`).join('')}</tr>`).join('')}</tbody></table></div>`:'<p class="trade-empty">За цими умовами рядків немає.</p>';}
function create(options={}){
 let active=null,stored=null;
 async function request(endpoint,params,signal){
  const result=await fetch('/api/v1/trading/reports/'+endpoint+'?'+new URLSearchParams(params),{credentials:'same-origin',signal,headers:{Accept:'application/json'}});
  if(!result.ok){const error=Error(result.status===401?'Сеанс завершився.':result.status===403?'Звіт недоступний за чинними правами.':'Не вдалося прочитати звіт. Повторіть запит.');error.status=result.status;throw error;}
  try{const value=await result.json();return endpoint==='summary'?summary(value,params):page(value,params);}catch(error){error.protocol=true;throw error;}
 }
 function mount(host,initial={}){
  active?.cancel();const date=today(),context={mode:'period',store:'',from:date.slice(0,8)+'01',to:date,as_of:date,...(stored||{}),...initial};
  const listeners=new AbortController();
  let confirmed=null;
  let qDraft='',section=context.mode==='balances'?'stock':'products',read=null,latest=null,sequence=0,cancelled=false,controller=null,debtControl=null,lastDebtContext=null,lastIntent={page:1,q:''};
  const params=()=>({mode:context.mode,store:String(context.store||''),...(context.mode==='balances'?{as_of:context.as_of}:{from:context.from,to:context.to})});
  const live=()=>!cancelled&&host.isConnected;
  function source(label,metric,value,id){return `<button type="button" class="btn soft" data-report-source data-metric="${metric}" data-value="${esc(value)}" ${id?`data-source="${id}"`:''}>${esc(label)}</button>`;}
  function csv(section,q=''){return `/api/v1/trading/reports/export.csv?${new URLSearchParams({...params(),section,q})}`;}
  function details(row){return `<details class="trade-store-result"><summary>Розрахунок результату</summary><dl>${moneyKeys.filter(k=>k!=='unallocated_expenses').map(k=>`<div><dt>${fieldLabel(k)}</dt><dd>${money(row[k])} грн</dd></div>`).join('')}</dl></details>`;}
  function rowTable(data){
   const rows=data.items,s=data.section,headers={products:['Товар','Кількість','Виторг','Валовий прибуток','Маржа','Результат','Складові'],by_store:['Магазин','Виторг','Результат','Складові'],expenses_by_category:['Стаття','Належність','Сума'],cashiers:['Касир','Змін / годин','З розходженням','Виторг','На годину','Нестача','Надлишок','Разом',...(data.summary.can_view_payroll?['Бонус пізніх повернень']:[])],stock:['Товар','Склад / партія','Кількість','Вартість','Термін','Джерела'],cash:['Рахунок','Тип','Залишок','Джерела'],debts:['Документ / дата','Контрагент','Напрям','Борг','Строк'],advances:['Платіж / дата','Контрагент','Напрям','Аванс'],payroll_debts:['Працівник','Борг із зарплати']};
   return table(headers[s],rows.map(r=>{
    if(s==='products')return [esc(r.name),esc(r.quantity.replace('.',','))+' '+esc(r.unit),money(r.revenue),money(r.gross_profit),r.margin===null?'—':esc(r.margin.replace('.',','))+'%',money(r.result),`<details class="trade-store-result"><summary>Собівартість і коригування</summary><dl><div><dt>Собівартість продажів</dt><dd>${money(r.cogs)} грн</dd></div><div><dt>Списано</dt><dd>${esc(r.writeoff_quantity.replace('.',','))} ${esc(r.unit)} · ${money(r.writeoff)} грн</dd></div><div><dt>Інвентаризаційне коригування</dt><dd>${money(r.inventory)} грн</dd></div></dl></details>`];
    if(s==='by_store')return [esc(r.name),money(r.revenue),money(r.profit),details(r)];
    if(s==='expenses_by_category')return [esc(r.category),r.scope==='network'?'Мережева — без розподілу':esc(r.store_name||('Магазин № '+r.store)),money(r.amount)];
    if(s==='cashiers')return [esc(r.name),`${r.shifts} / ${esc(r.hours.replace('.',','))}`,String(r.with_difference),money(r.revenue),r.revenue_per_hour===null?'—':money(r.revenue_per_hour),money(r.shortage),money(r.surplus),money(r.net),...(data.summary.can_view_payroll?[money(r.late_return_bonus)]:[])];
    if(s==='stock')return [esc(r.name),`${esc(r.warehouse_name)}<span class="muted">${esc(r.code)}</span>`,esc(r.quantity.replace('.',','))+' '+esc(r.unit),money(r.value),r.expiry?`<span class="${r.expired?'trade-error':''}">${esc(r.expiry)}</span>`:'Без терміну',source('Рухи партії','stock',r.value,r.lot)];
    if(s==='cash')return [esc(r.name),esc(({cash:'Готівка',bank:'Банк',terminal:'Термінал'})[r.kind]||r.kind),money(r.amount),source('Рухи рахунку','cash',r.amount,r.account)];
    if(s==='debts')return [esc(r.number)+'<span class="muted">'+esc(r.date)+'</span>',esc(r.party),r.kind==='sale'?'Нам винні':'Ми винні',money(r.amount),r.due_date?`<span class="${r.overdue?'trade-error':''}">${esc(r.due_date)}</span>`:'Не задано'];
    if(s==='advances')return [esc(r.number)+'<span class="muted">'+esc(r.date)+'</span>',esc(r.party),r.direction==='customer'?'Клієнтський':'Постачальнику',money(r.amount)];
    return [esc(r.name),money(r.amount)];
   }));
  }
  function cards(v){
   const items=v.mode==='period'?['revenue','cogs','gross_profit','profit','expenses','payroll','cash_net'].map(k=>[fieldLabel(k),v[k]]):[['Товар на дату',v.stock_value],['Кошти на дату',v.cash_total],['Нам винні',v.debt_totals.owed_to_us],['Ми винні',v.debt_totals.owed_by_us],['Аванси клієнтів',v.advance_totals.customer],['Аванси постачальникам',v.advance_totals.supplier]];
   return '<div class="trade-report-cards"><div class="trade-grid">'+items.map(([label,value])=>`<div class="trade-card"><span>${esc(label)}</span><strong>${money(value)} грн</strong></div>`).join('')+'</div></div>';
  }
  function render(){
   if(!live())return;window.ReactABCReport?.leave();options.dispose?.(host);debtControl?.cancel();debtControl=null;lastDebtContext=null;
   host.innerHTML=`<section class="panel"><div class="trade-report-tabs" role="tablist" aria-label="Режим фінансового звіту">${[['period','Обороти періоду'],['balances','Залишки на дату'],['abc','ABC товарів']].map(([mode,label])=>`<button class="btn ${mode===context.mode?'':'soft'}" type="button" role="tab" id="bounded-report-mode-${mode}" data-report-mode="${mode}" aria-selected="${mode===context.mode}" aria-controls="boundedReportResult" tabindex="${mode===context.mode?0:-1}">${label}</button>`).join('')}</div><form data-report-form class="trade-report-form"><fieldset data-report-filters class="trade-report-fields">${context.mode==='balances'?`<label>Станом на дату включно<input class="ui-input" type="date" name="as_of" value="${context.as_of}" required max="${date}"></label>`:`<label>З<input class="ui-input" type="date" name="from" value="${context.from}" required max="${date}"></label><label>По<input class="ui-input" type="date" name="to" value="${context.to}" required max="${date}"></label>`}${options.storeControl?.(context.store)||''}<button class="btn" type="submit">Показати</button></fieldset></form><p class="trade-saving" role="status" data-report-status aria-live="polite"></p><p class="trade-error" role="alert" data-report-error tabindex="-1"></p><button class="btn soft" type="button" data-report-retry hidden>Повторити читання</button><div data-report-summary></div><div data-report-body id="boundedReportResult" role="tabpanel" aria-labelledby="bounded-report-mode-${context.mode}"></div></section><div data-report-debts></div>`;
   if(context.mode==='abc'){host.querySelector('[data-report-form]').remove();host.querySelector('[data-report-error]').remove();host.querySelector('[data-report-retry]').remove();host.querySelector('[data-report-status]').textContent='Завантаження ABC-аналітики…';mountABC();return;}
   options.bind?.(host,context.store);show();
  }
  function mountABC(){
   if(!live()||context.mode!=='abc')return;
   if(window.ReactABCReport){host.querySelector('[data-report-status]').textContent='';window.ReactABCReport.mount(host.querySelector('[data-report-body]'),{store:String(context.store||''),from:context.from,to:context.to,onFilters:filters=>{if(live()&&context.mode==='abc'){context.store=filters.store;context.from=filters.from;context.to=filters.to;options.onStore?.(context.store);}}});}
   else host.querySelector('[data-report-status]').textContent='Модуль ABC ще недоступний. Оновіть сторінку або повторіть відкриття режиму.';
  }
  window.addEventListener('tsukenya:abc-ready',mountABC,{signal:listeners.signal});
  function show(){
   if(!live())return;const sum=host.querySelector('[data-report-summary]'),body=host.querySelector('[data-report-body]');
   if(!latest){sum.innerHTML='';body.innerHTML='';debtControl?.cancel();debtControl=null;lastDebtContext=null;host.querySelector('[data-report-debts]').innerHTML='';return;}
   const p=latest,available=Object.keys(p.counts);if(!available.includes(section))section=available[0];
   sum.innerHTML=`${cards(p)}<p class="trade-caption">${esc(p.scope_name)} · ${p.mode==='balances'?'Стан на кінець '+esc(p.as_of):esc(p.from)+' — '+esc(p.to)}. За обліковими датами; сторно — київською датою скасування. Назви — чинні.</p><p class="trade-caption">${esc(p.snapshot_notice)} Читання: ${esc(p.generated_at)}.</p>${p.mode==='period'?`<p class="trade-caption">Закупівля створює запаси; собівартість потрапляє у результат під час продажу. Кредитний продаж входить у виторг, оплата — у рух коштів. Результат управлінський, до податків.</p><p class="trade-caption">Мережеві нерозподілені витрати: ${money(p.unallocated_expenses)} грн. Сума результатів магазинів мінус ця сума дорівнює результату мережі.</p><details class="trade-report-source-actions"><summary>Розшифрувати показники</summary><div class="row">${moneyKeys.map(k=>source(fieldLabel(k),k,p[k])).join('')}</div></details>`:''}<a class="btn soft" data-report-export href="${csv(p.mode==='balances'?'all':'summary')}" download>${p.mode==='balances'?'CSV усіх залишків':'CSV підсумків'}</a>`;
   body.innerHTML=`<div class="trade-subnav" role="tablist" aria-label="Секції звіту">${available.map(s=>`<button type="button" class="btn ${s===section?'':'soft'}" role="tab" id="bounded-report-section-${s}" data-report-section="${s}" aria-selected="${s===section}" aria-controls="boundedReportRows" tabindex="${s===section?0:-1}">${titles[s]} · ${p.counts[s]}</button>`).join('')}</div><div id="boundedReportRows" role="tabpanel" aria-labelledby="bounded-report-section-${section}"><form data-report-search class="trade-toolbar"><label>Пошук у секції<input type="search" name="q" maxlength="250" value="${esc(qDraft)}"></label><button class="btn soft" type="submit">Знайти</button><a class="btn soft" data-report-export href="${csv(section,read?.q||'')}" download>CSV усієї секції</a></form>${section==='cashiers'?`<p class="trade-caption">Оперативна статистика чинних проведених документів закритих за період змін. На годину — лише для змін від 6 хв. ${p.can_view_payroll?'Бонус пізніх повернень уже нарахований і остаточний; попередні повернення споживають ту саму базу. Рядок із 0 змін може стосуватися повернення старої зміни.':''}</p>`:''}${read?`<p class="trade-caption">Результати: ${read.q?esc(read.q):'без пошуку'}. ${qDraft.trim()!==read.q?'Новий пошук застосуйте кнопкою «Знайти».':''}</p>`:''}${read?rowTable(read):'<p role="status">Завантаження секції…</p>'}<div class="trade-toolbar" data-report-pager>${read?`<button class="btn soft" type="button" data-report-page="${read.page-1}" ${read.page===1?'disabled':''}>Попередня</button><span role="status">Сторінка ${read.page} із ${read.pages} · ${read.total} рядків</span><button class="btn soft" type="button" data-report-page="${read.page+1}" ${read.page===read.pages?'disabled':''}>Наступна</button>`:''}</div></div>`;
   const debtHost=host.querySelector('[data-report-debts]'),debtContext=context.mode+':'+context.store;
   if(lastDebtContext!==debtContext){
    debtControl?.cancel();debtControl=null;lastDebtContext=debtContext;
    if(context.mode==='period'&&options.debts){debtHost.innerHTML='<section class="panel"><h3>Поточна заборгованість</h3><p class="trade-caption">Незалежно від періоду. Борги на вибрану дату — у «Залишки на дату».</p>'+options.debts.shell('debts','bounded-report-debts',{store:context.store,fixedStore:true})+'</section>';debtControl=options.debts.mount(debtHost.querySelector('[data-finance]'),{store:context.store});}else debtHost.innerHTML='';
   }
  }
  async function load(pageNumber=1,q='',focus=''){
   if(context.mode==='abc')return;
   lastIntent={page:pageNumber,q};controller?.abort();controller=new AbortController();const token=++sequence,signal=controller.signal,contextRead=params();
   host.querySelector('[data-report-form]').setAttribute('aria-busy','true');host.querySelector('[data-report-filters]').disabled=true;
   host.querySelector('[data-report-error]').textContent='';host.querySelector('[data-report-status]').textContent='Обчислення звіту…';host.querySelector('[data-report-retry]').hidden=true;
   host.querySelectorAll('[data-report-export]').forEach(a=>{a.removeAttribute('href');a.setAttribute('aria-disabled','true');});host.querySelectorAll('[data-report-source],[data-report-page]').forEach(b=>b.disabled=true);
   try{
    if(!latest){const value=await request('summary',contextRead,signal);if(!live()||token!==sequence)return;latest=value;show();}
    const value=await request('rows',{...contextRead,section,page:String(pageNumber),q},signal);if(!live()||token!==sequence)return;latest=value.summary;read=value;confirmed={summary:latest,read,context:{...contextRead}};stored={...context};const moveFocus=focus&&(document.activeElement===document.body||document.activeElement?.matches(focus));show();host.querySelector('[data-report-status]').textContent='Підсумки охоплюють увесь контекст; таблиця — одну сторінку.';
    if(moveFocus)host.querySelector(focus)?.focus();
   }catch(error){if(error.name==='AbortError'||!live()||token!==sequence)return;
    if(error.status===401){confirmed=latest=read=null;show();host.querySelector('[data-report-error]').textContent=error.message;host.querySelector('[data-report-retry]').hidden=true;location.href='/';return;}
    const safe=error.status!==403&&!error.protocol&&confirmed&&confirmed.context.mode===contextRead.mode&&confirmed.context.store===contextRead.store;
    if(safe){latest=confirmed.summary;read=confirmed.read;section=read.section;}else{latest=read=null;confirmed=null;}
    show();host.querySelector('[data-report-error]').textContent=error.message;
    host.querySelector('[data-report-status]').textContent=safe?'Показано попередній підтверджений звіт за датами у підсумках. Нові умови не застосовано. CSV і джерела вимкнено до успішного читання.':'';
    host.querySelectorAll('[data-report-export]').forEach(a=>{a.removeAttribute('href');a.setAttribute('aria-disabled','true');});host.querySelectorAll('[data-report-source],[data-report-page]').forEach(b=>b.disabled=true);
    host.querySelector('[data-report-retry]').hidden=false;}
   finally{if(live()&&token===sequence){host.querySelector('[data-report-form]').setAttribute('aria-busy','false');host.querySelector('[data-report-filters]').disabled=false;}}
  }
  host.addEventListener('submit',event=>{
   const form=event.target;if(!live()||!host.contains(form))return;
   if(form.matches('[data-report-form]')){event.preventDefault();if(!form.reportValidity())return;Object.assign(context,Object.fromEntries(new FormData(form)));options.onStore?.(context.store);latest=read=null;void load();}
   if(form.matches('[data-report-search]')){event.preventDefault();qDraft=new FormData(form).get('q');void load(1,qDraft.trim());}
  },{signal:listeners.signal});
  host.addEventListener('input',event=>{if(live()&&event.target.name==='q'&&event.target.closest('[data-report-search]'))qDraft=event.target.value;},{signal:listeners.signal});
  host.addEventListener('click',event=>{
   const button=event.target.closest('button');if(!live()||!button||!host.contains(button))return;
   if(button.dataset.reportMode){const previousForm=host.querySelector('[data-report-form]');if(previousForm)Object.assign(context,Object.fromEntries(new FormData(previousForm)));controller?.abort();sequence++;context.mode=button.dataset.reportMode;section=context.mode==='balances'?'stock':'products';latest=read=null;qDraft='';render();host.querySelector(`[data-report-mode="${context.mode}"]`)?.focus();void load(1,'',`[data-report-mode="${context.mode}"]`);}
   if(button.dataset.reportSection){section=button.dataset.reportSection;read=null;qDraft='';show();host.querySelector(`[data-report-section="${section}"]`)?.focus();void load(1,'',`[data-report-section="${section}"]`);}
   if(button.dataset.reportPage)void load(Number(button.dataset.reportPage),read?.q||'', '[data-report-pager] button:not([disabled])');
   if(button.hasAttribute('data-report-retry'))void load(lastIntent.page,lastIntent.q);
   if(button.hasAttribute('data-report-source')&&latest)options.sources?.({...params(),metric:button.dataset.metric,...(button.dataset.source?{source:button.dataset.source}:{})},button.dataset.value);
  },{signal:listeners.signal});
  host.addEventListener('keydown',event=>{
   const tab=event.target.closest('[role=tab]');if(!live()||!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
   event.preventDefault();const tabs=[...tab.closest('[role=tablist]').querySelectorAll('[role=tab]')],i=tabs.indexOf(tab),next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];next.focus();next.click();
  },{signal:listeners.signal});
  render();void load();const control={cancel(){window.ReactABCReport?.leave();cancelled=true;sequence++;listeners.abort();controller?.abort();debtControl?.cancel();options.dispose?.(host);}};active=control;return control;
 }
 return {mount,cancel(){active?.cancel();active=null;}};
}
window.TradeReports={create,decodeSummary:summary,decodePage:page,formatMoney:money};
})();
