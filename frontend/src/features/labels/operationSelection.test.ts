import { describe, expect, it } from 'vitest';
import { decodeSelectionReview, mergedSelection } from './operationSelection';
import { fixtureOperation, fixtureReview } from './operationSelection.fixtures';
describe('current operation selection binding', () => {
  it('accepts readonly current data and validates identity/page/snapshot/terms', () => {
    expect(
      decodeSelectionReview(fixtureReview(), fixtureOperation, { ordinals: [1] }).canApply,
    ).toBe(true);
    const mutations = [
      (v: ReturnType<typeof fixtureReview>) => {
        v.operation.id = '00000000-0000-4000-8000-000000000002';
      },
      (v: ReturnType<typeof fixtureReview>) => {
        v.selection[0]!.id = 'other';
      },
      (v: ReturnType<typeof fixtureReview>) => {
        v.items[0]!.current!.salePrice = '99.00';
      },
      (v: ReturnType<typeof fixtureReview>) => {
        v.pages = 9;
      },
      (v: ReturnType<typeof fixtureReview>) => {
        v.items[0]!.revisionChanged = true;
      },
      (v: ReturnType<typeof fixtureReview>) => {
        v.counts.missing = 1;
      },
    ];
    for (const mutate of mutations) {
      const v = fixtureReview();
      mutate(v);
      expect(() => decodeSelectionReview(v, fixtureOperation, { ordinals: [1] })).toThrow();
    }
    expect(() =>
      decodeSelectionReview(fixtureReview(), fixtureOperation, {
        ordinals: [1],
        snapshot: 'd'.repeat(64),
      }),
    ).toThrow();
  });
  it('cannot apply hidden/missing records and rejects false availability', () => {
    const v = fixtureReview();
    v.items[0]!.state = 'hidden';
    v.items[0]!.current = { ...v.items[0]!.current!, hidden: true };
    v.counts.available = 0;
    v.counts.hidden = 1;
    v.canApply = false;
    expect(decodeSelectionReview(v, fixtureOperation, { ordinals: [1] }).canApply).toBe(false);
    expect(() =>
      decodeSelectionReview({ ...v, canApply: true }, fixtureOperation, { ordinals: [1] }),
    ).toThrow();
  });
  it('replaces/adds explicitly, preserves copies, refuses limits without truncation', () => {
    expect(mergedSelection({ 'sample-1': 3, prior: 2 }, ['sample-1', 'next'], 'replace')).toEqual({
      'sample-1': 3,
      next: 1,
    });
    expect(mergedSelection({ prior: 2 }, ['next'], 'add')).toEqual({ prior: 2, next: 1 });
    expect(() => mergedSelection({ a: 500, b: 500 }, ['new'], 'add')).toThrow(/1000/);
    expect(() => mergedSelection({ a: 501 }, ['a'], 'replace')).toThrow(/500/);
  });
  it('rejects a valid but contradictory current store caption', () => {
    const v = fixtureReview();
    v.priceContext = { storeId: 1, storeName: 'Correct' };
    v.items[0]!.operationResult.context = {
      storeId: 1,
      storeName: 'Historical',
      effectiveDay: v.effectiveDay,
    };
    v.items[0]!.current = {
      ...v.items[0]!.current!,
      priceContext: { storeId: 1, storeName: 'Other' },
    };
    expect(() => decodeSelectionReview(v, fixtureOperation, { ordinals: [1] })).toThrow();
  });
  it('rejects hidden row falsely counted as available in the batch', () => {
    const v = fixtureReview();
    v.items[0]!.state = 'hidden';
    v.items[0]!.current = { ...v.items[0]!.current!, hidden: true };
    expect(() => decodeSelectionReview(v, fixtureOperation, { ordinals: [1] })).toThrow();
  });
});
