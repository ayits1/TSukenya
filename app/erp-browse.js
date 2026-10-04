/* Read-only document search. A child dialog preserves the editor behind it. */
(() => {
  'use strict';
  let active = null;
  const close = () => active?.close();

  function create({api, esc, amount, name, table, kinds}) {
    function browse({purpose, store, party, selected, partyName, history = false}) {
      close();
      const opener = document.activeElement;
      const d = document.createElement('dialog');
      d.className = 'trade-dialog trade-document-browser';
      d.setAttribute('aria-labelledby', 'tradeBrowseTitle');
      d.innerHTML = `<div class="trade-dialog-head"><h2 id="tradeBrowseTitle">${history ? 'Історія: ' + esc(partyName ?? name('parties', party)) : 'Вибрати вихідний документ'}</h2><button class="btn soft" type="button" data-browse="close">Закрити</button></div>
        <div class="trade-dialog-body"><form class="trade-browse-filters">
          <label class="trade-browse-search">Пошук за номером або контрагентом<input type="search" name="q" maxlength="250" autocomplete="off" placeholder="Наприклад, 000001"></label>
          <label>З дати<input type="date" name="from"></label><label>По дату<input type="date" name="to"></label>
          <button class="btn" type="submit">Знайти</button><button class="btn soft" type="button" data-browse="reset">Скинути</button>
        </form><p class="trade-caption">${history ? 'Документи, доступні вашій ролі. Фільтри застосовуються до всієї історії.' : 'Показано лише проведені документи, доступні для цієї операції й магазину.'}</p>
        <p class="trade-error" role="alert" tabindex="-1" data-browse-error></p>
        <div data-browse-results aria-busy="true"></div></div>
        <div class="trade-dialog-foot"><span role="status" aria-live="polite" data-browse-status></span><button class="btn soft" type="button" data-browse="prev">Назад</button><button class="btn soft" type="button" data-browse="next">Далі</button></div>`;
      document.body.append(d);
      active = d;
      const form = d.querySelector('form'), results = d.querySelector('[data-browse-results]'), status = d.querySelector('[data-browse-status]'), error = d.querySelector('[data-browse-error]');
      let page = 1, pages = 1, items = [], controller, request = 0, busy = false, timer, chosen = null;
      const promise = new Promise(resolve => d.addEventListener('close', () => {
        clearTimeout(timer); controller?.abort(); request++;
        if(active === d) active = null;
        d.remove();
        if(opener?.isConnected) opener.focus({preventScroll:true});
        resolve(chosen);
      }, {once:true}));
      const disablePaging = () => {
        d.querySelector('[data-browse=prev]').disabled = busy || page <= 1;
        d.querySelector('[data-browse=next]').disabled = busy || page >= pages;
      };
      async function load(focusResults = false) {
        clearTimeout(timer); controller?.abort(); controller = new AbortController(); const token = ++request;
        const values = Object.fromEntries(new FormData(form));
        if(values.from && values.to && values.from > values.to) {
          busy = false; page = pages = 1; items = []; results.removeAttribute('aria-busy'); results.innerHTML = ''; error.textContent = 'Початкова дата не може бути пізнішою за кінцеву.'; status.textContent = 'Перевірте дати пошуку.'; disablePaging(); error.focus(); return;
        }
        busy = true; disablePaging(); results.setAttribute('aria-busy', 'true'); error.textContent = ''; status.textContent = 'Завантажуємо документи…';
        results.querySelectorAll('button').forEach(button => button.disabled = true);
        try {
          const params = new URLSearchParams({...values, page:String(page), ...(store ? {store:String(store)} : {}), ...(party ? {party:String(party)} : {}), ...(purpose ? {purpose} : {})});
          const data = await api((history ? 'vouchers?' : 'references?') + params, 'GET', undefined, controller.signal);
          if(!d.open || token !== request) return;
          items = data.items; page = data.page; pages = data.pages || Math.max(1, Math.ceil(data.total / 30));
          results.innerHTML = table(['Документ', 'Дата', 'Контрагент', history ? 'Сума' : purpose === 'payment' ? 'До оплати' : 'Сума', 'Дія'], items.map(item => [
            `№ ${esc(item.number)}<span class="muted">${esc(kinds[item.kind])}${history ? ' · ' + esc({draft:'Чернетка',posted:'Проведено',reversed:'Скасовано'}[item.status]) : ''}</span>`,
            esc(item.date), esc(name('parties', item.party)), amount(purpose === 'payment' ? item.outstanding : item.total) + ' грн',
            `<button class="btn soft" type="button" data-browse="choose" data-id="${item.id}" aria-label="${history?'Відкрити':'Вибрати'} ${String(item.id)===String(selected)?'поточний ':''}документ № ${esc(item.number)}: ${esc(kinds[item.kind])}">${history ? 'Відкрити' : 'Вибрати'}</button>`
          ]), 'Документів за цими умовами немає. Змініть пошук або дати.');
          status.textContent = data.total ? `${(page - 1) * 30 + 1}–${Math.min(page * 30, data.total)} із ${data.total} · сторінка ${page} з ${pages}` : '0 документів';
          if(focusResults) {
            const target = results.querySelector('button') || status;
            target.tabIndex = target.matches('button') ? 0 : -1;
            target.focus();
          }
        } catch(e) {
          if(token !== request || !d.open || e.name === 'AbortError') return;
          error.textContent = e.message; status.textContent = 'Не вдалося завантажити документи.';
          results.innerHTML = '<button class="btn soft" type="button" data-browse="retry">Завантажити повторно</button>';
          if(focusResults) results.querySelector('button').focus();
        } finally {
          if(token === request) {busy = false; results.removeAttribute('aria-busy'); disablePaging();}
        }
      }
      form.onsubmit = event => {event.preventDefault(); page = 1; void load();};
      form.oninput = event => {if(event.target.name === 'q') {controller?.abort();request++;busy=true;disablePaging();results.setAttribute('aria-busy','true');results.querySelectorAll('button').forEach(button=>button.disabled=true);status.textContent='Оновлюємо пошук…';page = 1; clearTimeout(timer); timer = setTimeout(load, 250);}};
      form.onchange = event => {if(event.target.name==='from'||event.target.name==='to'){page=1;void load();}};
      d.addEventListener('click', event => {
        const button = event.target.closest('[data-browse]');
        if(!button || button.disabled) return;
        const action = button.dataset.browse;
        if(action === 'close') d.close();
        if(action === 'reset') {form.reset(); page = 1; void load(); form.elements.q.focus();}
        if(action === 'retry') void load();
        if(action === 'next' || action === 'prev') {page += action === 'next' ? 1 : -1; void load(true);}
        if(action === 'choose' && !busy) {chosen = items.find(item => String(item.id) === button.dataset.id); d.close();}
      });
      d.showModal(); form.elements.q.focus(); void load();
      return promise;
    }
    return {pick:options => browse(options), history:(party, options={}) => browse({...options, party, history:true})};
  }
  window.TradeBrowse = {create, close};
})();
