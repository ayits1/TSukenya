import type { NativeDraft, NativeField } from './fields';
export type Category = {
  id: string;
  name: string;
  active: boolean;
  revision: number;
  semantic_key: string | null;
};
export type CategoryRead = {
  resource: 'category';
  record: Category;
  permissions: { canEdit: boolean };
};
export type CategoryIntent = { id: string; name: string; active: boolean };
const fail = (): never => {
  throw Error('Не вдалося перевірити статтю. Чернетка збережена; повторіть читання.');
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v) ? v : fail();
export const categoryFields: NativeField[] = [
  { id: 'name', label: 'Назва статті', keys: ['name'] },
  {
    id: 'active',
    label: 'Стан статті',
    keys: ['active'],
    valueLabels: { true: 'Активна', false: 'Архівна' },
  },
];
export function captureCategory(value: NativeDraft): { name: string; active: boolean } {
  if (
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.trim().length > 160 ||
    typeof value.active !== 'boolean'
  )
    return fail();
  return { name: value.name.trim(), active: value.active };
}
export function decodeCategory(value: unknown, expectedId: string): Category {
  const v = object(value);
  if (
    uuid(v.id) !== uuid(expectedId) ||
    typeof v.name !== 'string' ||
    !v.name.trim() ||
    v.name.length > 160 ||
    typeof v.active !== 'boolean' ||
    typeof v.revision !== 'number' ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 1 ||
    !(
      v.semantic_key === null ||
      (typeof v.semantic_key === 'string' && /^[a-z_]{1,40}$/.test(v.semantic_key))
    )
  )
    return fail();
  return {
    id: expectedId,
    name: v.name,
    active: v.active,
    revision: v.revision,
    semantic_key: v.semantic_key,
  };
}
export function decodeCategoryRead(value: unknown, expectedId: string): CategoryRead {
  const v = object(value),
    permissions = object(v.permissions);
  if (v.resource !== 'category' || typeof permissions.canEdit !== 'boolean') return fail();
  return {
    resource: 'category',
    record: decodeCategory(v.record, expectedId),
    permissions: { canEdit: permissions.canEdit },
  };
}
export function categoryProjection(value: Category): NativeDraft {
  return { name: value.name, active: value.active };
}
export function confirmCategory(
  value: unknown,
  body: CategoryIntent | { name: string; active: boolean; revision: number },
  id: string,
  creating: boolean,
): Category {
  const v = object(value),
    result = decodeCategory(v, id),
    expected = captureCategory(body);
  if (
    result.name !== expected.name ||
    result.active !== expected.active ||
    result.revision !== (creating ? 1 : 'revision' in body ? body.revision + 1 : fail()) ||
    (creating &&
      (v.resource !== 'category' || v.request_key !== id || result.semantic_key !== null))
  )
    return fail();
  return result;
}
export function decodeCategoryIdentity(value: unknown, intent: CategoryIntent) {
  const v = object(value);
  if (
    v.resource !== 'category' ||
    v.request_key !== uuid(intent.id) ||
    typeof v.confirmed !== 'boolean'
  )
    return fail();
  if (!v.confirmed) {
    if (
      v.status !== 'legacy_unknown' ||
      v.id !== undefined ||
      v.revision !== undefined ||
      v.permissions !== undefined
    )
      return fail();
    return { confirmed: false, status: 'legacy_unknown' as const };
  }
  if (v.id !== intent.id || !['present', 'deleted'].includes(String(v.status))) return fail();
  if (v.status === 'deleted') {
    if (v.revision !== undefined || v.permissions !== undefined) return fail();
    return { confirmed: true, status: 'deleted' as const, id: intent.id };
  }
  const p = object(v.permissions);
  if (
    p.canEdit !== true ||
    typeof v.revision !== 'number' ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 1
  )
    return fail();
  return { confirmed: true, status: 'present' as const, id: intent.id };
}
