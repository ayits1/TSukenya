import { decimalKey, mergeEqual } from '../../shared/merge/threeWay';
import type { MergeField } from '../../shared/merge/threeWay';
import type { ProductCreate } from './api';

export type ProductDraft = Omit<Required<ProductCreate>, 'pricingRevision'>;
const labels = {
  name: 'Назва товару',
  type: 'Група',
  category: 'Категорія',
  pack: 'Пакування',
  size: 'Об’єм / вага',
  unit: 'Одиниця',
  barcode: 'Штрихкод',
  minStock: 'Мінімальний залишок',
  cost: 'Закупівля',
  markup: 'Націнка',
  manualPrice: 'Ручна ціна',
  price: 'Звичайна ручна ціна',
  promotion: 'Акція',
  promotionPrice: 'Акційна ціна',
  priceAt: 'Дата перевірки ціни',
  priceReviewed: 'Перевірено сьогодні',
};
const decimalFields = new Set<keyof ProductDraft>([
  'cost',
  'markup',
  'price',
  'promotionPrice',
  'minStock',
]);
function display(key: keyof ProductDraft, value: unknown): string {
  if (value == null || value === '') return 'Не задано';
  if (typeof value === 'boolean') return value ? 'Так' : 'Ні';
  if (
    decimalFields.has(key) &&
    typeof value === 'string' &&
    Number.isFinite(Number(value.replace(',', '.')))
  ) {
    const money = key === 'cost' || key === 'price' || key === 'promotionPrice';
    const amount = Number(value.replace(',', '.')).toLocaleString('uk-UA', {
      minimumFractionDigits: money ? 2 : 0,
      maximumFractionDigits: key === 'markup' ? 4 : key === 'minStock' ? 3 : 2,
    });
    return amount + (money ? ' грн' : key === 'markup' ? ' %' : '');
  }
  return String(value);
}
function group(id: string, label: string, keys: (keyof ProductDraft)[]): MergeField<ProductDraft> {
  return {
    id,
    label,
    read: (draft) => keys.map((key) => draft[key]),
    write: (target, source) => ({
      ...target,
      ...Object.fromEntries(keys.map((key) => [key, source[key]])),
    }),
    equal: (left, right) =>
      Array.isArray(left) &&
      Array.isArray(right) &&
      keys.every((key, index) =>
        mergeEqual(
          decimalFields.has(key) ? decimalKey(left[index]) : left[index],
          decimalFields.has(key) ? decimalKey(right[index]) : right[index],
        ),
      ),
    format: (value) =>
      Array.isArray(value)
        ? keys.map((key, index) => `${labels[key]}: ${display(key, value[index])}`).join('\n')
        : '',
  };
}
export const productMergeFields: MergeField<ProductDraft>[] = [
  ...(['name', 'pack', 'size', 'unit', 'barcode', 'minStock'] as const).map((key) =>
    group(key, labels[key], [key]),
  ),
  group('classification', 'Група та категорія', ['type', 'category']),
  group('pricing', 'Ціни та акція', [
    'cost',
    'markup',
    'manualPrice',
    'price',
    'promotion',
    'promotionPrice',
  ]),
  group('review', 'Перевірка ціни', ['priceAt', 'priceReviewed']),
];
