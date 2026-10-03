/** Label properties merge independently; store names and their selected index are inseparable. */
import type { MergeField } from '../../shared/merge/threeWay';
import { FIELD_LABELS, LABEL_FIELDS } from './domain';
import type { LabelConfig, LabelSettings, LabelStyle, LabelField } from './domain';

export type LabelDraft = { config: LabelConfig; settings: LabelSettings };
const shown = (value: unknown): string =>
  value === undefined
    ? 'За шаблоном'
    : value === ''
      ? 'Не задано'
      : typeof value === 'boolean'
        ? value
          ? 'Показувати'
          : 'Приховати'
        : String(value);
const fontNames = { rubik: 'Rubik', arial: 'Arial', georgia: 'Georgia', courier: 'Courier New' };
const alignNames = { left: 'Ліворуч', center: 'По центру', right: 'Праворуч' };
const weightNames = { '400': 'Звичайний', '600': 'Напівжирний', '700': 'Жирний' };
const propertyNames = {
  font: 'Шрифт',
  size: 'Розмір шрифту',
  color: 'Колір',
  weight: 'Насиченість',
  align: 'Вирівнювання',
};
function configField<K extends Exclude<keyof LabelConfig, 'styles' | 'storeIdx' | 'styleVersion'>>(
  key: K,
  label: string,
  format = shown,
): MergeField<LabelDraft> {
  return {
    id: `config.${key}`,
    label,
    read: (draft) => draft.config[key],
    write: (target, source) => ({
      ...target,
      config: { ...target.config, [key]: source.config[key] },
    }),
    format,
  };
}
function styleField<K extends keyof LabelStyle>(
  field: LabelField,
  property: K,
): MergeField<LabelDraft> {
  return {
    id: `style.${field}.${property}`,
    label: `${FIELD_LABELS[field]} — ${propertyNames[property]}`,
    read: (draft) => draft.config.styles[field]?.[property],
    write: (target, source) => {
      const styles = { ...target.config.styles },
        style = { ...styles[field] },
        value = source.config.styles[field]?.[property];
      if (value === undefined) delete style[property];
      else style[property] = value;
      if (Object.keys(style).length) styles[field] = style;
      else delete styles[field];
      return { ...target, config: { ...target.config, styles } };
    },
    format: (value) => {
      if (value === undefined) return 'За шаблоном';
      if (property === 'size') return `${value} pt`;
      const labels =
        property === 'font'
          ? fontNames
          : property === 'align'
            ? alignNames
            : property === 'weight'
              ? weightNames
              : {};
      return labels[String(value) as keyof typeof labels] || shown(value);
    },
  };
}
export const LABEL_MERGE_FIELDS: MergeField<LabelDraft>[] = [
  configField(
    'size',
    'Формат цінника',
    (value) =>
      ({ s: '58 × 40 мм', m: '75 × 50 мм', l: '100 × 70 мм' })[String(value) as 's' | 'm' | 'l'] ||
      shown(value),
  ),
  configField(
    'border',
    'Рамка',
    (value) =>
      ({ dash: 'Пунктирна', solid: 'Суцільна', none: 'Без рамки' })[
        String(value) as 'dash' | 'solid' | 'none'
      ] || shown(value),
  ),
  configField('nameBig', 'Назва товару — збільшений розмір'),
  configField('kop', 'Ціна — гривні й копійки окремо'),
  configField('custom', 'Додатковий напис — текст'),
  ...LABEL_FIELDS.map(([field, label]) =>
    configField(field === 'custom' ? 'customEnabled' : field, `${label} — видимість`),
  ),
  {
    id: 'settings.chainName',
    label: 'Назва мережі — текст',
    read: (draft) => draft.settings.chainName,
    write: (target, source) => ({
      ...target,
      settings: { ...target.settings, chainName: source.settings.chainName },
    }),
    format: shown,
  },
  {
    id: 'settings.staleDays',
    label: 'Через скільки днів ціна потребує перевірки',
    read: (draft) => draft.settings.staleDays,
    write: (target, source) => ({
      ...target,
      settings: { ...target.settings, staleDays: source.settings.staleDays },
    }),
    format: (value) => `${value} днів`,
  },
  {
    id: 'settings.stores',
    label: 'Магазини — список і вибраний магазин',
    read: (draft) => ({ names: draft.settings.storeNames, selected: draft.config.storeIdx }),
    write: (target, source) => ({
      ...target,
      settings: { ...target.settings, storeNames: [...source.settings.storeNames] },
      config: { ...target.config, storeIdx: source.config.storeIdx },
    }),
    format: (value) => {
      const stores = value as { names: string[]; selected: number };
      return stores.names.length
        ? stores.names
            .map(
              (name, index) =>
                `${index + 1}. ${name || 'Назву не задано'}${index === stores.selected ? ' (вибрано)' : ''}`,
            )
            .join('; ')
        : 'Магазини не задані';
    },
  },
  ...LABEL_FIELDS.flatMap(([field]) =>
    (Object.keys(propertyNames) as (keyof LabelStyle)[]).map((property) =>
      styleField(field, property),
    ),
  ),
];
