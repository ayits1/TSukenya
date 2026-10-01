(function(){
  const STAGES = [
    {n:1, name:"База товарів і витрат"},
    {n:2, name:"Цінники з накладних"},
    {n:3, name:"Міні-CRM"},
    {n:4, name:"Інтернет-вітрина"}
  ];
  const S = {settings:{}, project:{}, tasks:[], ideas:[], products:[], allProducts:[], expenses:[], tagSel:new Set(), tagQty:{}, catalogPage:1, catalogPageSize:20, F:{prod:newF(), tags:newF()}};
  const TYPES = ["Напої","Цукерки","Печиво і вафлі","Торти і десерти","Інше"];
  const NOTYPE = "Без типу";
  const typeOf = p => p.type || NOTYPE;
  const allTypes = () => [...TYPES, ...new Set(S.products.map(typeOf).filter(t=>t!==NOTYPE && !TYPES.includes(t)))];
  const typeRank = t => { const i = allTypes().indexOf(t); return i<0 ? 999 : i; };
  const sortByType = list => { const ranks=new Map(allTypes().map((t,i)=>[t,i])); return list.slice().sort((a,b)=> (ranks.get(typeOf(a))??999)-(ranks.get(typeOf(b))??999) || String(a.category||"").localeCompare(String(b.category||""),"uk") || String(a.name).localeCompare(String(b.name),"uk")); };
  const typeOpts = cur => { const l = allTypes(); if (cur && cur!==NOTYPE && !l.includes(cur)) l.push(cur); return (cur===NOTYPE?`<option value="" selected>${NOTYPE}</option>`:"") + l.map(t=>`<option ${t===cur?"selected":""}>${esc(t)}</option>`).join(""); };
  let db = null, downloads = null, mcp = null, tab = "overview", workspace = "operations", pending = false;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money = v => (Math.round(v*100)/100).toLocaleString("uk-UA",{minimumFractionDigits:2,maximumFractionDigits:2});
  const money0 = v => Math.round(v).toLocaleString("uk-UA");
  const countWord = (n,one,few,many) => n%100>=11&&n%100<=14 ? many : n%10===1 ? one : n%10>=2&&n%10<=4 ? few : many;
  const num = v => { const x = parseFloat(String(v).replace(",", ".")); return isFinite(x) ? x : 0; };

  /* ---------- filters model ---------- */
  const NOPACK = "Без пакування", NOSIZE = "Без розміру", NOCAT = "Без категорії";
  const UNITS = [["шт","шт — штука"],["кг","кг — кілограм (ваговий)"],["100 г","100 г"],["уп","уп — упаковка"],["пач","пач — пачка"],["кор","кор — коробка"],["л","л — літр (розлив)"],["порц","порц — порція"],["набір","набір"]];
  const unitOpts = v => (UNITS.some(u=>u[0]===v) ? UNITS : [[v,v],...UNITS]).map(([k,l])=>`<option value="${esc(k)}" ${k===v?"selected":""}>${esc(k)}</option>`).join("");
  const unitPhrase = u => { u = u || "шт"; return u==="100 г" ? "грн за 100 г" : `грн за 1 ${u}`; };
  const PACKS = ["Банка","ПЕТ","Скло","Стакан","Коробка","Пакет","Упаковка","Ваговий","Штучно"];
  const CUPS = ["S","M","L","XL","XXL","3XL"];
  const PRICE_LABEL = {ok:"Актуальна ціна", stale:"Застаріла ціна", none:"Немає ціни"};
  const today = () => {const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;};
  const catKey = p => p.category || NOCAT;
  const packKey = p => p.pack || NOPACK;
  const sizeKey = p => p.size || NOSIZE;
  const allPacks = () => [...PACKS, ...new Set(S.products.map(p=>p.pack).filter(x=>x && !PACKS.includes(x)))];
  const staleDays = () => S.settings.staleDays ?? 30;
  function priceState(p){
    if (priceOf(p) <= 0) return "none";
    const t = p.priceAt ? Date.parse(p.priceAt) : NaN;
    if (!isFinite(t)) return "stale";
    return (Date.now()-t)/864e5 > staleDays() ? "stale" : "ok";
  }
  function newF(){ return {q:"", types:new Set(), cats:new Set(), packs:new Set(), sizes:new Set(), price:new Set(),promotion:new Set()}; }
  const FACETS = [
    {k:"types", label:"Група", val:typeOf},
    {k:"cats", label:"Категорія", val:catKey},
    {k:"packs", label:"Пакування", val:packKey},
    {k:"sizes", label:"Розмір", val:sizeKey},
    {k:"price", label:"Ціна", val:priceState},
    {k:"promotion",label:"Акція",val:p=>p.promotion?"Так":"Ні"}];
  const curF = () => S.F[tab==="tags" ? "tags" : "prod"];
  const isActive = f => !!f.q.trim() || FACETS.some(fc=>f[fc.k].size>0);
  function matches(p, f, skip){
    const q = f.q.trim().toLowerCase();
    if (q && !String(p.name).toLowerCase().includes(q)) return false;
    for (const fc of FACETS){ if (fc.k===skip) continue; const st = f[fc.k]; if (st.size && !st.has(fc.val(p))) return false; }
    return true;
  }
  const filtered = f => S.products.filter(p=>matches(p,f,null));
  function sizeRank(v){
    if (v===NOSIZE) return 1e9;
    const ci = CUPS.indexOf(String(v).toUpperCase()); if (ci>=0) return 5e4+ci;
    const m = String(v).match(/^\s*(\d+(?:[.,]\d+)?)\s*(мл|л|кг|г)/i);
    if (m){ let x = parseFloat(m[1].replace(",",".")); const u = m[2].toLowerCase(); if (u==="мл"||u==="г") x/=1000; return ((u==="л"||u==="мл") ? 0 : 1e4) + x; }
    return 1e5;
  }
  function facetEntries(fc, f){
    const m = new Map();
    if (fc.k==="price") ["ok","stale","none"].forEach(k=>m.set(k,0));
    S.products.forEach(p=>{ const v = fc.val(p); if (!m.has(v)) m.set(v,0); });
    S.products.filter(p=>matches(p,f,fc.k)).forEach(p=>{ const v = fc.val(p); m.set(v,(m.get(v)||0)+1); });
    const last = {types:NOTYPE, cats:NOCAT, packs:NOPACK, sizes:NOSIZE}[fc.k];
    const pl = allPacks(), po = x => pl.indexOf(x)<0 ? 99 : pl.indexOf(x), PO = ["ok","stale","none"];
    const ord = {
      types:(a,b)=>typeRank(a)-typeRank(b),
      cats:(a,b)=>a.localeCompare(b,"uk"),
      packs:(a,b)=>po(a)-po(b),
      sizes:(a,b)=>sizeRank(a)-sizeRank(b) || a.localeCompare(b,"uk"),
      price:(a,b)=>PO.indexOf(a)-PO.indexOf(b),promotion:(a,b)=>a.localeCompare(b,"uk")}[fc.k];
    return [...m.entries()].sort((a,b)=> (a[0]===last)-(b[0]===last) || ord(a[0],b[0]));
  }
  function ddLabel(fc, f){
    const st = f[fc.k]; if (!st.size) return fc.label;
    const arr = [...st];
    return `${fc.label}: ${arr.length===1 ? (fc.k==="price" ? PRICE_LABEL[arr[0]] : arr[0]) : arr.length+" обрано"}`;
  }
  function facetRow(fc, f){
    const ents = facetEntries(fc, f), st = f[fc.k];
    if (fc.k!=="price" && ents.length<=1 && !st.size) return "";
    const open = S.openF===fc.k;
    const opts = ents.map(([v,n])=>`<label class="dd-opt${n===0&&!st.has(v)?" zero":""}"><input type="checkbox" data-f="${fc.k}" data-v="${esc(v)}" ${st.has(v)?"checked":""}><span class="dd-t">${esc(fc.k==="price"?PRICE_LABEL[v]:v)}</span><span class="dd-n">${n}</span></label>`).join("");
    const extra = fc.k==="price" ? `<label class="dd-stale">Застаріла — старіша за <select id="staleDays" aria-label="Через скільки днів ціна вважається застарілою">${[7,14,30,60,90].map(d=>`<option value="${d}" ${d===staleDays()?"selected":""}>${d} днів</option>`).join("")}</select></label>` : "";
    return `<div class="dd${open?" open":""}${st.size?" active":""}"><button type="button" class="dd-btn" data-ddtoggle="${fc.k}" aria-expanded="${open}" aria-haspopup="true"><span class="dd-l">${esc(ddLabel(fc,f))}</span><span class="dd-caret" aria-hidden="true">▾</span></button>${open ? `<div class="dd-pop" role="group" aria-label="${fc.label}">${st.size?`<button type="button" class="dd-clear" data-fclear="${fc.k}">Очистити вибір</button>`:""}<div class="dd-list">${opts}</div>${extra}</div>` : ""}</div>`;
  }
  const facetsHtml = f => FACETS.map(fc=>facetRow(fc,f)).join("");
  const countText = f => `${filtered(f).length} з ${S.products.length}`;
  function filterBar(f){
    return `<div class="fbar"><input id="q" type="text" placeholder="Пошук за назвою" value="${esc(f.q)}" aria-label="Пошук за назвою"><div id="facets">${facetsHtml(f)}</div><span class="fcount muted" id="fcount" title="Показано товарів з усіх">${countText(f)}</span><button type="button" class="btn soft fclear" id="fResetBtn" data-act="fReset" ${isActive(f)?"":"hidden"}>Скинути</button></div>`;
  }
  function refreshFilters(foc){
    const f = curF(), list = filtered(f), m=$('#main');
    const fx = $("#facets"); if (fx) fx.innerHTML = facetsHtml(f);
    if (foc && fx){ const e = [...fx.querySelectorAll("[data-f],[data-ddtoggle]")].find(x=> foc.k ? (x.dataset.f===foc.k && x.dataset.v===foc.v) : x.dataset.ddtoggle===foc.t); if (e) e.focus(); }
    const c = $("#fcount"); if (c) c.textContent = countText(f);
    const r = $("#fResetBtn"); if (r) r.hidden = !isActive(f);
    const pl = $("#prodList"); if (pl) pl.innerHTML = productList(list);
    const pk = $("#pickBox"); if (pk) pk.innerHTML = pickList(list);
    if(window.TSUKENYA_ROLE && window.TSUKENYA_ROLE!=='owner'){
      const role=window.TSUKENYA_ROLE,editCatalog=['manager','warehouse'].includes(role);
      m.querySelectorAll('[data-pf],[data-promotion],[data-edit-product],[data-act="newProduct"]').forEach(x=>{if(!editCatalog)x.disabled=true;});
      m.querySelectorAll('[data-disclosure="bulk"],[data-disclosure="sync"],.identity-settings').forEach(x=>x.hidden=true);
      if(tab==='tags')m.querySelectorAll('[data-style],[data-field-visible],[data-act="resetField"],[id^="tc"]').forEach(x=>x.disabled=true);
      document.querySelector('[data-workspace="development"]').hidden=true;
      document.querySelectorAll('.tab[data-tab="expenses"],.tab[data-tab="devOverview"],.tab[data-tab="ideas"],.tab[data-tab="tasks"]').forEach(x=>x.hidden=true);
    }
    if (tab==="tags") renderPreview();
  }

  function toast(t){ const el=$("#toast"); el.textContent=t; el.classList.add("show"); clearTimeout(toast._t); toast._t=setTimeout(()=>el.classList.remove("show"),2200); }

  /* ---------- pricing ---------- */
  const defMarkup = () => S.settings.defaultMarkup ?? 30;
  function roundPrice(x){ const r = S.settings.rounding ?? 0.5; const price=Math.ceil(x/r - 1e-9)*r;return price===0?0:price; }
  function priceOf(p){
    if (p.manualPrice && p.price != null) return num(p.price);
    const m = p.markup ?? defMarkup();
    return roundPrice(num(p.cost)*(1+num(m)/100));
  }
  const marginOf = p => { const pr = priceOf(p); return pr>0 ? (pr-num(p.cost))/pr : 0; };

  /* ---------- db writes ---------- */
  async function write(fn, ok){
    if (!db) { toast("Зміни зараз не зберігаються"); return; }
    try { await fn(); if (ok) toast(ok); return true; }
    catch(e){
      if (e && e.code==="unavailable"){ await new Promise(r=>setTimeout(r,400+Math.random()*600)); try{ await fn(); if(ok) toast(ok); return true; }catch(_){} }
      toast(e && e.code==="invalid_argument" ? "Немає прав змінювати дані" : "Не вдалося зберегти, спробуйте ще раз");return false;
    }
  }
  const gsSoon = col => { if (col==="products" && S.settings.gsId){ clearTimeout(S.gsSoonT); S.gsSoonT = setTimeout(()=>gsSync(), 2500); } };
  const upd = (col,id,data,ok) => write(()=>db.collection(col).doc(id).update(data), ok).then(r=>{ gsSoon(col); return r; });
  const add = (col,data,ok) => write(()=>db.collection(col).add(data), ok).then(r=>{ gsSoon(col); return r; });
  const del = (col,id,ok) => write(()=>db.collection(col).doc(id).delete(), ok).then(r=>{ gsSoon(col); return r; });
  async function setDoc(path,data,ok){ return write(async()=>{ const ref=db.doc(path); const s=await ref.get(); s.exists ? await ref.update(data) : await ref.set(data); }, ok); }

  let tagSaveQueue=Promise.resolve();
  function tagSaveStatus(){const el=$('#tagSaveStatus');if(el)el.textContent=S.tagSaving?'Збереження…':S.tagSaveFailed?'Не збережено. Натисніть, щоб повторити.':'Макет збережено';}
  function saveTag(patch){
    const c=Object.assign(tagCfg(),patch);S.settings.tag=c;renderPreview();S.tagSaving=(S.tagSaving||0)+1;tagSaveStatus();
    tagSaveQueue=tagSaveQueue.then(()=>setDoc('settings/main',{tag:c})).then(ok=>{S.tagSaving--;S.tagSaveFailed=!ok;tagSaveStatus();});
  }
  function saveStores(n, ok){
    S.settings.storeNames = n; S.settings.stores = Math.max(1, n.length);
    if (tab==="tags") render();
    if (db) setDoc("settings/main", {storeNames:n, stores:Math.max(1, n.length)}, ok);
  }
  /* ---------- header + path ---------- */
  function renderPath(){
    $("#chainName").textContent = S.settings.chainName || "Мережа солодощів";
    const cur = S.project.stage || 1;
    const html = STAGES.map(st=>{
      const ts = developmentTasks().filter(t=>t.stage===st.n), d = ts.filter(t=>t.status==="done").length;
      const cls = st.n<cur ? "done" : st.n===cur ? "now" : "";
      const meta = ts.length ? `${d} з ${ts.length} задач` : "ще не почато";
      return `<li class="stage ${cls}"><span class="stage-num" aria-hidden="true">${st.n<cur?"✓":st.n}</span>
        <div><div class="stage-name">${esc(st.name)}</div><div class="stage-meta">${st.n===cur?"зараз тут · ":""}${meta}</div></div></li>`;
    }).join("");
    $("#stages").innerHTML = html;
    const all = developmentTasks().length, done = developmentTasks().filter(t=>t.status==="done").length;
    $("#overall").textContent = all ? `Виконано ${done} з ${all} задач` : "";
    const nt = S.project.nextStep;
    $("#next").hidden = !nt; $("#nextText").textContent = nt || "";
    const u = S.project.updatedAt;
    $("#updated").textContent = u ? "Оновлено " + new Date(u).toLocaleDateString("uk-UA",{day:"numeric",month:"long"}) : "";
  }

  /* ---------- tabs ---------- */
  function render(force=false){
    const a = document.activeElement;
    if (!force && a && $("#main").contains(a) && (a.tagName==="INPUT" || a.tagName==="SELECT") && a.type!=="checkbox") { pending = true; return; }
    pending = false;
    if(tab==='products' && window.ReactCatalog){
      window.ReactLabels?.leave();
      window.Trade?.leave();renderPath();
      if(!$('#react-catalog'))$('#main').innerHTML='<div id="react-catalog"></div>'+productTools();
      window.ReactCatalog.mount($('#react-catalog'));refreshFilters();return;
    }
    window.ReactCatalog?.leave();
    if(tab==='tags' && window.ReactLabels){
      window.Trade?.leave();renderPath();
      if(!$('#react-labels'))$('#main').innerHTML='<div id="react-labels"></div>';
      window.ReactLabels.mount($('#react-labels'));refreshFilters();return;
    }
    window.ReactLabels?.leave();
    if(window.Trade?.handles(tab)){ window.Trade.mount(tab); return; }
    window.Trade?.leave();
    renderPath();
    const m = $("#main"),openPanels=[...m.querySelectorAll("[data-disclosure][open]")].map(el=>el.dataset.disclosure),scrolls=[...m.querySelectorAll(".pick,.field-list")].map(el=>[el.className,el.scrollTop,el.scrollLeft]);
    m.innerHTML = ({overview, devOverview, work, tasks, ideas, products, tags, expenses})[tab]();
    for(const key of openPanels)m.querySelector(`[data-disclosure="${key}"]`)?.setAttribute("open","");
    for(const [cls,top,left]of scrolls){const el=m.getElementsByClassName(cls)[0];if(el){el.scrollTop=top;el.scrollLeft=left;}}
    if (tab==="tags") renderPreview();
  }
  $("#main").addEventListener("focusout", ()=>setTimeout(()=>{ if(pending) render(); },0));
  const SECTIONS = {
    purchases:['trade','Закупівлі','Замовлення, надходження та розрахунки з постачальниками.'],
    stock:['trade','Складський облік','Залишки, партії, терміни придатності та рух товарів.'],
    sales:['trade','Продажі та каса','Касові зміни, продажі, оплати й повернення.'],
    finance:['trade','Фінанси','Рахунки, платежі, заборгованість та фактичні витрати.'],
    staff:['trade','Команда й зарплата','Оплата за зміну плюс відсоток від виторгу за касову зміну.'],
    customers:['trade','Клієнти','Контакти, замовлення й історія взаємодії.'],
    reports:['trade','Звіти','Виторг, собівартість, прибуток і рух коштів.'],
    setup:['trade','Налаштування обліку','Магазини, склади, рахунки, доступ і облікові періоди.'],
    overview:['operations','Операційний огляд','Стан каталогу, цін і поточних задач.'],
    products:['operations','Товари й ціни','Каталог товарів, закупівельні ціни та націнка.'],
    tags:['operations','Цінники','Виберіть товари, налаштуйте макет і перевірте аркуші перед друком.'],
    work:['operations','Поточні задачі','Щоденні справи магазину з термінами виконання.'],
    expenses:['operations','Бюджет витрат','Планові місячні витрати й точка беззбитковості. Фактичні платежі — у розділі «Фінанси» обліку торгівлі.'],
    devOverview:['development','Розвиток бізнесу','Рішення, які варто перевірити, та робота над їх реалізацією.'],
    ideas:['development','Ідеї та можливості','Зберігайте пропозиції, обирайте пріоритети й переводьте їх у план.'],
    tasks:['development','План реалізації','Задачі розвитку бізнесу та впровадження інструментів.']
  };
  const developmentTasks = () => S.tasks.filter(t=>t.scope!=='operations');
  const operationTasks = () => S.tasks.filter(t=>t.scope==='operations');
  function route(){
    const parts=location.hash.slice(1).split('/'), requested=parts[1];
    if(tab==='products' && requested!=='products' && window.ReactCatalog?.dirty() && !confirm('Відкинути незбережені зміни товару?')){history.replaceState(null,'','#operations/products');return;}
    if(tab==='tags' && requested!=='tags' && window.ReactLabels?.dirty() && !confirm('Відкинути незбережені зміни макета?')){history.replaceState(null,'','#operations/tags');return;}

    tab=SECTIONS[requested] && SECTIONS[requested][0]===parts[0] ? requested : 'overview';
    workspace=SECTIONS[tab][0];
    document.querySelectorAll('[data-workspace]').forEach(x=>x.setAttribute('aria-current',x.dataset.workspace===workspace?'page':'false'));
    document.querySelectorAll('.tab').forEach(x=>{x.hidden=false;x.setAttribute('aria-current',x.dataset.tab===tab?'page':'false');});
    $('#workspaceLabel').textContent=workspace==='operations'?'Операційна робота':workspace==='trade'?'Облік торгівлі':'Розвиток бізнесу';
    $('#pageTitle').textContent=SECTIONS[tab][1]; $('#pageDescription').textContent=SECTIONS[tab][2];
    $('#developmentPath').hidden=workspace!=='development'||tab==='ideas';
    document.title=SECTIONS[tab][1]+' · Цукерня'; render(true);
  }
  function navigate(next){ location.hash=SECTIONS[next][0]+'/'+next; }
  window.addEventListener('tsukenya:catalog-ready',()=>{if(tab==='products')render(true);});
  window.addEventListener('tsukenya:labels-ready',()=>{if(tab==='tags')render(true);});
  window.addEventListener('hashchange',route);

  /* ---------- totals ---------- */
  function totals(){
    const fixed = S.expenses.filter(e=>e.group==="fixed").reduce((s,e)=>s+num(e.amount),0);
    const variable = S.expenses.filter(e=>e.group!=="fixed").reduce((s,e)=>s+num(e.amount),0);
    const ps = S.products.filter(p=>num(p.cost)>0 && priceOf(p)>0);
    const avgM = ps.length ? ps.reduce((s,p)=>s+marginOf(p),0)/ps.length : 0;
    const be = avgM>0 ? (fixed+variable)/avgM : 0;
    return {fixed, variable, avgM, be, coverage:ps.length, total:S.products.length};
  }

  function overview(){
    const t=totals(), current=operationTasks().filter(x=>x.status!=='done'), noPrice=S.products.filter(p=>priceState(p)==='none').length, stale=S.products.filter(p=>priceState(p)==='stale').length;
    return `<section class="panel"><div class="stats">
      <div class="stat"><div class="l">Товарів у каталозі</div><div class="v num">${S.products.length}</div></div>
      <div class="stat"><div class="l">Потребують ціни</div><div class="v num">${noPrice}</div></div>
      <div class="stat"><div class="l">Поточні задачі</div><div class="v num">${current.length}</div></div>
      <div class="stat"><div class="l">План витрат на місяць</div><div class="v num">${money0(t.fixed+t.variable)} грн</div></div>
    </div></section>
    <section class="panel"><div class="row between gap-lg"><h3>Швидкі дії</h3></div><div class="quick-actions"><a href="#trade/purchases">Облік торгівлі<span>Закупівлі, склад і продажі</span></a><a href="#operations/products">Оновити каталог<span>Ціни, закупівля та націнка</span></a><a href="#operations/tags">Підготувати цінники<span>Макет, PDF і друк</span></a><a href="#operations/work">Запланувати роботу<span>Задачі та терміни</span></a></div></section>
    <section class="panel"><div class="row between gap-lg"><h3>Контроль цін</h3><a class="btn soft" href="#operations/products">Переглянути товари</a></div><p>${noPrice?`${noPrice} товарів без ціни. Заповніть ціну перед друком.`:'У всіх товарів є ціна.'} ${stale?`${stale} товарів мають застарілу дату ціни.`:''}</p></section>
    <section class="panel"><div class="row between gap-lg"><h3>Найближчі задачі</h3><a class="btn soft" href="#operations/work">Усі поточні задачі</a></div>${current.length?current.slice().sort((a,b)=>(a.dueDate||'9999').localeCompare(b.dueDate||'9999')).slice(0,5).map(taskRow).join(''):'<div class="empty">Поточних задач немає. Додайте першу справу магазину.</div>'}</section>`;
  }
  function devOverview(){
    const list=developmentTasks(), active=list.filter(t=>t.status==='doing'), accepted=S.ideas.filter(i=>i.reaction==='yes'), awaiting=S.ideas.filter(i=>!i.reaction);
    return `<section class="panel"><div class="stats"><div class="stat"><div class="l">Ідей на розгляді</div><div class="v num">${awaiting.length}</div></div><div class="stat"><div class="l">Обраних ідей</div><div class="v num">${accepted.length}</div></div><div class="stat"><div class="l">Задач у реалізації</div><div class="v num">${active.length}</div></div><div class="stat"><div class="l">Виконаних задач</div><div class="v num">${list.filter(t=>t.status==='done').length}</div></div></div></section>
    <section class="panel"><h3 class="gap-lg">Від ідеї до результату</h3><div class="quick-actions"><a href="#development/ideas">1. Записати ідею<span>Можливість для бізнесу або новий інструмент</span></a><a href="#development/ideas">2. Обрати для реалізації<span>Оцінити пропозицію й визначити пріоритет</span></a><a href="#development/tasks">3. Виконати план<span>Конкретні задачі та їхній стан</span></a></div></section>
    <section class="panel"><div class="row between gap-lg"><h3>Зараз у реалізації</h3><a class="btn soft" href="#development/tasks">План реалізації</a></div>${active.length?active.map(taskRow).join(''):'<div class="empty">Активних задач розвитку поки немає.</div>'}</section>`;
  }
  function work(){
    const list=operationTasks();
    return `<section class="panel"><div class="row between gap-lg"><h3>Справи магазину</h3><span class="muted">${list.filter(t=>t.status!=='done').length} незавершених</span></div>${['doing','todo','done'].map(status=>{const group=list.filter(t=>(t.status||'todo')===status);return group.length?`<div class="stage-block"><h3>${ST_LABEL[status]}</h3>${group.map(taskRow).join('')}</div>`:''}).join('')||'<div class="empty">Додайте задачу: перевірити ціни, замовити товар або підготувати цінники.</div>'}</section><section class="panel"><h3 class="gap-lg">Нова поточна задача</h3><div class="row"><label class="form-field grow">Що зробити<input id="newWork" type="text" placeholder="Наприклад, оновити цінники…" autocomplete="off"></label><label class="form-field">Термін<input id="newWorkDue" type="date"></label><button class="btn rasp" data-act="addWork">Додати задачу</button></div></section>`;
  }

  /* ---------- tasks ---------- */
  const ST_LABEL = {todo:"Не почато", doing:"В роботі", done:"Готово"};
  const ST_NEXT = {todo:"doing", doing:"done", done:"todo"};
  function taskRow(t){
    const s = t.status || "todo";
    return `<div class="task ${s}"><button class="chip ${s}" data-cycle="${t.id}" title="Натисніть, щоб змінити статус">${ST_LABEL[s]}</button>
      <span class="t">${esc(t.title)}${t.dueDate?`<small class="task-date">До ${esc(new Date(t.dueDate+'T12:00:00').toLocaleDateString('uk-UA'))}</small>`:''}</span><button class="x" data-del-task="${t.id}" aria-label="Видалити задачу">×</button></div>`;
  }
  function tasks(){
    const opts = STAGES.map(s=>`<option value="${s.n}">${s.n}. ${esc(s.name)}</option>`).join("");
    return `<section class="panel"><p class="muted gap-lg">Натискайте на статус задачі, щоб перемкнути його: не почато → в роботі → готово.</p>
      ${STAGES.map(st=>{
        const ts = developmentTasks().filter(t=>t.stage===st.n);
        return `<div class="stage-block"><h3>${st.n}. ${esc(st.name)}</h3>${ts.length?ts.map(taskRow).join(""):`<p class="muted" style="padding:8px 0">Задач поки немає</p>`}</div>`;
      }).join("")}
    </section>
    <section class="panel"><h3 class="gap-lg">Додати задачу</h3>
      <div class="row"><input id="newTask" type="text" aria-label="Назва задачі розвитку" placeholder="Що треба зробити…" style="flex:1;min-width:200px"><select id="newTaskStage" aria-label="Етап розвитку">${opts}</select><button class="btn" data-act="addTask">Додати</button></div>
    </section>`;
  }

  /* ---------- ideas ---------- */
  function ideaCard(i){
    const r = i.reaction, linked=developmentTasks().find(t=>t.ideaId===i.id);
    return `<article class="idea ${r||""}"><h3>${esc(i.title)}</h3><p class="muted">${esc(i.text)}</p>
      <div class="acts">${r ? `<span class="muted">${r==="yes"?"Обрано для реалізації":"Відкладено"}</span><button class="btn soft" data-react="${i.id}" data-v="">Змінити</button>`
        : `<button class="btn rasp" data-react="${i.id}" data-v="yes">Обрати</button><button class="btn soft" data-react="${i.id}" data-v="no">Відкласти</button>`}${r==='yes'?(linked?'<a class="btn soft" href="#development/tasks">Перейти до плану</a>':`<button class="btn" data-idea-task="${esc(i.id)}">Створити задачу</button>`):''}</div></article>`;
  }
  function ideas(){
    return `<section class="panel"><p class="muted gap-lg">Зберігайте ідеї розвитку бізнесу та програмних інструментів. Обрані ідеї можна перевести в задачу плану реалізації.</p>
      ${S.ideas.length?`<div class="ideas">${S.ideas.map(ideaCard).join("")}</div>`:`<div class="empty">Ідей поки немає</div>`}</section>
    <section class="panel"><h3 class="gap-lg">Своя ідея</h3><div class="row"><input id="newIdea" type="text" aria-label="Нова ідея" placeholder="Коротко опишіть ідею…" style="flex:1;min-width:200px"><button class="btn" data-act="addIdea">Записати</button></div></section>`;
  }

  /* ---------- products ---------- */
  const cats = () => [...new Set(S.products.map(p=>p.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"uk"));
  const packOpts = cur => { const l = allPacks(); if (cur && !l.includes(cur)) l.push(cur); return `<option value="">${NOPACK}</option>` + l.map(x=>`<option ${x===cur?"selected":""}>${esc(x)}</option>`).join(""); };
  function productList(list){
    if(!list.length) return `<div class="empty">${S.products.length?'За цими фільтрами товарів немає. Змініть умови пошуку.':'Додайте товар або імпортуйте файл.'}</div>`;
    const pages=Math.ceil(list.length/S.catalogPageSize);S.catalogPage=Math.max(1,Math.min(S.catalogPage,pages));const start=(S.catalogPage-1)*S.catalogPageSize;
    return `<table class="catalog-table"><thead><tr><th>Товар</th><th>Закупівля, грн</th><th>Націнка, %</th><th>Продаж, грн</th><th>Акція</th><th><span class="sr-only">Дії</span></th></tr></thead><tbody>${sortByType(list).slice(start,start+S.catalogPageSize).map(p=>{
      const st=priceState(p),meta=[p.type,p.category,p.pack,p.size,p.unit].filter(Boolean).join(' · ');
      return `<tr><td class="catalog-name" data-label="Товар"><button class="product-name" data-edit-product="${esc(p.id)}">${esc(p.name)}</button><small>${esc(meta)}</small><span class="price-status ${st}">${st==='none'?'Немає ціни':st==='stale'?'Перевірте дату ціни':`Оновлено ${esc(new Date(p.priceAt).toLocaleDateString('uk-UA'))}`}</span></td>
      <td data-label="Закупівля, грн">${money(num(p.cost))}</td>
      <td data-label="Націнка, %">${num(p.markup??defMarkup()).toLocaleString("uk-UA")} %</td>
      <td data-label="Продаж, грн"><strong class="num">${priceOf(p)>0?money(priceOf(p)):"—"}</strong><small>${p.manualPrice?'Ручна ціна':'За націнкою'}</small></td>
      <td data-label="Акція"><label class="promotion-toggle"><input type="checkbox" data-promotion="${esc(p.id)}" ${p.promotion?'checked':''}><span>${p.promotion?'Акція':'Ні'}</span><span class="sr-only"> для ${esc(p.name)}</span></label></td>
      <td class="catalog-actions"><button class="btn soft" data-edit-product="${esc(p.id)}" aria-label="Редагувати ${esc(p.name)}">Редагувати</button></td></tr>`;
    }).join('')}</tbody></table><nav class="catalog-pagination" aria-label="Сторінки каталогу"><span class="muted">${start+1}–${Math.min(start+S.catalogPageSize,list.length)} із ${list.length}</span><label class="inl">На сторінці <select id="catalogPageSize">${[10,20,50].map(n=>`<option value="${n}" ${n===S.catalogPageSize?'selected':''}>${n}</option>`).join('')}</select></label><div class="row"><button class="btn soft" data-page="${S.catalogPage-1}" ${S.catalogPage===1?'disabled':''}>Попередня</button><span class="muted" aria-live="polite">${S.catalogPage} / ${pages}</span><button class="btn soft" data-page="${S.catalogPage+1}" ${S.catalogPage===pages?'disabled':''}>Наступна</button></div></nav>`;
  }
  function reactFilteredProducts(){
    const f=window.ReactCatalog.filters();
    return S.products.filter(p=>f.q.trim().toLocaleLowerCase('uk-UA').split(/\s+/).every(word=>String(p.name||'').toLocaleLowerCase('uk-UA').includes(word)||String(p.barcode||'').toLocaleLowerCase('uk-UA').includes(word)) && (!f.type||p.type===f.type) && (!f.category||p.category===f.category) && (!f.pack||p.pack===f.pack) && (!f.promotion||(f.promotion==='yes')===!!p.promotion));
  }
  function productTools(){
    return `<details class="panel disclosure" data-disclosure="import"><summary>Імпорт товарів із CSV або Excel</summary><div id="impBox">${importInner()}</div><input id="impFile" type="file" accept=".xlsx,.xls,.csv" hidden></details>
    <details class="panel disclosure" data-disclosure="sheets"><summary>Спільна Google-таблиця</summary><div id="linkBox">${linkInner()}</div></details>
    <details class="panel disclosure" data-disclosure="bulk"><summary>Масове оновлення націнки та округлення</summary><div class="row"><label class="form-field">Націнка, %<input id="bulkM" type="number" value="${defMarkup()}"></label><label class="form-field">Застосувати до<select id="bulkC"><option value="">Усі товари</option><option value="__f">Показані за фільтром</option>${cats().map(c=>`<option>${esc(c)}</option>`).join('')}</select></label><button class="btn" data-act="bulk">Оновити ціни</button><label class="form-field">Округлення<select id="rounding">${[[0.01,'До копійки'],[0.1,'До 10 коп.'],[0.5,'До 50 коп.'],[1,'До гривні']].map(([v,l])=>`<option value="${v}" ${num(S.settings.rounding??0.5)===v?'selected':''}>${l}</option>`).join('')}</select></label></div></details>`;
  }
  function products(){
    const f=S.F.prod;
    return `<section class="panel"><div class="row between gap-lg"><h3>Каталог товарів</h3><button class="btn rasp" data-act="newProduct">Додати товар</button></div>${filterBar(f)}<div id="prodList">${productList(filtered(f))}</div></section>${productTools()}`;
  }
  function openProduct(id){
    const p=S.products.find(x=>x.id===id)||{name:'',cost:0,markup:defMarkup(),unit:'шт'}, d=$('#productEditor');
    S.productEditId=id||null;S.editDirty=false;S.productOpener=document.activeElement;
    d.innerHTML=`<form id="productForm"><div class="row between gap-lg"><h2 id="productDialogTitle">${id?'Редагувати товар':'Новий товар'}</h2><button type="button" class="x" data-act="closeProduct" aria-label="Закрити редактор">×</button></div><div class="editor-grid">
      <label class="form-field span-all">Назва товару<input name="name" value="${esc(p.name)}" required maxlength="250" autocomplete="off"></label>
      <label class="form-field">Група<select name="type">${typeOpts(id?typeOf(p):TYPES[0])}</select></label><label class="form-field">Категорія<input name="category" value="${esc(p.category||'')}" autocomplete="off"></label>
      <label class="form-field">Пакування<select name="pack">${packOpts(p.pack||'')}</select></label><label class="form-field">Об’єм / вага<input name="size" value="${esc(p.size||'')}" autocomplete="off"></label>
      <label class="form-field">Штрихкод<input name="barcode" value="${esc(p.barcode||'')}" maxlength="80" autocomplete="off"></label><label class="form-field">Мінімальний залишок<input name="minStock" type="number" min="0" step="0.001" value="${num(p.minStock)}"></label>
      <label class="form-field">Одиниця продажу<select name="unit">${unitOpts(p.unit||'шт')}</select></label><label class="form-field">Дата перевірки ціни<input name="priceAt" type="date" value="${esc(p.priceAt||today())}"></label>
      <label class="form-field">Закупівля, грн<input name="cost" type="number" min="0" step="0.01" value="${num(p.cost)}"></label><label class="form-field">Націнка, %<input name="markup" type="number" min="0" step="0.1" value="${p.markup??defMarkup()}"></label>
      <label class="form-field">Розрахунок ціни<select name="priceMode"><option value="calculated" ${!p.manualPrice?'selected':''}>Закупівля + націнка</option><option value="manual" ${p.manualPrice?'selected':''}>Задати вручну</option></select></label><label class="form-field">Ручна ціна, грн<input name="price" type="number" min="0" step="0.01" value="${p.manualPrice?num(p.price):''}" ${p.manualPrice?'':'disabled'}></label>
      <label class="promotion-toggle span-all"><input name="promotion" type="checkbox" ${p.promotion?'checked':''}><span>Акційний товар — показувати «Акція» на ціннику</span></label></div>
      <p id="productError" class="form-error" role="alert"></p><div class="row between editor-footer"><div>${id?`<button type="button" class="btn danger" data-act="deleteEditedProduct">Видалити товар</button>`:''}</div><div class="row"><button type="button" class="btn soft" data-act="closeProduct">Скасувати</button><button type="submit" class="btn rasp">Зберегти товар</button></div></div></form>`;
    d.showModal(); d.querySelector('[name=name]').focus();
  }
  async function deleteEditedProduct(button){
    if(!confirm('Видалити цей товар?'))return;button.disabled=true;
    try{await db.collection('products').doc(S.productEditId).delete();S.editDirty=false;$('#productEditor').close();toast('Товар видалено');}
    catch(error){$('#productError').textContent=error.message||'Не вдалося видалити товар.';button.disabled=false;}
  }
  function closeProduct(){if(S.editDirty&&!confirm('Закрити редактор без збереження змін?'))return;$('#productEditor').close();S.editDirty=false;}
  document.addEventListener('submit',async e=>{
    if(e.target.id!=='productForm')return;e.preventDefault();const f=e.target, v=Object.fromEntries(new FormData(f)),manual=v.priceMode==='manual';
    if(manual&&!v.price){$('#productError').textContent='Вкажіть ручну ціну або оберіть розрахунок за націнкою.';f.elements.price.focus();return;}
    const payload={barcode:v.barcode.trim(),minStock:num(v.minStock),name:v.name.trim(),type:v.type,category:v.category.trim(),pack:v.pack||null,size:v.size.trim()||null,unit:v.unit,cost:num(v.cost),markup:num(v.markup),manualPrice:manual,price:manual?num(v.price):null,priceAt:v.priceAt||null,promotion:f.elements.promotion.checked};
    if(!payload.name)return;const b=f.querySelector('[type=submit]');b.disabled=true;b.textContent='Збереження…';
    try{if(S.productEditId)await db.collection('products').doc(S.productEditId).update(payload);else await db.collection('products').add(payload);S.editDirty=false;$('#productEditor').close();toast('Товар збережено');}catch(err){$('#productError').textContent=err.message||'Не вдалося зберегти товар.';}finally{b.disabled=false;b.textContent='Зберегти товар';}
  });

  /* ---------- price tags ---------- */
  const TAG_DEF = {size:"s", border:"dash", chain:true, store:true, storeIdx:0, name:true, nameBig:false, pack:true, psize:true, price:true, kop:false, unit:true, per100:true, category:true, date:true, custom:"",customEnabled:true,promo:true};
  const TAG_EL = [["chain","Назва мережі"],["store","Назва магазину"],["name","Назва товару"],["pack","Тип пакування"],["psize","Об’єм / вага"],["price","Ціна"],["unit","Одиниця (грн за 1 шт/кг)"],["per100","Ціна за 100 г (вагові)"],["category","Категорія"],["date","Дата"]];
  const TAG_SIZES = {s:[58,40,"малий 58×40 мм"], m:[75,50,"середній 75×50 мм"], l:[100,70,"великий 100×70 мм"]};
  function tagCfg(){
    const c=Object.assign({},TAG_DEF,S.settings.tag||{}),k=c.size==='l'?1.65:c.size==='m'?1.25:1;
    if(c.styleVersion!==2){c.styles=Object.fromEntries(Object.entries(c.styles||{}).map(([key,v])=>[key,{...v,...(v.size!=null?{size:Number(v.size)*k}:{})}]));c.styleVersion=2;}
    return c;
  }
  const TAG_FONT = {rubik:'Rubik,Arial,sans-serif', arial:'Arial,sans-serif', georgia:'Georgia,serif', courier:'Courier New,monospace'};
  const TAG_STYLE_DEFAULT = {
    promo:[8,'#9A3412','700','left'], chain:[7,'#777777','400','left'], store:[7,'#777777','400','right'], custom:[8,'#c2185b','700','left'],
    name:[10,'#1c1c1c','600','left'], pack:[7.5,'#555555','400','left'], psize:[7.5,'#555555','400','left'],
    price:[22,'#1c1c1c','700','left'], unit:[8,'#444444','400','left'], per100:[8,'#444444','400','left'],
    category:[7,'#777777','400','left'], date:[7,'#777777','400','right']
  };
  const clamp = (n,min,max) => Math.max(min, Math.min(max, Number(n)||min));
  function fieldStyle(c, key){
    const raw = c.styles && c.styles[key] || {}, def = TAG_STYLE_DEFAULT[key];
    return {font: TAG_FONT[raw.font] ? raw.font : 'rubik', size:clamp(raw.size ?? (key==='name' && c.nameBig ? 12.5 : def[0])*(c.size==='l'?1.65:c.size==='m'?1.25:1),5,72),
      color:/^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : def[1], weight:['400','600','700'].includes(String(raw.weight)) ? String(raw.weight) : def[2],
      align:['left','center','right'].includes(raw.align) ? raw.align : def[3]};
  }
  function fieldAttr(c,key){
    const s=fieldStyle(c,key);
    return `data-field="${key}" style="font-family:${TAG_FONT[s.font]};font-size:${s.size}pt;font-weight:${s.weight};color:${s.color};text-align:${s.align}"`;
  }
  const storeNames = () => Array.isArray(S.settings.storeNames) ? S.settings.storeNames : [];
  const PACK_LBL = {"ПЕТ":"Пляшка ПЕТ", "Скло":"Скляна пляшка", "Ваговий":"На вагу", "Штучно":"Поштучно"};
  const packLabel = v => v ? (PACK_LBL[v] || v) : "";
  function sizeLabel(p){
    let v = String(p.size||"").trim(); if (!v) return "";
    if (/^\d+([.,]\d+)?$/.test(v)){ // число без одиниць: здогадуємось за пакуванням
      const n = parseFloat(v.replace(",", "."));
      v += ["ПЕТ","Скло","Банка"].includes(p.pack) ? (n < 10 ? " л" : " мл") : " г";
    }
    if (/\d\s*(л|мл|l|ml)(?![a-zа-яіїєґ])/i.test(v)) return "об’єм " + v;
    if (/\d\s*(г|кг|g|kg)(?![a-zа-яіїєґ])/i.test(v)) return "вага " + v;
    return (p.pack==="Стакан" ? "розмір " : "") + v;
  }
  function tagParts(p, c){
    const pr = priceOf(p), kg = p.unit==="кг", st = storeNames()[c.storeIdx] || "";
    const priceTxt = pr<=0 ? "—" : c.kop ? money(pr) : (Math.abs(pr-Math.round(pr))<0.005 ? money0(pr) : money(pr));
    return {
      hl: c.chain ? (S.settings.chainName || "Мережа солодощів") : "",
      hr: c.store ? st : "",
      promo:c.promo && p.promotion ? "Акція" : "",
      custom: c.customEnabled ? (c.custom||"").trim() : "",
      name: c.name ? (p.name||"") : "",
      pack: c.pack ? packLabel(p.pack) : "", size:c.psize ? sizeLabel(p) : "",
      price: c.price ? priceTxt : "",
      unit: c.unit ? unitPhrase(p.unit) : "", per100:c.per100 && kg && pr>0 ? `100 г — ${money(pr/10)} грн` : "",
      category: c.category ? (p.category||"") : "",
      date: c.date ? new Date().toLocaleDateString("uk-UA") : ""
    };
  }
  function tagMarkup(p, c = tagCfg()){
    const t = tagParts(p, c);
    const el=(key,cls,value)=>value ? `<div class="${cls}" ${fieldAttr(c,key)}>${esc(value)}</div>` : "";
    return `<div class="tag ${TAG_SIZES[c.size]?c.size:'s'} b-${['dash','solid','none'].includes(c.border)?c.border:'dash'}" data-product="${esc(p.id||'sample')}"><div class="t-top">
      ${t.hl||t.hr ? `<div class="t-hd">${el('chain','',t.hl)}${el('store','',t.hr)}</div>` : ""}
      ${el('promo','t-promo',t.promo)}${el('custom','t-cu',t.custom)}${el('name','nm',t.name)}${el('pack','t-pk',t.pack)}${el('psize','t-size',t.size)}</div>
      <div class="t-bottom">${t.price ? `<div class="pr" ${fieldAttr(c,'price')}>${esc(t.price)}${c.unit?'':`<small>грн</small>`}</div>` : ""}
      ${el('unit','un',t.unit)}${el('per100','per100',t.per100)}
      ${t.category||t.date ? `<div class="ft">${el('category','',t.category)}${el('date','',t.date)}</div>` : ""}</div></div>`;
  }
  const SAMPLE = {name:"Капучино XL", category:"Кав'ярня", pack:"Стакан", size:"XL", unit:"шт", manualPrice:true, price:49};
  function storeList(){
    const n = storeNames();
    return `<div class="stl">${n.map((v,i)=>`<div class="strow"><input type="text" data-store="${i}" value="${esc(v)}" placeholder="Напр. «ТЦ Глобус» або «вул. Шевченка, 12»" aria-label="Назва магазину ${i+1}"><button class="btn soft" data-act="delStore" data-i="${i}" aria-label="Видалити магазин">✕</button></div>`).join("") || `<p class="muted">Магазинів ще немає.</p>`}</div>
      <div class="row"><button class="btn soft" data-act="addStore">+ Додати магазин</button></div>`;
  }
  const FIELD_LABELS=Object.fromEntries([['promo','Акція'],...TAG_EL,['custom','Додатковий напис']]);
  const fieldVisible=(c,key)=>key==='custom'?c.customEnabled!==false:!!c[key];
  function styleControls(c){
    const key=S.tagField||'name',title=FIELD_LABELS[key],st=fieldStyle(c,key);
    return `<h3>${esc(title)}</h3><p class="muted inspector-description">Налаштування вибраного елемента</p><label class="visibility-switch"><input type="checkbox" data-field-visible="${key}" ${fieldVisible(c,key)?'checked':''}> Елемент видимий</label>
      ${key==='promo'?'<p class="muted">Позначка з’являється лише для товарів із увімкненою ознакою «Акція».</p>':''}
      ${key==='custom'?`<label class="form-field">Текст напису<input type="text" id="tcCustom" maxlength="40" value="${esc(c.custom)}" placeholder="Наприклад, новинка…"></label>`:''}
      <label class="form-field">Шрифт<select data-style="${key}" data-prop="font">${[['rubik','Rubik'],['arial','Arial'],['georgia','Georgia'],['courier','Courier']].map(([v,n])=>`<option value="${v}" ${st.font===v?'selected':''}>${n}</option>`).join('')}</select></label>
      <div class="inspector-pair"><label class="form-field">Розмір, pt<input type="number" min="5" max="72" step="0.5" data-style="${key}" data-prop="size" value="${Math.round(st.size*100)/100}"></label><label class="form-field">Колір<input type="color" data-style="${key}" data-prop="color" value="${st.color}"></label></div>
      <label class="form-field">Насиченість<select data-style="${key}" data-prop="weight">${[['400','Звичайний'],['600','Напівжирний'],['700','Жирний']].map(([v,n])=>`<option value="${v}" ${st.weight===v?'selected':''}>${n}</option>`).join('')}</select></label>
      <label class="form-field">Вирівнювання<select data-style="${key}" data-prop="align">${[['left','Ліворуч'],['center','По центру'],['right','Праворуч']].map(([v,n])=>`<option value="${v}" ${st.align===v?'selected':''}>${n}</option>`).join('')}</select></label>
      <p class="muted">Вказаний розмір — фактичний розмір шрифту у друці та PDF.</p><button class="btn soft" data-act="resetField">Скинути цей елемент</button>`;
  }
  function fieldList(c){return Object.entries(FIELD_LABELS).map(([key,label])=>`<button class="field-item" data-edit-field="${key}" aria-current="${key===(S.tagField||'name')?'true':'false'}"><span>${esc(label)}</span><small>${fieldVisible(c,key)?'Показано':'Приховано'}</small></button>`).join('');}
  function tagBuilder(){
    const c=tagCfg(),n=storeNames();
    return `<section class="panel builder-panel" id="tagBuilder"><div class="row between gap-lg"><h3>Макет цінника</h3><button type="button" class="save-status" id="tagSaveStatus" data-act="retryTagSave" aria-live="polite">${S.tagSaving?"Збереження…":S.tagSaveFailed?"Не збережено. Натисніть, щоб повторити.":"Макет збережено"}</button></div>
      <div class="builder-toolbar"><label class="form-field">Формат цінника<select id="tcSize">${Object.entries(TAG_SIZES).map(([key,v])=>`<option value="${key}" ${c.size===key?'selected':''}>${v[2]}</option>`).join('')}</select></label><label class="form-field">Рамка<select id="tcBorder">${[['dash','Пунктир для різання'],['solid','Суцільна'],['none','Без рамки']].map(([v,l])=>`<option value="${v}" ${c.border===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="form-field">Відображення ціни<select id="tcDecimals"><option value="auto" ${!c.kop?'selected':''}>Без зайвих нулів</option><option value="always" ${c.kop?'selected':''}>Завжди з копійками</option></select></label></div>
      <label class="form-field field-picker">Елемент цінника<select id="activeField">${Object.entries(FIELD_LABELS).map(([key,label])=>`<option value="${key}" ${key===(S.tagField||'name')?'selected':''}>${esc(label)}</option>`).join('')}</select></label><div class="builder-workspace"><aside class="field-list" aria-label="Елементи цінника">${fieldList(c)}</aside><div class="builder-stage"><div class="form-field"><label for="previewProduct">Товар для перегляду</label><div id="previewProductCombo"></div></div><div class="individual-preview" id="individualPreview"></div><p class="muted" id="previewQty"></p><p class="muted stage-hint">Оберіть елемент у списку або натисніть на нього в макеті.</p><p id="singlePreviewWarning" class="form-error" role="status"></p></div><aside id="fieldInspector" class="field-inspector" aria-label="Параметри елемента">${styleControls(c)}</aside></div>
      <details class="disclosure identity-settings" data-disclosure="identity"><summary>Назва мережі та магазини</summary><div class="editor-grid"><label class="form-field">Назва мережі<input id="chainIn" type="text" value="${esc(S.settings.chainName||'')}" autocomplete="off"></label><div>${storeList()}</div>${n.length?`<label class="form-field">Друкувати для магазину<select id="tcStore">${n.map((v,i)=>`<option value="${i}" ${c.storeIdx===i?'selected':''}>${esc(v||`Магазин ${i+1}`)}</option>`).join('')}</select></label>`:''}</div></details></section>`;
  }
  function selectField(key){if(!FIELD_LABELS[key])return;S.tagField=key;if($('#activeField'))$('#activeField').value=key;$('#fieldInspector').innerHTML=styleControls(tagCfg());document.querySelectorAll('[data-edit-field]').forEach(b=>b.setAttribute('aria-current',b.dataset.editField===key?'true':'false'));highlightField();}
  function highlightField(){document.querySelectorAll('#individualPreview [data-field]').forEach(el=>{el.classList.toggle('field-selected',el.dataset.field===(S.tagField||'name'));el.tabIndex=0;el.setAttribute('role','button');el.setAttribute('aria-label','Налаштувати: '+FIELD_LABELS[el.dataset.field]);});}
  function pickList(list){
    if (!S.products.length) return `<div class="empty">Спершу додайте товари у вкладці «Товари і ціни»</div>`;
    if (!list.length) return `<div class="empty">Нічого не знайдено за цими фільтрами. <button class="btn soft" data-act="fReset">Скинути фільтри</button></div>`;
    const groups=[];
    sortByType(list).forEach(p=>{const last=groups[groups.length-1];if(!last||last.category!==catKey(p)||last.type!==typeOf(p))groups.push({category:catKey(p),type:typeOf(p),products:[p]});else last.products.push(p);});
    return `<div class="pick">${groups.map(group=>`<section class="pick-group" aria-label="${esc(group.category)}"><div class="pick-grp">${esc(group.category)}</div>${group.products.map(p=>{
      const st = priceState(p), ptxt = st==="none" ? "немає ціни" : money(priceOf(p))+" грн"+(st==="stale" ? " · застаріла" : "");
      const on = S.tagSel.has(p.id);
      return `<div class="prow${on?" on":""}" data-row="${p.id}"><label><input type="checkbox" data-tag="${p.id}" ${on?"checked":""}><span style="flex:1">${esc(p.name)}</span><span class="num">${ptxt}</span></label><input type="number" class="qty" min="0" max="500" step="1" inputmode="numeric" data-qty="${p.id}" value="${qtyOf(p.id)}" aria-label="Скільки цінників: ${esc(p.name)}" title="Скільки цінників надрукувати"></div>`;}).join("")}</section>`).join("")}</div>`;
  }
  const qtyOf = id => Math.max(1, Math.min(500, Math.round(S.tagQty[id] || 1)));
  const syncChecks = () => document.querySelectorAll("[data-tag]").forEach(cb=>{ const on = S.tagSel.has(cb.dataset.tag); cb.checked = on; const r = cb.closest(".prow"); if (r) r.classList.toggle("on", on); const q = r && r.querySelector("[data-qty]"); if (q && document.activeElement!==q) q.value = qtyOf(cb.dataset.tag); });
  function tagCopies(){ const out = []; sortByType(selectedProducts()).forEach(p=>{ for (let i=0; i<qtyOf(p.id); i++) out.push(p); }); return out; }
  function perSheet(){ const [tw, th] = TAG_SIZES[tagCfg().size] || TAG_SIZES.s; return Math.floor((210-16)/tw) * Math.floor((297-16)/th); }
  function pageMarkup(list){
    const c=tagCfg(), [tw,th]=TAG_SIZES[c.size] || TAG_SIZES.s, cols=Math.floor(194/tw), per=perSheet();
    const pages=[];
    for(let i=0;i<list.length;i+=per) pages.push(`<div class="print-page" style="grid-template-columns:repeat(${cols},${tw}mm);grid-auto-rows:${th}mm">${list.slice(i,i+per).map(p=>tagMarkup(p,c)).join('')}</div>`);
    return pages.join('');
  }
  function printIssues(list){
    return {noPrice:[...new Set(list.filter(p=>priceState(p)==='none').map(p=>p.name))], stale:[...new Set(list.filter(p=>priceState(p)==='stale').map(p=>p.name))]};
  }
  function clippedTag(tag){
    const top=tag.querySelector('.t-top'), bottom=tag.querySelector('.t-bottom');
    if(top && bottom && top.getBoundingClientRect().bottom > bottom.getBoundingClientRect().top+1) return true;
    return [...tag.querySelectorAll('[data-field]')].some(field=>field.scrollWidth>field.clientWidth+1 || field.scrollHeight>field.clientHeight+1);
  }
  function tags(){
    const f = S.F.tags;
    return `${tagBuilder()}<details class="panel tag-selection" id="tagSelection" data-disclosure="tagSelection" open><summary>Товари для друку</summary>
      ${syncNote()}
      ${filterBar(f)}
      <div class="row" style="margin:8px 0 12px"><button class="btn soft" data-act="selShown">Вибрати всі показані</button><button class="btn soft" data-act="unselShown">Зняти показані</button><button class="btn soft" data-act="selNone">Очистити вибір</button></div>
      <div class="qbar" style="margin-bottom:8px"><span class="muted">Число праворуч від товару — скільки цінників надрукувати.</span></div>
      <div id="pickBox">${pickList(filtered(f))}</div>
      <div class="qbar" style="margin-top:10px"><label class="inl">Усім вибраним по <input type="number" id="qtyAll" min="1" max="500" step="1" value="1" style="width:64px;text-align:center"> шт</label><button class="btn soft" data-act="qtyAll">Застосувати</button></div>
      <div class="row" style="margin-top:14px" id="dlRow">
        <button class="btn rasp" data-act="printReview" data-need="any">Перевірити перед друком</button>
        <button class="btn" data-act="dlPdf" data-need="dl">Завантажити PDF</button>
        ${sheetBtn()}
        <button class="btn soft" data-act="dlCsv" data-need="dl">Завантажити CSV</button>
        <span class="muted" id="selCount"></span></div>
      <p class="muted" id="dlHint" style="margin-top:10px"></p>
      <p class="muted" id="dlNote" style="margin-top:10px">${downloads?"У PDF цінники розкладені на аркуші А4. Друкуйте в масштабі 100%, без «вмістити на сторінку».":"Завантаження файлів тут недоступне. Оновіть сторінку та повторіть спробу."}</p>
    </details>
    ${S.printReview ? `<section class="panel" id="printReview"><h3>Перегляд перед друком</h3><p class="muted">Нижче показано порядок і розкладку цінників на аркушах А4. Перед друком оберіть масштаб 100% і вимкніть колонтитули.</p><div id="printIssues" role="status"></div><div class="row"><label><input type="checkbox" id="staleAck" ${S.staleAck?'checked':''}> Я перевірив застарілі ціни</label><button class="btn rasp" data-act="confirmOutput">${S.printIntent==='pdf'?'Завантажити PDF':'Відкрити системний перегляд друку'}</button><button class="btn soft" data-act="closePrintReview">Закрити</button></div><div class="print-preview-pages" id="printPages"></div></section>`:''}`;
  }
  function selectedProducts(){ return S.products.filter(p=>S.tagSel.has(p.id)); }
  function renderPreview(){
    const list = selectedProducts();
    const total = list.reduce((a,p)=>a+qtyOf(p.id), 0), sheets = Math.ceil(total / perSheet());
    const pv=$("#individualPreview"), picker=$("#previewProductCombo");
    if(picker && pv){
      const available=S.products;
      if(!available.some(p=>p.id===S.tagPreviewId)) S.tagPreviewId=available.find(p=>priceOf(p)>0)?.id||available[0]?.id||null;
      window.PortalCombo.mount(picker,{id:"previewProduct",options:available.map(p=>({value:p.id,label:p.name})),value:S.tagPreviewId,onChange:id=>{S.tagPreviewId=id;renderPreview();}});
      const p=available.find(p=>p.id===S.tagPreviewId)||SAMPLE;
      pv.innerHTML=p ? tagMarkup(p) : '<p class="muted">Виберіть товар вище, щоб побачити його цінник.</p>';
      const q=$("#previewQty"); if(q) q.textContent=list.some(x=>x.id===p.id)?`До друку: ${qtyOf(p.id)} шт.`:'Перегляд макета. Товар не додано до друку.';
      highlightField();
      const warning=$('#singlePreviewWarning');if(warning)warning.textContent=clippedTag(pv.querySelector('.tag'))?'Текст виходить за межі цінника. Зменште шрифт або приховайте зайвий елемент.':'';
    }
    const noPrice = list.filter(p=>priceState(p)==="none").length, stale = list.filter(p=>priceState(p)==="stale").length;
    const c = $("#selCount"); if(c) c.textContent = list.length ? `${list.length} ${countWord(list.length,'товар','товари','товарів')}, ${total} ${countWord(total,'цінник','цінники','цінників')} (≈ ${sheets} арк. А4)` + (noPrice ? `, без ціни: ${noPrice}` : "") + (stale ? `, із застарілою ціною: ${stale}` : "") : "";
    document.querySelectorAll("#dlRow [data-need]").forEach(b=>{ b.disabled = !list.length || (b.dataset.need==="dl" && !downloads); });
    const h = $("#dlHint"); if (h) h.textContent = !list.length ? "Кнопки друку й завантаження стануть активними, коли ви позначите товари у списку вище." : "";
    const pages=$("#printPages");
    if(pages){
      const issues=printIssues(list), overLimit=total>1000;
      pages.innerHTML=overLimit ? '<p class="warn">За один раз можна підготувати до 1000 цінників. Зменште кількість і повторіть.</p>' : pageMarkup(tagCopies());
      const clipped=overLimit?[]:[...new Set([...pages.querySelectorAll('.tag')].filter(clippedTag).map(tag=>tag.dataset.product))];
      S.tagClipped=clipped;
      const box=$("#printIssues");
      if(box) box.innerHTML=`<p style="margin:10px 0">${list.length} ${countWord(list.length,'товар','товари','товарів')} · ${total} ${countWord(total,'цінник','цінники','цінників')} · ${sheets} ${countWord(sheets,'аркуш','аркуші','аркушів')} А4</p>`+
        (issues.noPrice.length?`<div class="warn">Немає ціни: ${esc(issues.noPrice.slice(0,5).join(', '))}${issues.noPrice.length>5?' та інші':''}. Друк заблоковано.</div>`:'')+
        (issues.stale.length?`<div class="warn">Перевірте застарілі ціни: ${esc(issues.stale.slice(0,5).join(', '))}${issues.stale.length>5?' та інші':''}.</div>`:'')+
        (clipped.length?`<div class="warn">Текст не вміщується: ${esc(clipped.slice(0,3).map(id=>S.products.find(p=>p.id===id)?.name||id).join(', '))}${clipped.length>3?' та інші':''}. Зменште шрифт або вимкніть зайві поля, потім перевірте макет знову. Друк заблоковано.</div>`:'');
      const btn=document.querySelector('[data-act="confirmOutput"]'); if(btn) btn.disabled=!!issues.noPrice.length||overLimit||!!clipped.length||(!!issues.stale.length&&!S.staleAck);
    }
  }
  function printTags(){
    const list = tagCopies(); if (!list.length) return;
    let pa = document.getElementById("printArea");
    if (!pa){ pa = document.createElement("div"); pa.id = "printArea"; document.body.appendChild(pa); }
    pa.innerHTML = pageMarkup(list);
    try{ window.print(); }catch(e){ toast("Не вдалося відкрити друк. Спробуйте PDF."); }
  }
  window.addEventListener('afterprint',()=>{ const area=$('#printArea'); if(area) area.remove(); });
  /* ---------- PDF (без бібліотек: малюємо аркуші на canvas і пакуємо в PDF) ---------- */
  const PX_MM = 300/25.4;
  function captureTag(p,c,ctx){
    const host=document.createElement('div');host.style.cssText='position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none';host.innerHTML=tagMarkup(p,c);document.body.append(host);
    try{
      const tag=host.firstElementChild,rect=tag.getBoundingClientRect(),scale=300/96;
      if(clippedTag(tag))throw new Error('Label content does not fit');
      const box=el=>{const r=el.getBoundingClientRect();return {x:(r.left-rect.left)*scale,y:(r.top-rect.top)*scale,w:r.width*scale,h:r.height*scale};};
      const layout={w:rect.width*scale,h:rect.height*scale,background:[],text:[]};
      const badge=tag.querySelector('.t-promo');if(badge)layout.background.push({...box(badge),color:getComputedStyle(badge).backgroundColor});
      const walker=document.createTreeWalker(tag,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()){
        const node=walker.currentNode;if(!node.textContent.trim())continue;
        const style=getComputedStyle(node.parentElement),size=parseFloat(style.fontSize)*scale,font=`${style.fontWeight} ${size}px ${style.fontFamily}`;
        ctx.font=font;const ascent=ctx.measureText('Аg').fontBoundingBoxAscent||size*.9;
        let offset=0,current=null;
        for(const char of node.textContent){
          const range=document.createRange();range.setStart(node,offset);offset+=char.length;range.setEnd(node,offset);const r=range.getBoundingClientRect();
          if(!r.width||!r.height)continue;
          const x=(r.left-rect.left)*scale,y=(r.top-rect.top)*scale;
          if(!current||Math.abs(current.y-y)>1){current={x,y,font,color:style.color,ascent,value:char};layout.text.push(current);}else current.value+=char;
        }
      }
      return layout;
    }finally{host.remove();}
  }
  function drawTag(ctx,x,y,layout,c){
    ctx.save();ctx.translate(x,y);ctx.beginPath();ctx.rect(0,0,layout.w,layout.h);ctx.clip();
    for(const bg of layout.background){ctx.fillStyle=bg.color;ctx.fillRect(bg.x,bg.y,bg.w,bg.h);}
    ctx.textAlign='left';ctx.textBaseline='alphabetic';
    for(const line of layout.text){ctx.font=line.font;ctx.fillStyle=line.color;ctx.fillText(line.value,line.x,line.y+line.ascent);}
    if(c.border!=='none'){const px=300/96;ctx.lineWidth=px;ctx.strokeStyle=c.border==='solid'?'#555':'#999';if(c.border==='dash')ctx.setLineDash([px*3,px*3]);ctx.strokeRect(px/2,px/2,layout.w-px,layout.h-px);}
    ctx.restore();
  }
  function pdfFromJpegs(pages){
    const enc = new TextEncoder(), parts = [], offs = []; let len = 0;
    const put = d => { const u = typeof d==="string" ? enc.encode(d) : d; parts.push(u); len += u.length; };
    const PW = 595.28, PH = 841.89, n = pages.length;
    put("%PDF-1.4\n");
    offs[1] = len; put("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    offs[2] = len; put(`2 0 obj\n<< /Type /Pages /Count ${n} /Kids [${pages.map((_,i)=>`${3+3*i} 0 R`).join(" ")}] >>\nendobj\n`);
    pages.forEach((pg,i)=>{
      const pid = 3+3*i, cid = pid+1, iid = pid+2, content = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
      offs[pid] = len; put(`${pid} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>\nendobj\n`);
      offs[cid] = len; put(`${cid} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
      offs[iid] = len; put(`${iid} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.bytes.length} >>\nstream\n`);
      put(pg.bytes); put("\nendstream\nendobj\n");
    });
    const total = 3+3*n, xref = len;
    put(`xref\n0 ${total}\n0000000000 65535 f \n` + offs.slice(1).map(o=>String(o).padStart(10,"0")+" 00000 n \n").join(""));
    put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, {type:"application/pdf"});
  }
  async function makePdf(btn){
    const list = tagCopies();
    if (!list.length || !downloads) return;
    const label = btn.textContent; btn.disabled = true; btn.textContent = "Готую PDF…";
    try{
      try{ const txt = "Абвгґдеєжзиіїйклмнопрстуфхцчшщьюя АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ 0123456789 ABCabc";
        await Promise.all(["400","600","700"].map(wt=>document.fonts.load(`${wt} 20px Rubik`, txt))); }catch(_){}
      await document.fonts.ready;
      const c = tagCfg(), [tw, th] = TAG_SIZES[c.size] || TAG_SIZES.s, M = 8;
      const cols = Math.floor((210-2*M)/tw), rows = Math.floor((297-2*M)/th), per = cols*rows;
      const W = Math.round(210*PX_MM), H = Math.round(297*PX_MM);
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d"), pages = [],layouts=new Map();
      for(const p of selectedProducts())layouts.set(p.id,captureTag(p,c,ctx));
      for (let i=0; i<list.length; i+=per){
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
        list.slice(i, i+per).forEach((p,j)=> drawTag(ctx, (M+(j%cols)*tw)*PX_MM, (M+Math.floor(j/cols)*th)*PX_MM, layouts.get(p.id), c));
        const blob = await new Promise(r=>cv.toBlob(r, "image/jpeg", 0.92));
        pages.push({bytes:new Uint8Array(await blob.arrayBuffer()), w:W, h:H});
      }
      await save(`tsinnyky-${new Date().toISOString().slice(0,10)}.pdf`, pdfFromJpegs(pages));
    }catch(e){ toast("Не вдалося створити PDF. Перевірте, чи текст уміщується, і повторіть"); }
    finally{ btn.textContent = label; renderPreview(); }
  }
  function csv(list){
    const q = v => `"${String(v??"").replace(/"/g,'""')}"`;
    const rows = [["Назва","Категорія","Одиниця","Ціна, грн","Ціна за 100 г, грн","Акція"]].concat(list.map(p=>{const pr=priceOf(p);return [p.name,p.category||"",p.unit||"шт",money(pr),p.unit==="кг"?money(pr/10):"",p.promotion?"Так":"Ні"];}));
    return "\uFEFF" + rows.map(r=>r.map(q).join(";")).join("\r\n");
  }
  async function save(filename, data){
    if(!downloads) return;
    try{ await downloads.save({filename, data}); toast("Файл збережено"); }
    catch(e){ if(e&&e.code==="declined") return; toast(e&&e.code==="rate_limited"?"Зачекайте кілька секунд і спробуйте ще раз":"Не вдалося зберегти файл"); }
  }

  /* ---------- import from Excel ---------- */
  let xlsxP = null;
  const loadXlsx = () => xlsxP || (xlsxP = new Promise((res, rej)=>{
    if (window.XLSX) return res(window.XLSX);
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => res(window.XLSX);
    s.onerror = () => { xlsxP = null; rej(new Error("load")); };
    document.head.appendChild(s);
  }));
  const norm = v => String(v ?? "").toLowerCase().replace(/[.,:;()№]/g, " ").replace(/\s+/g, " ").trim();
  function parseNum(v){
    if (typeof v === "number") return isFinite(v) ? v : 0;
    const x = parseFloat(String(v ?? "").replace(/[\s ]/g, "").replace(/грн|₴|uah/gi, "").replace(",", "."));
    return isFinite(x) ? x : 0;
  }
  function unitNorm(v){
    const s = norm(v);
    if (!s) return "";
    if (["кг","kg","кілограм","кілограми","кілограмів"].includes(s)) return "кг";
    if (["100 г","100г","100 гр","100 g"].includes(s)) return "100 г";
    if (["уп","упак","упаковка","pack"].includes(s)) return "уп";
    if (["пач","пачка","пачок"].includes(s)) return "пач";
    if (["кор","коробка","короб","box"].includes(s)) return "кор";
    if (["л","літр","литр","l"].includes(s)) return "л";
    if (["порц","порція","порция"].includes(s)) return "порц";
    if (["набір","набор","set"].includes(s)) return "набір";
    return "шт";
  }

  function typeNorm(v){
    const raw = String(v ?? "").trim(); if (!raw) return "";
    return allTypes().find(t=>norm(t)===norm(raw)) || raw;
  }
  const packNorm = v => { const t = norm(v); if (!t) return ""; return allPacks().find(x=>norm(x)===t) || String(v).trim(); };
  function packFromName(n){
    if (/банк/i.test(n)) return "Банка";
    if (/скл(о|ян)/i.test(n)) return "Скло";
    if (/(^|[^а-яіїєґ])пет([^а-яіїєґ]|$)/i.test(n)) return "ПЕТ";
    return "";
  }
  function sizeFromName(n){
    const m = String(n).match(/(\d+(?:[.,]\d+)?)\s*(мл|л|кг|г)(?![а-яіїєґ])/i);
    return m ? `${m[1].replace(".",",")} ${m[2].toLowerCase()}` : "";
  }
  function parseSheet(aoa, fileName){
    const isName = h => h==="назва" || h==="товар" || h==="name" || h.includes("назв") || h.includes("найменув") || h.includes("номенклатур");
    const hi = aoa.slice(0, 20).findIndex(r => r.map(norm).some(isName) && r.filter(c=>String(c).trim()!=="").length >= 2);
    if (hi < 0) return {fileName, error:"Не знайшов стовпець із назвою товару. Назвіть його «Назва» або «Найменування» у рядку із заголовками таблиці."};
    const hdr = aoa[hi].map(norm), used = new Set(), col = {};
    const take = (key, pred) => { const i = hdr.findIndex((h,i)=>h && !used.has(i) && pred(h)); if (i>=0){ used.add(i); col[key]=i; } };
    take("name", isName);
    take("price", h=>h.includes("ціна продаж") || h.includes("ціна прод") || h.includes("роздр") || h==="продаж" || h==="price");
    take("cost", h=>h.includes("закупів") || h.includes("закуп") || h.includes("собівартість") || h.includes("вхідн") || h.includes("ціна прихо") || h==="cost");
    take("markup", h=>h.includes("націнк") || h==="%" || h==="markup");
    take("type", h=>h==="тип" || h.startsWith("тип ") || h.startsWith("група") || h==="вид");
    take("category", h=>h.includes("категор"));
    take("promotion", h=>h==="акція"||h==="promotion");
    take("pack", h=>h.includes("пакуван") || h==="тара");
    take("size", h=>h.includes("розмір") || h.includes("фасув") || /об.?[єе]м/.test(h));
    take("unit", h=>h==="од" || h.startsWith("од ") || h.includes("одиниц") || h.includes("вим") || h==="unit" || h==="шт/кг");
    if (col.cost === undefined && col.price === undefined) take("generic", h=>h.startsWith("ціна"));
    const c = (r,k) => col[k]===undefined ? "" : r[col[k]];
    const rows = aoa.slice(hi+1).map(r=>{
      let mk = c(r,"markup"); const mkRaw = String(mk); mk = parseNum(mk); if (mk>0 && mk<1 && !mkRaw.includes("%")) mk *= 100;
      const nm = String(c(r,"name")).trim();
      return {name:nm,...(col.promotion!==undefined?{promotion:/^(так|true|1|акція|yes)$/i.test(String(c(r,"promotion")).trim())}:{}),cost:parseNum(c(r,"cost")), price:parseNum(c(r,"price")), generic:parseNum(c(r,"generic")),
        markup:mk, category:String(c(r,"category")).trim(), type:typeNorm(c(r,"type")), unit:unitNorm(c(r,"unit")), pack:packNorm(c(r,"pack")) || packFromName(nm), size:String(c(r,"size")).trim() || sizeFromName(nm)};
    }).filter(r=>r.name && !/^(разом|всього|итого|підсумок)/i.test(r.name));
    const labels = {name:"Назва", price:"Ціна продажу", cost:"Закупівля", generic:"Ціна", markup:"Націнка", type:"Тип", category:"Категорія",promotion:"Акція", pack:"Пакування", size:"Розмір", unit:"Од."};
    const mapping = Object.keys(col).map(k=>`${labels[k]} ← «${String(aoa[hi][col[k]]).trim()}»`);
    return {fileName, rows, mapping, hasGeneric: col.generic!==undefined, genericAs:"cost", markup:defMarkup(), defType:""};
  }
  function buildPlan(imp = S.imp, sync = false){
    const byName = new Map(S.products.map(p=>[norm(p.name), p]));
    const seen = new Set(), items = []; let skipped = 0, dup = 0;
    for (const r of imp.rows){
      const k = norm(r.name);
      if (seen.has(k)) { dup++; continue; }
      let cost = r.cost, price = r.price;
      if (imp.hasGeneric){ if (imp.genericAs==="price") price = price || r.generic; else cost = cost || r.generic; }
      if (!(cost>0 || price>0) && !sync) { skipped++; continue; }
      seen.add(k);
      const ex = byName.get(k), data = {name:r.name, unit:r.unit || ex?.unit || "шт"};
      if (cost>0) data.cost = cost; else if (!ex) data.cost = 0;
      if (price>0){ data.price = price; data.manualPrice = true; }
      else { if (r.markup>0) data.markup = r.markup; else if (!sync || !ex) data.markup = imp.markup; data.manualPrice = false; data.price = null; }
      if(typeof r.promotion==="boolean")data.promotion=r.promotion;
      if (r.category) data.category = r.category; else if (!ex) data.category = "";
      if (r.pack) data.pack = r.pack; if (r.size) data.size = r.size; data.priceAt = today();
      const t = r.type || ex?.type || imp.defType; if (t) data.type = t;
      items.push({ex, data});
    }
    return {items, skipped, dup, nNew: items.filter(i=>!i.ex).length, nUpd: items.filter(i=>i.ex).length};
  }
  function importInner(){
    const imp = S.imp, head = `<h3>Завантажити товари з Excel</h3>`;
    if (!imp) return `${head}<p class="muted" style="margin:6px 0 14px">Підійде Google Таблиця або файл .xlsx, .xls, .csv. Потрібні лише назва та ціна (закупівельна або продажу). Стовпці розпізнаю за заголовками: Назва, Тип, Категорія, Акція (Так / Ні), Пакування, Розмір, Од., Закупівля, Націнка, Ціна продажу. Якщо пакування й розміру немає, спробую взяти їх із назви (наприклад «0,5 л», «банка»). Товар, який уже є в базі, оновиться.</p>
      <div class="row"><button class="btn rasp" data-act="pickFile">Обрати файл</button><button class="btn soft" data-act="gsOpen" ${mcp?"":"disabled"} title="${mcp?"":"Google Drive тут ще не підключений"}">З Google Таблиці</button><button class="btn soft" data-act="tplXlsx" ${downloads?"":"disabled"}>Завантажити шаблон</button></div>${gsPanel("import")}
      <p class="muted" style="margin-top:10px">Для Google-таблиці завантажте аркуш «Товари» у форматі CSV або Excel.</p>`;
    if (imp.error) return `${head}<div class="warn" style="margin:10px 0 14px">${esc(imp.error)}</div>
      <div class="row"><button class="btn rasp" data-act="pickFile">Обрати інший файл</button><button class="btn soft" data-act="impCancel">Закрити</button></div>`;
    const plan = buildPlan(), n = plan.items.length;
    const typeSel = `<select id="impType" aria-label="Тип для товарів без типу"><option value="">не вказувати</option>${allTypes().map(t=>`<option ${t===imp.defType?"selected":""}>${esc(t)}</option>`).join("")}</select>`;
    const gen = imp.hasGeneric ? `<label class="inl">Стовпець «Ціна» — це <select id="impGen"><option value="cost" ${imp.genericAs==="cost"?"selected":""}>закупівельна ціна</option><option value="price" ${imp.genericAs==="price"?"selected":""}>ціна продажу</option></select></label>` : "";
    const rows = plan.items.slice(0, 8).map(({ex,data})=>{
      const v = {...(ex||{}), ...data}, pr = priceOf(v);
      return `<tr><td>${esc(data.name)}</td><td>${esc(v.unit||"шт")}</td><td class="r num">${num(v.cost)?money(num(v.cost)):"—"}</td><td class="r num">${money(pr)}</td><td>${esc(v.type||"без типу")}</td><td><span class="badge">${ex?"оновлення":"новий"}</span></td></tr>`;
    }).join("");
    return `${head}<p class="muted" style="margin:6px 0">Файл: ${esc(imp.fileName)}. Розпізнав стовпці: ${imp.mapping.map(esc).join("; ")}.</p>
      <div class="imp-opts">${gen}
        <label class="inl">Націнка для товарів без ціни продажу <input id="impMarkup" type="number" step="1" value="${imp.markup}"> %</label>
        <label class="inl">Тип для товарів без типу ${typeSel}</label></div>
      <p style="margin-bottom:10px"><b>Нових: ${plan.nNew}</b> · оновлень: ${plan.nUpd}${plan.skipped?` · пропущено без ціни: ${plan.skipped}`:""}${plan.dup?` · повторів у файлі пропущено: ${plan.dup}`:""}</p>
      ${n ? `<div class="scroll"><table><thead><tr><th>Назва</th><th>Од.</th><th class="r">Закупівля, грн</th><th class="r">Ціна продажу, грн</th><th>Тип</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${n>8?`<p class="muted" style="margin-top:6px">і ще ${n-8}</p>`:""}`
        : `<div class="warn">У файлі немає товарів із ціною. Додайте стовпець із закупівельною ціною або ціною продажу.</div>`}
      <div class="row" style="margin-top:14px"><button class="btn rasp" data-act="impGo" ${n?"":"disabled"}>Додати в базу${n?` (${n})`:""}</button>
        <button class="btn soft" data-act="pickFile">Обрати інший файл</button><button class="btn soft" data-act="impCancel">Скасувати</button></div>`;
  }
  const renderImport = () => { const b = $("#impBox"); if (b) b.innerHTML = importInner(); };
  async function handleFile(file){
    if (!file) return;
    const box = $("#impBox"); if (box) box.innerHTML = `<p class="muted">Читаю файл…</p>`;
    try{
      let aoa;
      if (/\.csv$/i.test(file.name)) aoa = parseCsv(await file.text());
      else { const X = await loadXlsx(); const wb = X.read(await file.arrayBuffer(), {type:"array"}); aoa = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, raw:true, defval:""}); }
      S.imp = parseSheet(aoa, file.name);
    }catch(e){
      S.imp = {fileName:file.name, error: e && e.message==="load" ? "Не вдалося завантажити модуль читання Excel. Перевірте інтернет або використайте CSV." : "Не вдалося прочитати файл. Перевірте, що це Excel (.xlsx, .xls) або .csv."};
    }
    renderImport();
  }
  async function applyImport(btn){
    if (!db) { toast("Зміни зараз не зберігаються"); return; }
    const plan = buildPlan(), total = plan.items.length; if (!total) return;
    btn.disabled = true; let done = 0, fail = 0, stop = "";
    const run = it => it.ex ? db.collection("products").doc(it.ex.id).update(it.data) : db.collection("products").add(it.data);
    for (const it of plan.items){
      btn.textContent = `Додаю ${done+1} з ${total}…`;
      try{ await run(it); }
      catch(e){
        if (e && (e.code==="unavailable" || e.code==="resource_exhausted")){
          await new Promise(r=>setTimeout(r, 1200));
          try{ await run(it); } catch(e2){ fail++; }
        } else if (e && e.code==="quota_exceeded"){ stop = "У базі закінчилося місце для нових товарів."; break; }
        else if (e && e.code==="invalid_argument"){ stop = "Немає прав змінювати дані."; break; }
        else fail++;
      }
      done++;
    }
    const ok = done - fail;
    S.imp = null; renderImport();
    toast(stop || (fail ? `Готово: ${ok} з ${total}, не вдалося ${fail}` : `Готово: додано ${plan.nNew}, оновлено ${plan.nUpd}`));
  }
  async function tplXlsx(){
    if (!downloads) { toast("Завантаження файлів тут недоступне"); return; }
    try{
      const X = await loadXlsx();
      const ws = X.utils.aoa_to_sheet([
        ["Назва","Тип","Категорія","Пакування","Розмір","Од.","Закупівля, грн","Націнка, %","Ціна продажу, грн","Акція"],
        ["Цукерки шоколадні вагові","Цукерки","Цукерки","Ваговий","","кг",210,30,"","Так"],
        ["Печиво вівсяне 300 г","Печиво і вафлі","Печиво","Упаковка","300 г","шт",32,35,""],
        ["Coca-Cola 0,5 л","Напої","Готові напої","ПЕТ","0,5 л","шт",24,30,""],
        ["Лате XL","Напої","Кав'ярня","Стакан","XL","шт","","",49]]);
      ws["!cols"] = [{wch:32},{wch:18},{wch:16},{wch:12},{wch:10},{wch:8},{wch:16},{wch:12},{wch:18}];
      const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, "Товари");
      await save("shablon-tovary.xlsx", X.write(wb, {bookType:"xlsx", type:"array"}));
    }catch(e){ toast("Не вдалося створити шаблон"); }
  }

  /* ---------- Google Sheets через Drive ---------- */
  const DRIVE = "Google Drive";
  const pj = r => { let x = r && r.payload; if (typeof x==="string"){ try{ x = JSON.parse(x); }catch(_){} } return x; };
  const drive = (tool, input, opts) => mcp.callTool(DRIVE, tool, input, opts).then(pj);
  const b64ToText = b => new TextDecoder("utf-8").decode(Uint8Array.from(atob(b), c=>c.charCodeAt(0)));
  function driveErr(e){
    const m = {
      needs_reauth:"Потрібно заново підключити Google Drive в налаштуваннях Claude.",
      server_not_connected:"Google Drive не підключений до вашого акаунта Claude. Підключіть його в налаштуваннях коннекторів.",
      consent_required:"Дозвольте сторінці працювати з Google Drive, коли з’явиться запит, і спробуйте ще раз.",
      approval_required:"Дозвольте сторінці працювати з Google Drive, коли з’явиться запит, і спробуйте ще раз.",
      not_in_manifest:"Цю дію з Google Drive не дозволено для сторінки.",
      blocked_by_policy:"Ваша організація забороняє цю дію в Google Drive.",
      rate_limited:"Забагато запитів. Зачекайте хвилину й спробуйте ще раз.",
      cancelled:"Скасовано."}[e && e.code];
    return m || "Google Drive відповів помилкою. Спробуйте ще раз.";
  }
  function parseCsv(text){
    text = String(text).replace(/^﻿/, "");
    const first = text.split(/\r?\n/, 1)[0] || "";
    const d = (first.split(";").length > first.split(",").length) ? ";" : ",";
    const rows = []; let row = [], cur = "", q = false;
    for (let i=0; i<text.length; i++){
      const ch = text[i];
      if (q){ if (ch==='"'){ if (text[i+1]==='"'){ cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch==='"') q = true;
      else if (ch===d){ row.push(cur); cur = ""; }
      else if (ch==="\n" || ch==="\r"){ if (ch==="\r" && text[i+1]==="\n") i++; row.push(cur); cur = ""; rows.push(row); row = []; }
      else cur += ch;
    }
    if (cur!=="" || row.length){ row.push(cur); rows.push(row); }
    return rows;
  }
  const dec = x => String(Math.round(x*100)/100).replace(".", ",");
  function tagsCsv(list){
    const q = v => `"${String(v ?? "").replace(/"/g,'""')}"`;
    const rows = [["Назва","Ціна, грн","Од.","Ціна за 100 г, грн","Група","Категорія","Пакування","Розмір","Ціна оновлена"]].concat(list.map(p=>{
      const pr = priceOf(p);
      return [p.name, pr>0 ? dec(pr) : "", p.unit||"шт", (pr>0 && p.unit==="кг") ? dec(pr/10) : "", typeOf(p)===NOTYPE ? "" : typeOf(p), p.category||"", p.pack||"", p.size||"", p.priceAt||""];
    }));
    return rows.map(r=>r.map(q).join(",")).join("\r\n");
  }
  function sheetBtn(){
    const url = safeUrl(S.settings.gsUrl);
    if (S.settings.gsId && url) return `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Відкрити Google-таблицю</a>`;
    return `<button class="btn" data-go="products" title="Спершу підключіть таблицю у вкладці «Товари і ціни»">Відкрити Google-таблицю</button>`;
  }
  const renderGs = () => { renderImport(); renderLink(); };
  function gsPanel(mode){
    const g = S.gs; if (!g || g.mode!==mode) return "";
    const list = g.busy ? `<p class="muted">Зачекайте…</p>` : g.error ? `<div class="warn">${esc(g.error)}</div>`
      : g.files ? (g.files.length ? g.files.map(f=>`<div class="gsrow"><span class="gst">${esc(f.title)}</span><span class="muted">${f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString("uk-UA") : ""}</span><button class="btn soft" data-gsid="${esc(f.id)}" data-gst="${esc(f.title)}" data-gsu="${esc(f.viewUrl||"")}">Обрати</button></div>`).join("") : `<p class="muted">Google-таблиць не знайдено. Змініть пошук або створіть таблицю з поточної бази.</p>`) : "";
    return `<div class="gs"><div class="row"><input id="gsQ" type="text" placeholder="Назва таблиці (можна залишити порожнім)" value="${esc(g.q||"")}" style="flex:1;min-width:200px" aria-label="Назва таблиці"><button class="btn" data-act="gsSearch">Знайти</button><button class="btn soft" data-act="gsClose">Закрити</button></div><div class="gsl">${list}</div><p class="muted" style="margin-top:8px">Береться перший аркуш. У першому рядку мають бути заголовки: Назва, Закупівля, Націнка, Ціна продажу тощо.</p></div>`;
  }
  async function gsSearch(){
    if (!mcp) return;
    const g = S.gs || (S.gs = {mode:"import"}), qe = $("#gsQ"); if (qe) g.q = qe.value.trim();
    g.busy = true; g.error = null; renderGs();
    try{
      const q = (g.q||"").replace(/\\/g,"\\\\").replace(/'/g,"\\'");
      const d = await drive("search_files", {query:`mimeType = 'application/vnd.google-apps.spreadsheet'${q ? ` and title contains '${q}'` : ""}`, pageSize:10, excludeContentSnippets:true});
      g.files = Array.isArray(d && d.files) ? d.files : [];
    }catch(e){ g.error = driveErr(e); }
    g.busy = false; renderGs(); const i = $("#gsQ"); if (i) i.focus();
  }
  function safeUrl(u){ return (typeof u==="string" && /^https:\/\/(docs|drive)\.google\.com\//.test(u)) ? u : ""; }
  async function gsPick(id, title, url){
    if (!mcp || !S.gs) return;
    if (S.gs.mode==="link"){ await gsLink(id, title, url); return; }
    S.gs.busy = true; renderGs();
    try{
      const d = await drive("download_file_content", {fileId:id, exportMimeType:"text/csv"});
      if (!d || typeof d.content!=="string") throw {code:"bad_shape"};
      S.imp = parseSheet(parseCsv(b64ToText(d.content)), (d.title || title));
      S.gs = null;
    }catch(e){ S.gs.busy = false; S.gs.error = driveErr(e); }
    renderGs();
  }

  /* ---------- Google Таблиця як джерело: автосинхронізація ---------- */
  function baseCsv(list){
    const q = v => `"${String(v ?? "").replace(/"/g,'""')}"`;
    const rows = [["Назва","Група","Категорія","Пакування","Розмір","Од.","Закупівля, грн","Націнка, %","Ціна продажу, грн","Ціна на цінник, грн"]].concat(list.map(p=>{
      const pr = priceOf(p), c = num(p.cost), man = p.manualPrice && p.price!=null;
      return [p.name, typeOf(p)===NOTYPE ? "" : typeOf(p), p.category||"", p.pack||"", p.size||"", p.unit||"шт", c>0 ? dec(c) : "", man ? "" : dec(num(p.markup ?? defMarkup())), man ? dec(num(p.price)) : "", pr>0 ? dec(pr) : ""];
    }));
    return rows.map(r=>r.map(q).join(",")).join("\r\n");
  }
  const timeText = t => new Date(t).toLocaleTimeString("uk-UA",{hour:"2-digit",minute:"2-digit"});
  function syncText(){
    const y = S.sync || {};
    if (y.busy) return "Синхронізую…";
    const ok = y.at ? `Синхронізовано о ${timeText(y.at)}: у таблиці ${y.n} позицій${y.added ? `, нових ${y.added}` : ""}${y.upd ? `, з таблиці оновлено ${y.upd}` : ""}${y.pushed ? `, у таблицю записано ${y.pushed}` : ""}.` : "Ще не синхронізовано.";
    return y.error ? `${y.at ? ok+" " : ""}Помилка: ${y.error}` : ok;
  }
  function syncNote(){
    return S.settings.gsId ? `<p class="muted" id="syncNote" style="margin-bottom:12px">Дані з Google Таблиці «${esc(S.settings.gsTitle||"")}». <span id="syncNoteT">${esc(syncText())}</span></p>` : "";
  }
  function updateSyncUi(){
    const a = $("#syncText"); if (a) a.textContent = syncText();
    const b = $("#syncNoteT"); if (b) b.textContent = syncText();
  }
  function linkInner(){
    const st = S.settings;
    if (window.TSUKENYA_SERVER) return `<h3>Спільна Google-таблиця</h3>
      <p class="muted" style="margin:6px 0 12px">Початкові товари завантажено зі знімка аркуша «Товари» від 29.09.2026. Автоматичний обмін зі спільною таблицею ще не підключено, тому зміни в застосунку наразі не потрапляють до неї.</p>
      <div class="row"><a class="btn soft" href="${esc(safeUrl(st.gsUrl) || 'https://docs.google.com/spreadsheets/d/134HsmPHl97xsbCjcEVrFqqjv2Z2_3Qc1Fdhs1kLfNow/edit')}" target="_blank" rel="noopener">Відкрити таблицю</a></div>
      <p class="muted" style="margin-top:10px">Для оновлення товарів зараз експортуйте аркуш «Товари» у CSV і завантажте його вище.</p>`;
    if (!st.gsId) return `<h3>Google Таблиця як джерело</h3>
      <p class="muted" style="margin:6px 0 14px">Підключіть таблицю: усе, що ви впишете в неї (нові товари, закупівельні ціни, націнки), з’явиться тут і в цінниках само, приблизно за хвилину.</p>
      <div class="row"><button class="btn rasp" data-act="gsLinkOpen" ${mcp?"":"disabled"}>Обрати таблицю</button><button class="btn soft" data-act="gsLinkNew" ${mcp && S.products.length ? "" : "disabled"}>Створити таблицю з поточної бази</button></div>
      ${mcp ? "" : `<p class="muted" style="margin-top:10px">Щоб підключити таблицю, дозвольте сторінці доступ до Google Drive. Якщо запиту не було, оновіть сторінку.</p>`}${gsPanel("link")}`;
    const url = safeUrl(st.gsUrl);
    return `<h3>Google Таблиця як джерело</h3>
      <p style="margin:6px 0">Підключено: ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(st.gsTitle||"таблиця")}</a>` : esc(st.gsTitle||"таблиця")}</p>
      <p class="muted" id="syncText">${esc(syncText())}</p>
      <div class="row" style="margin-top:12px"><button class="btn soft" data-act="gsSyncNow" ${mcp?"":"disabled"}>Синхронізувати зараз</button>${url ? `<a class="btn soft" href="${esc(url)}" target="_blank" rel="noopener">Відкрити таблицю</a>` : ""}<button class="btn soft" data-act="gsUnlink">Відключити</button></div>
      <p class="muted" style="margin-top:10px">Синхронізація двостороння. Зміни в таблиці з’являються тут приблизно за хвилину, зміни тут потрапляють у таблицю за кілька секунд. Якщо одне й те саме поле змінили і там, і тут, перемагає таблиця. «Ціна продажу» — ціна, задана вручну; якщо вона порожня, ціна рахується із закупівлі та націнки й видна в стовпці «Ціна на цінник». Стовпець ID не змінюйте: за ним застосунок впізнає товар. Видалили рядок у таблиці — товар ховається тут; видалили товар тут — рядок очищується в таблиці.</p>`;
  }
  function renderLink(){ const b = $("#linkBox"); if (b) b.innerHTML = linkInner(); }
  async function gsLink(id, title, url){
    await setDoc("settings/main", {gsId:id, gsTitle:title, gsUrl:safeUrl(url)||null, gsSheetName:id==='134HsmPHl97xsbCjcEVrFqqjv2Z2_3Qc1Fdhs1kLfNow'?'Товари':null}, "Таблицю підключено");
    S.gs = null; S.sync = null; renderGs();
  }
  async function gsCreateBase(btn){
    if (!mcp || !S.products.length) return;
    const label = btn.textContent; btn.disabled = true; btn.textContent = "Створюю таблицю…";
    try{
      const title = `База товарів ${today()}`;
      const f = pj(await mcp.callTool(DRIVE, "create_file", {title, contentMimeType:"text/csv", textContent:baseCsv(sortByType(S.products))}));
      if (!f || !f.id) throw {code:"bad_shape"};
      await gsLink(f.id, f.title || title, f.viewUrl);
    }catch(e){ toast(driveErr(e)); }
    finally{ btn.disabled = false; btn.textContent = label; }
  }
  /* SYNC-ENGINE-START */
  // Двостороння синхронізація товарів із Google Таблицею. Чиста функція: на вході рядки таблиці й товари, на виході — план записів.
  const GS_COLS = [
    {k:"name",     h:"Назва",                  m:h=>h==="назва" || h.includes("назв") || h.includes("найменув")},
    {k:"type",     h:"Група",                  m:h=>h==="група" || h.startsWith("група") || h==="тип"},
    {k:"category", h:"Категорія",              m:h=>h.includes("категор")},
    {k:"pack",     h:"Пакування",              m:h=>h.includes("пакуван") || h==="тара"},
    {k:"size",     h:"Об’єм / вага",           m:h=>h.includes("розмір") || h.includes("фасув") || /об.?[єе]м/.test(h)},
    {k:"unit",     h:"Од.",                    m:h=>h==="од" || h.startsWith("од ") || h.includes("одиниц")},
    {k:"cost",     h:"Закупівля, грн",         m:h=>h.includes("закуп")},
    {k:"markup",   h:"Націнка, %",             m:h=>h.includes("націнк")},
    {k:"price",    h:"Ціна продажу, грн",      m:h=>h.includes("ціна продаж") || h.includes("ціна вручну")},
    {k:"per100",   h:"Ціна за 100 г, грн",     m:h=>h.includes("100 г") || h.includes("100г"), calc:true},
    {k:"priceAt",  h:"Ціна оновлена",          m:h=>h.includes("оновлен"), calc:true},
    {k:"tagPrice", h:"Ціна на цінник, грн",    m:h=>h.includes("цінник"), calc:true},
    {k:"id",       h:"ID",                     m:h=>h==="id" || h==="код товару в застосунку", calc:true}
  ];
  const SYNC_F = ["name","type","category","pack","size","unit","cost","markup","price"];
  const n2 = x => { const v = Math.round((+x || 0)*100)/100; return String(v); };
  function colLetter(i){ let s = ""; i++; while (i > 0){ const m = (i-1) % 26; s = String.fromCharCode(65+m) + s; i = Math.floor((i-1)/26); } return s; }
  function planSync(values, all, env){
    // env: {defMarkup, priceOf(p), norm, parseNum, unitNorm, packNorm, today, newId()}
    const rows = Array.isArray(values) ? values : [];
    const hdrRaw = (rows[0] || []).map(v=>String(v ?? "").trim());
    if (!hdrRaw.length) return {error:"У першому рядку таблиці немає заголовків."};
    const hdr = hdrRaw.map(env.norm), col = {}, used = new Set();
    for (const c of GS_COLS){ const i = hdr.findIndex((h,i)=>h && !used.has(i) && c.m(h)); if (i>=0){ used.add(i); col[c.k] = i; } }
    if (col.name === undefined) return {error:"Не знайшов у таблиці стовпець «Назва»."};
    const newHdr = hdrRaw.slice(); let hdrChanged = false;
    for (const k of ["tagPrice","id"]) if (col[k] === undefined){ col[k] = newHdr.length; newHdr.push(GS_COLS.find(c=>c.k===k).h); hdrChanged = true; }
    const width = newHdr.length, last = colLetter(width-1);
    const def = env.defMarkup;
    const fromApp = p => ({name:String(p.name||"").trim(), type:String(p.type||"").trim(), category:String(p.category||"").trim(),
      pack:String(p.pack||"").trim(), size:String(p.size||"").trim(), unit:p.unit||"шт", cost:n2(p.cost),
      markup:n2(p.markup ?? def), price:p.manualPrice && +p.price>0 ? n2(p.price) : "0"});
    const cell = (r,k) => col[k]===undefined ? "" : String(r[col[k]] ?? "").trim();
    const fromSheet = r => {
      const mkRaw = cell(r,"markup"); let mk = env.parseNum(mkRaw); if (mk>0 && mk<1 && !mkRaw.includes("%")) mk *= 100;
      return {name:cell(r,"name"), type:cell(r,"type"), category:cell(r,"category"), pack:env.packNorm(cell(r,"pack")) || cell(r,"pack"),
        size:cell(r,"size"), unit:env.unitNorm(cell(r,"unit")) || "шт", cost:n2(env.parseNum(cell(r,"cost"))),
        markup:mkRaw==="" ? "" : n2(mk), price:n2(env.parseNum(cell(r,"price")))};
    };
    const same = (a,b) => SYNC_F.every(k=>a[k]===b[k]);
    const toPatch = (m, p) => {
      const d = {name:m.name, type:m.type || null, category:m.category, pack:m.pack || null, size:m.size || null, unit:m.unit, cost:+m.cost, markup:+m.markup};
      if (+m.price > 0){ d.price = +m.price; d.manualPrice = true; } else { d.price = null; d.manualPrice = false; }
      if (!p || n2(p.cost)!==m.cost || n2(p.markup ?? def)!==m.markup || (p.manualPrice && +p.price>0 ? n2(p.price) : "0")!==m.price) d.priceAt = env.today;
      return d;
    };
    const rowOut = (m, id, pr, priceAt) => {
      const out = new Array(width).fill(null);
      const put = (k,v) => { if (col[k]!==undefined) out[col[k]] = v; };
      const numOrBlank = v => +v > 0 ? +v : "";
      put("name", m.name); put("type", m.type); put("category", m.category); put("pack", m.pack); put("size", m.size ? "'"+m.size : "");
      put("unit", m.unit); put("cost", numOrBlank(m.cost)); put("markup", +m.markup); put("price", numOrBlank(m.price));
      put("tagPrice", pr > 0 ? Math.round(pr*100)/100 : ""); put("per100", m.unit==="кг" && pr > 0 ? Math.round(pr*10)/100 : "");
      put("priceAt", priceAt ? "'"+priceAt : ""); put("id", "'"+id);
      return out;
    };
    const calcSame = (r, out) => ["tagPrice","per100","priceAt","id"].every(k=>{
      if (col[k]===undefined) return true;
      const want = out[col[k]], have = cell(r,k);
      if (typeof want === "number") return Math.abs(env.parseNum(have) - want) < 0.005;
      return String(want).replace(/^'/,"") === have;
    });
    const lastRow = rows.reduce((m, r, i) => (r && r.some(v=>String(v ?? "").trim()!=="")) ? i+1 : m, 1);
    const plan = {header: hdrChanged ? newHdr : null, last, width, lastRow, rowWrites:[], appends:[], clears:[], dbUpdates:[], dbAdds:[], hides:[], n:0, added:0, changed:0, pushed:0};
    const byId = new Map(all.map(p=>[p.id, p]));
    const seenIds = new Set();
    for(let i=1;i<rows.length;i++){
      const r=rows[i]; if(!r || !cell(r,'name')) continue;
      const id=cell(r,'id').replace(/^'/,''); if(!id) continue;
      if(seenIds.has(id)) return {error:`ID «${id}» повторюється в таблиці (рядок ${i+1}). Виправте дубль перед синхронізацією.`};
      if(!byId.has(id)) return {error:`Невідомий ID «${id}» у рядку ${i+1}. Синхронізацію зупинено: відсутність товару не підтверджує видалення рядка.`};
      seenIds.add(id);
    }
    for(const p of all) if(p.gsBase && !p.hidden && !seenIds.has(p.id)) return {error:`У таблиці немає товару «${p.name}» (ID ${p.id}). Перевірте аркуш та повноту даних; автоматичне приховування зупинено.`};
    const claimed = new Set(), pending = [];
    const handle = (r, i, p) => {
      const s = fromSheet(r), a = fromApp(p), b = p.gsBase || null, m = {};
      for (const k of SYNC_F){
        if (!b) m[k] = (s[k]==="" || s[k]==="0") && a[k]!=="" && a[k]!=="0" ? a[k] : s[k];
        else if (s[k]!==b[k] && a[k]===b[k]) m[k] = s[k];
        else if (a[k]!==b[k] && s[k]===b[k]) m[k] = a[k];
        else if (s[k]!==b[k] && a[k]!==b[k]) m[k] = s[k];
        else m[k] = a[k];
      }
      if (!m.name) m.name = a.name;
      if (m.markup==="") m.markup = n2(def);
      let patch = null;
      if (!same(m, a) || p.hidden){ patch = toPatch(m, p); if (p.hidden) patch.hidden = false; plan.changed++; }
      if (!b || !same(m, b)){ patch = patch || {}; patch.gsBase = m; }
      if (patch) plan.dbUpdates.push({id:p.id, patch});
      const after = Object.assign({}, p, patch || {});
      const out = rowOut(m, p.id, env.priceOf(after), after.priceAt || "");
      if (!same(m, s) || !calcSame(r, out)){ plan.rowWrites.push({row:i+1, values:out}); if (!same(m, s)) plan.pushed++; }
    };
    rows.forEach((r, i) => {
      if (i===0 || !r || !cell(r,"name")) return;
      plan.n++;
      const id = cell(r,"id").replace(/^'/,"");
      if (id && byId.has(id) && !claimed.has(id)){ claimed.add(id); handle(r, i, byId.get(id)); return; }
      if (id && !byId.has(id)) return; // unknown IDs are rejected before any writes
      pending.push([r, i]);
    });
    const byName = new Map(); all.forEach(p=>{ if (!claimed.has(p.id) && !p.hidden){ const k = env.norm(p.name); if (!byName.has(k)) byName.set(k, p); } });
    for (const [r, i] of pending){
      const k = env.norm(cell(r,"name")), p = byName.get(k);
      if (p){ byName.delete(k); claimed.add(p.id); handle(r, i, p); continue; }
      const s = fromSheet(r); if (s.markup==="") s.markup = n2(def);
      const id = env.newId(), data = toPatch(s, null);
      data.gsBase = s; if (!(+s.cost>0 || +s.price>0)) delete data.priceAt;
      plan.dbAdds.push({id, data}); plan.added++;
      plan.rowWrites.push({row:i+1, values:rowOut(s, id, env.priceOf(data), data.priceAt || "")});
    }
    for (const p of all){
      if (claimed.has(p.id) || p.hidden) continue;
      if (p.gsBase) continue; // missing rows are rejected before any writes
      const a = fromApp(p);
      plan.appends.push(rowOut(a, p.id, env.priceOf(p), p.priceAt || ""));
      plan.dbUpdates.push({id:p.id, patch:{gsBase:a}});
    }
    return plan;
  }
  /* SYNC-ENGINE-END */

  const SHEETS = "Google Sheets";
  const sheets = (tool, input) => mcp.callTool(SHEETS, tool, input, {cache:false}).then(pj);
  const gsRange = range => {
    const name=S.settings.gsSheetName || (S.settings.gsId==='134HsmPHl97xsbCjcEVrFqqjv2Z2_3Qc1Fdhs1kLfNow'?'Товари':'');
    return name ? `'${name.replace(/'/g,"''")}'!${range}` : range;
  };
  function sheetsErr(e){
    const c = e && e.code;
    if (c==="server_not_connected") return "Google Sheets не підключений до вашого акаунта Claude. Підключіть його в налаштуваннях конекторів.";
    if (c==="needs_reauth") return "Потрібно заново підключити Google Sheets у налаштуваннях Claude.";
    if (c==="consent_required" || c==="approval_required") return "Дозвольте сторінці працювати з Google Sheets, коли з’явиться запит.";
    if (c==="rate_limited") return "Забагато запитів до Google. Спробую ще раз за хвилину.";
    if (c==="tool_error") return "Google Sheets відповів помилкою (можливо, немає доступу до таблиці).";
    return "Не вдалося зв’язатися з Google Sheets. Спробую ще раз за хвилину.";
  }
  const clean = o => JSON.parse(JSON.stringify(o));
  async function gsSync(){
    const id = S.settings.gsId; if (!id || !mcp || !db || !S.productsLoaded) return;
    const y = S.sync || (S.sync = {});
    if (y.busy){ y.again = true; return; }
    y.busy = true; y.error = null; updateSyncUi();
    try{
      const d = await sheets("get_values", {spreadsheetId:id, range:gsRange("A:Z")});
      const plan = planSync(d && Array.isArray(d.values) ? d.values : [], S.allProducts, {
        defMarkup:defMarkup(), priceOf, norm, parseNum, unitNorm, packNorm, today:today(),
        newId:()=>db.collection("products").doc().id || ("g"+Date.now().toString(36)+Math.random().toString(36).slice(2,7))});
      if (plan.error) throw {sheetErr:plan.error};
      const L = plan.last;
      // 1) нові товари з таблиці — у застосунок (щоб їхні ID вже існували)
      for (const a of plan.dbAdds) await db.collection("products").doc(a.id).set(clean(a.data));
      // 2) записи в таблицю
      if (plan.header) await sheets("update_values", {spreadsheetId:id, range:gsRange(`A1:${L}1`), values:[plan.header]});
      if (plan.rowWrites.length){ // один запит на всі змінені рядки: незмінені рядки — null (Google їх пропускає)
        const lo = Math.min(...plan.rowWrites.map(w=>w.row)), hi = Math.max(...plan.rowWrites.map(w=>w.row));
        const block = Array.from({length:hi-lo+1}, ()=>new Array(plan.width).fill(null));
        plan.rowWrites.forEach(w=>{ block[w.row-lo] = w.values; });
        await sheets("update_values", {spreadsheetId:id, range:gsRange(`A${lo}:${L}${hi}`), values:block});
      }
      if (plan.appends.length){ // дописуємо під останнім заповненим рядком (append_values Google може «вставити» посеред таблиці)
        const at = plan.lastRow + 1;
        await sheets("update_values", {spreadsheetId:id, range:gsRange(`A${at}:${L}${at+plan.appends.length-1}`), values:plan.appends});
      }
      if (plan.clears.length) await sheets("batch_clear_values", {spreadsheetId:id, ranges:plan.clears.map(r=>gsRange(`A${r}:${L}${r}`))});
      // 3) зміни з таблиці — у застосунок
      for (const u of plan.dbUpdates) await db.collection("products").doc(u.id).update(clean(u.patch));
      Object.assign(y, {at:Date.now(), n:plan.n, added:plan.added, upd:plan.changed, pushed:plan.pushed + plan.appends.length});
    }catch(e){ y.error = (e && e.sheetErr) ? e.sheetErr : /quota|rate/i.test(String(e && (e.message||""))) ? "Google тимчасово обмежив кількість запитів. Спробую ще раз за хвилину." : sheetsErr(e); }
    y.busy = false; updateSyncUi();
    if (y.again){ y.again = false; setTimeout(gsSync, 3000); }
  }
  function syncSetup(){
    clearInterval(S.syncT);
    if (mcp && db && S.settings.gsId && S.productsLoaded){
      if (S.syncKey !== S.settings.gsId){ S.syncKey = S.settings.gsId; gsSync(); }
      S.syncT = setInterval(()=>{ if (!document.hidden) gsSync(); }, 60000);
    } else S.syncKey = null;
  }
  document.addEventListener("visibilitychange", ()=>{ if (!document.hidden && S.syncKey) gsSync(); });

  /* ---------- expenses ---------- */
  function expRow(e){
    return `<div class="exp"><span class="n">${esc(e.name)}</span><input type="number" min="0" step="100" value="${num(e.amount)}" data-exp="${e.id}" aria-label="${esc(e.name)}, грн на місяць"><span class="muted">грн</span><button class="x" data-del-exp="${e.id}" aria-label="Видалити статтю">×</button></div>`;
  }
  function expenses(){
    const t = totals(), fx = S.expenses.filter(e=>e.group==="fixed"), vr = S.expenses.filter(e=>e.group!=="fixed");
    const block = (title, hint, list, g, sum) => `<div><h3>${title}</h3><p class="muted" style="margin:4px 0 8px">${hint}</p>
      ${list.map(expRow).join("")||`<p class="muted">Статей немає</p>`}
      <div class="row" style="margin-top:10px"><input type="text" placeholder="Нова стаття" data-newexp="${g}" aria-label="Нова стаття: ${title}" autocomplete="off" style="flex:1"><button class="btn soft" data-act="addExp" data-g="${g}">Додати</button></div>
      <div class="total"><span>Разом на місяць</span><span class="num">${money0(sum)} грн</span></div></div>`;
    return `<section class="panel"><div class="row between gap-lg"><h2>Витрати мережі на місяць</h2>
      <label class="inl">Магазинів у мережі <input id="stores" type="number" min="1" step="1" value="${S.settings.stores||1}" style="width:70px"></label></div>
      <p class="muted gap-lg">Впишіть суми за місяць на всю мережу. Зміни зберігаються, щойно ви перейдете до іншого поля.</p>
      <div class="cols">
        ${block("Постійні","Платите щомісяця, навіть якщо продажів мало",fx,"fixed",t.fixed)}
        ${block("Змінні","Залежать від обсягу закупівель і продажів",vr,"variable",t.variable)}
      </div>
      <div class="be">${t.be ? `<div class="muted">Щоб покрити всі витрати, мережі треба продати на</div>
        <div class="big num">${money0(t.be)} грн на місяць</div>
        <div class="muted">≈ ${money0(t.be/30)} грн на день${(S.settings.stores||1)>1?` · ≈ ${money0(t.be/30/(S.settings.stores||1))} грн на день з кожного магазину`:""}. Орієнтовний розрахунок за рівною часткою товарів: ${Math.round(t.avgM*100)}% маржі. Враховано ${t.coverage} із ${t.total} товарів. Це модель каталогу; фактична точка беззбитковості потребує структури продажів і змінних витрат.</div>`
        : `<div>Точка беззбитковості з’явиться, коли будуть суми витрат і товари з цінами.</div>`}</div>
    </section>`;
  }

  /* ---------- events ---------- */
  document.addEventListener("click", e=>{
    if(e.target.closest(".skip-link")){e.preventDefault();$("#main").focus();return;}
    if (S.openF && !e.target.closest(".dd")){ S.openF = null; refreshFilters(); }
    const field=e.target.closest('#individualPreview [data-field]');if(field){selectField(field.dataset.field);return;}
    const t = e.target.closest("button"); if(!t) return;
    if(t.dataset.page){S.catalogPage=Number(t.dataset.page);refreshFilters();$("#prodList").scrollIntoView({block:"start"});return;}
    if(t.dataset.editField){selectField(t.dataset.editField);return;}
    if(t.dataset.editProduct){openProduct(t.dataset.editProduct);return;}
    if(t.dataset.ideaTask){const idea=S.ideas.find(i=>i.id===t.dataset.ideaTask);if(idea&&!developmentTasks().some(x=>x.ideaId===idea.id)){t.disabled=true;add('tasks',{title:idea.title,scope:'development',ideaId:idea.id,stage:S.project.stage||1,status:'todo',order:Date.now()},'Задачу створено');}return;}
    if (t.dataset.go){ navigate(t.dataset.go); return; }
    if (t.dataset.gsid){ gsPick(t.dataset.gsid, t.dataset.gst, t.dataset.gsu); return; }
    if (t.dataset.ddtoggle!==undefined){ const k = t.dataset.ddtoggle; S.openF = S.openF===k ? null : k; refreshFilters({t:k}); return; }
    if (t.dataset.fclear!==undefined){ S.catalogPage=1;curF()[t.dataset.fclear].clear(); refreshFilters({t:t.dataset.fclear}); return; }
    if (t.dataset.cycle){ const k=S.tasks.find(x=>x.id===t.dataset.cycle); upd("tasks",k.id,{status:ST_NEXT[k.status||"todo"]}); return; }
    if (t.dataset.delTask){ if(confirm("Видалити задачу?")) del("tasks",t.dataset.delTask,"Задачу видалено"); return; }
    if (t.dataset.react!==undefined && t.dataset.react){ upd("ideas",t.dataset.react,{reaction:t.dataset.v||null}, t.dataset.v==="yes"?"Ідею обрано":t.dataset.v==="no"?"Записав: відкладаємо":null); return; }
    if (t.dataset.delProd){ if(confirm("Видалити товар?")) del("products",t.dataset.delProd,"Товар видалено"); return; }
    if (t.dataset.delExp){ if(confirm("Видалити статтю витрат?")) del("expenses",t.dataset.delExp); return; }
    const a = t.dataset.act;
    if(a==='retryTagSave'){if(S.tagSaveFailed)saveTag({});return;}
    if(a==='newProduct'){openProduct();return;}
    if(a==='closeProduct'){closeProduct();return;}
    if(a==='deleteEditedProduct'){deleteEditedProduct(t);return;}
    if(a==='resetField'){const styles={...(tagCfg().styles||{})};delete styles[S.tagField||'name'];saveTag({styles,nameBig:false});selectField(S.tagField||'name');return;}
    if(a==='addWork'){const v=$('#newWork').value.trim();if(!v)return;add('tasks',{title:v,scope:'operations',dueDate:$('#newWorkDue').value||null,status:'todo',order:Date.now()},'Поточну задачу додано');return;}
    if (a==="addTask"){ const v=$("#newTask").value.trim(); if(!v) return; const st=+$("#newTaskStage").value;
      add("tasks",{title:v,scope:"development",stage:st,status:"todo",order:Date.now()},"Задачу додано"); }
    if (a==="addIdea"){ const v=$("#newIdea").value.trim(); if(!v) return; add("ideas",{title:v,text:"Ідея власника",reaction:null,order:Date.now(),byOwner:true},"Ідею записано"); }
    if (a==="clearEx"){ if(confirm("Прибрати всі товари-приклади?")) S.products.filter(p=>p.example).reduce((pr,p)=>pr.then(()=>del("products",p.id)),Promise.resolve()).then(()=>toast("Приклади прибрано")); }
    if (a==="bulk"){ const m=num($("#bulkM").value), c=$("#bulkC").value; const list = c==="__f" ? (window.ReactCatalog?reactFilteredProducts():filtered(S.F.prod)) : S.products.filter(p=>!c||p.category===c);
      if(!list.length) return; if(!confirm(`Встановити націнку ${m}% для ${list.length} товарів? Ручні ціни теж перерахуються.`)) return;
      (async()=>{ for(const p of list) await upd("products",p.id,{markup:m,manualPrice:false,price:null,priceAt:today()}); if(!c) await setDoc("settings/main",{defaultMarkup:m}); toast("Ціни перераховано"); })(); }
    if (a==="addProd"){ const n=$("#npName").value.trim(); if(!n) return;
      const cost=num($("#npCost").value); add("products",{name:n,type:$("#npType").value,category:$("#npCat").value.trim(),pack:$("#npPack").value||null,size:$("#npSize").value.trim()||null,unit:$("#npUnit").value,cost,markup:num($("#npMarkup").value),manualPrice:false,priceAt:cost>0?today():null},"Товар додано"); }
    if (a==="selShown"){ filtered(S.F.tags).forEach(p=>S.tagSel.add(p.id)); syncChecks(); renderPreview(); }
    if (a==="unselShown"){ filtered(S.F.tags).forEach(p=>S.tagSel.delete(p.id)); syncChecks(); renderPreview(); }
    if (a==="qtyAll"){ const v = Math.max(1, Math.min(500, Math.round(num($("#qtyAll").value)))); if (!S.tagSel.size){ toast("Спершу позначте товари"); return; } S.tagSel.forEach(id=>{ S.tagQty[id] = v; }); syncChecks(); renderPreview(); toast(`Кожному вибраному — по ${v} шт`); }
    if (a==="selNone"){ S.tagSel.clear(); syncChecks(); renderPreview(); }
    if (a==="fReset"){ S.catalogPage=1;S.F[tab==="tags"?"tags":"prod"] = newF(); S.openF = null; render(); }
    if (a==="dlPdf" || a==="printReview"){
      S.printIntent=a==="dlPdf"?'pdf':'print'; S.printReview=true; S.staleAck=false; render();
      $("#printReview")?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'}); return;
    }
    if (a==="closePrintReview"){ S.printReview=false; render(); return; }
    if (a==="confirmOutput"){
      const list=tagCopies(), issues=printIssues(list);
      if(!list.length || list.length>1000 || issues.noPrice.length || S.tagClipped?.length || (issues.stale.length&&!S.staleAck)) return;
      if(S.printIntent==='pdf') makePdf(t); else printTags(); return;
    }
    if (a==="addStore"){ const n = storeNames().slice(); n.push(""); saveStores(n); setTimeout(()=>{ const i = document.querySelector(`[data-store="${n.length-1}"]`); if (i) i.focus(); }, 60); }
    if (a==="delStore"){ const i = +t.dataset.i, n = storeNames().slice(), nm = n[i];
      if (nm && !confirm(`Видалити магазин «${nm}»?`)) return;
      n.splice(i,1); const c = tagCfg(); saveStores(n, "Магазин видалено"); if (c.storeIdx >= n.length) saveTag({storeIdx:Math.max(0,n.length-1)}); }
    if (a==="pickFile"){ $("#impFile").click(); }
    if (a==="impCancel"){ S.imp = null; renderImport(); }
    if (a==="impGo"){ applyImport(t); }
    if (a==="tplXlsx"){ tplXlsx(); }
    if (a==="gsOpen"){ S.gs = {mode:"import", q:"", files:null}; renderGs(); gsSearch(); }
    if (a==="gsLinkOpen"){ S.gs = {mode:"link", q:"", files:null}; renderGs(); gsSearch(); }
    if (a==="gsLinkNew"){ gsCreateBase(t); }
    if (a==="gsSyncNow"){ gsSync(); }
    if (a==="gsUnlink"){ if (confirm("Відключити таблицю? Товари в застосунку залишаться.")) setDoc("settings/main", {gsId:null, gsTitle:null, gsUrl:null, gsSheetName:null}, "Таблицю відключено").then(()=>{ S.sync = null; }); }
    if (a==="gsSearch"){ gsSearch(); }
    if (a==="gsClose"){ S.gs = null; renderGs(); }
    if (a==="dlCsv"){ save(`tsinnyky-${new Date().toISOString().slice(0,10)}.csv`, csv(selectedProducts())); }
    if (a==="addExp"){ const g=t.dataset.g, inp=document.querySelector(`[data-newexp="${g}"]`), v=inp.value.trim(); if(!v) return;
      add("expenses",{name:v,group:g,amount:0,order:Date.now()},"Статтю додано"); }
  });
  document.addEventListener("change", e=>{
    const el = e.target;
    if(el.closest('#productForm')){S.editDirty=true;if(el.name==='priceMode'){$('#productForm').elements.price.disabled=el.value!=='manual';}return;}
    if(el.id==='catalogPageSize'){S.catalogPageSize=Number(el.value);S.catalogPage=1;refreshFilters();return;}
    if(el.dataset.promotion){upd('products',el.dataset.promotion,{promotion:el.checked},'Ознаку акції збережено');return;}
    if(el.dataset.fieldVisible){saveTag({[el.dataset.fieldVisible==='custom'?'customEnabled':el.dataset.fieldVisible]:el.checked});$('.field-list').innerHTML=fieldList(tagCfg());return;}
    if(el.id==='tcDecimals'){saveTag({kop:el.value==='always'});return;}
    if(el.id==="staleAck"){ S.staleAck=el.checked; renderPreview(); return; }
    if(el.dataset.style){
      const key=el.dataset.style, prop=el.dataset.prop;
      if(!TAG_STYLE_DEFAULT[key] || !['font','size','color','weight','align'].includes(prop)) return;
      const styles={...(tagCfg().styles||{}),[key]:{...((tagCfg().styles||{})[key]||{}),[prop]:prop==='size'?clamp(el.value,5,72):el.value}};
      saveTag({styles}); return;
    }
    if (el.dataset.f!==undefined){ S.catalogPage=1;const st = curF()[el.dataset.f], v = el.dataset.v; el.checked ? st.add(v) : st.delete(v); refreshFilters({k:el.dataset.f, v}); return; }
    if (el.dataset.ptype!==undefined){ upd("products",el.dataset.id,{type:el.value||null}); return; }
    if (el.dataset.punit!==undefined){ upd("products",el.dataset.id,{unit:el.value||"шт"}); return; }
    if (el.dataset.ppack!==undefined){ upd("products",el.dataset.id,{pack:el.value||null}); return; }
    if (el.dataset.psize!==undefined){ upd("products",el.dataset.id,{size:el.value.trim()||null}); return; }
    if (el.id==="staleDays"){ S.settings.staleDays = +el.value; refreshFilters(); setDoc("settings/main",{staleDays:+el.value},"Термін застарілості змінено"); return; }
    if (el.id==="impFile"){ const f = el.files[0]; el.value = ""; handleFile(f); return; }
    if (el.id==="impMarkup" && S.imp){ S.imp.markup = num(el.value); renderImport(); return; }
    if (el.id==="impType" && S.imp){ S.imp.defType = el.value; renderImport(); return; }
    if (el.id==="impGen" && S.imp){ S.imp.genericAs = el.value; renderImport(); return; }
    if (el.dataset.pf){ const p=S.products.find(x=>x.id===el.dataset.id); if(!p) return; const v=num(el.value);
      if (el.dataset.pf==="price") upd("products",p.id,{price:v,manualPrice:true,priceAt:today()});
      else if (el.dataset.pf==="markup") upd("products",p.id,{markup:v,manualPrice:false,price:null,priceAt:today()});
      else upd("products",p.id,{cost:v,priceAt:today()}); return; }
    if (el.dataset.exp){ upd("expenses",el.dataset.exp,{amount:num(el.value)}); return; }
    if (el.dataset.qty){ const id = el.dataset.qty, v = Math.round(num(el.value));
      if (v <= 0){ S.tagSel.delete(id); S.tagQty[id] = 1; } else { S.tagQty[id] = Math.min(500, v); S.tagSel.add(id); }
      syncChecks(); renderPreview(); return; }
    if (el.dataset.tag){ el.checked ? S.tagSel.add(el.dataset.tag) : S.tagSel.delete(el.dataset.tag); syncChecks(); renderPreview(); return; }
    if (el.id==="activeField"){selectField(el.value);return;}
    if (el.id==="tcSize"){ saveTag({size:el.value}); selectField(S.tagField||'name'); return; }
    if (el.id==="tcBorder"){ saveTag({border:el.value}); return; }
    if (el.id==="tcStore"){ saveTag({storeIdx:+el.value}); return; }
    if (el.id==="tcCustom"){ saveTag({custom:el.value.trim().slice(0,40)}); return; }
    if (el.id==="chainIn"){ const v = el.value.trim(); S.settings.chainName = v; renderPreview(); setDoc("settings/main",{chainName:v||"Мережа солодощів"},"Назву мережі збережено"); return; }
    if (el.dataset.store!==undefined){ const n = storeNames().slice(); n[+el.dataset.store] = el.value.trim(); saveStores(n, "Назву магазину збережено"); return; }
    if (el.id==="rounding"){ setDoc("settings/main",{rounding:num(el.value)},"Округлення змінено"); }
    if (el.id==="stores"){ setDoc("settings/main",{stores:Math.max(1,Math.round(num(el.value)))}); }
  });
  $('#productEditor').addEventListener('close',()=>{const live=S.productOpener?.isConnected?S.productOpener:document.querySelector('[data-edit-product="'+S.productEditId+'"]');(live||document.querySelector('[data-act=newProduct]'))?.focus({preventScroll:true});});
  $('#productEditor').addEventListener('cancel',e=>{if(S.editDirty){e.preventDefault();closeProduct();}});
  window.addEventListener('beforeunload',e=>{if(S.editDirty||S.tagSaving||S.tagSaveFailed){e.preventDefault();e.returnValue='';}});
  document.addEventListener("input", e=>{
    if(e.target.closest('#productForm')){S.editDirty=true;return;}
    if(e.target.dataset.style){const el=e.target;if(el.dataset.prop==='size'&&!el.value)return;const styles={...(tagCfg().styles||{}),[el.dataset.style]:{...((tagCfg().styles||{})[el.dataset.style]||{}),[el.dataset.prop]:el.dataset.prop==='size'?clamp(el.value,5,72):el.value}};S.settings.tag={...tagCfg(),styles};renderPreview();return;}
    if (e.target.id==="tcCustom"){ S.settings.tag = Object.assign(tagCfg(), {custom:e.target.value}); renderPreview(); return; }
    if (e.target.id==="q"){ S.catalogPage=1;curF().q = e.target.value; clearTimeout(refreshFilters._t); refreshFilters._t = setTimeout(refreshFilters, 180); }
  });
  document.addEventListener("keydown", e=>{
    const field=e.target.closest('#individualPreview [data-field]');if(field&&(e.key==='Enter'||e.key===' ')){e.preventDefault();selectField(field.dataset.field);return;}
    if (e.key==="Escape" && S.openF){ const k = S.openF; S.openF = null; refreshFilters({t:k}); return; }
    if (e.key!=="Enter") return;
    if (e.target.dataset && e.target.dataset.qty){ e.target.blur(); return; }
    const map = {qtyAll:"qtyAll", newTask:"addTask", newWork:"addWork", newIdea:"addIdea", npName:"addProd", gsQ:"gsSearch"};
    if (map[e.target.id]) document.querySelector(`[data-act="${map[e.target.id]}"]`).click();
  });

  /* ---------- data ---------- */
  if (window.TSUKENYA_SERVER) $("#accountLink").hidden = false;
  route();
  document.fonts.ready.then(()=>{if(tab==="tags")renderPreview();});
  const noDbTimer = setTimeout(()=>{ if(!db) $("#noDb").hidden=false; }, 4000);
  window.claude?.use?.("downloads").then(d=>{ downloads=d; if(tab==="tags") render(); }).catch(()=>{});
  window.claude?.use?.("mcp").then(m=>{ mcp=m; if(tab==="tags"||tab==="products") render(); syncSetup(); }).catch(()=>{});
  (window.claude?.use ? window.claude.use("db") : Promise.resolve(null)).then(d=>{
    if(!d){ $("#noDb").hidden=false; clearTimeout(noDbTimer); return; }
    db = d; clearTimeout(noDbTimer);
    const byOrder = (a,b)=>(a.order??0)-(b.order??0);
    const sub = (col, key, sort) => db.collection(col).onSnapshot(s=>{
      S[key] = s.docs.map(x=>({id:x.id, ...x.data()})).sort(sort); render();
    }, ()=>{});
    sub("tasks","tasks",(a,b)=>(a.stage-b.stage)||byOrder(a,b));
    sub("ideas","ideas",byOrder);
    db.collection("products").onSnapshot(s=>{
      const firstProducts = !S.productsLoaded;
      S.allProducts = s.docs.map(x=>({id:x.id, ...x.data()})).sort((a,b)=>String(a.name).localeCompare(String(b.name),"uk"));
      S.products = S.allProducts.filter(p=>!p.hidden); S.productsLoaded=true; render(); if(firstProducts) syncSetup();
    }, ()=>{});
    sub("expenses","expenses",byOrder);
    db.doc("settings/main").onSnapshot(s=>{ const saved=s.exists?s.data():{};S.settings=S.tagSaving?{...saved,tag:S.settings.tag}:saved;render();syncSetup(); }, ()=>{});
    db.doc("project/state").onSnapshot(s=>{ S.project = s.exists ? s.data() : {}; render(); }, ()=>{});
  }).catch(()=>{ $("#noDb").hidden=false; });
})();
