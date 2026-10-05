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
  failSet = false;
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
    if (this.failSet) throw Error('write quota');
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
  it('suspension after issued CREATE permanently removes live-first rejection authority while keeping exact intent', async () => {
    const { store } = setup(),
      m = new TaskMachine(payload());
    await m.prepare();
    const original = globalThis.fetch;
    let release: (r: Response) => void = () => {};
    let issued = 0;
    const held = new Promise<Response>((r) => {
      release = r;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, options?: RequestInit) => {
        if (path !== '/api/v1/crm/contact-tasks' || options?.method !== 'POST')
          return original(path, options);
        issued++;
        if (issued === 1) return held;
        const body = JSON.parse(String(options.body));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: 'Rejected',
              write_rejected: true,
              resource: 'contact_task',
              request_key: body.request_key,
              action: 'create',
            }),
            { status: 400 },
          ),
        );
      }),
    );
    const pending = m.save();
    for (let i = 0; i < 10 && issued === 0; i++) await pause();
    expect(issued).toBe(1);
    const intent = m.snapshot().payload.firstIntent;
    m.suspend();
    release(new Response('{}', { status: 503 }));
    await pending;
    await m.save();
    expect(issued).toBe(2);
    expect(m.snapshot().payload.firstIntent).toEqual(intent);
    expect(store.beforeSend('contact_' + id)).toEqual(intent);
    m.dispose();
  });
  it('Apply persists one combined baseline+merged raw atomically and adopts nothing on storage failure', async () => {
    const { memory, store } = setup(),
      m = new TaskMachine(payload(true));
    await m.prepare();
    const p = m.snapshot().payload;
    const current: api.TaskRead = {
      resource: 'contact_task',
      record: {
        id,
        customer: 1,
        store: 2,
        revision: 2,
        terms: api.capture({ ...base, title: 'Server' }),
        customerName: 'Contact',
        customerActive: true,
        storeName: 'Store',
        assigneeName: null,
        assigneeActive: null,
        createdAt: '2026-10-05T10:00:00Z',
        updatedAt: '2026-10-05T10:00:00Z',
        completedAt: null,
      },
      permissions: { canEdit: true },
    };
    m.view = { ...m.view, current };
    const saved = [...memory.data],
      merged = { ...base, title: 'Merged mine' };
    memory.failSet = true;
    m.apply(merged);
    expect(m.snapshot().payload).toEqual(p);
    expect([...memory.data]).toEqual(saved);
    expect(m.snapshot().error).toContain('зберегти');
    memory.failSet = false;
    const write = vi.spyOn(memory, 'setItem');
    m.apply(merged);
    expect(write).toHaveBeenCalledTimes(1);
    expect(api.state(m.snapshot().payload.baseline).revision).toBe(2);
    expect(api.raw(m.snapshot().payload.draft)).toEqual(merged);
    const record = JSON.parse([...memory.data.values()][0]!);
    expect(record.payload.draft).toEqual(merged);
    expect(store.entries()[0]?.id).toBe('contact_' + id);
    m.dispose();
  });
  it.each([401, 403])(
    'nonJSON issued business HTTP%s suspends private raw without waiting for JSON and preserves current policy',
    async (status) => {
      setup();
      const m = new TaskMachine(payload());
      await m.prepare();
      const original = globalThis.fetch;
      vi.stubGlobal('location', { assign: vi.fn() });
      vi.stubGlobal(
        'fetch',
        vi.fn((path: string, options?: RequestInit) =>
          path === '/api/v1/crm/contact-tasks' && options?.method === 'POST'
            ? Promise.resolve(new Response('<html>Denied</html>', { status }))
            : original(path, options),
        ),
      );
      await m.save();
      expect(m.snapshot().visible).toBe(false);
      if (status === 401) expect(location.assign).toHaveBeenCalledWith('/');
      m.dispose();
    },
  );
  it.each([
    [401, 'html'],
    [403, 'html'],
    [401, 'json'],
    [403, 'json'],
  ] as const)(
    'final session HTTP%s %s suspends raw before any business request',
    async (status, format) => {
      setup();
      const m = new TaskMachine(payload());
      await m.prepare();
      const original = globalThis.fetch;
      let writes = 0;
      vi.stubGlobal('location', { assign: vi.fn() });
      vi.stubGlobal(
        'fetch',
        vi.fn((path: string, options?: RequestInit) => {
          if (options?.method === 'POST') writes++;
          return path === '/api/v1/session'
            ? Promise.resolve(
                new Response(
                  format === 'json' ? JSON.stringify({ error: 'Denied' }) : '<html>Denied</html>',
                  { status },
                ),
              )
            : original(path, options);
        }),
      );
      await m.save();
      expect(writes).toBe(0);
      expect(m.snapshot().visible).toBe(false);
      m.dispose();
    },
  );
  it.each([401, 403])(
    'nonJSON current HTTP%s runs P0 denial before local current adoption',
    async (status) => {
      const { store } = setup();
      const m = new TaskMachine(payload(true));
      await m.prepare();
      const codec = store;
      const original = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn((path: string, options?: RequestInit) =>
          path === '/api/v1/crm/contact-tasks/' + id
            ? Promise.resolve(new Response('<html>Denied</html>', { status }))
            : original(path, options),
        ),
      );
      await m.current();
      expect(m.snapshot().current).toBeNull();
      expect(m.snapshot().visible).toBe(false);
      expect(codec.entries()).toHaveLength(0);
      m.dispose();
    },
  );
  it('identity changed allowed actor after P0 context issues no identity POST, hides raw and retains original intent', async () => {
    const { store } = setup(),
      m = new TaskMachine(payload());
    await m.prepare();
    const intent: Payload['firstIntent'] = {
      method: 'POST',
      path: '/api/v1/crm/contact-tasks',
      key: '22222222-2222-4222-8222-222222222222',
      revision: null,
      possiblySent: true,
      body: {
        id,
        request_key: '22222222-2222-4222-8222-222222222222',
        customer: 1,
        store: 2,
        terms: api.json(api.capture(base)),
      },
    };
    m.view = { ...m.view, payload: { ...m.view.payload, firstIntent: intent } };
    store.save('contact_' + id, 'contact_task', m.view.payload);
    const original = globalThis.fetch;
    let writes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, options?: RequestInit) => {
        if (options?.method === 'POST') writes++;
        return path === '/api/v1/session'
          ? Promise.resolve(
              new Response(
                JSON.stringify({
                  ...session,
                  draftOwner: 'c'.repeat(64),
                  draftSession: 'd'.repeat(64),
                  csrf: 'new-actor-csrf',
                }),
                { status: 200 },
              ),
            )
          : original(path, options);
      }),
    );
    await m.identity();
    expect(writes).toBe(0);
    expect(m.snapshot().visible).toBe(false);
    expect(m.snapshot().payload.firstIntent).toEqual(intent);
    expect(store.beforeSend('contact_' + id)).toEqual(intent);
    m.dispose();
  });
  it('ordinary reopen cannot overwrite existing plain invalid raw or unreadable storage', async () => {
    const { store, memory, controller } = setup();
    const prior = payload(true);
    prior.draft = api.json({ ...base, title: 'Unsent private title', due_on: '2026-02-30' });
    await controller.check(false);
    store.save('contact_' + id, 'contact_task', prior);
    const before = [...memory.data];
    const m = new TaskMachine(payload(true));
    await m.prepare();
    expect(m.snapshot().existing).toBe(true);
    expect(m.snapshot().visible).toBe(false);
    m.raw({ ...base, title: 'Server overwrite' });
    await m.save();
    expect([...memory.data]).toEqual(before);
    m.dispose();
    const key = [...memory.data.keys()][0]!;
    memory.data.set(key, 'malformed');
    const corrupt = new TaskMachine(payload(true));
    await corrupt.prepare();
    expect(corrupt.snapshot().existing).toBe(true);
    expect(memory.data.get(key)).toBe('malformed');
    corrupt.dispose();
  });
  it('Close before initial session completion prevents preparation from saving or replacing any record', async () => {
    const { memory, store } = setup();
    let release: (s: typeof session) => void = () => {};
    const held = new Promise<typeof session>((r) => {
      release = r;
    });
    const controller = new RecoveryController(store, () => held);
    window.NativeDraftRecovery!.controller = controller;
    const m = new TaskMachine(payload(true)),
      pending = m.prepare();
    m.dispose();
    release(session);
    await pending;
    expect(memory.data.size).toBe(0);
    expect(m.snapshot().visible).toBe(false);
  });
});
