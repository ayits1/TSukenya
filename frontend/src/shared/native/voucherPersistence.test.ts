import { describe, it, expect } from 'vitest';
import {
  decodeVoucherPayload,
  decodeContext,
  confirmVoucherPayload,
  fieldNames,
  type VoucherState,
} from './voucherPersistence';
const key = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const body = {
  kind: 'opening',
  date: '2026-10-04',
  store: 1,
  note: 'Первісний намір',
  warehouse: 2,
  party: null,
  employee: null,
  account: null,
  shift: null,
  reference: null,
  target: null,
  lines: [
    {
      product: 'p1',
      quantity: '2',
      price: '10.50',
      lot: 'A',
      expiry: '',
      line_key: key,
      reference_line: null,
    },
  ],
  payload: { additional_cost: '0', payments: [], recipe: [], shift_ids: [] },
  idempotency_key: key,
};
const state: VoucherState = {
  identity: { recordId: 'voucher_qa', kind: 'opening', store: 1, id: null, revision: null, key },
  projection: null,
  confirmedId: null,
  postUnknown: false,
  needsReview: false,
  confirmedRead: false,
};
const fields = Object.fromEntries(
  fieldNames.map((k) => [
    k,
    k === 'store' ? '1' : k === 'date' ? 'invalid' : k === 'amount' ? '-' : '',
  ]),
);
const raw = {
  fields,
  lines: [
    {
      line_key: key,
      reference_line: '',
      product: 'p1',
      quantity: '',
      price: '-',
      lot: 'A',
      expiry: '',
    },
  ],
  payments: [],
  payrollIds: [],
  production: null,
  allocations: [],
  reference: null,
  available: null,
};
const payload = () => ({
  baseline: state,
  draft: raw,
  firstIntent: {
    method: 'POST',
    path: '/api/erp/vouchers',
    key,
    body,
    revision: null,
    possiblySent: true,
  },
  confirmation: null,
});
describe('native voucher persistence whitelist', () => {
  it('retains raw invalid newer fields separately from exact first CREATE terms', () => {
    expect(decodeVoucherPayload(payload())).toEqual(payload());
  });
  it('refuses unknown derived/private keys and changed identity/line keys', () => {
    for (const mutate of [
      (v: ReturnType<typeof payload>) => {
        v.firstIntent.body.payload = Object.assign(v.firstIntent.body.payload, { cost: 'secret' });
      },
      (v: ReturnType<typeof payload>) => {
        v.firstIntent.path = '/api/erp/users';
      },
      (v: ReturnType<typeof payload>) => {
        v.draft.lines[0]!.line_key = 'invalid';
      },
      (v: ReturnType<typeof payload>) => {
        v.firstIntent.body.idempotency_key = 'different';
      },
    ]) {
      const v = structuredClone(payload());
      mutate(v);
      expect(() => decodeVoucherPayload(v)).toThrow();
    }
  });
  it('allows view/correction context with invalid date or closed/inactive canEditfalse, never infers permission from it', () => {
    const session = {
      draftOwner: 'a'.repeat(64),
      draftSession: 'b'.repeat(64),
      role: 'owner' as const,
      storeId: null,
      networkOwner: true,
    };
    const r = {
      kind: 'opening',
      store: 1,
      editing: {
        role: 'owner',
        storeId: null,
        closedThrough: '2026-10-03',
        canEdit: false,
        storeActive: false,
      },
    };
    expect(decodeContext(r, { kind: 'opening', store: 1 }, session)).toEqual({
      canEdit: false,
      storeActive: false,
    });
    expect(() =>
      decodeContext({ ...r, store: 2 }, { kind: 'opening', store: 1 }, session),
    ).toThrow();
  });
});

describe('authoritative durable transitions', () => {
  it('binds CREATE ACK and identity to original terms, retaining invalid newer fields and no revision adoption from identity', async () => {
    const { confirmVoucherPayload } = await import('./voucherPersistence');
    const initial = decodeVoucherPayload({
      baseline: state,
      draft: raw,
      firstIntent: {
        method: 'POST',
        path: '/api/erp/vouchers',
        key,
        body,
        revision: null,
        possiblySent: true,
      },
      confirmation: null,
    });
    const record = {
      ...body,
      id: 7,
      revision: 1,
      status: 'draft',
      total: '21.00',
      request_key: key,
      lines: [
        {
          ...body.lines[0],
          id: 8,
          name: 'Товар',
          unit: 'шт',
          quantity: '2.000',
          price: '10.5000',
          amount: '21.00',
        },
      ],
    };
    const saved = confirmVoucherPayload(initial, { type: 'save', raw: record, draft: raw })!;
    expect(saved.firstIntent).toBeNull();
    expect(saved.draft).toEqual(raw);
    expect((saved.baseline as typeof state).needsReview).toBe(true);
    expect(() =>
      confirmVoucherPayload(initial, {
        type: 'save',
        raw: { ...record, request_key: 'another' },
        draft: raw,
      }),
    ).toThrow();
    expect(() =>
      confirmVoucherPayload(initial, {
        type: 'save',
        raw: {
          ...record,
          lines: [{ ...record.lines[0], quantity: '3.000', amount: '31.50' }],
          total: '31.50',
        },
        draft: raw,
      }),
    ).toThrow();
    const identity = {
      confirmed: true,
      idempotencyKey: key,
      id: 7,
      revision: 99,
      status: 'draft',
      kind: 'opening',
      store: 1,
      date: body.date,
      editing: {
        role: 'owner',
        storeId: null,
        closedThrough: null,
        storeActive: true,
        canEdit: true,
      },
    };
    const confirmed = confirmVoucherPayload(initial, {
      type: 'identity',
      raw: identity,
      draft: raw,
    })!;
    expect((confirmed.baseline as typeof state).identity.revision).toBeNull();
    expect((confirmed.baseline as typeof state).needsReview).toBe(true);
    expect(() =>
      confirmVoucherPayload(initial, {
        type: 'identity',
        raw: { ...identity, idempotencyKey: 'other' },
        draft: raw,
      }),
    ).toThrow();
  });
  it('only a strict CREATE no-write proof releases the original intent and preserves invalid raw strings', () => {
    const proof = {
      error: 'Неправильна сума',
      write_rejected: true,
      request_key: key,
      kind: 'opening',
    };
    const next = confirmVoucherPayload(decodeVoucherPayload(payload()), {
      type: 'rejected',
      raw: proof,
      draft: raw,
    })!;
    expect(() =>
      decodeVoucherPayload({
        ...payload(),
        firstIntent: { ...payload().firstIntent, key: 'different-envelope-key' },
      }),
    ).toThrow();
    expect(next.firstIntent).toBeNull();
    expect(next.draft).toEqual(raw);
    for (const bad of [
      { ...proof, request_key: 'other' },
      { ...proof, kind: 'sale' },
      { ...proof, write_rejected: false },
      { ...proof, confirmed: false },
    ])
      expect(() =>
        confirmVoucherPayload(decodeVoucherPayload(payload()), {
          type: 'rejected',
          raw: bad,
          draft: raw,
        }),
      ).toThrow();
    expect(
      decodeVoucherPayload({
        ...payload(),
        draft: { ...raw, fields: { ...fields, warehouse: '9007199254740991' } },
      }).draft,
    ).toBeDefined();
    expect(() =>
      decodeVoucherPayload({
        ...payload(),
        draft: { ...raw, fields: { ...fields, warehouse: '9007199254740992' } },
      }),
    ).toThrow();
  });
});
