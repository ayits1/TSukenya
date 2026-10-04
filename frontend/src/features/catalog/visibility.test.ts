import { afterEach, expect, test, vi } from 'vitest';
import { createCatalogApi, decodePage, decodeProduct, emptyFilters } from './api';
import { catalogPage, catalogProducts } from './fixtures';
const product = catalogProducts[0]!;
afterEach(() => vi.unstubAllGlobals());
test('visibility DTO rejects coerced state, missing permissions and cross-mode pages', () => {
  for (const hidden of [undefined, 1, 'true', [], null])
    expect(() => decodeProduct({ ...product, hidden })).toThrow();
  expect(() => decodeProduct({ ...product, canEdit: undefined })).toThrow();
  expect(() => decodePage({ ...catalogPage, visibility: 'hidden' }, 'hidden')).toThrow();
  expect(() =>
    decodePage({ ...catalogPage, visibility: 'hidden', items: [{ ...product, hidden: true }] }),
  ).toThrow();
  expect(
    decodePage(
      { ...catalogPage, visibility: 'hidden', items: [{ ...product, hidden: true }] },
      'hidden',
    ).items[0]?.hidden,
  ).toBe(true);
});
test('metadata request has only frozen revision/state and validates ACK identity/state', async () => {
  const transport = vi.fn(async (...args: Parameters<typeof fetch>) => {
    void args;
    return Response.json({ ...product, hidden: true, revision: 'new-revision' });
  });
  vi.stubGlobal('fetch', transport);
  await createCatalogApi(undefined, 'isolated').visibility(product, true);
  expect(transport.mock.calls[0]?.[0]).toBe(`/api/v1/catalog/products/${product.id}/visibility`);
  expect(JSON.parse((transport.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
    revision: product.revision,
    hidden: true,
  });
  for (const invalid of [
    { ...product, hidden: false },
    { ...product, hidden: true, id: 'other' },
    { ...product, hidden: true, canEdit: false },
    { ...product, hidden: true },
    { ...product, hidden: true, revision: 'different', cost: '999' },
  ]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(invalid)),
    );
    await expect(
      createCatalogApi(undefined, 'isolated').visibility(product, true),
    ).rejects.toThrow();
  }
});
test('hidden recovery opts in without changing default lookup and rejects unrelated identity', async () => {
  const transport = vi.fn(async (...args: Parameters<typeof fetch>) => {
    void args;
    return Response.json({ ...product, hidden: true });
  });
  vi.stubGlobal('fetch', transport);
  const api = createCatalogApi();
  await api.product(product.id, true);
  await api.product(product.id);
  expect(String(transport.mock.calls[0]?.[0])).toContain('?includeHidden=true');
  expect(String(transport.mock.calls[1]?.[0])).not.toContain('includeHidden');
  await expect(api.product('other', true)).rejects.toThrow();
});
test('list binds hidden requested mode to decoded response', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(catalogPage)),
  );
  await expect(
    createCatalogApi().list({ ...emptyFilters, visibility: 'hidden' }),
  ).rejects.toThrow();
});
