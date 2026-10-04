import { describe, it, expect } from 'vitest';
import {
  decodeWorkShiftPayload,
  confirmWorkShiftPayload,
  decodeWorkShiftContext,
  decodeWorkShiftReceipt,
} from './workShiftPersistence';
const key = '11111111-1111-1111-1111-111111111111';
const raw = {
  employee: '1',
  date: '2026-10-05',
  cash_shift: '',
  units: '1',
  shift_rate: '100',
  bonus_percent: '0',
  bonus_basis: 'store',
  note: 'моя',
};
const state = {
  recordId: 'workshift_' + key,
  key,
  id: null,
  store: 1,
  employee: 1,
  date: raw.date,
  original: null,
  createBase: null,
  needsReview: false,
  confirmed: false,
};
const body = { ...raw, idempotency_key: key };
const payload = {
  baseline: state,
  draft: raw,
  firstIntent: {
    method: 'POST',
    path: '/api/erp/work-shifts',
    key,
    body,
    revision: null,
    possiblySent: true,
  },
  confirmation: null,
};
const row = {
  id: 5,
  employee_id: 1,
  store_id: 1,
  date: raw.date,
  cash_shift_id: null,
  units: '1.00',
  shift_rate: '100.00',
  bonus_percent: '0.000',
  bonus_basis: 'store',
  note: 'моя',
  revision: 'a'.repeat(32),
  payroll_id: null,
  accrued: '0.00',
  basis_amount: '0.00',
};
const page = { items: [row], total: 1, page: 1, pages: 1 };
describe('work shift reload contract', () => {
  it('keeps invalid newer raw apart from exact frozen request and rejects extra secrets', () => {
    const p = decodeWorkShiftPayload({
      ...payload,
      draft: { ...raw, units: '1e-', shift_rate: '-', bonus_percent: '100.0001' },
    });
    expect(p.draft).toMatchObject({ units: '1e-', shift_rate: '-' });
    expect(p.firstIntent?.body).toEqual(body);
    expect(() =>
      decodeWorkShiftPayload({ ...payload, draft: { ...raw, password: 'secret' } }),
    ).toThrow();
    expect(() =>
      decodeWorkShiftPayload({
        ...payload,
        firstIntent: { ...payload.firstIntent, body: { ...body, shift_rate: '-' } },
      }),
    ).toThrow();
  });
  it('binds ACK to first key and exact terms; identity never supplies a revision', () => {
    const ack = { id: 5, type: 'work_shift', request_key: key, request: body };
    expect(decodeWorkShiftReceipt(ack, key, body)).toBe(5);
    for (const change of [
      { request_key: '22222222-2222-2222-2222-222222222222' },
      { request: { ...body, shift_rate: '150' } },
      { revision: 'b'.repeat(32) },
    ])
      expect(() => decodeWorkShiftReceipt({ ...ack, ...change }, key, body)).toThrow();
    const p = confirmWorkShiftPayload(payload, {
      type: 'identity',
      raw: { confirmed: true, ...ack },
      draft: { ...raw, shift_rate: '-' },
    })!;
    expect(p.firstIntent).toBeNull();
    expect(p.baseline).toMatchObject({ id: 5, original: null, createBase: raw, needsReview: true });
    const applied = confirmWorkShiftPayload(p, { type: 'apply', raw: page, draft: raw })!;
    expect(applied.baseline).toMatchObject({ original: row, needsReview: false });
  });
  it('does not clear a newer draft on ACK/current read; exact decimal success can clean', () => {
    const p = confirmWorkShiftPayload(payload, {
      type: 'create',
      raw: { id: 5, type: 'work_shift', request_key: key, request: body },
      draft: raw,
    })!;
    expect(confirmWorkShiftPayload(p, { type: 'complete', raw: page, draft: raw })).toBeNull();
    expect(
      confirmWorkShiftPayload(p, {
        type: 'complete',
        raw: page,
        draft: { ...raw, shift_rate: '100.001' },
      }),
    ).not.toBeNull();
    expect(() =>
      confirmWorkShiftPayload(p, {
        type: 'apply',
        raw: { ...page, items: [{ ...row, employee_id: 2 }] },
        draft: raw,
      }),
    ).toThrow();
  });
  it('can view/correct payroll locked context; fresh identity mismatch fails closed', () => {
    const session = {
      draftOwner: 'a'.repeat(64),
      draftSession: 'b'.repeat(64),
      role: 'owner' as const,
      storeId: 1,
      networkOwner: false,
    };
    const ctx = {
      type: 'work_shift',
      id: null,
      store: 1,
      employee: 1,
      role: 'owner',
      storeId: 1,
      networkOwner: false,
      exists: null,
      canEdit: false,
    };
    expect(decodeWorkShiftContext(ctx, state, session).canEdit).toBe(false);
    expect(() => decodeWorkShiftContext({ ...ctx, role: 'accountant' }, state, session)).toThrow();
    expect(() => decodeWorkShiftContext({ ...ctx, store: 2 }, state, session)).toThrow();
  });
});
