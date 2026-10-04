import { decimalKey, mergeEqual, type MergeField } from '../merge/threeWay';

export type NativeDraft = Record<string, string | number | boolean | null>;
/** Application-owned descriptors. Network responses must be decoded by the consumer first. */
export type NativeField = {
  id: string;
  label: string;
  keys: string[];
  decimals?: string[];
  labels?: Record<string, string>;
  valueLabels?: Record<string, string>;
};

const display = (value: unknown) => (value === null || value === '' ? 'Не задано' : String(value));

export function nativeFields(descriptors: NativeField[]): MergeField<NativeDraft>[] {
  const used = new Set<string>(),
    ids = new Set<string>();
  return descriptors.map((field) => {
    if (!field.id || ids.has(field.id) || !field.label || !field.keys.length)
      throw new Error('Некоректний опис порівняння.');
    ids.add(field.id);
    for (const key of field.keys) {
      if (!key || ['__proto__', 'constructor', 'prototype'].includes(key) || used.has(key))
        throw new Error('Поля порівняння повторюються або недоступні.');
      used.add(key);
    }
    if (field.decimals?.some((key) => !field.keys.includes(key)))
      throw new Error('Некоректні десяткові поля порівняння.');
    const read = (value: NativeDraft) =>
      Object.fromEntries(field.keys.map((key) => [key, value[key] ?? null]));
    const normalized = (value: unknown) =>
      Object.fromEntries(
        field.keys.map((key) => {
          const scalar = Reflect.get(value as object, key);
          return [key, field.decimals?.includes(key) ? decimalKey(scalar) : scalar];
        }),
      );
    return {
      id: field.id,
      label: field.label,
      read,
      write: (target, source) => ({ ...target, ...read(source) }),
      equal: (a, b) => mergeEqual(normalized(a), normalized(b)),
      format: (value) =>
        field.keys
          .map((key) => {
            const raw = Reflect.get(value as object, key);
            const scalar = (raw !== null && field.valueLabels?.[String(raw)]) || display(raw);
            return field.keys.length === 1 ? scalar : `${field.labels?.[key] || key}: ${scalar}`;
          })
          .join('\n'),
    };
  });
}
