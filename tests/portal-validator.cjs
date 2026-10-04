/* Proxy encodings must not turn a valid metadata body into a startup failure. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../server/runtime.js'), 'utf8');
const hash = 'a'.repeat(64), token = `"tsukenya-portal-v2-${hash}"`;
const domains = ['products', 'references', 'tasks', 'ideas', 'expenses', 'settings/main', 'project/state'];
const body = { contract: 'portal-metadata-v2', scopeStore: null, networkOwner: true, role: 'owner', csrf: 'synthetic-csrf', labelRevision: 'revision', data: { 'settings/main': { chainName: 'Підтверджена мережа' }, 'project/state': {} }, stateVersions: Object.fromEntries(domains.map(key => [key, hash])) };
function setup() {
  const window = new EventTarget(), queue = [], calls = [];
  window.PortalApi = require('../app/portal-api.js');
  vm.runInNewContext(source, { window, location: {}, document: { hidden: false }, Event, CustomEvent, structuredClone, setInterval() {}, setTimeout, Blob, URL, crypto,
    fetch: async (url, options) => { calls.push(options); assert(queue.length); return queue.shift(); } });
  const reply = (status, etag, value = body) => queue.push({ status, ok: status === 200, headers: { get: () => etag }, json: async () => structuredClone(value) });
  return { window, calls, reply };
}
(async () => {
  for (const suffix of ['-gzip', '-zstd', '-br', '']) {
    const r = setup(), encoded = token.slice(0, -1) + suffix + '"';
    r.reply(200, encoded);
    const db = await r.window.claude.use('db');
    let snapshots = 0;
    db.doc('settings/main').onSnapshot(s => { snapshots++; assert.equal(s.data().chainName, body.data['settings/main'].chainName); });
    r.reply(304, token); // Caddy's bodyless 304 carries the origin validator.
    await r.window.TSUKENYA_REFRESH();
    assert.equal(r.calls.at(-1).headers['If-None-Match'], encoded, 'echo the wire validator');
    assert.equal(snapshots, 1, '304 keeps the confirmed snapshot');
    r.reply(304, token.replace(hash, 'b'.repeat(64)));
    await assert.rejects(r.window.TSUKENYA_REFRESH(), /validator/);
  }
  const r = setup();
  r.reply(200, 'W/' + token); await r.window.claude.use('db');
  r.reply(304, token); await r.window.TSUKENYA_REFRESH();
  r.reply(200, '"opaque-proxy-token"'); await r.window.TSUKENYA_REFRESH();
  r.reply(200, token); await r.window.TSUKENYA_REFRESH();
  assert.equal(r.calls.at(-1).headers['If-None-Match'], undefined, 'unknown optimization falls back to full GET');
  r.reply(200, token, { ...body, data: { ...body.data, products: [] } });
  await assert.rejects(r.window.TSUKENYA_REFRESH(), /Invalid database response/);
  r.reply(200, token); const db = await r.window.claude.use('db');
  let failedCalls = 0;
  assert.throws(() => db.doc('settings/main').onSnapshot(() => { failedCalls++; throw Error('render failed'); }), /render failed/);
  r.reply(200, '', { ...body, data: { ...body.data, 'settings/main': { chainName: 'Новий стан' } } });
  await r.window.TSUKENYA_REFRESH();
  assert.equal(failedCalls, 1, 'a failed initial callback is not left subscribed');
  let scopeEvents = 0;
  r.window.addEventListener('tsukenya:data-changed', () => scopeEvents++);
  const scoped = { ...body, networkOwner: false, scopeStore: 1 };
  r.reply(200, '"unknown-tag"', scoped); await r.window.TSUKENYA_REFRESH();
  r.reply(200, '"unknown-tag"', { ...scoped, scopeStore: 2 }); await r.window.TSUKENYA_REFRESH();
  assert.equal(scopeEvents, 2, 'fallback announces scope changes even with identical document data');
  assert(r.calls.every(call => !call.method), 'all recovery requests are GET');
  console.log('PASS compressed/weak validators, origin 304, mismatch rejection, unknown-validator full GET and strict body validation');
})().catch(error => { console.error(error); process.exitCode = 1; });
