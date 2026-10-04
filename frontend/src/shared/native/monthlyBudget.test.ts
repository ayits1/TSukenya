import { describe, expect, it } from 'vitest';
import { nativeFields } from './fields';
import { compareThreeWay, resolveThreeWay } from '../merge/threeWay';
import {
  comparison,
  fromComparison,
  decimal,
  terms,
  decodeCurrent,
  decodeAck,
  decodeIdentity,
  validateCategories,
  type BudgetTerms,
} from './monthlyBudget';
const id = '11111111-1111-4111-8111-111111111111',
  a = '22222222-2222-4222-8222-222222222222',
  b = '33333333-3333-4333-8333-333333333333',
  cat = '44444444-4444-4444-8444-444444444444';
const row = {
  id: a,
  category: cat,
  mode: 'fixed_amount' as const,
  amount: '10.00',
  rate: '0.000',
  base: 'revenue' as const,
};
const base: BudgetTerms = {
  planned_revenue: '100.00',
  lines: [row, { ...row, id: b, amount: '20.00' }],
};
const current = {
  resource: 'monthly_budget',
  record: {
    ...base,
    id,
    month: '2026-10',
    store: null,
    revision: 1,
    lines: base.lines.map((l) => ({ ...l, category_name: 'Оренда' })),
  },
  permissions: { canEdit: true },
};
const context = { month: '2026-10', store: null, id };
function merge(records: BudgetTerms[], choices = {}) {
  const v = comparison(records, { [cat]: 'Оренда' });
  const f = nativeFields(v.fields);
  const merged = resolveThreeWay(v.snapshots[0]!, v.snapshots[1]!, v.snapshots[2]!, f, choices);
  return {
    ...v,
    rows: compareThreeWay(v.snapshots[0]!, v.snapshots[1]!, v.snapshots[2]!, f),
    merged: merged && fromComparison(merged, records[2]!, v.structural),
  };
}
describe('Monthly budget recovery', () => {
  it('keeps independent revenue and different rows without readonly captions', () => {
    const mine = {
        ...base,
        planned_revenue: '200',
        lines: [{ ...row, amount: '11' }, base.lines[1]!],
      },
      server = { ...base, lines: [row, { ...base.lines[1]!, amount: '22' }] };
    const v = merge([base, mine, server]);
    expect(v.structural).toBe(false);
    expect(v.merged).toEqual({
      planned_revenue: '200.00',
      lines: [
        { ...row, amount: '11.00' },
        { ...base.lines[1]!, amount: '22.00' },
      ],
    });
  });
  it('does not split category and amount of the same stable row', () => {
    const mine = { ...base, lines: [{ ...row, category: id }, base.lines[1]!] },
      server = { ...base, lines: [{ ...row, amount: '15' }, base.lines[1]!] };
    const v = merge([base, mine, server]);
    expect(v.merged).toBeNull();
    expect(v.rows.filter((r) => r.status === 'conflict').map((r) => r.id)).toEqual([`row:${a}`]);
    expect(merge([base, mine, server], { [`row:${a}`]: 'server' }).merged?.lines[0]).toEqual({
      ...row,
      amount: '15.00',
    });
  });
  it('requires an explicit whole-list choice for removal versus change, additions and order', () => {
    const mine = { ...base, planned_revenue: '300', lines: [base.lines[1]!] },
      server = { ...base, lines: [{ ...row, amount: '15' }, base.lines[1]!] };
    expect(merge([base, mine, server]).merged).toBeNull();
    expect(merge([base, mine, server], { lines: 'mine' }).merged).toEqual(terms(mine));
    const ordered = { ...base, lines: [...base.lines].reverse() };
    expect(merge([base, ordered, server]).structural).toBe(true);
    expect(
      merge([
        base,
        { ...base, lines: [...base.lines, { ...row, id }] },
        { ...base, lines: [...base.lines, { ...row, id: cat }] },
      ]).merged,
    ).toBeNull();
  });
  it('uses exact bounded money/rates and rejects malformed line/policy/resource identities', () => {
    expect(decimal('999999999998.99')).toBe('999999999998.99');
    expect(decimal('1.234e2')).toBe('123.40');
    expect(decimal('-0')).toBe('0.00');
    for (const value of ['1.001', '1e999', 'NaN', '999999999999.01', true])
      expect(() => decimal(value)).toThrow();
    expect(() => terms({ ...base, lines: [row, row] })).toThrow();
    expect(() => terms({ ...base, lines: [{ ...row, rate: '1' }] })).toThrow();
    expect(() =>
      terms({ ...base, lines: [{ ...row, mode: 'revenue_rate', amount: '0', rate: '100.001' }] }),
    ).toThrow();
    expect(decodeCurrent(current, context).canEdit).toBe(true);
    expect(decodeCurrent({ ...current, permissions: { canEdit: false } }, context).canEdit).toBe(
      false,
    );
    for (const bad of [
      { ...current, resource: ['monthly_budget'] },
      { ...current, permissions: {} },
      { ...current, record: { ...current.record, id: cat } },
      { ...current, record: { ...current.record, store: 1 } },
      { ...current, record: { ...current.record, revision: 0 } },
      { ...current, record: { ...current.record, lines: [{ ...row }] } },
    ])
      expect(() => decodeCurrent(bad, context)).toThrow();
  });
  it('binds ACK to immutable original key/terms and identity without adopting revision', () => {
    const input = { ...base, month: context.month, store: null, idempotency_key: 'initial-key' },
      ack = { ...current.record, resource: 'monthly_budget', request_key: 'initial-key' };
    expect(decodeAck(ack, input).id).toBe(id);
    for (const bad of [
      { ...ack, request_key: 'other' },
      { ...ack, planned_revenue: '101' },
      { ...ack, lines: [...ack.lines].reverse() },
      { ...ack, revision: 2 },
    ])
      expect(() => decodeAck(bad, input)).toThrow();
    const found = {
      resource: 'monthly_budget',
      request_key: 'initial-key',
      confirmed: true,
      status: 'present',
      id,
      month: context.month,
      store: null,
      revision: 99,
      permissions: { canEdit: true },
    };
    expect(decodeIdentity(found, input)).toEqual({
      confirmed: true,
      status: 'present',
      id,
      canEdit: true,
    });
    expect(() => decodeIdentity({ ...found, store: 7 }, input)).toThrow();
    expect(() => decodeIdentity({ ...found, request_key: 'other' }, input)).toThrow();
    expect(
      decodeIdentity(
        {
          resource: 'monthly_budget',
          request_key: 'initial-key',
          confirmed: false,
          status: 'legacy_unknown',
        },
        input,
      ),
    ).toEqual({ confirmed: false, status: 'legacy_unknown' });
    expect(() =>
      decodeIdentity({ ...found, confirmed: false, status: 'legacy_unknown' }, input),
    ).toThrow();
  });
  it('only keeps archived categories in their unchanged historical binding', () => {
    const choices = [{ id: cat, name: 'Архів', active: false }];
    expect(validateCategories(base, choices, base)).toEqual(base);
    expect(() => validateCategories(base, choices)).toThrow();
    expect(() => validateCategories({ ...base, lines: [{ ...row, id }] }, choices, base)).toThrow();
    expect(() => validateCategories(base, [])).toThrow();
  });
});
