import { describe, it, expect, vi } from 'vitest';
import { createSalesApi, decodeDocuments, decodeShifts, moneyText } from './api';
import { documents, shifts } from './fixtures';
describe('strict sales reads', () => {
  it('accepts only exact scalar journal and rejects hidden payload, scope, enums, totals and pages', () => {
    expect(decodeDocuments(documents, documents.query)).toEqual(documents);
    for (const patch of [
      { payload: {} },
      { kind: ['sale'] },
      { status: ['posted'] },
      { total: 12.34 },
      { number: '1' },
    ])
      expect(() =>
        decodeDocuments(
          { ...documents, items: [{ ...documents.items[0], ...patch }] },
          documents.query,
        ),
      ).toThrow();
    expect(() =>
      decodeDocuments({ ...documents, policy: { ...documents.policy, store: 2 } }, documents.query),
    ).toThrow();
    expect(() =>
      decodeDocuments(
        { ...documents, policy: { ...documents.policy, role: ['owner'] } },
        documents.query,
      ),
    ).toThrow();
    expect(() => decodeDocuments({ ...documents, total: 31 }, documents.query)).toThrow();
  });
  it('validates shift scope, closed action, timestamps and preserves exact signed decimals', () => {
    expect(decodeShifts(shifts, shifts.query)).toEqual(shifts);
    for (const patch of [
      { note: 'private' },
      { canClose: 'true' },
      { openedAt: 'yesterday' },
      { openedAt: '2026-02-30T16:00:00Z' },
      { closedAt: '2026-10-05T16:00:00+00:00' },
      { expectedCash: '0.00' },
    ])
      expect(() =>
        decodeShifts({ ...shifts, items: [{ ...shifts.items[0], ...patch }] }, shifts.query),
      ).toThrow();
    expect(() =>
      decodeShifts({ ...shifts, query: { ...shifts.query, employee: 2 } }, shifts.query),
    ).toThrow();
    expect(moneyText('-10000000000000.13')).toBe('-10 000 000 000 000,13');
  });
  it('only GETs same-origin no-store data and surfaces denied/protocol errors', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(shifts)));
    await createSalesApi(transport).shifts(shifts.query);
    expect(transport.mock.calls[0]?.[0]).toContain('/api/v1/trading/sales/cash-shifts?');
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(transport.mock.calls[0]?.[1]?.method).toBeUndefined();
    transport.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Доступ відкликано' }), { status: 403 }),
    );
    await expect(createSalesApi(transport).documents(documents.query)).rejects.toMatchObject({
      status: 403,
    });
  });
});
