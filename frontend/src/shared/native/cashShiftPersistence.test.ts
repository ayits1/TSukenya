import { describe, it, expect } from 'vitest';
import {
  decodePayload,
  decodeReceipt,
  decodeCurrent,
  confirmPayload,
  decodeContext,
} from './cashShiftPersistence';
const key = '11111111-1111-1111-1111-111111111111';
const raw = { account: '1', employee: '', counted: '', note: '' };
const state = {
  recordId: 'cashshift_' + key,
  key,
  action: 'open',
  id: null,
  account: 1,
  store: 1,
  original: null,
  needsReview: false,
};
const body = { action: 'open', account: '1', employee: '', idempotency_key: key };
const intent = {
  method: 'POST',
  path: '/api/erp/shifts',
  key,
  body,
  revision: null,
  possiblySent: true,
};
const payload = { baseline: state, draft: raw, firstIntent: intent, confirmation: null };
const ack = {
  id: 3,
  type: 'cash_shift',
  action: 'open',
  request_key: key,
  original: { action: 'open', account: 1, employee: null },
};
const row = {
  id: 3,
  store: 1,
  account: 1,
  employee: null,
  openedBy: 1,
  openedAt: '2026-10-05T10:00:00+00:00',
  closedAt: null,
  openingCash: '1000.00',
  expectedCash: null,
  countedCash: null,
  note: '',
  revision: 'a'.repeat(32),
  editing: { role: 'owner', storeId: null, networkOwner: true, canWrite: true },
};
describe('cash open/close persistence', () => {
  it('keeps invalid raw independent and binds the entire normalized action ACK', () => {
    expect(
      decodePayload({ ...payload, draft: { ...raw, counted: '1e-', account: '-' } }).draft,
    ).toMatchObject({ counted: '1e-' });
    expect(decodeReceipt(ack, key, body).id).toBe(3);
    for (const change of [
      { request_key: '22222222-2222-2222-2222-222222222222' },
      { original: { action: 'open', account: 2, employee: null } },
      { revision: 'a'.repeat(32) },
    ])
      expect(() => decodeReceipt({ ...ack, ...change }, key, body)).toThrow();
    expect(() => decodePayload({ ...payload, draft: { ...raw, password: 'hidden' } })).toThrow();
  });
  it('confirms identity durably before current read, retaining original and newer raw without current revision', () => {
    const newer = { ...raw, account: '-', note: 'новіше' };
    const p = confirmPayload(payload, {
      type: 'identity',
      raw: { confirmed: true, ...ack },
      draft: newer,
    });
    expect(p.firstIntent).toBeNull();
    expect(p.baseline).toMatchObject({ id: 3, original: null, needsReview: true });
    expect(p.confirmation).toEqual(ack);
    expect(p.draft).toEqual(newer);
    expect(
      confirmPayload(payload, {
        type: 'identity',
        raw: { confirmed: false, type: 'cash_shift', action: 'open', request_key: key },
        draft: newer,
      }).firstIntent,
    ).toEqual(intent);
  });
  it('validates normalized count precision, immutable close resources, policy and current state semantics', () => {
    const close = {
      action: 'close',
      id: '3',
      counted: '1,2',
      note: 'note',
      revision: row.revision,
      idempotency_key: key,
    };
    const closing = {
      ...ack,
      action: 'close',
      original: { action: 'close', id: 3, counted: '1.20', note: 'note', revision: row.revision },
    };
    expect(decodeReceipt(closing, key, close).original).toEqual(closing.original);
    for (const amount of ['-1', '1.001', '999999999999.01'])
      expect(() => decodeReceipt(closing, key, { ...close, counted: amount })).toThrow();
    expect(decodeCurrent(row, 3)).toEqual(row);
    for (const changed of [
      { closedAt: '2026-10-05T11:00:00+00:00' },
      { expectedCash: '0.00' },
      { editing: { ...row.editing, canWrite: false } },
    ])
      expect(() => decodeCurrent({ ...row, ...changed }, 3)).toThrow();
    expect(() =>
      decodeContext(
        {
          type: 'cash_shift',
          action: 'open',
          id: null,
          account: 1,
          store: 1,
          role: 'manager',
          storeId: 1,
          networkOwner: false,
          canWrite: true,
        },
        state as never,
        { role: 'owner', storeId: null, networkOwner: true } as never,
      ),
    ).toThrow();
  });
  it('only bound live-rejection frees first intent; local apply never retires an unresolved sent request', () => {
    expect(() =>
      confirmPayload(payload, {
        type: 'rejected',
        raw: {
          write_rejected: true,
          type: 'cash_shift',
          action: 'close',
          request_key: key,
          resource: 1,
        },
        draft: raw,
      }),
    ).toThrow();
    expect(
      confirmPayload(payload, {
        type: 'rejected',
        raw: {
          write_rejected: true,
          type: 'cash_shift',
          action: 'open',
          request_key: key,
          resource: 1,
        },
        draft: raw,
      }).firstIntent,
    ).toBeNull();
    const baseline = { ...state, action: 'close', id: 3, original: row };
    const close = {
      action: 'close',
      id: '3',
      counted: '1000',
      note: '',
      revision: row.revision,
      idempotency_key: key,
    };
    expect(() =>
      confirmPayload(
        {
          baseline,
          draft: raw,
          firstIntent: { ...intent, body: close, revision: row.revision },
          confirmation: null,
        },
        { type: 'apply', raw: row, draft: raw },
      ),
    ).toThrow();
    expect(
      confirmPayload(
        { baseline, draft: raw, firstIntent: null, confirmation: null },
        { type: 'apply', raw: row, draft: raw },
      ).baseline,
    ).toMatchObject({ original: row, needsReview: false });
  });
});
