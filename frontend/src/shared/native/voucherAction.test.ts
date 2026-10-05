import type { DraftSession } from '../recovery/session';
import { describe, expect, it } from 'vitest';
import {
  confirm,
  decodeAck,
  decodeContext,
  decodeIdentity,
  decodePayload,
  decodeState,
  type Terms,
} from './voucherAction';
const terms: Terms = {
  key: '44444444-4444-4444-8444-444444444444',
  action: 'reverse',
  id: 3,
  kind: 'receipt',
  store: 2,
  expenseScope: 'store',
  revision: 1,
  reason: 'First reason',
};
const base = {
  recordId: 'voucher_action_33333333-3333-4333-8333-333333333333',
  terms,
  observedStatus: 'posted',
  observedDate: '2026-09-29',
  needsReview: false,
  outcome: null,
};
const unknown = () =>
  decodePayload({
    baseline: base,
    draft: { reason: '' },
    firstIntent: {
      method: 'POST',
      path: '/api/v1/trading/voucher-actions/execute',
      key: terms.key,
      body: terms,
      revision: 1,
      possiblySent: true,
    },
    confirmation: null,
  });
const ack = { contract: 'voucher-action-v1', request: terms, outcome: 'reversed' };
describe('standalone voucher action strict raw + confirmation', () => {
  it('keeps invalid newer reason separately from frozen original and rejects forged body/extra fields', () => {
    const p = unknown();
    expect(p.draft).toEqual({ reason: '' });
    expect(p.firstIntent?.body).toEqual(terms);
    expect(() =>
      decodePayload({
        ...p,
        firstIntent: { ...p.firstIntent, body: { ...terms, reason: 'New reason' } },
      }),
    ).toThrow();
    expect(() => decodePayload({ ...p, draft: { reason: '', total: '999' } })).toThrow();
  });
  it('durably confirms identity before current GET without adopting revision; missing is not rejection', () => {
    const p = unknown();
    expect(
      decodeIdentity({ contract: 'voucher-action-v1', confirmed: false, request: terms }, terms),
    ).toBeNull();
    const same = confirm(p, {
      type: 'identity',
      raw: { contract: 'voucher-action-v1', confirmed: false, request: terms },
      draft: { reason: 'new invalid raw' },
    })!;
    expect(same.firstIntent).not.toBeNull();
    const saved = confirm(p, {
      type: 'identity',
      raw: { confirmed: true, ...ack },
      draft: { reason: 'new invalid raw' },
    })!;
    expect(saved.firstIntent).toBeNull();
    expect(decodeState(saved.baseline).outcome).toBe('reversed');
    expect(decodeState(saved.baseline).terms.revision).toBe(1);
    expect(saved.draft).toEqual({ reason: 'new invalid raw' });
    expect(decodePayload(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });
  it('binds ACK and rejection to whole first action/key/creator-target terms', () => {
    for (const field of [
      'key',
      'id',
      'action',
      'kind',
      'store',
      'expenseScope',
      'revision',
      'reason',
    ])
      expect(() =>
        decodeAck(
          {
            ...ack,
            request: {
              ...terms,
              [field]:
                field === 'id' || field === 'revision' || field === 'store' ? 99 : 'different',
            },
          },
          terms,
        ),
      ).toThrow();
    expect(() => decodeAck({ ...ack, outcome: 'posted' }, terms)).toThrow();
    expect(() =>
      confirm(unknown(), {
        type: 'rejected',
        raw: {
          write_rejected: true,
          request: { ...terms, key: '11111111-1111-4111-8111-111111111111' },
        },
        draft: { reason: '' },
      }),
    ).toThrow();
    const p = confirm(unknown(), {
      type: 'rejected',
      raw: { write_rejected: true, request: terms },
      draft: { reason: '' },
    })!;
    expect(p.firstIntent).toBeNull();
    expect(decodeState(p.baseline).needsReview).toBe(true);
  });
  it('permits authorized closed/deleted viewing without treating canExecute as a grant and refuses role/scope mismatch', () => {
    const session: DraftSession = {
      role: 'owner',
      storeId: null,
      networkOwner: true,
      draftOwner: 'a'.repeat(64),
      draftSession: 'b'.repeat(64),
    };
    const c = {
      contract: 'voucher-action-context-v1',
      id: 3,
      kind: 'receipt',
      store: 2,
      expenseScope: 'store',
      action: 'reverse',
      exists: false,
      status: null,
      revision: null,
      date: null,
      canExecute: false,
      closedThrough: '2026-09-29',
      role: 'owner',
      storeId: null,
    };
    expect(decodeContext(c, terms, session).exists).toBe(false);
    expect(() => decodeContext({ ...c, role: 'cashier' }, terms, session)).toThrow();
    expect(() =>
      decodeContext({ ...c, exists: false, status: 'posted' }, terms, session),
    ).toThrow();
    expect(() => decodeContext({ ...c, products: [] }, terms, session)).toThrow();
  });
});
