import { describe, it, expect } from 'vitest';
import {
  capture,
  confirm,
  decodeAck,
  decodeContext,
  decodeIdentity,
  decodePayload,
  decodeRaw,
  decodeState,
  decodeTerms,
  type Action,
} from './orderAction';
const key = '10000000-0000-4000-8000-000000000001';
function terms(a: Action = 'reserve') {
  return decodeTerms({
    id: 12,
    kind: a === 'expected_date' ? 'purchase_order' : 'customer_order',
    store: 1,
    body: {
      action: a,
      revision: 4,
      idempotencyKey: key,
      ...(a === 'reserve'
        ? { expires_on: '2026-10-05', lines: [{ line: 11, quantity: '1.500' }] }
        : a === 'release'
          ? { reservation: 70, quantity: '0.500', reason: 'Original' }
          : a === 'close'
            ? { reason: 'Original' }
            : a === 'expected_date'
              ? { expected_date: '' }
              : {}),
    },
  });
}
const raw = {
  reason: 'New invalid reason',
  quantity: '1,2,wrong',
  expires_on: 'invalid date',
  expected_date: '31/31/2026',
  lines: [{ line: 11, quantity: '1e-' }],
};
function payload(a: Action = 'reserve') {
  const t = terms(a);
  return decodePayload({
    baseline: {
      recordId: 'order_action_' + key,
      terms: t,
      observedState: 'approved',
      observedDate: '2026-10-05',
      needsReview: false,
      outcome: null,
    },
    draft: raw,
    firstIntent: {
      method: 'POST',
      path: '/api/v1/trading/order-actions/execute',
      key,
      body: t,
      revision: 4,
      possiblySent: true,
    },
    confirmation: null,
  });
}
describe('Five order controls reload contract', () => {
  it('retains invalid raw independently from immutable first intent for all five actions', () => {
    for (const a of ['reserve', 'release', 'expire', 'close', 'expected_date'] as const) {
      const p = payload(a);
      expect(decodeRaw(p.draft)).toEqual(raw);
      expect(decodeState(p.baseline).terms).toEqual(terms(a));
      expect(p.firstIntent?.body).toEqual(terms(a));
    }
  });
  it('binds scalar ACK to exact original action/body/order/control revision', () => {
    const t = terms();
    const ack = {
      contract: 'order-action-v1',
      request: t,
      outcome: { id: 12, revision: 5, state: 'approved' },
    };
    expect(decodeAck(ack, t).outcome.revision).toBe(5);
    for (const bad of [
      { ...ack, request: { ...t, id: 13 } },
      { ...ack, request: { ...t, body: { ...t.body, lines: [{ line: 11, quantity: '1.5' }] } } },
      { ...ack, outcome: { id: 12, revision: 6, state: 'approved' } },
      { ...ack, privateHistory: [] },
    ])
      expect(() => decodeAck(bad, t)).toThrow();
  });
  it('persists identity confirmation before any independent current read; false is never absence', () => {
    const p = payload('close'),
      t = terms('close');
    expect(
      decodeIdentity({ contract: 'order-action-v1', confirmed: false, request: t }, t),
    ).toBeNull();
    const next = confirm(p, {
      type: 'identity',
      raw: {
        contract: 'order-action-v1',
        confirmed: true,
        request: t,
        outcome: { id: 12, revision: 5, state: 'closed' },
      },
      draft: raw,
    })!;
    expect(next.firstIntent).toBeNull();
    expect(decodeState(next.baseline).needsReview).toBe(true);
    expect(decodeState(next.baseline).outcome?.state).toBe('closed');
    expect(decodeRaw(decodePayload(JSON.parse(JSON.stringify(next))).draft)).toEqual(raw);
  });
  it('separates raw capture from submit validation and pins line IDs/spelling', () => {
    const t = terms();
    expect(() => capture(t, raw)).toThrow();
    expect(
      capture(t, { ...raw, expires_on: '2026-10-05', lines: [{ line: 11, quantity: '1.500' }] })
        .body.lines,
    ).toEqual([{ line: 11, quantity: '1.500' }]);
    expect(capture(terms('expected_date'), { ...raw, expected_date: '' }).body.expected_date).toBe(
      '',
    );
    expect(() =>
      decodePayload({ ...payload(), draft: { ...raw, lines: [{ line: 999, quantity: '1e-' }] } }),
    ).toThrow();
  });
  it('checks fresh scoped context including exact old reservation and rejects extra/corrupt data', () => {
    const t = terms('release');
    const session = { role: 'owner', storeId: null } as Parameters<typeof decodeContext>[2];
    const c = {
      contract: 'order-action-context-v1',
      id: 12,
      kind: 'customer_order',
      store: 1,
      action: 'release',
      revision: 4,
      state: 'approved',
      date: '2026-10-05',
      canExecute: true,
      expected_date: null,
      lines: [
        {
          line: 11,
          name: 'Товар',
          unit: 'шт',
          quantity: '6.000',
          fulfilled: '0.000',
          remaining: '6.000',
          reserved: '1.500',
        },
      ],
      selected: {
        id: 70,
        line: 11,
        name: 'Товар',
        code: 'Партія',
        expires_on: '2026-10-05',
        unused: '1.500',
      },
      limits: [],
      role: 'owner',
      storeId: null,
    };
    expect(decodeContext(c, t, session).selected?.id).toBe(70);
    expect(() =>
      decodeContext({ ...c, selected: { ...c.selected, id: 71 } }, t, session),
    ).toThrow();
    expect(() => decodeContext({ ...c, role: 'accountant' }, t, session)).toThrow();
    expect(() => decodeContext({ ...c, history: [] }, t, session)).toThrow();
  });
});
