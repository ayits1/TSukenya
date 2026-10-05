/* Independent trading validator namespace. Business writes never enter this module. */
(function () {
  'use strict';
  const resources = Object.freeze(['stock','assortment','stock_documents','purchases_documents','replenishment','sales_documents','sales_shifts','finance_accounts','finance_ledger','finance_documents','finance_debts','finance_advances','staff_employees','staff_shifts','staff_documents','directories','policy','customers_contacts','customers_metrics','customers_debts','reports_period','reports_balances','reports_salary','reports_abc']);
  const roles = ['owner','manager','cashier','warehouse','accountant'];
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
  const id = value => value === null || Number.isSafeInteger(value) && value > 0;
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  function decode(value, context) {
    if (!exact(value,['contract','identity','day','versions']) || value.contract !== 'trading-versions-v1' ||
        !exact(value.identity,['role','scopeStore','store','session']) || !roles.includes(value.identity.role) ||
        !id(value.identity.store) || !id(value.identity.scopeStore) || value.identity.store !== context.store ||
        !hash(value.identity.session) || typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) || Number.isNaN(Date.parse(value.day+'T00:00:00Z')) || new Date(value.day+'T00:00:00Z').toISOString().slice(0,10)!==value.day ||
        !exact(value.versions,context.resources) || !Object.values(value.versions).every(hash))
      throw Error('Сервер повернув невідомий контракт перевірки обліку.');
    return value;
  }
  function validator(value) {
    return typeof value === 'string' ? /^(?:W\/)?"tsukenya-trading-v1-([a-f0-9]{64})(?:-(?:gzip|br|zstd))?"$/.exec(value)?.[1] ?? null : null;
  }
  function contextOf(registration) {
    const value=registration.context();
    if (!exact(value,['store','resources']) || !id(value.store) || !Array.isArray(value.resources) || !value.resources.length || value.resources.length>8 ||
        new Set(value.resources).size !== value.resources.length || value.resources.some(value => !resources.includes(value)))
      throw Error('Некоректний контекст перевірки обліку.');
    return {store:value.store,resources:[...value.resources].sort()};
  }
  function create({transport=fetch, visible=()=>document.visibilityState==='visible', invalidated=()=>{}, notice=()=>{}}={}) {
    let active=null, generation=0, request=null, running=false;
    function cancel() { generation++; request?.abort(); request=null; running=false; }
    function current(job, token, context) { return active===job && generation===token && visible() && JSON.stringify(contextOf(job.registration))===JSON.stringify(context); }
    function deny(job,status) {
      cancel(); job.denied=true;job.registration.deny();notice(job,'Доступ до обліку змінився. Перевірте сеанс.',false);
      invalidated(status);
    }
    async function poll(manual=false) {
      const job=active;
      if (!job || !visible() || job.denied) return;
      let context;
      try { context=contextOf(job.registration); } catch { notice(job,'Не вдалося визначити підтверджений контекст.',true);return; }
      const key=JSON.stringify(context);
      if(job.key!==key) {cancel();job.key=key;job.etag=null;job.value=null;job.confirmed=null;job.pending=true;}
      if(running)return;
      const token=generation,controller=new AbortController();request=controller;running=true;
      const stamp=job.registration.readStamp();
      let refreshing=false;
      const live=()=>current(job,token,context)&&!controller.signal.aborted;
      try {
        const params=new URLSearchParams({resources:context.resources.join(',')});if(context.store!==null)params.set('store',String(context.store));
        const response=await transport('/api/v1/trading/versions?'+params,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:job.etag?{'If-None-Match':job.etag}:{}});
        // Obsolete issued 401 is discarded BEFORE any invalidation/redirect.
        if(!live())return;
        if(stamp!==job.registration.readStamp()) {job.etag=null;job.pending=true;return;}
        if(response.status===401||response.status===403){deny(job,response.status);return;}
        if(response.status===304) {
          if(!job.value || !job.etag || validator(response.headers.get('ETag'))!==validator(job.etag))throw Error('Некоректна умовна відповідь обліку.');
        } else {
          if(!response.ok)throw Error('Не вдалося перевірити зміни обліку.');
          const value=decode(await response.json(),context);if(!live())return;
          if(stamp!==job.registration.readStamp()){job.etag=null;job.pending=true;return;}
          const expected=job.registration.identity;
          if(value.identity.role!==expected.role || value.identity.scopeStore!==expected.scopeStore || job.value && value.identity.session!==job.value.identity.session) {deny(job,403);return;}
          job.value=value; const wire=response.headers.get('ETag');job.etag=validator(wire)?wire:null;
          if(JSON.stringify(value)!==job.confirmed)job.pending=true;
        }
        if(!job.pending){notice(job,'',false);return;}
        if(job.registration.mode==='manual'&&!manual || job.registration.blocked()) {
          notice(job,'Є непідтверджене оновлення списку. Чернетки збережені; перечитайте список після завершення редагування.',true);return;
        }
        // One bounded current-page refresh per tick. Never remount/reset a business editor.
        if(job.registration.revalidate)await job.registration.revalidate(controller.signal);
        if(!live()||job.registration.blocked())return;
        if(stamp!==job.registration.readStamp()){job.etag=null;job.pending=true;return;}
        refreshing=true;
        const refreshed=await job.registration.refresh(controller.signal);
        if(!live()||job.registration.blocked())return;
        if(refreshed!==true)throw Error('Поточний список не підтверджений.');
        // Do not acknowledge an earlier validator after an independent read. The
        // next conditional check validates the read barrier; a changed token
        // leaves pending and schedules another bounded read, never an endless loop.
        job.confirmed=JSON.stringify(job.value);job.pending=false;notice(job,'',false);

      } catch(error) {
        if(live() && (refreshing||stamp===job.registration.readStamp()) && error && (error.status===401 || error.status===403)) {deny(job,error.status);return;}
        if(live()&&(refreshing||stamp===job.registration.readStamp())&&!(error instanceof Error&&error.name==='AbortError'))notice(job,'Не вдалося перевірити зміни. Показано попереднє підтверджене читання; повторіть лише GET.',true);
      } finally {if(active===job&&token===generation){request=null;running=false;}}
    }
    return {
      register(registration) {
        cancel();if(active)notice(active,'',false);
        const job={registration,key:null,etag:null,value:null,confirmed:null,pending:true,denied:false};active=job;
        void poll();return ()=>{if(active===job){cancel();notice(job,'',false);active=null;}};
      },
      poll,
      suspend:()=>cancel(),
      identity(role,scopeStore) {if(active&&(active.registration.identity.role!==role||active.registration.identity.scopeStore!==scopeStore))deny(active,403);},
      dispose(){cancel();if(active)notice(active,'',false);active=null;},
    };
  }
  let box=null;
  const coordinator=create({
    invalidated(status) {
      const recovery=window.NativeDraftRecovery?.controller;
      recovery?.suspend();
      window.Trade?.freshnessDeny?.();
      if(status===401) {window.dispatchEvent(new Event('tsukenya:session-invalidated'));location.assign('/');}
      else void recovery?.check(false).catch(()=>{});
    },
    notice(job,text,retry) {
      if(!text){box?.remove();box=null;window.Trade?.freshnessNotice?.('');return;}
      if(!box){box=document.createElement('aside');box.className='alert';box.setAttribute('aria-label','Актуальність обліку');job.registration.host.before(box);}
      box.replaceChildren();const message=document.createElement('p');message.setAttribute('role','status');message.textContent=text;box.append(message);
      if(retry){const button=document.createElement('button');button.className='btn';button.type='button';button.textContent='Перечитати';button.onclick=()=>void coordinator.poll(true);box.append(button);}
      window.Trade?.freshnessNotice?.(text);
    },
  });
  window.TradingFreshness={register:coordinator.register,create,decode,validator};
  setInterval(()=>void coordinator.poll(),5000);
  window.addEventListener('focus',()=>void coordinator.poll());
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void coordinator.poll();else coordinator.suspend();});
  window.addEventListener('pagehide',()=>coordinator.dispose());
  window.addEventListener('tsukenya:data-changed',()=>coordinator.identity(window.TSUKENYA_ROLE,window.TSUKENYA_SCOPE_STORE));
})();
