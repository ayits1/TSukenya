/** Physical label layouts retain the version 2 format used by the original portal. */
export const LABEL_FIELDS = [
  ['promo', 'Акція'],
  ['chain', 'Назва мережі'],
  ['store', 'Назва магазину'],
  ['name', 'Назва товару'],
  ['pack', 'Тип пакування'],
  ['psize', 'Об’єм / вага'],
  ['price', 'Ціна'],
  ['oldPrice', 'Стара ціна'],
  ['unit', 'Одиниця продажу'],
  ['per100', 'Ціна за 100 г'],
  ['category', 'Категорія'],
  ['date', 'Дата'],
  ['custom', 'Додатковий напис'],
] as const;
export type LabelField = (typeof LABEL_FIELDS)[number][0];
export type FieldKey = LabelField;
export const FIELD_LABELS = Object.fromEntries(LABEL_FIELDS) as Record<LabelField, string>;
export type LabelSize = 's' | 'm' | 'l';
export type LabelFont = 'rubik' | 'arial' | 'georgia' | 'courier';
export type LabelStyle = {
  font: LabelFont;
  size: number;
  color: string;
  weight: '400' | '600' | '700';
  align: 'left' | 'center' | 'right';
};
export type LabelConfig = {
  size: LabelSize;
  border: 'dash' | 'solid' | 'none';
  styleVersion: 2;
  chain: boolean;
  store: boolean;
  storeIdx: number;
  name: boolean;
  nameBig: boolean;
  pack: boolean;
  psize: boolean;
  price: boolean;
  oldPrice: boolean;
  kop: boolean;
  unit: boolean;
  per100: boolean;
  category: boolean;
  date: boolean;
  custom: string;
  customEnabled: boolean;
  promo: boolean;
  styles: Partial<Record<LabelField, Partial<LabelStyle>>>;
};
export type LabelProduct = {
  id: string;
  name: string;
  type: string;
  category: string;
  pack: string;
  size: string;
  unit: string;
  salePrice: number;
  regularPrice?: number;
  priceAt: string;
  promotion: boolean;
};
export type LabelSettings = { chainName: string; storeNames: string[]; staleDays: number };
export const LABEL_SIZES = { s: [58, 40], m: [75, 50], l: [100, 70] } as const;
export const TAG_SIZES = {
  s: [58, 40, '58 × 40 мм'],
  m: [75, 50, '75 × 50 мм'],
  l: [100, 70, '100 × 70 мм'],
} as const;
export const FONT_OPTIONS = [
  { value: 'rubik', label: 'Rubik' },
  { value: 'arial', label: 'Arial' },
  { value: 'georgia', label: 'Georgia' },
  { value: 'courier', label: 'Courier' },
] as const;
export const LABEL_FONTS: Record<LabelFont, string> = {
  rubik: 'Rubik,Arial,sans-serif',
  arial: 'Arial,sans-serif',
  georgia: 'Georgia,serif',
  courier: 'Courier New,monospace',
};
export const DEFAULT_LABEL_CONFIG: LabelConfig = {
  size: 's',
  border: 'dash',
  styleVersion: 2,
  chain: true,
  store: true,
  storeIdx: 0,
  name: true,
  nameBig: false,
  pack: true,
  psize: true,
  price: true,
  oldPrice: true,
  kop: false,
  unit: true,
  per100: true,
  category: true,
  date: true,
  custom: '',
  customEnabled: true,
  promo: true,
  styles: {},
};
export const defaultConfig = (): LabelConfig => ({ ...DEFAULT_LABEL_CONFIG, styles: {} });
const freshPresetConfig = (): LabelConfig => ({
  ...defaultConfig(),
  styles: Object.fromEntries(
    ['chain', 'store', 'category', 'date'].map((key) => [key, { color: '#707070' }]),
  ),
});
export const LABEL_PRESETS = [
  {
    id: 'classic',
    name: 'Класичний',
    description: 'Назва, ціна та інформація про товар',
    config: freshPresetConfig(),
  },
  {
    id: 'minimal',
    name: 'Лаконічний',
    description: 'Лише потрібне для покупця',
    config: {
      ...freshPresetConfig(),
      chain: false,
      store: false,
      category: false,
      date: false,
      pack: false,
    },
  },
  {
    id: 'promotion',
    name: 'Акційний',
    description: 'Помітна позначка для акційних товарів',
    config: {
      ...freshPresetConfig(),
      border: 'solid' as const,
      chain: false,
      store: false,
      styles: {
        ...freshPresetConfig().styles,
        promo: { size: 11, weight: '700' as const, color: '#9A3412' },
      },
    },
  },
] as const;
const STYLE_DEFAULTS: Record<
  LabelField,
  readonly [number, string, LabelStyle['weight'], LabelStyle['align']]
> = {
  promo: [8, '#9A3412', '700', 'left'],
  chain: [7, '#707070', '400', 'left'],
  store: [7, '#707070', '400', 'right'],
  custom: [8, '#c2185b', '700', 'left'],
  name: [10, '#1c1c1c', '600', 'left'],
  pack: [7.5, '#555555', '400', 'left'],
  psize: [7.5, '#555555', '400', 'left'],
  price: [22, '#1c1c1c', '700', 'left'],
  oldPrice: [8, '#707070', '400', 'right'],
  unit: [8, '#444444', '400', 'left'],
  per100: [8, '#444444', '400', 'left'],
  category: [7, '#707070', '400', 'left'],
  date: [7, '#707070', '400', 'right'],
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const numeric = (value: unknown, fallback = 0) => {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value.replace(',', '.'))
        : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const scale = (size: LabelSize) => (size === 'l' ? 1.65 : size === 'm' ? 1.25 : 1);
export const clampFontSize = (value: unknown) => Math.max(5, Math.min(72, numeric(value, 5)));
/** Check before decoding newer or malformed layouts, so unsupported saved fields are visible. */
export function labelConfigWarnings(value: unknown): string[] {
  const raw = record(value),
    warnings: string[] = [];
  if (raw.styleVersion != null && raw.styleVersion !== 1 && raw.styleVersion !== 2)
    warnings.push('Макет має непідтримувану версію. Перевірте його перед збереженням.');
  const knownKeys = new Set(Object.keys(DEFAULT_LABEL_CONFIG));
  for (const key of Object.keys(raw))
    if (!knownKeys.has(key)) warnings.push(`Непідтримуваний параметр макета: ${key}.`);
  const fieldKeys = new Set<string>(LABEL_FIELDS.map(([key]) => key));
  for (const [key, entry] of Object.entries(record(raw.styles))) {
    if (!fieldKeys.has(key)) {
      warnings.push(`Непідтримуваний елемент макета: ${key}.`);
      continue;
    }
    const style = record(entry);
    for (const property of Object.keys(style))
      if (!['font', 'size', 'color', 'weight', 'align'].includes(property))
        warnings.push(`Непідтримуваний стиль: ${key}.${property}.`);
  }
  return warnings;
}
/** Defensive decoding preserves valid saved settings, migrating scaled v1 point sizes once. */
export function decodeLabelConfig(value: unknown): LabelConfig {
  const raw = record(value);
  const size: LabelSize = raw.size === 'm' || raw.size === 'l' ? raw.size : 's';
  const result = { ...DEFAULT_LABEL_CONFIG, size, styles: {} };
  for (const [key] of LABEL_FIELDS) {
    const property = key === 'custom' ? 'customEnabled' : key;
    if (typeof raw[property] === 'boolean') result[property] = raw[property];
  }
  result.border = raw.border === 'none' || raw.border === 'solid' ? raw.border : 'dash';
  result.storeIdx = Math.max(0, Math.floor(numeric(raw.storeIdx)));
  result.custom = text(raw.custom).slice(0, 40);
  result.nameBig = raw.nameBig === true;
  result.kop = raw.kop === true;
  const styles: LabelConfig['styles'] = {};
  for (const [key] of LABEL_FIELDS) {
    const style = record(record(raw.styles)[key]);
    const decoded: Partial<LabelStyle> = {};
    if (
      style.font === 'rubik' ||
      style.font === 'arial' ||
      style.font === 'georgia' ||
      style.font === 'courier'
    )
      decoded.font = style.font;
    if (style.size != null && Number.isFinite(numeric(style.size, NaN)))
      decoded.size = clampFontSize(
        numeric(style.size) * (raw.styleVersion === 2 ? 1 : scale(size)),
      );
    if (typeof style.color === 'string' && /^#[0-9a-f]{6}$/i.test(style.color))
      decoded.color = style.color;
    if (
      String(style.weight) === '400' ||
      String(style.weight) === '600' ||
      String(style.weight) === '700'
    )
      decoded.weight = String(style.weight) as LabelStyle['weight'];
    if (style.align === 'left' || style.align === 'center' || style.align === 'right')
      decoded.align = style.align;
    if (Object.keys(decoded).length) styles[key] = decoded;
  }
  return { ...result, styles };
}
/** The boundary supplies the authoritative sale price; this module never calculates a markup. */
export function adaptLabelProduct(value: unknown, salePrice?: number): LabelProduct {
  const raw = record(value);
  return {
    id: text(raw.id),
    name: text(raw.name),
    type: text(raw.type),
    category: text(raw.category),
    pack: text(raw.pack),
    size: typeof raw.size === 'number' ? String(raw.size) : text(raw.size),
    unit: text(raw.unit) || 'шт',
    salePrice: numeric(salePrice ?? raw.salePrice),
    regularPrice: numeric(raw.regularPrice, numeric(salePrice ?? raw.salePrice)),
    priceAt: text(raw.priceAt),
    promotion: raw.effectivePromotion != null || raw.promotion === true,
  };
}
export function adaptLabelSettings(value: unknown): LabelSettings {
  const raw = record(value);
  return {
    chainName: text(raw.chainName) || 'Мережа солодощів',
    storeNames: Array.isArray(raw.storeNames) ? raw.storeNames.map(text) : [],
    staleDays: Math.max(1, numeric(raw.staleDays, 30)),
  };
}
export function fieldStyle(config: LabelConfig, key: LabelField): LabelStyle {
  const raw = config.styles[key] ?? {},
    def = STYLE_DEFAULTS[key];
  return {
    font: raw.font ?? 'rubik',
    size: clampFontSize(
      raw.size ?? (key === 'name' && config.nameBig ? 12.5 : def[0]) * scale(config.size),
    ),
    color: raw.color ?? def[1],
    weight: raw.weight ?? def[2],
    align: raw.align ?? def[3],
  };
}
/**
 * Store only the edited properties on top of the saved override. A computed style must not be
 * written back: its default point size depends on the format and would stop scaling.
 */
export const withFieldStyle = (
  config: LabelConfig,
  key: LabelField,
  patch: Partial<LabelStyle>,
): LabelConfig => ({
  ...config,
  styles: { ...config.styles, [key]: { ...config.styles[key], ...patch } },
});
export const fieldVisible = (config: LabelConfig, key: LabelField) =>
  key === 'custom' ? config.customEnabled : config[key];
export const formatLabelMoney = (value: number, decimals = true) =>
  (Math.round(value * 100) / 100).toLocaleString('uk-UA', {
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  });
/**
 * Price of 100 g for a per-kilogram price, in kopecks, rounded half up from the exact decimal.
 * Number → String returns the shortest decimal that round-trips, i.e. the server's decimal string,
 * so no binary float division is involved. Returns null for negative or malformed values.
 */
export function per100Kopecks(price: number | string): number | null {
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(String(price).trim());
  if (!match) return null;
  const fraction = match[2] ?? '';
  // price × 100 kopecks ÷ 10: keep one fraction digit in the whole part, round on the next one.
  const digits = match[1]! + fraction;
  const kept = digits.length - Math.max(0, fraction.length - 1);
  const whole = Number(digits.slice(0, kept) + '0'.repeat(Math.max(0, 1 - fraction.length)));
  return whole + (Number(digits[kept] ?? '0') >= 5 ? 1 : 0);
}
/** Exact kopecks as Ukrainian money text, e.g. 1001 → "10,01". */
export const formatKopecks = (kopecks: number) =>
  `${Math.floor(kopecks / 100).toLocaleString('uk-UA')},${String(kopecks % 100).padStart(2, '0')}`;
export const formatPer100 = (price: number | string) => {
  const kopecks = per100Kopecks(price);
  return kopecks === null ? '' : formatKopecks(kopecks);
};
export const hasPromotionPrice = (product: LabelProduct) =>
  product.promotion && product.salePrice > 0 && (product.regularPrice ?? 0) > product.salePrice;
const PACK_LABELS: Record<string, string> = {
  ПЕТ: 'Пляшка ПЕТ',
  Скло: 'Скляна пляшка',
  Ваговий: 'На вагу',
  Штучно: 'Поштучно',
};
export function sizeLabel(product: LabelProduct) {
  let value = product.size.trim();
  if (!value) return '';
  if (/^\d+([.,]\d+)?$/.test(value))
    value += ['ПЕТ', 'Скло', 'Банка'].includes(product.pack)
      ? numeric(value) < 10
        ? ' л'
        : ' мл'
      : ' г';
  if (/\d\s*(л|мл|l|ml)(?![a-zа-яіїєґ])/i.test(value)) return 'об’єм ' + value;
  if (/\d\s*(г|кг|g|kg)(?![a-zа-яіїєґ])/i.test(value)) return 'вага ' + value;
  return (product.pack === 'Стакан' ? 'розмір ' : '') + value;
}
export function tagParts(
  product: LabelProduct,
  config: LabelConfig,
  settings: LabelSettings,
  date = new Date(),
): Record<LabelField, string> {
  const price = product.salePrice;
  const per100 = product.unit === 'кг' && price > 0 ? formatPer100(price) : '';
  const result: Record<LabelField, string> = {
    chain: settings.chainName,
    store: settings.storeNames[config.storeIdx] ?? '',
    promo: product.promotion ? 'Акція' : '',
    custom: config.custom.trim(),
    name: product.name,
    pack: PACK_LABELS[product.pack] ?? product.pack,
    psize: sizeLabel(product),
    price:
      price <= 0
        ? '—'
        : formatLabelMoney(price, config.kop || Math.abs(price - Math.round(price)) >= 0.005),
    oldPrice: hasPromotionPrice(product) ? `${formatLabelMoney(product.regularPrice!)} грн` : '',
    unit: product.unit === '100 г' ? 'грн за 100 г' : `грн за 1 ${product.unit}`,
    per100: per100 ? `100 г — ${per100} грн` : '',
    category: product.category,
    date: date.toLocaleDateString('uk-UA'),
  };
  for (const [key] of LABEL_FIELDS) if (!fieldVisible(config, key)) result[key] = '';
  return result;
}
export function pageGeometry(config: Pick<LabelConfig, 'size'>) {
  const [width, height] = LABEL_SIZES[config.size];
  const columns = Math.floor(194 / width),
    rows = Math.floor(281 / height);
  return {
    width,
    height,
    columns,
    rows,
    perSheet: columns * rows,
    pageWidth: 210,
    pageHeight: 297,
    margin: 8,
  };
}
export const MAX_LABEL_COPIES = 1000;
/** Expand only validated quantities; avoid accidental huge allocations while editing a print job. */
export function labelCopies(
  products: readonly LabelProduct[],
  quantities: Readonly<Record<string, number>>,
): LabelProduct[] {
  const copies: LabelProduct[] = [];
  for (const product of products) {
    const count = quantities[product.id] ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 500)
      throw new RangeError('Кількість цінників має бути цілим числом від 1 до 500.');
    if (copies.length + count > MAX_LABEL_COPIES)
      throw new RangeError('За один раз можна підготувати до 1000 цінників.');
    for (let i = 0; i < count; i++) copies.push(product);
  }
  return copies;
}
export function buildPrintPages(
  products: readonly LabelProduct[],
  config: Pick<LabelConfig, 'size'>,
): LabelProduct[][] {
  if (products.length > MAX_LABEL_COPIES)
    throw new RangeError('За один раз можна підготувати до 1000 цінників.');
  const { perSheet } = pageGeometry(config),
    pages: LabelProduct[][] = [];
  for (let i = 0; i < products.length; i += perSheet) pages.push(products.slice(i, i + perSheet));
  return pages;
}
export function printIssues(
  products: readonly LabelProduct[],
  settings: Pick<LabelSettings, 'staleDays'>,
  now = new Date(),
) {
  const noPrice = [
    ...new Set(products.filter((product) => product.salePrice <= 0).map((product) => product.name)),
  ];
  const stale = [
    ...new Set(
      products
        .filter(
          (product) =>
            product.salePrice > 0 &&
            (!Number.isFinite(Date.parse(product.priceAt)) ||
              (now.getTime() - Date.parse(product.priceAt)) / 864e5 > settings.staleDays),
        )
        .map((product) => product.name),
    ),
  ];
  const incompletePromotion = [
    ...new Set(
      products
        .filter((product) => product.promotion && !hasPromotionPrice(product))
        .map((product) => product.name),
    ),
  ];
  return { noPrice, stale, incompletePromotion, overLimit: products.length > MAX_LABEL_COPIES };
}
/** Geometry must be measured in the DOM: font metrics and wrapping cannot be guessed in pure code. */
export function clippedLabel(label: HTMLElement): boolean {
  // A shrinking flex section can place otherwise untruncated fields outside the label.
  // Checking only each field's own scroll dimensions misses this physical crop.
  if (label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1)
    return true;
  const bounds = label.getBoundingClientRect(),
    style = getComputedStyle(label);
  const scaleX = bounds.width / (Number.parseFloat(style.width) || bounds.width || 1);
  const scaleY = bounds.height / (Number.parseFloat(style.height) || bounds.height || 1);
  const left =
    bounds.left +
    (Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft)) * scaleX;
  const right =
    bounds.right -
    (Number.parseFloat(style.borderRightWidth) + Number.parseFloat(style.paddingRight)) * scaleX;
  const upper =
    bounds.top +
    (Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop)) * scaleY;
  const lower =
    bounds.bottom -
    (Number.parseFloat(style.borderBottomWidth) + Number.parseFloat(style.paddingBottom)) * scaleY;
  const toleranceX = Math.max(1, scaleX),
    toleranceY = Math.max(1, scaleY);
  const top = label.querySelector<HTMLElement>('.t-top'),
    bottom = label.querySelector<HTMLElement>('.t-bottom');
  if (
    top &&
    bottom &&
    top.getBoundingClientRect().bottom > bottom.getBoundingClientRect().top + toleranceY
  )
    return true;
  return [...label.querySelectorAll<HTMLElement>('[data-field]')].some((field) => {
    const fieldBounds = field.getBoundingClientRect();
    return (
      field.scrollWidth > field.clientWidth + 1 ||
      field.scrollHeight > field.clientHeight + 1 ||
      fieldBounds.left < left - toleranceX ||
      fieldBounds.right > right + toleranceX ||
      fieldBounds.top < upper - toleranceY ||
      fieldBounds.bottom > lower + toleranceY
    );
  });
}
