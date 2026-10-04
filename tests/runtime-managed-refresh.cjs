/* Adapter failure semantics without a browser, DB, or network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server/runtime.js'), 'utf8');

const domains = ['products','references','tasks','ideas','expenses','settings/main','project/state'];
const etag = version => '"tsukenya-portal-v2-' + String(version).repeat(64) + '"';
function payload(role = 'manager', taskVersion = 1) {
  return { contract:'portal-metadata-v2',scopeStore:null,networkOwner:role==='owner',role, csrf: 'isolated-csrf', labelRevision: 'label-revision',
    stateVersions:Object.fromEntries(domains.map(domain => [domain, (domain==='tasks'?String(taskVersion):'a').repeat(64)])),data: {
    'project/state':{},
    'settings/main': { chainName: 'Cached chain' },
  } };
}
function response(status, value, version = 1) {
  return { status, ok: status >= 200 && status < 300, headers:{get: name => name==='ETag'?etag(version):null}, async json() { return structuredClone(value); } };
}
function runtime() {
  const window = new EventTarget();window.PortalApi=require('../app/portal-api.js');const calls = [], queue = [], intervals = [], notices = [], recoveries = [];
  const changes = [], listRefreshes = [];
  window.addEventListener('tsukenya:data-changed', event => changes.push(event.detail.domains===null?null:Array.from(event.detail.domains)));
  window.PortalCollections={async refreshVisible(){listRefreshes.push(changes.at(-1));}};
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
  return { window, location, calls, queue, intervals, notices, recoveries, changes, listRefreshes,
    async db(initial = payload()) {
      queue.push(response(200, initial));
      return window.claude.use('db');
    } };
}
(async()=>{
 const r=runtime(),db=await r.db();let release;
 assert.throws(()=>db.collection('tasks').onSnapshot(()=>{}),/unavailable/,'metadata cannot masquerade as a complete task list');
 r.queue.push(()=>new Promise(resolve=>release=resolve));
 const earlier=r.window.TSUKENYA_REFRESH();
 const incoming=payload('manager',2);
 r.queue.push(response(200,incoming,2));
 const after=r.window.TSUKENYA_REFRESH_AFTER_WRITE();
 assert.equal(r.calls.length,2,'external confirmed write waits for existing read before fresh GET');
 release(response(200,payload()));await earlier;await after;
 assert.equal(r.calls.length,3,'fresh GET chained after preceding manual read');
 assert.deepEqual(r.changes.at(-1),['tasks'],'fresh metadata invalidates the externally changed task domain');
 assert.equal(r.listRefreshes.length,2,'both explicit reads refresh the visible bounded list');
 assert.deepEqual(r.listRefreshes.at(-1),['tasks'],'confirmed-write recovery refreshes the list after fresh task metadata');
 assert.equal(r.queue.length,0,'all specified metadata responses were consumed');
 assert(r.calls.every(call=>call.url==='/api/v1/portal/metadata'),'runtime recovery reads only slim metadata');
 assert(r.calls.every(call=>call.method==='GET'),'read recovery never repeats external write');
 console.log('PASS external confirmed alert mutation refresh waits for preceding GET and reads fresh state');
})().catch(error=>{console.error(error);process.exitCode=1;});
