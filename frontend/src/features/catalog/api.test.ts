import { expect, test } from 'vitest';
import { decodePage, decodeProduct, decodeReferences, referenceKey } from './api';
import { catalogPage, catalogProducts } from './fixtures';
test('reference boundary rejects unknown fields, missing parent metadata and repeated ids', () => {
  expect(referenceKey('  НАПОЇ  без   цукру ')).toBe(referenceKey('Напої без цукру'));
  const reference = { id: 'group-1', field: 'type', value: 'Напої', parentType: '' };
  expect(decodeReferences({ items: [reference], canEdit: true }).items[0]?.value).toBe('Напої');
  for (const invalid of [
    { ...reference, field: 'anything' },
    { ...reference, value: '' },
    { ...reference, parentType: undefined },
  ])
    expect(() => decodeReferences({ items: [invalid], canEdit: true })).toThrow();
  expect(() => decodeReferences({ items: [reference, reference], canEdit: true })).toThrow();
});
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

test('expiry threshold preserves explicit zero and rejects non-integer or coerced values', () => {
  const product = catalogProducts[0]!;
  expect(decodeProduct({ ...product, expiryAlertDays: 0 }).expiryAlertDays).toBe(0);
  expect(decodeProduct({ ...product, expiryAlertDays: null }).expiryAlertDays).toBeNull();
  expect(decodeProduct({ ...product, expiryAlertDays: 3650 }).expiryAlertDays).toBe(3650);
  for (const expiryAlertDays of [true, '7', 7.5, -1, 3651, [7], {}])
    expect(() => decodeProduct({ ...product, expiryAlertDays })).toThrow();
});
