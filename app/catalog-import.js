/* Server-owned catalogue preview and atomic, retry-safe import. */
(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const normal = value => clean(value).toLocaleLowerCase('uk-UA').replace(/[.,:;()№]/g, ' ').replace(/\s+/g, ' ').trim();
  const amount = value => Number(value).toLocaleString('uk-UA',{minimumFractionDigits:2,maximumFractionDigits:2});
  const present = value => value !== undefined && value !== null && clean(value) !== '';
  function decimal(value, label, precision = 2, percent = false) {
    let raw = clean(value).replace(/[\s\u00a0]/g, '').replace(/(?:грн|₴|uah)$/i, '').replace(',', '.');
    const hasPercent = raw.endsWith('%');
    if (percent && hasPercent) raw = raw.slice(0, -1);
    if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) throw Error(`${label}: некоректне число.`);
    if (percent && !hasPercent && Number(raw) > 0 && Number(raw) < 1) raw = String(Number(raw) * 100);
    const fraction = (raw.split('.')[1] || '').replace(/0+$/, '');
    if (fraction.length > precision || Number(raw) > 99999999.99) throw Error(`${label}: максимум ${precision} знаки після коми та 99 999 999,99.`);
    return raw;
  }
  function parseRows(table, fileName) {
    const nameHeader = h => ['назва','товар','name'].includes(h) || /назв|найменув|номенклатур/.test(h);
    const headerIndex = table.slice(0,20).findIndex(row => row.map(normal).some(nameHeader) && row.filter(present).length >= 2);
    if (headerIndex < 0) return {fileName, error:'Не знайдено заголовок «Назва» або «Найменування». Додайте його у перші 20 рядків.'};
    const headers = table[headerIndex].map(normal), used = new Set(), columns = {};
    const take = (key, predicate) => { const index = headers.findIndex((h,i) => h && !used.has(i) && predicate(h)); if (index >= 0) { columns[key] = index; used.add(index); } };
    take('name',nameHeader);
    take('promotionPrice',h => h.includes('акційна ціна') || ['promotionprice','promotion price'].includes(h));
    take('price',h => /звичайна ціна|ціна продаж|ціна прод|роздр/.test(h) || ['продаж','price'].includes(h));
    take('cost',h => /закупів|закуп|собівартість|вхідн|ціна прихо/.test(h) || h === 'cost');
    take('markup',h => /націнк/.test(h) || ['%','markup'].includes(h));
    take('type',h => h === 'тип' || h.startsWith('тип ') || h.startsWith('група') || h === 'вид');
    take('category',h => h.includes('категор'));
    take('promotion',h => ['акція','promotion'].includes(h));
    take('pack',h => /пакуван/.test(h) || h === 'тара');
    take('size',h => /розмір|фасув|об.?[єе]м/.test(h));
    take('unit',h => h === 'од' || h.startsWith('од ') || /одиниц|вим/.test(h) || ['unit','шт/кг'].includes(h));
    take('id',h => ['id','id товару','ідентифікатор товару'].includes(h));
    take('barcode',h => /штрих.?код/.test(h) || h === 'barcode');
    if (columns.cost === undefined && columns.price === undefined) take('generic',h => ['ціна','ціна грн'].includes(h));
    const rows = [];
    for (let index = headerIndex + 1; index < table.length; index++) {
      const cells = table[index]; if (!cells.some(present)) continue;
      const name = clean(cells[columns.name]);
      if (/^(разом|всього|итого|підсумок)\s*:?[\s]*$/i.test(name)) continue;
      const values = {name}, errors = [], row = {line:index+1, values, errors};
      for (const [field,col] of Object.entries(columns)) {
        const raw = cells[col]; if (!present(raw) || field === 'name') continue;
        try {
          if (['cost','price','promotionPrice','markup','generic'].includes(field)) {
            const value = decimal(raw,table[headerIndex][col],field === 'markup' ? 4 : 2,field === 'markup');
            if (field === 'generic') row.generic = value; else values[field] = value;
            if (field === 'price') values.manualPrice = true;
          } else if (field === 'promotion') {
            if (/^(так|true|1|акція|yes)$/i.test(clean(raw))) values.promotion = true;
            else if (/^(ні|false|0|no)$/i.test(clean(raw))) values.promotion = false;
            else throw Error('Акція: вкажіть «Так» або «Ні».');
          } else if (field === 'id') row.id = clean(raw).replace(/^'/,'');
          else values[field] = clean(raw);
        } catch (error) { errors.push(error.message); }
      }
      if (!name) errors.push('Вкажіть назву товару.');
      rows.push(row);
    }
    if (!rows.length) return {fileName,error:'У файлі немає рядків товарів.'};
    if (rows.length > 1000) return {fileName,error:'У файлі понад 1000 товарів. Розділіть його на окремі пакети.'};
    return {fileName, rows, mapping:Object.values(columns).map(index => clean(table[headerIndex][index])), hasGeneric:columns.generic !== undefined};
  }
  let state = null, sequence = 0, initialMarkup = '30';
  const locked = () => !!(state?.saving || state?.uncertain);
  const notify = () => { const host = document.querySelector('#impBox'); if (host) host.innerHTML = html(); };
  const button = (action,text,disabled=false) => `<button type="button" class="btn soft" data-catalog-import="${action}" ${disabled?'disabled':''}>${text}</button>`;
  function html(options = {}) {
    if (!state && options.markup !== undefined) initialMarkup = String(options.markup);
    const title = '<h3>Імпорт товарів</h3>';
    if (!state) return `${title}<p>Оберіть CSV або Excel. Перед збереженням перевірте кожен рядок. Порожні клітинки зберігають поточні значення; товари зі збіжною назвою оновлюються.</p><p class="muted">Для Google-таблиці завантажте потрібний аркуш у CSV або Excel. Пряме підключення Google Drive на сервері ще не налаштовано.</p><button class="btn" data-act="pickFile">Обрати файл</button>`;
    const busy = state.loading || state.saving, block = locked(), preview = state.preview;
    const controls = `${button('reset',state.completed?'Завершити':'Скасувати',block)}<button class="btn soft" data-act="pickFile" ${block?'disabled':''}>Обрати інший файл</button>`;
    if (state.error) return `${title}<p class="form-error" role="alert">${escape(state.error)}</p><div class="row">${controls}</div>`;
    if (!state.rows) return `${title}<p role="status">Читаємо файл…</p>${controls}`;
    const localErrors = state.rows.filter(row => row.errors.length);
    const rows = localErrors.length ? localErrors.map(row => ({line:row.line,action:'error',error:row.errors.join(' '),values:row.values})) : preview?.entries || [];
    const page = state.page || 1, pages = Math.max(1,Math.ceil(rows.length/20));
    const cards = rows.slice((page-1)*20,page*20).map(row => `<li class="catalog-import-item ${row.action==='error'?'warn':''}"><div><strong>Рядок ${row.line}: ${escape(row.values?.name || state.rows.find(source => source.line === row.line)?.values.name || 'Без назви')}</strong><span class="badge">${row.action==='error'?'Помилка':row.action==='create'?'Новий товар':'Оновлення'}</span></div>${row.error?`<p role="alert">${escape(row.error)}</p>`:`<p class="muted">Закупівля: ${escape(amount(row.values.cost))} грн · Звичайна ціна: ${escape(amount(row.regularPrice))} грн · Діюча: ${escape(amount(row.salePrice))} грн</p>`}</li>`).join('');
    return `${title}<p class="muted">${escape(state.fileName)} · ${state.rows.length} рядків · Стовпці: ${state.mapping.map(escape).join(', ')}</p>
      <div class="catalog-import-options"><label class="form-field">Націнка нових товарів, %<input id="catalogImportMarkup" type="number" inputmode="decimal" min="0" max="99999999.99" step="0.0001" required value="${escape(state.markup)}" ${busy||block||state.completed?'disabled':''}></label>${state.hasGeneric?`<label class="form-field">Стовпець «Ціна» означає<select id="catalogImportGeneric" ${busy||block||state.completed?'disabled':''}><option value="cost" ${state.genericAs==='cost'?'selected':''}>Закупівлю</option><option value="price" ${state.genericAs==='price'?'selected':''}>Звичайну ціну продажу</option></select></label>`:''}</div>
      <p role="status" aria-live="polite">${state.saving?'Зберігаємо весь пакет…':state.loading?'Перевіряємо товари на сервері…':state.completed?`Імпорт збережено: додано ${state.completed.counts.created}, оновлено ${state.completed.counts.updated}.`:preview?`Нових: ${preview.counts.created} · Оновлень: ${preview.counts.updated} · Помилок: ${preview.counts.errors}`:localErrors.length?`Рядків із помилками: ${localErrors.length}. Виправте файл і завантажте знову.`:'Потрібна перевірка перед збереженням.'}</p>
      ${state.failure?`<p class="form-error" role="alert">${escape(state.failure)}</p>`:''}
      ${cards?`<ul class="catalog-import-list">${cards}</ul><nav class="catalog-import-pagination" aria-label="Сторінки попереднього перегляду імпорту">${button('previous','Попередня',page<=1||busy)}<span>${page} / ${pages}</span>${button('next','Наступна',page>=pages||busy)}</nav>`:''}
      <div class="row">${!state.completed&&!localErrors.length?button(state.uncertain?'commit':state.conflict?'preview':preview?.valid?'commit':'preview',state.uncertain?'Перевірити результат / повторити':state.conflict?'Оновити попередній перегляд':preview?.valid?'Зберегти весь пакет':'Перевірити файл',busy):''}${state.refreshFailed?button('refresh','Оновити каталог',busy):''}${controls}</div>`;
  }
  async function read(file, readers) {
    if (!file || locked()) return;
    if(window.CatalogPricing?.dirty()){window.alert('Спершу перевірте результат незавершеної зміни цін.');return;}
    const token = ++sequence; state?.controller?.abort(); state = {fileName:file.name,loading:true}; notify();
    try {
      if (file.size > 5*1024*1024) throw Error('Файл більший за 5 МіБ. Розділіть його на окремі пакети.');
      let table;
      if (/\.csv$/i.test(file.name)) table = readers.parseCsv(await file.text());
      else if (/\.xlsx?$/i.test(file.name)) { const X = await readers.loadXlsx(), workbook = X.read(await file.arrayBuffer(),{type:'array'}); table = X.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1,raw:true,defval:''}); }
      else throw Error('Оберіть CSV, XLS або XLSX.');
      if (token !== sequence) return;
      state = {...parseRows(table,file.name),markup:initialMarkup,genericAs:'cost',page:1}; notify();
      if (!state.error && !state.rows.some(row => row.errors.length)) await preview();
    } catch (error) { if (token === sequence) { state = {fileName:file.name,error:error.message==='load'?'Не вдалося завантажити модуль Excel. Спробуйте CSV.':error.message}; notify(); } }
  }
  async function request(path,payload,signal) {
    const sessionResponse = await fetch('/api/v1/session',{credentials:'same-origin',cache:'no-store',signal});
    if (!sessionResponse.ok) throw Error(sessionResponse.status===401?'Сеанс завершився. Увійдіть знову.':'Не вдалося перевірити сеанс. Повторіть спробу.');
    const session = await sessionResponse.json();
    const response = await fetch('/api/v1/catalog/import/'+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify(payload),signal});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = Error(data.error || 'Сервер не підтвердив результат.'); error.status = response.status; error.code = data.code; throw error; }
    const counts=data?.counts;
    const countValid=counts && ['created','updated','errors'].every(key=>Number.isInteger(counts[key])&&counts[key]>=0&&counts[key]<=1000);
    const entriesValid=Array.isArray(data?.entries)&&data.entries.length>0&&data.entries.length<=1000&&data.entries.every(row=>row&&Number.isInteger(row.line)&&['create','update','error'].includes(row.action));
    const valid=entriesValid && (path==='preview'?typeof data?.valid==='boolean'&&/^[a-f0-9]{64}$/.test(data.snapshot||'')&&data.entries?.every(row=>row.action==='error'?typeof row.error==='string':row.values&&typeof row.values.name==='string'&&[row.values.cost,row.regularPrice,row.salePrice].every(value=>typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value))):data?.ok===true&&data.idempotencyKey===payload.idempotencyKey&&data.entries?.every(row=>typeof row.id==='string'&&typeof row.revision==='string'));
    if(!countValid||!entriesValid||!valid)throw Error('Сервер повернув некоректний результат перевірки. Повторіть спробу.');
    return data;
  }
  async function preview() {
    if (!state?.rows || state.loading || locked() || state.completed) return;
    const current = state; current.preview = null; current.failure = ''; current.conflict = false; current.page = 1;
    try {
      const markup = decimal(current.markup,'Націнка',4), entries = current.rows.map(row => {
        const values = {...row.values}; if (row.generic !== undefined) { values[current.genericAs] = row.generic; if (current.genericAs === 'price') values.manualPrice = true; }
        return {line:row.line,values,...(row.id?{id:row.id}:{})};
      });
      current.payload = {entries,defaultMarkup:markup}; current.commitPayload = null;
      if (new TextEncoder().encode(JSON.stringify(current.payload)).length > 1024*1024-256) throw Error('Дані імпорту більші за 1 МіБ. Розділіть файл на менші пакети.');
      current.loading = true; current.controller = new AbortController(); notify();
      const timer = setTimeout(() => current.controller.abort(),30000);
      try { current.preview = await request('preview',current.payload,current.controller.signal); } finally { clearTimeout(timer); }
    } catch (error) { if (state === current) current.failure = error.name === 'AbortError'?'Перевірка не завершилася. Повторіть спробу.':error.message; }
    finally { current.loading = false; if (state === current) notify(); }
  }
  async function refresh() {
    if (!state?.completed || state.loading) return;
    const current = state; current.loading = true; notify();
    try { await window.TSUKENYA_REFRESH(); current.refreshFailed = false; current.failure = ''; }
    catch (_) { current.refreshFailed = true; current.failure = 'Імпорт збережено. Каталог поки не оновився — повторіть лише оновлення.'; }
    finally { current.loading = false; if (state === current) notify(); }
  }
  async function commit() {
    if (!state?.preview?.valid || state.saving || state.loading || state.completed || state.conflict) return;
    if(window.CatalogPricing?.dirty()){window.alert('Спершу перевірте результат незавершеної зміни цін.');return;}
    const current = state; current.saving = true; current.failure = ''; notify();
    current.commitPayload ||= {...structuredClone(current.payload),snapshot:current.preview.snapshot,idempotencyKey:crypto.randomUUID()};
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(),30000);
    try {
      current.completed = await request('commit',current.commitPayload,controller.signal); current.uncertain = false;
    } catch (error) {
      if (error.status && error.status >= 400 && error.status < 500) {
        current.uncertain = false; current.conflict = true; current.failure = error.message + ' Пакет не збережено.';
      } else { current.uncertain = true; current.failure = 'Немає підтвердження збереження. Файл і перевірку залишено. Натисніть «Перевірити результат / повторити» — повтор не створить дублів.'; }
    } finally { clearTimeout(timeout); current.saving = false; if (state === current) notify(); }
    if (current.completed) await refresh();
  }
  function reset() { if (locked()) return; sequence++; state?.controller?.abort(); state = null; notify(); }
  const api = {html,read,parseRows,decimal,commit,reset,pending:() => !!state?.saving,dirty:() => !!(state?.saving||state?.uncertain)};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CatalogImport = api;
  if (typeof document !== 'undefined') {
    document.addEventListener('click',event => {
      const target = event.target.closest('[data-catalog-import]'); if (!target || target.disabled) return;
      const action = target.dataset.catalogImport;
      if (action === 'preview') void preview(); else if (action === 'commit') void commit(); else if (action === 'refresh') void refresh(); else if (action === 'reset') reset();
      else if (state && ['previous','next'].includes(action)) { state.page = Math.max(1,(state.page||1)+(action==='next'?1:-1)); notify(); document.querySelector('.catalog-import-pagination [data-catalog-import='+action+']')?.focus(); }
    });
    document.addEventListener('change',event => {
      if (!state || state.loading || locked() || state.completed) return;
      if (event.target.id === 'catalogImportMarkup' || event.target.id === 'catalogImportGeneric') {
        state[event.target.id === 'catalogImportMarkup'?'markup':'genericAs'] = event.target.value;
        state.preview = null; state.failure = ''; state.conflict = false; state.commitPayload = null; const id=event.target.id;notify();document.getElementById(id)?.focus({preventScroll:true});
      }
    });
  }
})();
