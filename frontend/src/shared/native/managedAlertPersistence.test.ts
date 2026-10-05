import { describe, it, expect } from 'vitest';
import {
  decodePayload,
  decodeContext,
  decodeIdentity,
  firstIntent,
  confirmPayload,
} from './managedAlertPersistence';
import { DraftStore, type Payload } from '../recovery/storage';
const key = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const id = 'auto_' + 'a'.repeat(32),
  rev = 'b'.repeat(32),
  recordId = 'managed_' + id;
const actor = {
  draftOwner: 'a'.repeat(64),
  draftSession: 'b'.repeat(64),
  role: 'owner' as const,
  storeId: null,
  networkOwner: true,
};
const task = {
  id,
  kind: 'auto',
  title: 'Перевірити запас',
  revision: rev,
  scope: 'operations',
  store: 1,
  cycle: 1,
  active: true,
  workState: 'open',
  until: null,
  reason: '',
};
function payload(action = 'defer'): Payload {
  return {
    baseline: { recordId, key, original: task, action, review: false },
    draft: { until: '2026-10-20', reason: '  Дочекатися поставки  ' },
    firstIntent: null,
    confirmation: null,
  };
}
function pending() {
  const p = payload();
  p.firstIntent = firstIntent(p);
  return p;
}
const receipt = {
  contract: 'managed-alert-identity-v1',
  confirmed: true,
  key,
  task: id,
  action: 'defer',
  observedRevision: rev,
  appliedRevision: 'c'.repeat(32),
  appliedCycle: 1,
};
const event = (p: Payload) => ({ type: 'identity', identity: receipt, draft: p.draft });
describe('managed lifecycle persistence', () => {
  it('stores raw invalid fields separately from the exact frozen request, never adds hidden fields', () => {
    const p = pending(),
      intent = structuredClone(p.firstIntent);
    p.draft = { until: '', reason: '' };
    expect(decodePayload(p).draft).toEqual(p.draft);
    expect(firstIntent(p)).toEqual(intent);
    expect(intent?.body).toMatchObject({ reason: '  Дочекатися поставки  ' });
    for (const malformed of [
      { ...p, permissions: true },
      { ...p, draft: { ...p.draft, active: false } },
      { ...p, baseline: { ...(p.baseline as object), recordId: 'managed_' + 'x'.repeat(32) } },
      { ...p, firstIntent: { ...intent, path: '/api/erp/vouchers' } },
    ])
      expect(() => decodePayload(malformed)).toThrow();
  });
  it('binds all four actions, record identity and current actor without coercion', () => {
    for (const action of ['accept', 'complete', 'resume', 'defer'])
      expect(firstIntent(payload(action)).body).toMatchObject({ action, revision: rev });
    const context = { contract: 'managed-alert-context-v1', ...actor, task, canAct: true };
    const { draftOwner: _owner, draftSession: _session, ...dto } = context;
    void _owner;
    void _session;
    expect(decodeContext(dto, id, actor).task.id).toBe(id);
    expect(() => decodeContext({ ...dto, role: ['owner'] }, id, actor)).toThrow();
    expect(() => decodeContext({ ...dto, storeId: 2 }, id, actor)).toThrow();
    expect(() => decodeContext({ ...dto, task: { ...task, cycle: '1' } }, id, actor)).toThrow();
  });
  it('requires positive creator receipt binding and never treats absence as a no-write proof', () => {
    const p = pending(),
      absent = { ...receipt, confirmed: false };
    delete (absent as Partial<typeof receipt>).appliedRevision;
    delete (absent as Partial<typeof receipt>).appliedCycle;
    expect(decodeIdentity(absent, p).confirmed).toBe(false);
    expect(() => confirmPayload(p, { ...event(p), identity: absent })).toThrow();
    for (const mismatch of [
      { key: other },
      { task: 'auto_' + 'd'.repeat(32) },
      { action: 'complete' },
      { observedRevision: 'e'.repeat(32) },
      { appliedCycle: 0 },
    ])
      expect(() => decodeIdentity({ ...receipt, ...mismatch }, p)).toThrow();
    expect(() =>
      confirmPayload(p, { type: 'apply', current: task, draft: p.draft, key: other }),
    ).toThrow();
  });
  it('persists positive identity before current GET and preserves newer raw through old-cycle receipts', () => {
    const p = pending();
    p.draft = { until: '', reason: 'Нове введення' };
    const confirmed = confirmPayload(p, event(p))!;
    expect(confirmed.firstIntent).toBeNull();
    expect(() => firstIntent(confirmed)).toThrow();
    expect(confirmed.baseline).toMatchObject({
      original: { revision: rev, cycle: 1 },
      review: true,
    });
    const current = { ...task, revision: 'e'.repeat(32), cycle: 2, workState: 'open' };
    expect(confirmPayload(confirmed, { type: 'complete', current })?.draft).toEqual(p.draft);
    const applied = confirmPayload(confirmed, {
      type: 'apply',
      current,
      draft: p.draft,
      key: other,
    })!;
    expect(applied.baseline).toMatchObject({ key: other, original: { cycle: 2 }, review: false });
    expect(applied.confirmation).toBeNull();
    expect(() => firstIntent(applied)).toThrow(); // invalid raw does not become a request
    const unchanged = pending();
    const done = confirmPayload(unchanged, event(unchanged))!;
    expect(confirmPayload(done, { type: 'complete', current })).toBeNull();
  });
  it('retires only a bound first definitive validation/revision rejection into local review', () => {
    const p = pending();
    const rejected = {
      type: 'rejected',
      key,
      task: id,
      action: 'defer',
      revision: rev,
      status: 409,
      code: 'revision_conflict',
      draft: { until: '', reason: 'Нове введення' },
    };
    const next = confirmPayload(p, rejected)!;
    expect(next.firstIntent).toBeNull();
    expect(next.draft).toEqual(rejected.draft);
    expect(next.baseline).toMatchObject({ key, original: { revision: rev }, review: true });
    expect(() => firstIntent(next)).toThrow();
    expect(confirmPayload(p, { ...rejected, status: 400, code: null })?.firstIntent).toBeNull();
    for (const mismatch of [
      { status: 403, code: null },
      { status: 409, code: 'idempotency_conflict' },
      { key: other },
      { task: 'auto_' + 'd'.repeat(32) },
      { revision: 'e'.repeat(32) },
    ])
      expect(() => confirmPayload(p, { ...rejected, ...mismatch })).toThrow();
    expect(() =>
      confirmPayload({ ...p, baseline: { ...(p.baseline as object), review: true } }, rejected),
    ).toThrow();
  });
  it('quota failures keep the durable original and do not partially adopt Apply/confirmation', () => {
    const memory = new Map<string, string>();
    let quota = false;
    const storage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (quota) throw Error('quota');
        memory.set(k, v);
      },
      removeItem: (k: string) => memory.delete(k),
      key: (i: number) => [...memory.keys()][i] ?? null,
      get length() {
        return memory.size;
      },
      clear: () => memory.clear(),
    };
    const store = new DraftStore(storage);
    store.register({
      name: 'managed',
      version: 1,
      label: 'Системна задача',
      decode: decodePayload,
      confirm: confirmPayload,
      authorize: async () => true,
      restore: () => {},
      suspend: () => {},
    });
    store.bind(actor);
    const p = pending();
    store.save(recordId, 'managed', p);
    const original = [...memory.values()][0];
    quota = true;
    expect(() => store.confirmed(recordId, event(p))).toThrow();
    expect([...memory.values()][0]).toBe(original);
    expect(store.beforeSend(recordId)).toEqual(p.firstIntent);
    quota = false;
    store.confirmed(recordId, event(p));
    const confirmed = [...memory.values()][0];
    quota = true;
    expect(() =>
      store.confirmed(recordId, { type: 'apply', current: task, draft: p.draft, key: other }),
    ).toThrow();
    expect([...memory.values()][0]).toBe(confirmed);
    expect(() => store.beforeSend(recordId)).toThrow();
  });
});
