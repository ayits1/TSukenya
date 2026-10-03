import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogApi, decodeProduct } from '../catalog/api';
import { catalogProducts } from '../catalog/fixtures';
import { decodeProductPricePreview } from '../../shared/api/client';
import { decodeCampaign, decodeContext, decodeHistory } from './api';
const context = { storeId: 2, storeName: 'Магазин №2' };
const effective = {
  effectiveDay: '2026-10-04',
  effectivePriceRevision: 'a'.repeat(64),
  priceContext: context,
  effectivePromotion: {
    source: 'campaign',
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Акція',
    price: '21.00',
    startsOn: '2026-10-01',
    endsOn: '2026-10-08',
    revision: 1,
  },
};
const product = {
  ...catalogProducts[0]!,
  promotion: false,
  promotionPrice: null,
  salePrice: '21.00',
  ...effective,
};
const preview = {
  regularPrice: '35.00',
  salePrice: '21.00',
  config: { markup: '30', rounding: '0.5' },
  pricingRevision: 'b'.repeat(64),
  promotionValid: false,
  warnings: [],
  ...effective,
};
afterEach(() => vi.unstubAllGlobals());
describe('B14 effective pricing boundary', () => {
  it('retains raw editor fields and campaign context through product and preview decoders', () => {
    expect(decodeProduct(product)).toMatchObject({
      promotion: false,
      promotionPrice: null,
      effectivePromotion: effective.effectivePromotion,
    });
    expect(decodeProductPricePreview(preview)).toMatchObject(effective);
    expect(() =>
      decodeProduct({ ...product, priceContext: { storeId: 2, storeName: null } }),
    ).toThrow();
    expect(() =>
      decodeProductPricePreview({ ...preview, effectivePriceRevision: 'invalid' }),
    ).toThrow();
  });
  it('keeps the session CSRF for a newly selected store without requiring a fresh cached session query', async () => {
    const transport = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async (url: string) =>
        new Response(JSON.stringify(url.includes('price-preview') ? preview : product), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', transport);
    const api = createCatalogApi(2, 'context-session-csrf');
    await api.save({ name: 'Кава' }, product.id);
    await api.previewPrice({
      id: product.id,
      revision: product.revision,
      manualPrice: true,
      price: '35.00',
    });
    expect(transport.mock.calls[0]![0]).toContain(`products/${product.id}?store=2`);
    expect(transport.mock.calls[0]![1]?.headers).toMatchObject({
      'X-CSRF-Token': 'context-session-csrf',
    });
    expect(transport.mock.calls[1]![0]).toBe('/api/v1/catalog/products/price-preview?store=2');
  });
  it('rejects malformed campaign and access/context answers', () => {
    expect(() =>
      decodeCampaign({ id: 'campaign', prices: [{ product: 'p', price: 'NaN' }] }),
    ).toThrow();
    expect(() =>
      decodeContext({
        storeId: 2,
        storeName: 'Магазин',
        effectiveDay: 'wrong',
        csrf: 'x',
        canManage: true,
        stores: [],
      }),
    ).toThrow();
  });
});

const campaign = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Акція',
  reason: 'Сезон',
  author: 'owner',
  startsOn: '2026-10-04',
  endsOn: '2026-10-08',
  active: true,
  archived: false,
  revision: 1,
  scope: 'stores',
  status: 'active',
  stores: [2],
  prices: [{ product: 'p', name: 'Кава', price: '20.00' }],
};
const access = {
  ...context,
  canManage: true,
  canViewHistory: true,
  canSelectNetwork: true,
  effectiveDay: '2026-10-04',
  csrf: 'synthetic',
  stores: [{ id: 2, name: 'Магазин' }],
};
it('rejects coerced enums, reversed or impossible dates, and unsafe identities', () => {
  expect(decodeCampaign(campaign)).toEqual(campaign);
  for (const extra of [
    { scope: ['stores'] },
    { status: ['active'] },
    { startsOn: '2026-10-09' },
    { endsOn: '2026-02-30' },
    { stores: [0] },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(() => decodeCampaign({ ...campaign, ...extra })).toThrow();
  expect(decodeContext(access)).toEqual(access);
  for (const extra of [
    { storeId: -2 },
    { storeId: Number.MAX_SAFE_INTEGER + 1 },
    { storeName: null },
    { stores: [{ id: 0, name: 'Магазин' }] },
  ])
    expect(() => decodeContext({ ...access, ...extra })).toThrow();
  const item = {
    id: 1,
    name: 'Кава',
    product: 'p',
    storeId: 2,
    before: { regularPrice: '30.00', salePrice: '30.00' },
    after: { regularPrice: '30.00', salePrice: '20.00' },
    author: 'owner',
    source: 'campaign',
    reason: 'Сезон',
    at: '2026-10-04T12:00:00Z',
  };
  const page = { page: 1, pages: 1, limit: 20, total: 1 };
  expect(decodeHistory({ ...page, items: [item] }).items).toEqual([item]);
  for (const extra of [{ id: 0 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { storeId: -1 }])
    expect(() => decodeHistory({ ...page, items: [{ ...item, ...extra }] })).toThrow();
});
