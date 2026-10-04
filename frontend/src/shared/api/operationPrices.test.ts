import { describe, expect, it, vi } from 'vitest';
import { createOperationPriceApi, decodeOperationPricePage } from './operationPrices';
const key = '00000000-0000-4000-8000-000000000001';
const term = (price: string) => ({
  productRevision: 'a'.repeat(64),
  effectivePriceRevision: 'b'.repeat(64),
  regularPrice: price,
  salePrice: price,
  effectivePromotion: null,
  display: { promotion: false, oldPrice: null as string | null },
});
function fixture() {
  return {
    operation: { kind: 'import', id: key },
    comparisonUnavailable: false,
    priceContext: { storeId: 1, storeName: 'Магазин' },
    status: 'cancelled',
    group: 'retail',
    total: 1,
    page: 1,
    pages: 1,
    limit: 100,
    items: [
      {
        id: 'coffee',
        ordinal: 2,
        line: 4,
        outcome: 'updated',
        before: term('13.00'),
        after: term('14.00'),
        retailChanged: true,
        displayChanged: false,
        created: false,
        context: { storeId: 1, storeName: 'Збережена назва', effectiveDay: '2026-10-04' },
        committedAt: '2026-10-04T12:00:00+03:00',
      },
    ],
  };
}
const expected = { kind: 'import' as const, id: key, group: 'retail' as const };
describe('immutable price operation evidence', () => {
  it('keeps actual partial/cancelled results without claiming present prices', () => {
    const value = fixture(),
      decoded = decodeOperationPricePage(value, expected);
    expect(decoded.status).toBe('cancelled');
    expect(decoded.items[0]?.before?.salePrice).toBe('13.00');
    expect(decoded.items[0]?.after.salePrice).toBe('14.00');
    expect(decoded.items[0]?.context.storeName).toBe('Збережена назва');
  });
  it('rejects wrong operation/store identity, enum coercion and inconsistent deltas', () => {
    for (const mutate of [
      (v: ReturnType<typeof fixture>) => (v.operation.id = key.replace(/1$/, '2')),
      (v: ReturnType<typeof fixture>) => (v.items[0]!.context.storeId = 2),
      (v: ReturnType<typeof fixture>) => (v.items[0]!.retailChanged = false),
      (v: ReturnType<typeof fixture>) => (v.items[0]!.after.salePrice = '14.0'),
      (v: ReturnType<typeof fixture>) => (v.items[0]!.context.effectiveDay = '2026-02-30'),
      (v: ReturnType<typeof fixture>) => (v.pages = 999),
      (v: ReturnType<typeof fixture>) => (v.total = 17),
      (v: ReturnType<typeof fixture>) => (v.items[0]!.after.display.oldPrice = '13.00'),
    ]) {
      const value = fixture();
      mutate(value);
      expect(() => decodeOperationPricePage(value, expected)).toThrow();
    }
    expect(() => decodeOperationPricePage({ ...fixture(), group: ['retail'] }, expected)).toThrow();
    expect(() =>
      decodeOperationPricePage({ ...fixture(), status: ['completed'] }, expected),
    ).toThrow();
  });
  it('accepts explicit legacy unavailability with no guessed before price', () => {
    const v = {
      ...fixture(),
      comparisonUnavailable: true,
      priceContext: null,
      total: 0,
      items: [],
    };
    expect(decodeOperationPricePage(v, expected).comparisonUnavailable).toBe(true);
    expect(() => decodeOperationPricePage({ ...v, items: fixture().items }, expected)).toThrow();
  });
  it('allows regular/oldprice-only offer and separately validates new product', () => {
    const promotion = {
      source: 'legacy',
      id: null,
      name: 'Акція',
      price: '11.00',
      startsOn: null,
      endsOn: null,
      revision: null,
    };
    const v = fixture();
    const row = v.items[0]!;
    const display = {
      ...row,
      before: {
        ...term('13.00'),
        salePrice: '11.00',
        effectivePromotion: promotion,
        display: { promotion: true, oldPrice: '13.00' },
      },
      after: {
        ...term('14.00'),
        salePrice: '11.00',
        effectivePromotion: promotion,
        display: { promotion: true, oldPrice: '14.00' },
      },
      retailChanged: false,
      displayChanged: true,
    };
    expect(
      decodeOperationPricePage(
        { ...v, group: 'display', items: [display] },
        { ...expected, group: 'display' },
      ).items[0]?.retailChanged,
    ).toBe(false);
    const created = {
      ...row,
      before: null,
      outcome: 'created',
      created: true,
      retailChanged: false,
    };
    expect(
      decodeOperationPricePage(
        { ...v, group: 'new', items: [created] },
        { ...expected, group: 'new' },
      ).items[0]?.before,
    ).toBeNull();
  });
  it('binds the requested page while allowing the server last-page clamp', async () => {
    const value = { ...fixture(), total: 101, pages: 2, page: 2 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value)));
    const api = createOperationPriceApi(fetcher);
    await expect(api.result('import', key, { group: 'retail', page: 9 })).resolves.toMatchObject({
      page: 2,
    });
    const wrong = {
      ...value,
      page: 1,
      items: Array.from({ length: 100 }, (_, index) => ({
        ...value.items[0]!,
        id: `p${index}`,
        ordinal: index + 1,
      })),
    };
    fetcher.mockResolvedValue(new Response(JSON.stringify(wrong)));
    await expect(api.result('import', key, { group: 'retail', page: 2 })).rejects.toThrow(
      'невідомого формату',
    );
    expect(() => decodeOperationPricePage(value, { ...expected, page: 1 })).toThrow();
  });
  it('uses only same-origin readonly fetch and propagates abort, malformed 200 rejects', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(fixture())));
    const api = createOperationPriceApi(fetcher),
      controller = new AbortController();
    await api.result('import', key, { group: 'retail' }, controller.signal);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`/api/v1/catalog/price-results/import/${key}?group=retail&page=1`);
    expect(init?.method).toBe('GET');
    expect(init?.signal).toBe(controller.signal);
    expect(init?.credentials).toBe('same-origin');
    expect(init?.body).toBeUndefined();
    fetcher.mockResolvedValue(new Response('{'));
    await expect(api.result('import', key)).rejects.toThrow('невідомого формату');
  });
});
