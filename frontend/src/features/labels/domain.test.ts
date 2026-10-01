import { describe, expect, it } from 'vitest';
import {
  adaptLabelProduct,
  adaptLabelSettings,
  buildPrintPages,
  decodeLabelConfig,
  defaultConfig,
  fieldStyle,
  labelConfigWarnings,
  labelCopies,
  pageGeometry,
  printIssues,
  tagParts,
} from './domain';

const product = adaptLabelProduct({
  id: 'synthetic',
  name: 'Карамель',
  pack: 'Ваговий',
  unit: 'кг',
  category: 'Цукерки',
  size: '250',
  salePrice: '150.50',
  regularPrice: '180.00',
  priceAt: '2026-10-01',
  promotion: true,
});
const settings = adaptLabelSettings({
  chainName: 'Цукерня',
  storeNames: ['Магазин №1'],
  staleDays: 30,
});
const date = new Date(2026, 9, 1, 12);

describe('physical label domain', () => {
  it('migrates saved old point sizes exactly once, preserving version 2 values', () => {
    const old = decodeLabelConfig({
      size: 'l',
      styles: {
        name: { size: 10, font: 'georgia', color: '#abcdef', align: 'center', weight: '700' },
      },
    });
    expect(old.styles.name?.size).toBe(16.5);
    expect(decodeLabelConfig(old)).toEqual(old);
    expect(fieldStyle(old, 'name')).toEqual({
      size: 16.5,
      font: 'georgia',
      color: '#abcdef',
      align: 'center',
      weight: '700',
    });
    expect(
      fieldStyle(
        decodeLabelConfig({ size: 'm', styleVersion: 2, styles: { price: { size: 30 } } }),
        'price',
      ).size,
    ).toBe(30);
    expect(fieldStyle(decodeLabelConfig({ size: 'l' }), 'price').size).toBe(36.3);
  });
  it('keeps toggles/custom text and normalizes invalid persisted styles safely', () => {
    const config = decodeLabelConfig({
      custom: 'Новинка',
      customEnabled: false,
      name: false,
      kop: true,
      styles: {
        price: { size: Infinity, font: 'bad', color: 'url(foo)', weight: 'heavy', align: 'start' },
      },
    });
    expect(config.custom).toBe('Новинка');
    expect(config.customEnabled).toBe(false);
    expect(config.name).toBe(false);
    expect(config.kop).toBe(true);
    expect(fieldStyle(config, 'price')).toEqual(fieldStyle(defaultConfig(), 'price'));
    expect(
      fieldStyle(decodeLabelConfig({ styleVersion: 2, styles: { price: { size: 100 } } }), 'price')
        .size,
    ).toBe(72);
  });
  it('renders supplied sale price, promotion, volume, unit and date', () => {
    const parts = tagParts(product, defaultConfig(), settings, date);
    expect(parts.chain).toBe('Цукерня');
    expect(parts.store).toBe('Магазин №1');
    expect(parts.promo).toBe('Акція');
    expect(parts.price).toBe('150,50');
    expect(parts.oldPrice).toBe('180,00 грн');
    expect(
      tagParts({ ...product, promotion: false }, defaultConfig(), settings, date).oldPrice,
    ).toBe('');
    expect(
      tagParts(product, { ...defaultConfig(), oldPrice: false }, settings, date).oldPrice,
    ).toBe('');
    expect(parts.per100).toBe('100 г — 15,05 грн');
    expect(parts.psize).toBe('вага 250 г');
    expect(parts.unit).toBe('грн за 1 кг');
    expect(parts.date).toBe('01.10.2026');
    expect(tagParts({ ...product, promotion: false }, defaultConfig(), settings, date).promo).toBe(
      '',
    );
    expect(
      tagParts(
        product,
        { ...defaultConfig(), promo: false, price: false, psize: false },
        settings,
        date,
      ),
    ).toMatchObject({ promo: '', price: '', psize: '' });
    expect(tagParts({ ...product, salePrice: 150 }, defaultConfig(), settings, date).price).toBe(
      '150',
    );
    expect(
      tagParts({ ...product, salePrice: 150 }, { ...defaultConfig(), kop: true }, settings, date)
        .price,
    ).toBe('150,00');
  });
  it('adapts decimal contracts without calculating financial prices and preserves store indices', () => {
    expect(
      adaptLabelProduct({ cost: 10, markup: 30, price: 13, manualPrice: true }).salePrice,
    ).toBe(0);
    expect(adaptLabelProduct({ cost: 10 }, 13.5).salePrice).toBe(13.5);
    expect(adaptLabelProduct({ salePrice: NaN }).salePrice).toBe(0);
    expect(adaptLabelSettings({ storeNames: [null, 'Другий магазин'] }).storeNames).toEqual([
      '',
      'Другий магазин',
    ]);
    expect(
      tagParts(
        adaptLabelProduct({ size: '0,5', pack: 'ПЕТ', unit: '100 г' }),
        defaultConfig(),
        settings,
        date,
      ),
    ).toMatchObject({ pack: 'Пляшка ПЕТ', psize: 'об’єм 0,5 л', unit: 'грн за 100 г' });
  });
  it('preserves A4 millimetres, padding and page capacities for every supported format', () => {
    expect(pageGeometry(defaultConfig())).toEqual({
      width: 58,
      height: 40,
      columns: 3,
      rows: 7,
      perSheet: 21,
      pageWidth: 210,
      pageHeight: 297,
      margin: 8,
    });
    expect(pageGeometry({ size: 'm' })).toMatchObject({
      width: 75,
      height: 50,
      columns: 2,
      rows: 5,
      perSheet: 10,
    });
    expect(pageGeometry({ size: 'l' })).toMatchObject({
      width: 100,
      height: 70,
      columns: 1,
      rows: 4,
      perSheet: 4,
    });
    const copies = Array.from({ length: 22 }, () => product);
    expect(buildPrintPages(copies, defaultConfig()).map((page) => page.length)).toEqual([21, 1]);
    expect(buildPrintPages([], defaultConfig())).toEqual([]);
    expect(() =>
      buildPrintPages(
        Array.from({ length: 1001 }, () => product),
        defaultConfig(),
      ),
    ).toThrow(/1000/);
  });
  it('distinguishes missing price blockers and stale-date warnings without duplicating copies', () => {
    const missing = { ...product, name: 'Без ціни', salePrice: 0 };
    const undated = { ...product, name: 'Без дати', priceAt: '' };
    const stale = { ...product, name: 'Стара ціна', priceAt: '2026-08-01' };
    expect(printIssues([product, missing, missing, undated, stale], settings, date)).toEqual({
      noPrice: ['Без ціни'],
      stale: ['Без дати', 'Стара ціна'],
      overLimit: false,
      incompletePromotion: ['Без ціни'],
    });
    expect(
      printIssues(
        Array.from({ length: 1001 }, () => product),
        settings,
        date,
      ).overLimit,
    ).toBe(true);
  });
  it('does not invent old prices for badge-only promotions and blocks ambiguous print output', () => {
    const legacy = adaptLabelProduct({
      name: 'Стара позначка',
      promotion: true,
      salePrice: '45.00',
    });
    expect(tagParts(legacy, defaultConfig(), settings, date).oldPrice).toBe('');
    expect(printIssues([legacy], settings, date).incompletePromotion).toEqual(['Стара позначка']);
    expect(decodeLabelConfig({ styleVersion: 2 }).oldPrice).toBe(true);
    expect(labelConfigWarnings({ oldPrice: true, styles: { oldPrice: { size: 9 } } })).toEqual([]);
  });
  it('rejects invalid print quantities before expanding and flags newer layout properties', () => {
    expect(labelCopies([product], { synthetic: 22 })).toHaveLength(22);
    expect(() => labelCopies([product], { synthetic: 0 })).toThrow(/1 до 500/);
    expect(() => labelCopies([product], { synthetic: 1.5 })).toThrow(/цілим/);
    expect(() => labelCopies([product], { synthetic: NaN })).toThrow(/цілим/);
    expect(() =>
      labelCopies([product, { ...product, id: 'second' }, { ...product, id: 'third' }], {
        synthetic: 500,
        second: 500,
        third: 1,
      }),
    ).toThrow(/1000/);
    expect(labelConfigWarnings(defaultConfig())).toEqual([]);
    expect(
      labelConfigWarnings({ styleVersion: 3, styles: { name: { rotation: 90 }, barcode: {} } }),
    ).toEqual([
      'Макет має непідтримувану версію. Перевірте його перед збереженням.',
      'Непідтримуваний стиль: name.rotation.',
      'Непідтримуваний елемент макета: barcode.',
    ]);
  });
});
