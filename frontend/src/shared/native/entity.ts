import type { components } from '../api/trading.generated';
import type { NativeDraft, NativeField } from './fields';
export type EntityResource = 'stores' | 'warehouses' | 'accounts' | 'employees' | 'parties';
export type EntityRecord = NativeDraft & { id: string; revision: string; name: string };
const fail = (): never => {
  throw Error('Не вдалося прочитати всі поля запису. Повторіть читання; чернетка збережена.');
};
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length <= max ? value : fail();
const positive = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fail();
const decimal = (value: unknown, places: number) =>
  typeof value === 'string' &&
  new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`).test(value) &&
  value.length <= 24 &&
  Number(value) <= 999999999999
    ? value
    : fail();
const enumValue = (value: unknown, options: string[]): string =>
  typeof value === 'string' && options.includes(value) ? value : fail();
export function entityFields(resource: EntityResource): NativeField[] {
  const fields: NativeField[] = [{ id: 'name', label: 'Назва / ім’я', keys: ['name'] }];
  if (resource === 'parties')
    fields.push(
      ...['phone', 'email', 'notes'].map((key, i) => ({
        id: key,
        label: ['Телефон', 'Email', 'Примітка'][i] || fail(),
        keys: [key],
      })),
    );
  if (resource === 'employees')
    fields.push({
      id: 'payTerms',
      label: 'Умови оплати праці',
      keys: ['shift_rate', 'bonus_percent', 'bonus_basis'],
      decimals: ['shift_rate', 'bonus_percent'],
      labels: {
        shift_rate: 'Оплата за зміну, грн',
        bonus_percent: 'Відсоток, %',
        bonus_basis: 'База відсотка',
      },
      valueLabels: {
        store: 'Виторг магазину за касову зміну',
        personal: 'Особисті продажі',
        profit: 'Валовий прибуток за зміну',
      },
    });
  if (['stores', 'employees', 'parties'].includes(resource))
    fields.push({
      id: 'active',
      label: 'Стан',
      keys: ['active'],
      valueLabels: { true: 'Активний', false: 'Неактивний' },
    });
  return fields;
}
export function decodeEntity(
  resource: EntityResource,
  value: unknown,
  expectedId: string,
): EntityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (
    v.type !== resource ||
    typeof v.id !== 'string' ||
    v.id !== expectedId ||
    !/^[1-9]\d*$/.test(v.id) ||
    !Number.isSafeInteger(Number(v.id)) ||
    typeof v.revision !== 'string' ||
    !/^[a-f0-9]{32}$/.test(v.revision)
  )
    return fail();
  const name = text(v.name, 160);
  if (!name.trim()) return fail();
  const result: EntityRecord = { id: v.id, revision: v.revision, name };
  if (['warehouses', 'accounts', 'employees'].includes(resource))
    result.store_id = positive(v.store_id);
  if (resource === 'accounts') result.kind = enumValue(v.kind, ['cash', 'bank', 'terminal']);
  if (resource === 'parties') {
    result.kind = enumValue(v.kind, ['customer', 'supplier']);
    result.phone = text(v.phone, 80);
    result.email = text(v.email, 254);
    result.notes = text(v.notes, 4000);
  }
  if (['stores', 'employees', 'parties'].includes(resource)) {
    if (typeof v.active !== 'boolean') return fail();
    result.active = v.active;
  }
  if (resource === 'employees') {
    result.shift_rate = decimal(v.shift_rate, 2);
    result.bonus_percent = decimal(v.bonus_percent, 3);
    if (Number(result.bonus_percent) > 100) return fail();
    result.bonus_basis = enumValue(v.bonus_basis, ['store', 'personal', 'profit']);
  }
  return result;
}
export function entityProjection(resource: EntityResource, record: NativeDraft): NativeDraft {
  return Object.fromEntries(
    entityFields(resource)
      .flatMap((field) => field.keys)
      .map((key) => [key, record[key] === undefined ? fail() : record[key]]),
  );
}
export function entityIdentityMatches(base: EntityRecord, latest: EntityRecord): boolean {
  return ['id', 'store_id', 'kind'].every((key) => base[key] === latest[key]);
}

export type EntityCreateRequest = components['schemas']['EntityCreateRequest'];
export type EntityCreateAcknowledgement = components['schemas']['EntityCreateAcknowledgement'];
export type EntityCreateIdentity = components['schemas']['EntityCreateIdentity'];
export type EntityCreateIntent = Record<string, string | number | boolean>;
const canonicalDecimal = (value: string, places: number) => {
  const valid = decimal(value, places);
  if (Number(valid) > 999999999999) return fail();
  const [whole, fraction = ''] = valid.split('.');
  return (
    (whole || '0').replace(/^0+(?=\d)/, '') +
    (fraction.replace(/0+$/, '') ? '.' + fraction.replace(/0+$/, '') : '')
  );
};
export function captureEntityCreate(
  resource: EntityResource,
  value: Record<string, unknown>,
): EntityCreateIntent {
  const result: EntityCreateIntent = { name: text(value.name, 160).trim() };
  if (!result.name) return fail();
  if (['warehouses', 'accounts', 'employees'].includes(resource)) {
    const store =
      typeof value.store === 'string' && /^[1-9]\d*$/.test(value.store)
        ? Number(value.store)
        : value.store;
    result.store = positive(store);
  }
  if (resource === 'accounts') result.kind = enumValue(value.kind, ['cash', 'bank', 'terminal']);
  if (resource === 'parties') {
    result.kind = enumValue(value.kind, ['customer', 'supplier']);
    result.phone = text(value.phone, 80);
    result.email = text(value.email, 254);
    result.notes = text(value.notes, 4000);
  }
  if (['stores', 'employees', 'parties'].includes(resource)) {
    if (typeof value.active !== 'boolean') return fail();
    result.active = value.active;
  }
  if (resource === 'employees') {
    result.shift_rate = canonicalDecimal(text(value.shift_rate, 24), 2);
    result.bonus_percent = canonicalDecimal(text(value.bonus_percent, 24), 3);
    if (Number(result.bonus_percent) > 100) return fail();
    result.bonus_basis = enumValue(value.bonus_basis, ['store', 'personal', 'profit']);
  }
  return result;
}
export function decodeEntityReceipt(
  resource: EntityResource,
  value: unknown,
  key: string,
  intent: EntityCreateIntent,
): EntityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (v.type !== resource || v.request_key !== key || typeof v.id !== 'string') return fail();
  const original = decodeEntity(resource, v.original, v.id);
  const body = captureEntityCreate(resource, { ...original, store: original.store_id });
  if (JSON.stringify(body) !== JSON.stringify(captureEntityCreate(resource, intent))) return fail();
  return original;
}
export function decodeEntityIdentity(
  resource: EntityResource,
  value: unknown,
  key: string,
  intent: EntityCreateIntent,
): { confirmed: false } | { confirmed: true; original: EntityRecord; exists: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (v.type !== resource || v.request_key !== key || typeof v.confirmed !== 'boolean')
    return fail();
  if (!v.confirmed) {
    if ('id' in v || 'original' in v || 'exists' in v) return fail();
    return { confirmed: false };
  }
  if (typeof v.exists !== 'boolean') return fail();
  return {
    confirmed: true,
    original: decodeEntityReceipt(resource, value, key, intent),
    exists: v.exists,
  };
}
