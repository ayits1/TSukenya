import { referenceFields, type Product, type ProductPage, type ReferenceData } from './api';
import type { PricePreview, PricePreviewRequest } from './api';
/** Synthetic editor service; live calculations are tested against Django. */
export async function fixturePricePreview(input: PricePreviewRequest): Promise<PricePreview> {
  return {
    regularPrice: input.manualPrice && input.price ? input.price : '35.00',
    salePrice:
      input.promotion && input.promotionPrice
        ? input.promotionPrice
        : input.manualPrice && input.price
          ? input.price
          : '35.00',
    config: { markup: '30', rounding: '.5' },
    pricingRevision: 'synthetic-pricing',
    warnings: [],
    promotionValid: !!input.promotion && !!input.promotionPrice,
    effectivePromotion: null,
    effectiveDay: '2026-10-04',
    effectivePriceRevision: 'f'.repeat(64),
    priceContext: { storeId: null, storeName: null },
  };
}
export const catalogProducts: Product[] = [
  {
    id: 'sample-1',
    hidden: false,
    canEdit: true,
    revision: 'synthetic-1',
    name: 'Кава Американо',
    type: 'Напої',
    category: 'Кава',
    pack: 'Стакан',
    size: '200 мл',
    unit: 'шт',
    barcode: '',
    cost: '12.50',
    markup: '30',
    price: '35',
    regularPrice: '35.00',
    promotionPrice: '29.99',
    salePrice: '29.99',
    manualPrice: true,
    promotion: true,
    priceAt: '2026-10-01',
    minStock: '0',
  },
  {
    id: 'sample-2',
    hidden: false,
    canEdit: true,
    revision: 'synthetic-2',
    name: 'Шоколад із фундуком та карамеллю в подарунковому пакуванні, обмежена серія',
    type: 'Цукерки',
    category: 'Шоколад',
    pack: 'Коробка',
    size: '300 г',
    unit: 'шт',
    barcode: '',
    cost: '105',
    markup: '30',
    price: null,
    regularPrice: '136.50',
    promotionPrice: null,
    salePrice: '136.50',
    manualPrice: false,
    promotion: false,
    priceAt: '',
    minStock: '5',
  },
  {
    id: 'sample-3',
    hidden: false,
    canEdit: true,
    revision: 'synthetic-3',
    name: 'Новий товар без ціни',
    type: '',
    category: '',
    pack: '',
    size: '',
    unit: 'шт',
    barcode: '',
    cost: '0',
    markup: '30',
    price: null,
    regularPrice: '0.00',
    promotionPrice: null,
    salePrice: '0.00',
    manualPrice: false,
    promotion: false,
    priceAt: '',
    minStock: '0',
  },
];
export const catalogPage: ProductPage = {
  visibility: 'active',
  items: catalogProducts,
  total: 3,
  page: 1,
  pages: 1,
  limit: 20,
  facets: {
    type: ['Напої', 'Цукерки'],
    category: ['Кава', 'Шоколад'],
    pack: ['Стакан', 'Коробка'],
  },
  canEdit: true,
  defaultMarkup: '30',
};
export const catalogReferences: ReferenceData = {
  canEdit: true,
  items: catalogProducts
    .flatMap((product, index) =>
      referenceFields
        .filter((field) => product[field])
        .map((field) => ({
          id: `fixture-${index}-${field}`,
          field,
          value: product[field],
          parentType: field === 'category' ? product.type : '',
        })),
    )
    .filter(
      (item, index, items) =>
        items.findIndex(
          (other) =>
            other.field === item.field &&
            other.value === item.value &&
            other.parentType === item.parentType,
        ) === index,
    ),
};
