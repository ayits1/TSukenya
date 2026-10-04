import { describe, it, expect } from 'vitest';
import { decodeABCReport, createABCApi } from './api';
import { fixtureFilters, fixtureReport } from './fixtures';
import { formatMoney } from './ABCReport';
describe('ABC authoritative bounded decoder', () => {
  it('keeps exact amounts, first-group class and matched context', () => {
    expect(decodeABCReport(fixtureReport(), fixtureFilters).summary.positivePoolRevenue).toBe(
      '90.00',
    );
    expect(formatMoney('-0.99')).toBe('−0,99');
  });
  it('rejects wrong context, contradictory coverage, pagination, enum coercion and money', () => {
    const changes = [
      { store: 2 },
      { pages: 999 },
      { items: [] },
      { class: ['A'] },
      { aThreshold: '80.001' },
      { summary: { ...fixtureReport().summary, positiveCount: 0 } },
      { summary: { ...fixtureReport().summary, grossProfit: '40.001' } },
    ];
    for (const change of changes)
      expect(() => decodeABCReport({ ...fixtureReport(), ...change }, fixtureFilters)).toThrow();
    expect(() =>
      decodeABCReport(
        { ...fixtureReport(), items: [{ ...fixtureReport().items[0], classification: ['A'] }] },
        fixtureFilters,
      ),
    ).toThrow();
  });
  it('accepts display rounding equal before/after on a positive tiny SKU', () => {
    const data = fixtureReport();
    data.items[0] = {
      ...data.items[0]!,
      share: '0.0000',
      cumulativeBefore: '100.0000',
      cumulativeAfter: '100.0000',
    };
    expect(() => decodeABCReport(data, fixtureFilters)).not.toThrow();
  });
  it('reads GET only with AbortSignal and no-store auth guard', async () => {
    let calls = 0;
    const abort = new AbortController();
    const api = createABCApi(async (input, init) => {
      calls++;
      expect(String(input)).toContain('/reports/abc?');
      expect(init?.signal).toBe(abort.signal);
      expect(init?.method).toBeUndefined();
      return new Response(JSON.stringify(fixtureReport()), { status: 200 });
    });
    expect((await api.read(fixtureFilters, 1, abort.signal)).total).toBe(1);
    expect(calls).toBe(1);
  });
  it('rejects malformed JSON200 and valid-but-impossible class membership', async () => {
    const api = createABCApi(async () => new Response('{broken', { status: 200 }));
    await expect(api.read(fixtureFilters, 1)).rejects.toMatchObject({ protocol: true });
    const data = fixtureReport();
    data.items[0]!.classification = 'C';
    expect(() => decodeABCReport(data, fixtureFilters)).toThrow();
  });
});
