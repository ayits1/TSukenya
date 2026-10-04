import { describe, it, expect } from 'vitest';
import { decodeExpensePayload, confirmExpensePayload, expenseTerms } from './expensePersistence';
const key = '12345678-1234-1234-1234-123456789abc',
  revision = 'a'.repeat(32),
  rev2 = 'b'.repeat(32),
  terms = { name: 'Оренда', group: 'fixed', amount: '100.00', category: null };
const payload = (id: string | null = 'rent', units = ['amount']) => ({
  baseline: {
    recordId: 'expense_' + key,
    key,
    id,
    revision: id ? revision : null,
    original: id ? terms : { ...terms, name: '', amount: '0.00' },
    units,
    review: false,
    order: 7,
  },
  draft: { ...terms, category: '', amount: '1..2' },
  firstIntent: null,
  confirmation: null,
});
describe('Actual expense draft whitelist and accounting units', () => {
  it('retains invalid independent raw and refuses private caches/foreign revisions', () => {
    expect(decodeExpensePayload(payload()).draft).toMatchObject({ amount: '1..2' });
    expect(() => decodeExpensePayload({ ...payload(), totals: 4 })).toThrow();
    expect(() =>
      decodeExpensePayload({
        ...payload(),
        baseline: { ...payload().baseline, permissions: { canEdit: true } },
      }),
    ).toThrow();
    expect(expenseTerms({ ...terms, amount: '00100.0' }).amount).toBe('100.00');
  });
  it('freezes only original one-field PATCH and never adds unrelated classification', () => {
    const p = {
      ...payload(),
      firstIntent: {
        method: 'PATCH',
        path: '/api/docs/expenses/rent',
        key,
        revision,
        body: { amount: '4.00' },
        possiblySent: true,
      },
    };
    expect(decodeExpensePayload(p).firstIntent?.body).toEqual({ amount: '4.00' });
    expect(() =>
      decodeExpensePayload({
        ...p,
        firstIntent: { ...p.firstIntent, body: { amount: '4.00', category: 'Інше' } },
      }),
    ).toThrow();
    expect(() =>
      decodeExpensePayload({ ...p, firstIntent: { ...p.firstIntent, revision: rev2 } }),
    ).toThrow();
  });
  it('binds actual CREATE identity terms before current read, keeping newer invalid input', () => {
    const p = {
      ...payload(null, ['name', 'group', 'amount', 'category']),
      firstIntent: {
        method: 'POST',
        path: '/api/expenses',
        key,
        revision: null,
        body: { ...terms, amount: 100, order: 7 },
        possiblySent: true,
      },
    };
    const next = confirmExpensePayload(p, {
      type: 'identity',
      id: 'created',
      revision: rev2,
      terms,
      draft: p.draft,
    });
    expect(next?.confirmation).toMatchObject({ id: 'created', revision: rev2 });
    expect(next?.firstIntent).toBeNull();
    expect(next?.draft).toMatchObject({ amount: '1..2' });
    expect(() =>
      confirmExpensePayload(p, {
        type: 'identity',
        id: 'created',
        revision: rev2,
        terms: { ...terms, name: 'Інша' },
        draft: p.draft,
      }),
    ).toThrow();
  });
  it('ACK and current cleanup are separate; wrong ACK or changed current cannot remove raw', () => {
    const p = {
      ...payload(),
      firstIntent: {
        method: 'PATCH',
        path: '/api/docs/expenses/rent',
        key,
        revision,
        body: { amount: '4.00' },
        possiblySent: true,
      },
    };
    const saved = confirmExpensePayload(p, {
      type: 'saved',
      id: 'rent',
      revision: rev2,
      terms: { ...terms, amount: '4.00' },
      draft: p.draft,
    })!;
    expect(() =>
      confirmExpensePayload(p, {
        type: 'saved',
        id: 'rent',
        revision: rev2,
        terms: { ...terms, amount: '5.00' },
        draft: p.draft,
      }),
    ).toThrow();
    expect(() =>
      confirmExpensePayload(saved, {
        type: 'complete',
        id: 'rent',
        revision: rev2,
        terms: { ...terms, amount: '5.00' },
        draft: p.draft,
      }),
    ).toThrow();
    expect(
      confirmExpensePayload(saved, {
        type: 'complete',
        id: 'rent',
        revision: rev2,
        terms: { ...terms, amount: '4.00' },
        draft: p.draft,
      }),
    ).not.toBeNull();
    expect(
      confirmExpensePayload(saved, {
        type: 'complete',
        id: 'rent',
        revision: rev2,
        terms: { ...terms, amount: '4.00' },
        draft: { ...p.draft, amount: '4' },
      }),
    ).toBeNull();
  });
  it('Apply installs one current baseline without mutation and preserves invalid newer raw', () => {
    const applied = confirmExpensePayload(payload(), {
      type: 'apply',
      id: 'rent',
      revision: rev2,
      terms,
      draft: payload().draft,
    })!;
    expect(applied.baseline).toMatchObject({ revision: rev2, review: false });
    expect(applied.draft).toMatchObject({ amount: '1..2' });
  });
  it('historical positive creator identity blocks CREATE without fabricating original or revision', () => {
    const p = {
      ...payload(null, ['name', 'group', 'amount', 'category']),
      firstIntent: {
        method: 'POST',
        path: '/api/expenses',
        key,
        revision: null,
        body: { ...terms, amount: 100, order: 7 },
        possiblySent: true,
      },
    };
    const confirmed = confirmExpensePayload(p, {
      type: 'identityLegacy',
      id: 'history',
      revision: null,
      terms: null,
      draft: p.draft,
    })!;
    expect(confirmed.firstIntent).toBeNull();
    expect(confirmed.confirmation).toEqual({ id: 'history', revision: null, original: null });
    expect(confirmed.baseline).toMatchObject({ id: null, revision: null, review: true });
    expect(() =>
      confirmExpensePayload(confirmed, {
        type: 'complete',
        id: 'history',
        revision: rev2,
        terms,
        draft: p.draft,
      }),
    ).toThrow();
  });
});
