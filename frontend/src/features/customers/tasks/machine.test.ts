import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftStore, type Payload } from '../../../shared/recovery/storage';
import { RecoveryController } from '../../../shared/recovery/controller';
import { TaskMachine, installTaskRecovery } from './machine';
import * as api from './api';
const id = '11111111-1111-4111-8111-111111111111';
const session = {
  draftOwner: 'a'.repeat(64),
  draftSession: 'b'.repeat(64),
  role: 'owner' as const,
  storeId: null,
  networkOwner: true,
};
const base: api.Raw = {
  title: 'Pending request',
  note: 'Private',
  due_on: '',
  assignee: '',
  status: 'todo',
  archived: false,
};
function payload(confirmed = false): Payload {
  return {
    baseline: api.json({
      recordId: 'contact_' + id,
      id,
      customer: 1,
      store: 2,
      revision: confirmed ? 1 : null,
      base,
      needsReview: false,
      confirmed,
    }),
    draft: api.json(base),
    firstIntent: null,
    confirmation: null,
  };
}
class Memory implements Storage {
  data = new Map<string, string>();
  failRemove = false;
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(k: string) {
    if (this.failRemove) throw Error('remove quota');
    this.data.delete(k);
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}
const pause = () => new Promise((r) => setTimeout(r, 0));
function setup() {
  const memory = new Memory(),
    store = new DraftStore(memory),
    controller = new RecoveryController(store, async () => session);
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('window', {
    NativeDraftRecovery: {
      store,
      controller,
      register: (codec: Parameters<DraftStore['register']>[0]) => store.register(codec),
      close: vi.fn(),
    },
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.startsWith('/api/v1/crm/contact-task-context')
              ? {
                  resource: 'contact_task',
                  id,
                  exists: true,
                  customer: 1,
                  store: 2,
                  role: 'owner',
                  storeId: null,
                  canEdit: true,
                }
              : { ...session, csrf: 'current-csrf' },
          ),
          { status: 200 },
        ),
    ),
  );
  installTaskRecovery(() => {});
  return { memory, store, controller };
}
afterEach(() => vi.unstubAllGlobals());
describe('contact task machine privacy and final-await boundary', () => {
  it('last awaited session completion after Close retains frozen raw intent and issues zero business POST', async () => {
    const { store } = setup(),
      m = new TaskMachine(payload());
    await m.prepare();
    let release: (r: Response) => void = () => {};
    const held = new Promise<Response>((r) => (release = r));
    const original = globalThis.fetch;
    const writes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, options?: RequestInit) => {
        if (options?.method === 'POST') writes.push(path);
        if (path === '/api/v1/session') return held;
        return original(path, options);
      }),
    );
    const saving = m.save();
    await pause();
    await pause();
    m.raw({ ...base, title: '', due_on: 'invalid newer' });
    m.dispose();
    release(new Response(JSON.stringify({ ...session, csrf: 'fresh' })));
    await saving;
    expect(writes).toEqual([]);
    expect(store.beforeSend('contact_' + id)?.body).toMatchObject({ terms: { title: base.title } });
    expect(api.raw(m.snapshot().payload.draft).due_on).toBe('invalid newer');
  });
  it('late ignored-abort current401 after Close cannot erase this or another unknown intent', async () => {
    const { store, memory } = setup(),
      m = new TaskMachine(payload(true));
    await m.prepare();
    const otherId = '33333333-3333-4333-8333-333333333333',
      other = payload();
    other.baseline = api.json({
      ...api.state(other.baseline),
      id: otherId,
      recordId: 'contact_' + otherId,
    });
    other.firstIntent = {
      method: 'POST',
      path: '/api/v1/crm/contact-tasks',
      key: otherId,
      revision: null,
      possiblySent: true,
      body: {
        id: otherId,
        request_key: otherId,
        customer: 1,
        store: 2,
        terms: api.json(api.capture(base)),
      },
    };
    store.save('contact_' + otherId, 'contact_task', other);
    const old = [...memory.data];
    let entered = false,
      release: (r: Response) => void = () => {};
    const held = new Promise<Response>((r) => (release = r)),
      original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, options?: RequestInit) => {
        if (path === '/api/v1/crm/contact-tasks/' + id) {
          entered = true;
          return held;
        }
        return original(path, options);
      }),
    );
    const reading = m.current();
    while (!entered) await pause();
    m.dispose();
    release(new Response(JSON.stringify({ error: 'Obsolete401' }), { status: 401 }));
    await reading;
    expect([...memory.data]).toEqual(old);
    expect(store.beforeSend('contact_' + otherId)).toEqual(other.firstIntent);
    expect(m.snapshot().visible).toBe(false);
  });
  it('storage removal failure stays visible as public error, hides private fields and preserves record', async () => {
    const { memory } = setup(),
      m = new TaskMachine(payload());
    await m.prepare();
    const old = [...memory.data];
    memory.failRemove = true;
    expect(await m.discard()).toBe(false);
    expect(m.snapshot().visible).toBe(false);
    expect(m.snapshot().error).toContain('Не вдалося відкинути');
    expect([...memory.data]).toEqual(old);
    m.dispose();
  });
});
