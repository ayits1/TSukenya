import { expect, test } from 'vitest';
import { decodePage, decodeProduct } from './api';
import { catalogPage, catalogProducts } from './fixtures';
test('decimal strings and role-redacted costs survive decoding', () => {
  const product = catalogProducts[0]!;
  expect(decodeProduct(product).salePrice).toBe('29.99');
  expect(decodeProduct(product).regularPrice).toBe('35.00');
  expect(decodeProduct(product).promotionPrice).toBe('29.99');
  expect(decodeProduct({ ...product, cost: null, markup: null }).cost).toBeNull();
  expect(decodePage(catalogPage).total).toBe(3);
});
test('rejects numeric money, missing revisions and malformed facets', () => {
  const product = catalogProducts[0]!;
  expect(() => decodeProduct({ ...product, cost: 12.5 })).toThrow();
  expect(() => decodeProduct({ ...product, regularPrice: undefined })).toThrow();
  expect(() => decodeProduct({ ...product, promotionPrice: 29.99 })).toThrow();
  expect(
    decodeProduct({ ...product, promotionPrice: null, salePrice: product.regularPrice })
      .promotionPrice,
  ).toBeNull();
  expect(() => decodeProduct({ ...product, minStock: undefined })).toThrow();
  expect(() => decodeProduct({ ...product, revision: undefined })).toThrow();
  expect(() =>
    decodePage({ ...catalogPage, facets: { type: [null], category: [], pack: [] } }),
  ).toThrow();
  expect(() => decodePage({ ...catalogPage, page: 0 })).toThrow();
});
