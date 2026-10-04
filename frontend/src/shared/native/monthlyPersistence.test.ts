import { describe, expect, it } from 'vitest';
import {
  decodeMonthlyPayload,
  decodeMonthlyRaw,
  decodeMonthlyContext,
  confirmMonthlyPayload,
  type MonthlyState,
} from './monthlyPersistence';
import type { DraftSession } from '../recovery/session';
const key = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  line = 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  cat = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const terms = {
  planned_revenue: '100.00',
  lines: [
    {
      id: line,
      category: cat,
      mode: 'fixed_amount',
      amount: '12.34',
      rate: '0.000',
      base: 'revenue',
    },
  ],
};
const baseline: MonthlyState = {
  recordId: 'monthly_' + key,
  key,
  id: null,
  month: '2026-10',
  store: null,
  original: null,
  base: terms as MonthlyState['base'],
  needsReview: false,
  confirmed: false,
  deleted: false,
  pendingRefresh: false,
  existingReview: false,
};
const draft = {
  month: 'bad month',
  store: 'not a number',
  planned_revenue: '-',
  lines: [{ ...terms.lines[0], amount: '1..2' }],
};
const body = { ...terms, month: baseline.month, store: null, idempotency_key: key };
const payload = () => ({
  baseline,
  draft,
  firstIntent: {
    method: 'POST',
    path: '/api/erp/monthly-budgets',
    key,
    body,
    revision: null,
    possiblySent: true,
  },
  confirmation: null,
});
const record = {
  ...terms,
  id,
  month: baseline.month,
  store: null,
  revision: 1,
  lines: terms.lines.map((l) => ({ ...l, category_name: 'Стаття' })),
};
describe('monthly reload whitelist and authoritative boundaries', () => {
  it('keeps invalid raw with ordered UUIDs and excludes private facts/grants/extras', () => {
    expect(decodeMonthlyRaw(draft)).toEqual(draft);
    expect(decodeMonthlyPayload(payload()).firstIntent?.body).toEqual(body);
    for (const raw of [
      { ...draft, fact_total: '100.00' },
      { ...draft, lines: [{ ...draft.lines[0], permissions: { canEdit: true } }] },
      { ...draft, lines: [draft.lines[0], draft.lines[0]] },
    ])
      expect(() => decodeMonthlyRaw(raw)).toThrow();
    expect(() =>
      decodeMonthlyPayload({
        ...payload(),
        firstIntent: { ...payload().firstIntent, body: { ...body, store: 2 } },
      }),
    ).toThrow();
  });
  it('persists confirmed CREATE identity before independent current read without mutable revision adoption', () => {
    const p = confirmMonthlyPayload(payload(), {
      type: 'identity',
      raw: {
        resource: 'monthly_budget',
        request_key: key,
        confirmed: true,
        status: 'present',
        id,
        revision: 99,
        month: baseline.month,
        store: null,
        permissions: { canEdit: true },
      },
      draft,
    })!;
    expect(p.firstIntent).toBeNull();
    expect(p.baseline).toMatchObject({ id, original: null, needsReview: true, confirmed: true });
    expect(p.draft).toEqual(draft);
    expect(
      confirmMonthlyPayload(payload(), {
        type: 'create',
        raw: { ...record, resource: 'monthly_budget', request_key: key },
        draft,
      })?.baseline,
    ).toMatchObject({ id, original: null });
    expect(() =>
      confirmMonthlyPayload(payload(), {
        type: 'create',
        raw: { ...record, resource: 'monthly_budget', request_key: 'wrong' },
        draft,
      }),
    ).toThrow();
    expect(
      confirmMonthlyPayload(payload(), {
        type: 'identity',
        raw: {
          resource: 'monthly_budget',
          request_key: key,
          confirmed: true,
          status: 'deleted',
          id,
          month: baseline.month,
          store: null,
        },
        draft,
      })?.baseline,
    ).toMatchObject({ deleted: true });
  });
  it('retains unknown UPDATE original terms, explicit Apply alone adopts revision; cleanup requires independent exact current', () => {
    const original = {
      ...terms,
      id,
      month: baseline.month,
      store: null,
      revision: 1,
      captions: { [line]: 'Стаття' },
    };
    const p = {
      ...payload(),
      baseline: { ...baseline, id, original },
      firstIntent: {
        method: 'PUT',
        path: '/api/erp/monthly-budgets/' + id,
        key,
        body: { ...terms, month: baseline.month, store: null, revision: 1 },
        revision: 1,
        possiblySent: true,
      },
    };
    const ack = { ...record, revision: 2 },
      confirmed = confirmMonthlyPayload(p, { type: 'update', raw: ack, draft })!;
    expect(confirmed.baseline).toMatchObject({ original: { revision: 1 }, needsReview: true });
    const applied = confirmMonthlyPayload(confirmed, {
      type: 'apply',
      raw: { resource: 'monthly_budget', record: ack, permissions: { canEdit: true } },
      draft,
    })!;
    expect(applied.baseline).toMatchObject({ original: { revision: 2 }, needsReview: false });
    expect(
      confirmMonthlyPayload(applied, {
        type: 'complete',
        raw: { resource: 'monthly_budget', record: ack, permissions: { canEdit: true } },
        draft,
      }),
    ).not.toBeNull();
    expect(
      confirmMonthlyPayload(applied, {
        type: 'complete',
        raw: { resource: 'monthly_budget', record: ack, permissions: { canEdit: true } },
        draft: { ...draft, ...terms },
      }),
    ).toBeNull();
  });
  it('uses pinned allowed month/store despite invalid newer fields and binds rollback proof to the exact first key', () => {
    const session = { role: 'owner', storeId: null, networkOwner: true } as DraftSession;
    expect(
      decodeMonthlyContext(
        {
          resource: 'monthly_budget',
          id: null,
          month: baseline.month,
          store: null,
          exists: null,
          role: 'owner',
          storeId: null,
          networkOwner: true,
          canEdit: true,
        },
        baseline,
        session,
      ).canEdit,
    ).toBe(true);
    expect(() =>
      decodeMonthlyContext(
        {
          resource: 'monthly_budget',
          id: null,
          month: '2026-11',
          store: null,
          exists: null,
          role: 'owner',
          storeId: null,
          networkOwner: true,
          canEdit: true,
        },
        baseline,
        session,
      ),
    ).toThrow();
    expect(
      confirmMonthlyPayload(payload(), {
        type: 'rejected',
        raw: { write_rejected: true, resource: 'monthly_budget', request_key: key },
        draft,
      })?.firstIntent,
    ).toBeNull();
    expect(() =>
      confirmMonthlyPayload(payload(), {
        type: 'rejected',
        raw: { write_rejected: true, resource: 'monthly_budget', request_key: id },
        draft,
      }),
    ).toThrow();
  });
});
