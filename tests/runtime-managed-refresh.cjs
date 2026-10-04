/* Adapter failure semantics without a browser, DB, or network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server/runtime.js'), 'utf8');

function payload(role = 'manager') {
  return { contract:'portal-metadata-v1',networkOwner:role==='owner',role, csrf: 'isolated-csrf', labelRevision: 'label-revision', data: {
    tasks: [{ id: 'existing', data: { title: 'Cached task', scope: 'operations' }, permissions: { canEdit: true, canDelete: true } }],
    ideas:[],expenses:[],'project/state':{},
    'settings/main': { chainName: 'Cached chain' },
  } };
}
function response(status, value) {
  return { status, ok: status >= 200 && status < 300, async json() { return structuredClone(value); } };
}
function runtime() {
  const window = new EventTarget();window.PortalApi=require('../app/portal-api.js');const calls = [], queue = [], intervals = [], notices = [], recoveries = [];
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

(async()=>{
 const r=runtime(),db=await r.db();let release;
 r.queue.push(()=>new Promise(resolve=>release=resolve));
 const earlier=r.window.TSUKENYA_REFRESH();
 const incoming=payload();incoming.data.tasks[0].data.title='Confirmed alert action';incoming.data.tasks[0].revision='new-task-revision';
 r.queue.push(response(200,incoming));
 const after=r.window.TSUKENYA_REFRESH_AFTER_WRITE();
 assert.equal(r.calls.length,2,'external confirmed write waits for existing read before fresh GET');
 release(response(200,payload()));await earlier;await after;
 assert.equal(r.calls.length,3,'fresh GET chained after preceding manual read');
 assert.equal(cached(db,'tasks').docs[0].data().title,'Confirmed alert action');
 assert.equal(cached(db,'tasks').docs[0].revision,'new-task-revision');
 assert(r.calls.every(call=>call.method==='GET'),'read recovery never repeats external write');
 console.log('PASS external confirmed alert mutation refresh waits for preceding GET and reads fresh state');
})().catch(error=>{console.error(error);process.exitCode=1;});
