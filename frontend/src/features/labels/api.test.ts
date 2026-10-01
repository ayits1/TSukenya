import { describe, expect, it } from 'vitest';
import { decodeWorkspace, decodeProof } from './api';
import { defaultConfig } from './domain';
import { catalogProducts } from '../catalog/fixtures';

const workspace = () => ({
  config: defaultConfig(),
  settings: { chainName: 'Цукерня', storeNames: ['Київ'], staleDays: 30 },
  revision: 'layout-revision',
  canEdit: true,
  csrf: 'isolated-csrf',
});
describe('Label network boundary', () => {
  it('migrates legacy point sizes once and warns about future layouts', () => {
    expect(
      decodeWorkspace({ ...workspace(), config: { size: 'm', styles: { price: { size: 22 } } } })
        .config.styles.price?.size,
    ).toBe(27.5);
    expect(
      decodeWorkspace({
        ...workspace(),
        config: { ...defaultConfig(), size: 'm', styles: { price: { size: 27.5 } } },
      }).config.styles.price?.size,
    ).toBe(27.5);
    expect(
      decodeWorkspace({ ...workspace(), config: { ...defaultConfig(), styleVersion: 3 } }).warnings
        .length,
    ).toBeGreaterThan(0);
    expect(() =>
      decodeWorkspace({ ...workspace(), settings: { storeNames: ['Київ'], staleDays: 30 } }),
    ).toThrow();
  });
  it('requires a bounded matching selection and decimal string products', () => {
    const product = catalogProducts[0]!;
    const valid = {
      ...workspace(),
      products: [product],
      selection: [{ id: product.id, quantity: 22 }],
      date: '2026-10-01',
      snapshot: 'print-snapshot',
    };
    expect(decodeProof(valid).selection[0]?.quantity).toBe(22);
    for (const invalid of [
      { ...valid, selection: [{ id: product.id, quantity: 501 }] },
      { ...valid, selection: [{ id: 'other', quantity: 1 }] },
      { ...valid, products: [{ ...product, salePrice: 45 }] },
      { ...valid, snapshot: '' },
    ])
      expect(() => decodeProof(invalid)).toThrow();
  });
});
