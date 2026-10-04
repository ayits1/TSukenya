import { describe, it, expect } from 'vitest';
import {
  decodeEntityPayload,
  decodeEntityContext,
  confirmEntityPayload,
  rawKeys,
  type EntityState,
} from './entityPersistence';
const key = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const body = {
  name: 'Олена',
  store: 1,
  active: true,
  shift_rate: '100',
  bonus_percent: '2.3',
  bonus_basis: 'store',
  idempotency_key: key,
};
const raw = {
  name: '',
  store: 'invalid newer store',
  active: 'yes',
  shift_rate: '1e-',
  bonus_percent: '100.001',
  bonus_basis: 'profit',
};
const original = {
  id: '3',
  revision: 'b'.repeat(32),
  name: 'Олена',
  store_id: 1,
  active: true,
  shift_rate: '100.00',
  bonus_percent: '2.300',
  bonus_basis: 'store',
};
const state: EntityState = {
  recordId: 'entity_' + key,
  resource: 'employees',
  key,
  id: null,
  store: 1,
  kind: null,
  original: null,
  needsReview: false,
  confirmed: false,
  deleted: false,
};
const payload = () => ({
  baseline: state,
  draft: raw,
  firstIntent: {
    method: 'POST',
    path: '/api/erp/entities/employees',
    key,
    body,
    revision: null,
    possiblySent: true,
  },
  confirmation: null,
});
const receipt = {
  type: 'employees',
  id: '3',
  request_key: key,
  original: { type: 'employees', ...original },
};
describe('entity reload persistence', () => {
  it('keeps invalid newer raw independent of frozen first body and exact fields', () => {
    expect(decodeEntityPayload(payload())).toEqual(payload());
    for (const value of [
      { ...payload(), draft: { ...raw, csrf: 'secret' } },
      { ...payload(), firstIntent: { ...payload().firstIntent, path: '/api/erp/vouchers' } },
      { ...payload(), baseline: { ...state, key: 'bad' } },
    ])
      expect(() => decodeEntityPayload(value)).toThrow();
  });
  it('accepts all five resource raw whitelists, including unsent incomplete fields', () => {
    for (const resource of ['stores', 'warehouses', 'accounts', 'parties', 'employees'] as const) {
      const draft = Object.fromEntries(rawKeys(resource).map((k) => [k, '']));
      expect(
        decodeEntityPayload({
          baseline: { ...state, resource, store: null },
          draft,
          firstIntent: null,
          confirmation: null,
        }).draft,
      ).toEqual(draft);
    }
  });
  it('separates confirmed receipt/current read, preserves invalid newer text and tombstone', () => {
    const next = confirmEntityPayload(payload(), { type: 'create', raw: receipt, draft: raw })!;
    expect(next.firstIntent).toBeNull();
    expect(next.draft).toEqual(raw);
    expect(next.baseline).toMatchObject({ id: '3', needsReview: true, original });
    const deleted = confirmEntityPayload(payload(), {
      type: 'identity',
      raw: { ...receipt, confirmed: true, exists: false },
      draft: raw,
    });
    expect(deleted?.baseline).toMatchObject({ deleted: true });
    expect(() =>
      confirmEntityPayload(payload(), {
        type: 'create',
        raw: { ...receipt, request_key: 'bad' },
        draft: raw,
      }),
    ).toThrow();
  });
  it('UPDATE unknown adopts only explicit fresh Apply and cleanup keeps newer edits', () => {
    const value = {
      baseline: { ...state, id: '3', original, needsReview: true },
      draft: { ...raw, store: '1' },
      firstIntent: {
        method: 'POST',
        path: '/api/erp/entities/employees',
        key,
        body: {
          name: 'Олена',
          active: true,
          shift_rate: '100',
          bonus_percent: '2.3',
          bonus_basis: 'store',
          store: 1,
          id: '3',
          revision: original.revision,
        },
        revision: original.revision,
        possiblySent: true,
      },
      confirmation: null,
    };
    const next = confirmEntityPayload(value, {
      type: 'update',
      raw: { id: 3 },
      draft: value.draft,
    })!;
    expect(next.firstIntent).toBeNull();
    expect(next.baseline).toMatchObject({ needsReview: true, original });
    const fresh = { type: 'employees', ...original, name: 'На сервері', revision: 'c'.repeat(32) };
    const applied = confirmEntityPayload(next, { type: 'apply', raw: fresh, draft: value.draft })!;
    expect(applied.baseline).toMatchObject({
      original: { revision: 'c'.repeat(32) },
      needsReview: false,
    });
    expect(() =>
      confirmEntityPayload(applied, { type: 'complete', raw: fresh, draft: raw }),
    ).toThrow();
    const valid = { ...raw, name: 'Новіше', store: '1', shift_rate: '100', bonus_percent: '2.3' };
    expect(
      confirmEntityPayload(applied, { type: 'complete', raw: fresh, draft: valid }),
    ).not.toBeNull();
  });
  it('current authorization matches original scope, not invalid newer store or raw rate', () => {
    const session = {
      draftOwner: 'a'.repeat(64),
      draftSession: 'b'.repeat(64),
      role: 'owner' as const,
      storeId: 1,
      networkOwner: false,
    };
    const context = {
      type: 'employees',
      id: null,
      store: 1,
      role: 'owner',
      storeId: 1,
      networkOwner: false,
      canCreate: true,
      exists: null,
    };
    expect(decodeEntityContext(context, state, session).canCreate).toBe(true);
    expect(() => decodeEntityContext({ ...context, storeId: 2 }, state, session)).toThrow();
  });
  it('binds no-write proof to exact resource and UUID, never arbitrary ACK', () => {
    expect(
      confirmEntityPayload(payload(), {
        type: 'rejected',
        raw: { write_rejected: true, request_key: key, type: 'employees' },
        draft: raw,
      })?.firstIntent,
    ).toBeNull();
    expect(() =>
      confirmEntityPayload(payload(), {
        type: 'rejected',
        raw: { write_rejected: true, request_key: 'bad', type: 'employees' },
        draft: raw,
      }),
    ).toThrow();
  });
});
