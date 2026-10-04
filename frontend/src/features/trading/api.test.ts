import { describe, expect, it, vi } from 'vitest';
import {
  createTradingApi,
  decodeDirectoryDetails,
  decodeDirectoryItem,
  decodeDirectoryPage,
  decodeTradingBootstrap,
} from './api';
const bootstrap = {
  csrf: 'isolated-token',
  defaultCategoryId: '',
  role: 'manager',
  username: 'qa',
  storeId: 1,
  defaultStoreId: 1,
  canViewAudit: false,
  closed_through: null,
  fiscal_required: false,
  max_discount: '10.000',
};
describe('bounded trading read contracts', () => {
  it('rejects malformed typed IDs, optional money, pages and duplicate batch results', () => {
    for (const value of [
      { id: [], name: 'QA' },
      { id: 'a/b', name: 'QA' },
      { id: '1', name: 'QA', active: ['true'] },
      { id: '1', name: 'QA', salePrice: 1.23 },
      { id: '1', name: 'QA', bonus_basis: 'unknown' },
      { id: '1', name: 'QA', gsBase: { secret: true } },
    ])
      expect(() => decodeDirectoryItem(value)).toThrow();
    expect(() =>
      decodeDirectoryPage({
        items: Array.from({ length: 31 }, () => ({ id: '1', name: 'QA' })),
        page: 1,
        pages: 1,
        total: 31,
        limit: 30,
      }),
    ).toThrow();
    expect(() =>
      decodeDirectoryDetails({
        items: [{ type: 'employees', id: '2', name: 'QA' }],
        unavailable: [{ type: 'employees', id: '2' }],
      }),
    ).toThrow();
    expect(() =>
      decodeDirectoryDetails({
        items: [{ type: ['employees'], id: '2', name: 'QA' }],
        unavailable: [],
      }),
    ).toThrow();
    expect(() => decodeTradingBootstrap({ ...bootstrap, role: ['manager'] })).toThrow();
  });
  it('bootstraps CSRF without a full legacy read and sends a clearly read-only selected batch', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(bootstrap)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ type: 'products', id: 'p', name: 'QA', salePrice: '13.00' }],
            unavailable: [],
          }),
        ),
      );
    const api = createTradingApi(transport);
    await api.details([{ type: 'products', id: 'p' }], { store: 1 });
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/trading/bootstrap',
      '/api/v1/trading/directories/details',
    ]);
    const request = transport.mock.calls[1]?.[1];
    expect(request?.method).toBe('POST');
    expect(request?.headers).toMatchObject({ 'X-CSRF-Token': 'isolated-token' });
    expect(JSON.parse(String(request?.body))).toEqual({
      ids: [{ type: 'products', id: 'p' }],
      store: 1,
    });
  });
  it('passes server query and resolves only current store price strings', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [{ id: 'p', name: 'QA', salePrice: '10.01', regularPrice: '13.00' }],
          page: 1,
          pages: 1,
          total: 1,
          limit: 30,
        }),
      ),
    );
    const result = await createTradingApi(transport).lookup('barcode', '012345', 2);
    expect(result.items[0]?.salePrice).toBe('10.01');
    expect(transport.mock.calls[0]?.[0]).toContain('store=2');
  });
});
