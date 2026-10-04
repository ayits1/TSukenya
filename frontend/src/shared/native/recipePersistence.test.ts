import { describe, it, expect } from 'vitest';
import {
  decodePayload,
  decodeRawRecipe,
  confirmPayload,
  decodeIdentity,
  decodeContext,
  original,
} from './recipePersistence';
import type { Json, Payload } from '../recovery/storage';
import { DraftStore } from '../recovery/storage';
const key = '11111111-1111-4111-8111-111111111111',
  rowKey = '22222222-2222-4222-8222-222222222222',
  rev = 'a'.repeat(64);
const actor = {
  draftOwner: 'a'.repeat(64),
  draftSession: 'b'.repeat(64),
  role: 'owner' as const,
  storeId: null,
  networkOwner: true,
};
const legacy = {
  product: { id: 'cake', name: 'Кекс', unit: 'шт' },
  revision: rev,
  canEdit: true,
  recipe: [{ product: 'flour', quantity: '2.000' }],
};
const current = {
  product: legacy.product,
  catalogRevision: rev,
  latestVersion: null,
  canApprove: true,
  items: [],
  legacyRecipe: legacy.recipe,
  page: 1,
  pages: 1,
  total: 0,
  limit: 20 as const,
};
function payload(mode: 'legacy' | 'version' = 'version'): Payload {
  return {
    baseline: {
      recordId: 'recipe_' + key,
      key,
      mode,
      original: original(mode === 'legacy' ? legacy : current) as unknown as Json,
      needsReview: false,
    },
    draft: {
      product: 'cake',
      components: [{ rowKey, product: 'flour', quantity: '2' }],
      outputQuantity: mode === 'legacy' ? '' : '1',
      expiryPolicy: mode === 'legacy' ? '' : 'unspecified',
      shelfLifeDays: '',
      reason: mode === 'legacy' ? '' : 'Початковий норматив',
    },
    firstIntent: null,
    confirmation: null,
  };
}
const body = {
  idempotencyKey: key,
  product: 'cake',
  expectedVersion: null,
  catalogRevision: rev,
  outputQuantity: '1.000',
  components: [{ product: 'flour', quantity: '2.000' }],
  expiryPolicy: 'unspecified',
  shelfLifeDays: null,
  reason: 'Початковий норматив',
};
const version = {
  id: key,
  product: 'cake',
  version: 1,
  name: 'Кекс',
  unit: 'шт',
  outputQuantity: '1.000',
  components: [{ product: 'flour', quantity: '2.000', name: 'Борошно', unit: 'кг' }],
  expiryPolicy: 'unspecified',
  shelfLifeDays: null,
  reason: 'Початковий норматив',
  approvedBy: 'tester',
  approvedAt: '2026-10-05T10:00:00Z',
};
const pending = (mode: 'legacy' | 'version' = 'version') => {
  const p = payload(mode);
  p.firstIntent = {
    method: 'POST',
    path: mode === 'legacy' ? '/api/erp/recipes' : '/api/erp/recipes/versions',
    key,
    body: mode === 'legacy' ? { product: 'cake', recipe: legacy.recipe, revision: rev } : body,
    revision: rev,
    possiblySent: true,
  };
  return p;
};
const event = (p: Payload, type: string, raw: unknown) => ({ type, raw, draft: p.draft });
describe('recipe durable raw contract', () => {
  it('retains invalid raw strings and stable row keys independently of the frozen valid request', () => {
    const p = pending();
    const r = decodeRawRecipe(p.draft);
    r.components[0]!.quantity = '-';
    r.outputQuantity = '';
    r.shelfLifeDays = '1.';
    r.reason = '';
    p.draft = r as unknown as Json;
    const decoded = decodePayload(p);
    expect(decoded.firstIntent?.body).toEqual(body);
    expect(decoded.draft).toEqual(r);
    expect(() =>
      decodeRawRecipe({ ...r, components: [...r.components, ...r.components] }),
    ).toThrow();
    expect(() => decodePayload({ ...p, draft: { ...r, csrf: 'private' } })).toThrow();
    expect(() =>
      decodePayload({ ...p, firstIntent: { ...p.firstIntent, path: '/api/erp/vouchers' } }),
    ).toThrow();
  });
  it('allows empty original version terms but rejects permission caches and wrong request revision', () => {
    const p = payload();
    p.baseline = {
      ...(p.baseline as object),
      original: original({ ...current, legacyRecipe: [] }) as unknown as Json,
    };
    expect(decodePayload(p)).toBeTruthy();
    expect(() =>
      decodePayload({
        ...p,
        baseline: { ...(p.baseline as object), permissions: { canWrite: true } },
      }),
    ).toThrow();
    const n = pending();
    expect(() =>
      decodePayload({
        ...n,
        firstIntent: { ...n.firstIntent, body: { ...body, catalogRevision: 'b'.repeat(64) } },
      }),
    ).toThrow();
  });
  it('requires creator-bound identity shape and preserves absent identity plus original request', () => {
    const p = pending();
    const absent = { confirmed: false, key, product: 'cake' };
    expect(confirmPayload(p, event(p, 'identity', absent))?.firstIntent).toEqual(p.firstIntent);
    expect(() =>
      decodeIdentity(
        { confirmed: true, key, product: 'cake', original: { ...version, reason: 'Other' } },
        body,
      ),
    ).toThrow();
    expect(() => decodeIdentity({ ...absent, key: rowKey }, body)).toThrow();
    const confirmed = confirmPayload(
      p,
      event(p, 'identity', { confirmed: true, key, product: 'cake', original: version }),
    )!;
    expect(confirmed.firstIntent).toBeNull();
    expect(confirmed.confirmation).toMatchObject({ id: key, body });
    expect(() => confirmPayload(p, event(p, 'apply', { current, key: rowKey }))).toThrow();
  });
  it('unknown legacy UPDATE only accepts explicit current GET Apply, and complete cleanup needs matching current fields', () => {
    const p = pending('legacy'),
      latest = {
        ...legacy,
        revision: 'b'.repeat(64),
        recipe: [{ product: 'flour', quantity: '3.000' }],
      };
    const applied = confirmPayload(p, event(p, 'apply', { current: latest, key: rowKey }))!;
    expect(applied.firstIntent).toBeNull();
    expect(applied.baseline).toMatchObject({
      key: rowKey,
      needsReview: false,
      original: { revision: 'b'.repeat(64) },
    });
    const ack = confirmPayload(
      p,
      event(p, 'ack', { ok: true, product: 'cake', revision: 'c'.repeat(64) }),
    )!;
    expect(confirmPayload(ack, event(ack, 'complete', latest))).not.toBeNull();
    expect(confirmPayload(ack, event(ack, 'complete', legacy))).toBeNull();
  });
  it('keeps confirmed ID as a read barrier while newer invalid fields survive and next approval uses a fresh key', () => {
    const p = pending(),
      r = decodeRawRecipe(p.draft);
    r.reason = '';
    r.components[0]!.quantity = '-';
    p.draft = r as unknown as Json;
    const ack = confirmPayload(p, event(p, 'ack', version))!;
    expect(ack.confirmation).toMatchObject({ id: key });
    expect(ack.draft).toEqual(r);
    expect(() =>
      confirmPayload(
        ack,
        event(ack, 'complete', { confirmed: true, key, product: 'cake', original: version }),
      ),
    ).toThrow();
    r.reason = 'Наступне затвердження';
    r.components[0]!.quantity = '3';
    ack.draft = r as unknown as Json;
    const next = confirmPayload(
      ack,
      event(ack, 'apply', {
        current: { ...current, items: [version], latestVersion: key, total: 1 },
        key: rowKey,
      }),
    )!;
    expect(next.baseline).toMatchObject({ key: rowKey, original: { latestVersion: key } });
    expect(next.confirmation).toBeNull();
  });
  it('accepts only a version/key/product bound rollback proof', () => {
    const p = pending(),
      proof = { write_rejected: true, request_key: key, product: 'cake', mode: 'version' };
    const next = confirmPayload(p, event(p, 'rejected', proof))!;
    expect(next.firstIntent).toBeNull();
    expect(next.baseline).toMatchObject({ needsReview: true });
    expect(() =>
      confirmPayload(p, event(p, 'rejected', { ...proof, request_key: rowKey })),
    ).toThrow();
    const old = pending('legacy');
    expect(() => confirmPayload(old, event(old, 'rejected', proof))).toThrow();
  });
  it('binds fresh context and fails storage before-send quota without replacing a durable intent', () => {
    const p = pending();
    expect(() =>
      decodeContext(
        {
          mode: 'version',
          product: 'cake',
          role: 'manager',
          storeId: null,
          networkOwner: false,
          canWrite: true,
          exists: true,
        },
        'version',
        'cake',
        actor,
      ),
    ).toThrow();
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
      name: 'recipe',
      version: 1,
      label: 'Рецептура',
      decode: decodePayload,
      authorize: async () => true,
      restore: () => {},
      suspend: () => {},
      confirm: confirmPayload,
    });
    store.bind(actor);
    store.save('recipe_' + key, 'recipe', p);
    quota = true;
    expect(() =>
      store.save('recipe_' + key, 'recipe', {
        ...p,
        draft: { ...(p.draft as object), reason: 'newer' },
      }),
    ).toThrow();
    expect(store.beforeSend('recipe_' + key).body).toEqual(body);
    expect(() => store.save('recipe_' + key, 'recipe', { ...p, firstIntent: null })).toThrow();
  });
});
