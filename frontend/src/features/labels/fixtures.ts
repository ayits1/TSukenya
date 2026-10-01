import { defaultConfig } from './domain';
import type { LabelProduct, LabelSettings } from './domain';

export const studioProducts: LabelProduct[] = [
  {
    id: 'demo-americano',
    name: 'Американо',
    type: 'Кав’ярня',
    category: 'Кава',
    pack: 'Стакан',
    size: '200 мл',
    unit: 'шт',
    salePrice: 35,
    priceAt: '2026-10-01',
    promotion: false,
  },
  {
    id: 'demo-chocolate',
    name: 'Шоколад молочний з карамеллю та лісовими горіхами, 90 г',
    type: 'Солодощі',
    category: 'Шоколад',
    pack: 'Штучно',
    size: '90 г',
    unit: 'шт',
    salePrice: 79.5,
    priceAt: '2026-10-01',
    promotion: true,
  },
  {
    id: 'demo-water',
    name: 'Вода мінеральна негазована 0,5 л',
    type: 'Напої',
    category: 'Вода',
    pack: 'ПЕТ',
    size: '0.5',
    unit: 'шт',
    salePrice: 0,
    priceAt: '',
    promotion: false,
  },
];
export const studioSettings: LabelSettings = {
  chainName: 'Цукерня',
  storeNames: ['Магазин на Шевченка'],
  staleDays: 30,
};
export const studioConfig = {
  ...defaultConfig(),
  size: 'm' as const,
  chain: true,
  store: false,
  pack: false,
  psize: false,
  category: false,
  date: false,
  per100: false,
  styles: { chain: { color: '#707070' }, price: { size: 30 }, name: { size: 13 } },
};
