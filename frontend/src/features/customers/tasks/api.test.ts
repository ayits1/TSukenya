import { describe, expect, it, vi } from 'vitest';
import { DraftStore, type Payload } from '../../../shared/recovery/storage';
import * as api from './api';
const id = '11111111-1111-4111-8111-111111111111',
  key = '22222222-2222-4222-8222-222222222222';
const base: api.Raw = {
  title: 'Call back',
  note: 'Initial',
  due_on: '',
  assignee: '',
  status: 'todo',
  archived: false,
};
const initial: Payload = {
  baseline: api.json({
    recordId: 'contact_' + id,
    id,
    customer: 1,
    store: 2,
    revision: null,
    base,
    needsReview: false,
    confirmed: false,
  }),
  draft: api.json(base),
  firstIntent: null,
  confirmation: null,
};
const frozen: Payload = {
  ...initial,
  firstIntent: {
    method: 'POST',
    path: '/api/v1/crm/contact-tasks',
    key,
    body: { id, request_key: key, customer: 1, store: 2, terms: api.json(api.capture(base)) },
    revision: null,
    possiblySent: true,
  },
};
const ack = {
  resource: 'contact_task',
  request_key: key,
  action: 'create',
  original: { id, customer: 1, store: 2, revision: 1, terms: api.capture(base) },
};
const current = {
  resource: 'contact_task',
  record: {
    ...ack.original,
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
const event = (type: string, raw: unknown, draft: unknown = frozen.draft) => ({ type, raw, draft });
class Memory implements Storage {
  data = new Map<string, string>();
  denied = false;
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
    this.data.delete(k);
  }
  setItem(k: string, v: string) {
    if (this.denied) throw Error('quota');
    this.data.set(k, v);
  }
}
const session = {
  draftOwner: 'a'.repeat(64),
  draftSession: 'b'.repeat(64),
  role: 'owner' as const,
  storeId: null,
  networkOwner: true,
};
function storage(memory = new Memory()) {
  const store = new DraftStore(memory);
  store.register({
    name: 'contact_task',
    version: 1,
    label: 'Задача',
    decode: api.payload,
    confirm: api.confirm,
    authorize: async () => true,
    restore: () => {},
    suspend: () => {},
  });
  store.bind(session);
  return { store, memory };
}
describe('contact task bounded durable contract', () => {
  it('raw invalid date, assignee and newer empty title survive reconstruction independently of Save validation', () => {
    const invalid = {
      ...base,
      title: '',
      due_on: '2026-02-30',
      assignee: 'typed search is not an ID',
    };
    const p = api.payload({ ...frozen, draft: invalid });
    expect(api.raw(p.draft)).toEqual(invalid);
    expect(() => api.capture(invalid)).toThrow();
    expect(p.firstIntent).toEqual(frozen.firstIntent);
    expect(() => api.payload({ ...p, baseline: { ...api.state(p.baseline), store: 3 } })).toThrow();
  });
  it('strict ACK binds creator operation intent terms/context/key without deriving revision baseline', () => {
    for (const wrong of [
      {},
      { ...ack, request_key: id },
      { ...ack, original: { ...ack.original, store: 3 } },
      { ...ack, original: { ...ack.original, terms: { ...ack.original.terms, note: 'other' } } },
    ])
      expect(() => api.ack(wrong, frozen)).toThrow();
    const confirmed = api.confirm(frozen, event('ack', ack, { ...base, title: '' }))!;
    expect(api.state(confirmed.baseline)).toMatchObject({
      confirmed: true,
      revision: null,
      needsReview: true,
    });
    expect(confirmed.firstIntent).toBeNull();
    expect(api.raw(confirmed.draft).title).toBe('');
  });
  it('positive identity is durable before independent current503, false is not absence, Apply is local', () => {
    const { store, memory } = storage();
    const record = 'contact_' + id;
    store.save(record, 'contact_task', frozen);
    store.confirmed(record, event('identity', { confirmed: true, ...ack }));
    const reload = storage(memory).store;
    const saved = reload.entries()[0]!;
    expect(saved.state).toBe('confirmed');
    expect(() => reload.beforeSend(record)).toThrow();
    const p = api.confirm(frozen, event('identity', { confirmed: true, ...ack }))!;
    expect(api.state(p.baseline).needsReview).toBe(true);
    const applied = api.confirm(p, event('apply', current))!;
    expect(api.state(applied.baseline).revision).toBe(1);
    expect(api.state(applied.baseline).needsReview).toBe(false);
    expect(
      api.confirm(
        frozen,
        event('identity', {
          resource: 'contact_task',
          request_key: key,
          action: 'create',
          confirmed: false,
        }),
      )?.firstIntent,
    ).toEqual(frozen.firstIntent);
  });
  it('quota fails before-send without changing original record and lostACK exact key/body cannot be replaced', () => {
    const { store, memory } = storage();
    store.save('contact_' + id, 'contact_task', initial);
    memory.denied = true;
    expect(() => store.save('contact_' + id, 'contact_task', frozen)).toThrow();
    expect(() => store.beforeSend('contact_' + id)).toThrow();
    memory.denied = false;
    store.save('contact_' + id, 'contact_task', frozen);
    store.save('contact_' + id, 'contact_task', { ...frozen, draft: { ...base, title: '' } });
    expect(store.beforeSend('contact_' + id)).toEqual(frozen.firstIntent);
    expect(() =>
      store.save('contact_' + id, 'contact_task', { ...frozen, firstIntent: null }),
    ).toThrow();
  });
  it('page counts and strict DTO refuse truncated universe/private extras/wrong dates', () => {
    const page = {
      items: [current.record],
      total: 1,
      page: 1,
      pages: 1,
      summary: { todo: 1, doing: 0, done: 0, cancelled: 0, overdue: 0 },
      scope: { store: 2, today: '2026-10-05' },
      canEdit: true,
    };
    expect(api.page(page).total).toBe(1);
    for (const wrong of [
      { ...page, total: 65 },
      { ...page, privatePayroll: 'forbidden' },
      { ...page, summary: { ...page.summary, todo: 2 } },
      { ...page, scope: { store: 2, today: '2026-02-30' } },
      { ...page, items: [{ ...current.record, createdAt: null }] },
    ])
      expect(() => api.page(wrong)).toThrow();
  });
  it('history and assignee pages bind concrete resource/store and exact count before adoption', () => {
    const h = { resource: 'contact_task_history', id, items: [], total: 0, page: 1, pages: 1 };
    expect(api.history(h, id).id).toBe(id);
    expect(() => api.history({ ...h, id: key }, id)).toThrow();
    expect(() => api.history({ ...h, total: 31 }, id)).toThrow();
    const a = { store: 2, items: [{ id: 1, name: 'Allowed' }], total: 1, page: 1, pages: 1 };
    expect(api.assignees(a, 2).items.length).toBe(1);
    expect(() => api.assignees(a, 3)).toThrow();
    expect(() => api.assignees({ ...a, total: 32 }, 2)).toThrow();
  });
  it('only bound live create rollback proof can release first intent, malformed/foreign proof cannot', () => {
    const proof = {
      write_rejected: true,
      resource: 'contact_task',
      request_key: key,
      action: 'create',
      id,
      code: 'validation_error',
      error: 'Validation',
    };
    expect(api.confirm(frozen, event('rejected', proof))?.firstIntent).toBeNull();
    expect(() => api.confirm(frozen, event('rejected', { ...proof, request_key: id }))).toThrow();
  });
  it('unresolved UPDATE cannot adopt a current baseline or complete without positive operation identity', () => {
    const unresolved: Payload = {
      ...frozen,
      baseline: api.json({ ...api.state(initial.baseline), confirmed: true, revision: 1 }),
      firstIntent: {
        ...frozen.firstIntent!,
        method: 'PATCH',
        path: '/api/v1/crm/contact-tasks/' + id,
        revision: 1,
        body: { request_key: key, revision: 1, terms: api.json(api.capture(base)) },
      },
    };
    const before = JSON.stringify(unresolved);
    for (const type of ['apply', 'complete'])
      expect(() => api.confirm(unresolved, event(type, current))).toThrow();
    expect(JSON.stringify(unresolved)).toBe(before);
  });
  it.each([401, 403])(
    'nonJSON current HTTP%s is an authorization error before strict JSON decoding; canceled response stays canceled',
    async (status) => {
      vi.stubGlobal('fetch', async () => new Response('<html>private error</html>', { status }));
      await expect(api.request('/current')).rejects.toMatchObject({ status });
      const canceled = new AbortController();
      canceled.abort();
      await expect(api.request('/current', {}, canceled.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      vi.unstubAllGlobals();
    },
  );
  it('bound first revision rejection clears only the matching attempt and requires explicit current comparison', () => {
    const update: Payload = {
      ...frozen,
      baseline: api.json({ ...api.state(initial.baseline), confirmed: true, revision: 1 }),
      firstIntent: {
        ...frozen.firstIntent!,
        method: 'PATCH',
        path: '/api/v1/crm/contact-tasks/' + id,
        revision: 1,
        body: { request_key: key, revision: 1, terms: api.json(api.capture(base)) },
      },
    };
    const proof = {
      error: 'Stale',
      resource: 'contact_task',
      write_rejected: true,
      id,
      request_key: key,
      action: 'update',
      code: 'revision_conflict',
    };
    const next = api.confirm(update, event('rejected', proof))!;
    expect(next.firstIntent).toBeNull();
    expect(api.state(next.baseline).needsReview).toBe(true);
    expect(api.state(next.baseline).revision).toBe(1);
    for (const wrong of [
      { ...proof, id: key },
      { ...proof, action: 'create' },
      { ...proof, code: 'idempotency_conflict' },
    ])
      expect(() => api.confirm(update, event('rejected', wrong))).toThrow();
  });
  it('strict enum fields reject arrays rather than coercing them to allowed strings', () => {
    const update: Payload = {
      ...frozen,
      baseline: api.json({ ...api.state(initial.baseline), confirmed: true, revision: 1 }),
      firstIntent: {
        ...frozen.firstIntent!,
        method: 'PATCH',
        path: '/api/v1/crm/contact-tasks/' + id,
        revision: 1,
        body: { request_key: key, revision: 1, terms: api.json(api.capture(base)) },
      },
    };
    expect(() =>
      api.payload({ ...update, firstIntent: { ...update.firstIntent, method: ['PATCH'] } }),
    ).toThrow();
    expect(() =>
      api.payload({ ...update, firstIntent: null, confirmation: { id, action: ['apply'] } }),
    ).toThrow();
    const h = {
      resource: 'contact_task_history',
      id,
      total: 1,
      page: 1,
      pages: 1,
      items: [
        {
          request_key: key,
          actor: 'Owner',
          action: ['create'],
          at: '2026-10-05T10:00:00Z',
          revision: 1,
          terms: api.capture(base),
        },
      ],
    };
    expect(() => api.history(h, id)).toThrow();
  });
});
