import { expect, test } from 'vitest';
import { compareThreeWay, resolveThreeWay } from '../../shared/merge/threeWay';
import { productMergeFields } from './productMerge';
import type { ProductDraft } from './productMerge';

const base: ProductDraft = {
  name: 'Кава',
  type: 'Напої',
  category: 'Кава',
  pack: 'Стакан',
  size: '200 мл',
  unit: 'шт',
  barcode: '',
  minStock: '0',
  expiryAlertDays: '',
  cost: '10.01',
  markup: '30',
  manualPrice: false,
  price: null,
  promotion: false,
  promotionPrice: null,
  priceAt: '',
  priceReviewed: false,
};
test('server name and local pack both survive with a fresh baseline', () => {
  const mine = { ...base, pack: 'Коробка' },
    server = { ...base, name: 'Кава зернова' };
  expect(resolveThreeWay(base, mine, server, productMergeFields, {})).toEqual({
    ...server,
    pack: 'Коробка',
  });
});
test('pricing and parent category groups never silently mix versions', () => {
  for (const [mine, server, group] of [
    [{ ...base, cost: '11.00' }, { ...base, promotion: true, promotionPrice: '9.99' }, 'pricing'],
    [{ ...base, type: 'Цукерки', category: '' }, { ...base, category: 'Чай' }, 'classification'],
  ] as const) {
    expect(
      compareThreeWay(base, mine, server, productMergeFields).find((row) => row.id === group)
        ?.status,
    ).toBe('conflict');
    expect(resolveThreeWay(base, mine, server, productMergeFields, {})).toBeNull();
    expect(resolveThreeWay(base, mine, server, productMergeFields, { [group]: 'mine' })).toEqual(
      mine,
    );
  }
});
test('numeric spellings and transient review intent do not corrupt the merge', () => {
  expect(
    compareThreeWay(
      base,
      { ...base, cost: '010,010', markup: '30.0000' },
      { ...base, cost: '10.01', markup: '30.0' },
      productMergeFields,
    ),
  ).toEqual([]);
  const merged = resolveThreeWay(
    base,
    { ...base, priceReviewed: true },
    { ...base, pack: 'Коробка' },
    productMergeFields,
    {},
  );
  expect(merged).toEqual({ ...base, pack: 'Коробка', priceReviewed: true });
});
