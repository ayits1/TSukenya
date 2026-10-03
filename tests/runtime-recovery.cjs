/* Adapter failure semantics without a browser, DB, or network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server/runtime.js'), 'utf8');

function payload(role = 'manager') {
  return { role, csrf: 'isolated-csrf', labelRevision: 'label-revision', data: {
    tasks: [{ id: 'existing', data: { title: 'Cached task', scope: 'operations' }, permissions: { canEdit: true, canDelete: true } }],
    products: [{ id: 'p1', data: { name: 'Cached product' }, revision: 'product-revision' }],
    'settings/main': { chainName: 'Cached chain' },
  } };
}
function response(status, value) {
  return { status, ok: status >= 200 && status < 300, async json() { return structuredClone(value); } };
}
function runtime() {
  const window = new EventTarget(), calls = [], queue = [], intervals = [], notices = [], recoveries = [];
  window.addEventListener('tsukenya:refresh-failed', event => notices.push(event.detail));
  window.addEventListener('tsukenya:refresh-succeeded', () => recoveries.push(true));
  const location = { href: '/initial' };
  const fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', ...options });
    assert(queue.length, 'test must specify every request: ' + (options.method || 'GET') + ' ' + url);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  vm.runInNewContext(source, { window, location, fetch, document: { hidden: false },
    Event, CustomEvent, structuredClone, crypto: { randomUUID: () => 'synthetic-uuid' },
    setInterval: callback => intervals.push(callback), setTimeout, Blob, URL,
  }, { filename: 'runtime.js' });
  return { window, location, calls, queue, intervals, notices, recoveries,
    async db(initial = payload()) {
      queue.push(response(200, initial));
      return window.claude.use('db');
    } };
}
function cached(db, collection) {
  let snapshot;
  const off = db.collection(collection).onSnapshot(value => { snapshot = value; });
  off();
  return snapshot;
}

(async () => {
  {
    const r = runtime(), db = await r.db(), snapshots = [];
    db.collection('tasks').onSnapshot(s => snapshots.push(s));
    r.queue.push(response(200, { ok: true, id: 'saved' }), response(503, { error: 'private downstream detail' }));
    const saved = await db.collection('tasks').add({ title: 'New task', scope: 'operations' });
    assert.equal(saved.id, 'saved', 'confirmed POST returns document even when subsequent GET fails');
    assert.equal(r.calls.filter(c => c.method === 'POST').length, 1, 'no automatic write retry');
    assert.equal(r.notices.length, 1);
    assert.deepEqual(Object.keys(r.notices[0]), ['message']);
    assert.match(r.notices[0].message, /Не вдалося оновити дані/);
    assert(!JSON.stringify(r.notices).includes('private'), 'failure event contains no response detail');
    assert.equal(snapshots.length, 1, 'failed refresh does not notify a fabricated optimistic state');
    const requests = r.calls.length, old = cached(db, 'tasks').docs[0];
    assert.equal(r.calls.length, requests, 'subscribing to cached snapshot does not write or fetch');
    assert.equal(old.data().title, 'Cached task');
    assert.deepEqual(old.permissions(), { canEdit: true, canDelete: true });
    const incoming = payload();
    incoming.data.tasks.push({ id: 'saved', data: { title: 'New task', scope: 'operations' }, permissions: { canEdit: true, canDelete: true } });
    r.queue.push(response(200, incoming));
    await r.window.TSUKENYA_REFRESH();
    assert.equal(cached(db, 'tasks').docs.length, 2);
    assert.equal(r.recoveries.length, 2, 'successful retry announces banner recovery');
    assert.equal(r.calls.filter(c => c.method !== 'GET').length, 1, 'refresh retry only reads');
    assert.equal(r.calls.at(-1).method, 'GET');
  }
  {
    const r = runtime(), db = await r.db();
    r.queue.push(response(403, { error: 'Недостатньо прав для задачі.' }));
    await assert.rejects(db.collection('tasks').add({ title: 'Denied' }), /Недостатньо прав/);
    assert.equal(r.notices.length, 0, 'write rejection is not a refresh failure');
    assert.deepEqual(r.calls.map(c => c.method), ['GET', 'POST'], 'denied write is neither refreshed nor retried');
    r.queue.push(new Error('Ambiguous network transport failure'));
    await assert.rejects(db.collection('tasks').add({ title: 'Unknown result' }), /Ambiguous/);
    assert.equal(r.calls.filter(c => c.method === 'POST').length, 2, 'transport ambiguity never retries POST');
  }
  {
    const r = runtime(), db = await r.db();
    for (const bad of [{ data: null, csrf: 'x', role: 'owner' }, { data: [], csrf: 'x', role: 'owner' },
      { data: {}, csrf: 'x' }, { data: {}, csrf: 'x', role: 'admin' },
      { data: {}, csrf: null, role: 'owner' }, { data: {}, csrf: 'x', role: 'owner', labelRevision: {} }]) {
      r.queue.push(response(200, bad));
      await assert.rejects(r.window.TSUKENYA_REFRESH(), /Invalid database response/);
      assert.equal(r.window.TSUKENYA_ROLE, 'manager', 'malformed GET cannot replace role with owner');
      assert.equal(cached(db, 'tasks').docs[0].id, 'existing');
      assert.deepEqual(cached(db, 'tasks').docs[0].permissions(), { canEdit: true, canDelete: true });
    }
    r.queue.push(new Error('private server hostname and customer data'));
    await assert.rejects(r.window.TSUKENYA_REFRESH(), /private server/);
    assert(!JSON.stringify(r.notices).includes('private'), 'network failure details are excluded from UI event');
    r.queue.push(response(200, { ok: true }), response(503, {}));
    await db.doc('products/p1').update({ name: 'Confirmed product' });
    const write = r.calls.find(c => c.method === 'PATCH');
    assert.equal(write.headers['If-Match'], 'product-revision', 'failed GET preserves existing version');
    assert.equal(write.headers['X-CSRF-Token'], 'isolated-csrf', 'failed GET preserves existing CSRF');
  }
  {
    const r = runtime(), initial = payload('cashier');
    initial.data.tasks[0].permissions = { canEdit: false, canDelete: false };
    const db = await r.db(initial);
    r.queue.push(response(503, {}));
    await assert.rejects(r.window.TSUKENYA_REFRESH());
    assert.equal(r.window.TSUKENYA_ROLE, 'cashier');
    assert.deepEqual(cached(db, 'tasks').docs[0].permissions(), { canEdit: false, canDelete: false });
    let notifications = 0;
    db.collection('tasks').onSnapshot(() => notifications++);
    r.queue.push(response(200, { ...initial, role: 'manager' }));
    await r.window.TSUKENYA_REFRESH();
    assert.equal(notifications, 2, 'role-only change notifies existing subscribers');
    assert.equal(r.window.TSUKENYA_ROLE, 'manager');
    const before = notifications;
    r.queue.push(response(200, { ...initial, role: 'manager' }));
    await r.window.TSUKENYA_REFRESH();
    assert.equal(notifications, before, 'unchanged data and role does not need rerender');
    assert.equal(r.recoveries.length, 3, 'unchanged successful GET still clears recovery banner');
  }
  {
    const r = runtime(), db = await r.db();
    for (const [method, operation] of [
      ['PUT', () => db.doc('settings/main').set({ chainName: 'Changed' })],
      ['DELETE', () => db.collection('tasks').doc('existing').delete()],
    ]) {
      r.queue.push(response(200, { ok: true }), response(503, {}));
      assert.equal((await operation()).ok, true);
      const write = r.calls.find(c => c.method === method);
      if (method === 'PUT') assert.equal(write.headers['If-Match'], 'label-revision');
    }
    let release;
    r.queue.push(() => new Promise(resolve => { release = resolve; }));
    const first = r.window.TSUKENYA_REFRESH(), second = r.window.TSUKENYA_REFRESH();
    assert.equal(r.calls.filter(c => c.url === '/api/state').length, 4, 'concurrent refresh callers share one request');
    release(response(200, payload()));
    await Promise.all([first, second]);
    assert.equal(r.queue.length, 0);
  }
  {
    // A GET already in flight when a write is confirmed may predate it: the write waits for a fresh GET.
    const r = runtime(), db = await r.db(), seen = [];
    db.collection('tasks').onSnapshot(s => seen.push(s.docs.map(d => d.id)));
    let releaseStale;
    r.queue.push(() => new Promise(resolve => { releaseStale = resolve; }));
    const stale = r.window.TSUKENYA_REFRESH();
    const fresh = payload();
    fresh.data.tasks.push({ id: 'saved', data: { title: 'New task', scope: 'operations' }, permissions: { canEdit: true, canDelete: true } });
    r.queue.push(response(200, { ok: true, id: 'saved' }), response(200, fresh));
    let added = false;
    const write = db.collection('tasks').add({ title: 'New task', scope: 'operations' }).then(ref => { added = true; return ref; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(r.calls.map(c => c.method), ['GET', 'GET', 'POST'], 'write sent while the earlier GET is pending');
    assert.equal(added, false);
    releaseStale(response(200, payload()));
    await stale;
    assert.equal((await write).id, 'saved');
    assert.deepEqual(r.calls.map(c => c.method), ['GET', 'GET', 'POST', 'GET'], 'a fresh GET is chained after the stale one');
    assert.deepEqual(seen.at(-1), ['existing', 'saved'], 'saved document is visible when the write resolves');
    assert.equal(r.queue.length, 0);
    // A GET that starts after the confirmed write is fresh and is shared, not repeated.
    let releaseWrite, releaseRead;
    r.queue.push(() => new Promise(resolve => { releaseWrite = resolve; }), () => new Promise(resolve => { releaseRead = resolve; }));
    const second = db.collection('tasks').add({ title: 'Second' });
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseWrite(response(200, { ok: true, id: 'second' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(r.calls.slice(4).map(c => c.method), ['POST', 'GET']);
    const poll = r.window.TSUKENYA_REFRESH();
    releaseRead(response(200, fresh));
    await Promise.all([second, poll]);
    assert.deepEqual(r.calls.slice(4).map(c => c.method), ['POST', 'GET'], 'a poll during the post-write GET shares it');
  }
  {
    // An explicit refresh (after a catalogue/import write through another API) does not reuse a background poll.
    const r = runtime(), db = await r.db(), fresh = payload();
    fresh.data.products[0].data.name = 'Saved elsewhere';
    let releasePoll;
    r.queue.push(() => new Promise(resolve => { releasePoll = resolve; }), response(200, fresh));
    r.intervals[0]();
    assert.equal(r.calls.length, 2, 'poll GET in flight');
    r.intervals[0]();
    assert.equal(r.calls.length, 2, 'a poll does not overlap a pending read');
    const explicit = r.window.TSUKENYA_REFRESH(), shared = r.window.TSUKENYA_REFRESH();
    releasePoll(response(200, payload()));
    await Promise.all([explicit, shared]);
    assert.equal(r.calls.length, 3, 'explicit callers share one read started after the poll');
    assert.equal(cached(db, 'products').docs[0].data().name, 'Saved elsewhere');
    assert.equal(r.queue.length, 0);
  }
  {
    // Server reasons are marked for display; transport and 5xx texts are not.
    const r = runtime(), db = await r.db();
    r.queue.push(response(409, { error: 'Товар уже змінено. Оновіть дані перед повторним збереженням.', code: 'revision_conflict' }));
    const conflict = await db.doc('products/p1').update({ name: 'Late' }).catch(error => error);
    assert.equal(conflict.serverMessage, 'Товар уже змінено. Оновіть дані перед повторним збереженням.');
    assert.equal(conflict.status, 409);
    r.queue.push(response(503, { error: 'upstream connect error' }));
    const unavailable = await db.doc('products/p1').update({ name: 'Late' }).catch(error => error);
    assert.equal(unavailable.serverMessage, undefined, 'a 5xx body is not a business reason');
    r.queue.push({ status: 502, ok: false, async json() { throw new SyntaxError('Unexpected token <'); } });
    const html = await db.doc('products/p1').update({ name: 'Late' }).catch(error => error);
    assert.equal(html.message, 'Save failed');
    assert.equal(html.serverMessage, undefined);
    assert.equal(r.calls.filter(c => c.method === 'GET').length, 1, 'refused writes do not refresh');
  }
  {
    // Editors send the revision they opened, not the latest polled one.
    const r = runtime(), db = await r.db(), updated = payload();
    updated.data.products[0].revision = 'changed-elsewhere';
    updated.labelRevision = 'label-changed-elsewhere';
    r.queue.push(response(200, updated));
    await r.window.TSUKENYA_REFRESH();
    assert.equal(cached(db, 'products').docs[0].revision, 'changed-elsewhere', 'snapshot exposes the shown product revision');
    let settings;
    db.doc('settings/main').onSnapshot(s => { settings = s; })();
    assert.equal(settings.revision, 'label-changed-elsewhere', 'settings snapshot exposes the shown label revision');
    r.queue.push(response(409, { error: 'Товар уже змінено.' }));
    await assert.rejects(db.collection('products').doc('p1').update({ name: 'Edited' }, { revision: 'product-revision' }));
    assert.equal(r.calls.at(-1).headers['If-Match'], 'product-revision');
    r.queue.push(response(409, { error: 'Товар уже змінено.' }));
    await assert.rejects(db.collection('products').doc('p1').delete({ revision: 'product-revision' }));
    assert.equal(r.calls.at(-1).headers['If-Match'], 'product-revision');
    r.queue.push(response(200, { ok: true }), response(200, updated));
    await db.collection('products').doc('p1').update({ promotion: true });
    assert.equal(r.calls.find(c => c.method === 'PATCH' && c.headers['If-Match'] === 'changed-elsewhere') !== undefined, true, 'immediate actions keep the latest revision');
  }
  {
    // A settings write returns its layout version; the next save chains from it even if the read after it fails.
    const r = runtime(), db = await r.db();
    r.queue.push(response(200, { ok: true, id: 'main', revision: 'label-after-first' }), response(503, { error: 'down' }));
    await db.doc('settings/main').update({ tag: { size: 'l' } });
    assert.equal(r.calls.at(-2).headers['If-Match'], 'label-revision');
    r.queue.push(response(200, { ok: true, id: 'main', revision: 'label-after-second' }), response(200, payload()));
    await db.doc('settings/main').update({ chainName: 'Second' });
    assert.equal(r.calls.at(-2).headers['If-Match'], 'label-after-first', 'second save uses the version returned by the first');
    // A later poll may carry another session's layout; a save from the shown version still conflicts.
    const elsewhere = payload(); elsewhere.labelRevision = 'label-changed-elsewhere';
    r.queue.push(response(200, elsewhere));
    await r.window.TSUKENYA_REFRESH();
    r.queue.push(response(409, { error: 'Макет уже змінено. Оновіть дані перед повторним збереженням.', code: 'revision_conflict' }));
    const conflict = await db.doc('settings/main').update({ tag: { size: 's' } }, { revision: 'label-after-second' }).catch(error => error);
    assert.equal(r.calls.at(-1).headers['If-Match'], 'label-after-second');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.serverMessage, 'Макет уже змінено. Оновіть дані перед повторним збереженням.');
  }
  console.log('RUNTIME RECOVERY PASS: confirmed writes, read retry, true write errors, cache/role/permissions, malformed reads, coalescing, fresh read after write and after a poll, server reasons, opened revisions');
})().catch(error => { console.error(error); process.exitCode = 1; });
