import { createApiClient } from '../../shared/api/client';
import type { components } from '../../shared/api/catalogReferences.generated';
import { type ReferenceField } from './api';
import {
  decodeManagedReference,
  type ManagedReference,
  type ReferenceMutation,
} from './referenceManagementApi';
export type ReferenceQuery = components['schemas']['Query'];
export type ReferencePage = components['schemas']['Page'];
export type SelectedReference = components['schemas']['Selected'];
export type ReferenceDetails = components['schemas']['Details'];
export type ImpactSection = components['schemas']['ImpactSection'];
export type ImpactPage = components['schemas']['ImpactPage'];
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Некоректні дані довідника.');
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value)))
    throw new Error('Некоректний склад даних довідника.');
};
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const token = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function counts(data: Record<string, unknown>, items: unknown[]) {
  if (
    !Number.isSafeInteger(data.total) ||
    Number(data.total) < 0 ||
    !Number.isSafeInteger(data.page) ||
    Number(data.page) < 1 ||
    data.limit !== 30 ||
    data.pages !== Math.max(1, Math.ceil(Number(data.total) / 30)) ||
    Number(data.page) > Number(data.pages) ||
    items.length !== Math.min(30, Math.max(0, Number(data.total) - (Number(data.page) - 1) * 30))
  )
    throw new Error('Некоректна сторінка довідника.');
}
export function referenceQuery(
  field: ReferenceField,
  context: Partial<ReferenceQuery> = {},
): ReferenceQuery {
  return { field, q: '', state: 'active', parentId: null, parentType: null, ...context };
}
export function decodeReferencePage(value: unknown, expected: ReferenceQuery): ReferencePage {
  const data = object(value);
  exact(data, ['contract', 'items', 'total', 'page', 'pages', 'limit', 'query', 'canEdit', 'csrf']);
  const query = object(data.query);
  exact(query, ['field', 'q', 'state', 'parentId', 'parentType']);
  if (
    data.contract !== 'catalog-reference-page-v1' ||
    Object.entries(expected).some(([key, value]) => query[key] !== value) ||
    typeof data.canEdit !== 'boolean' ||
    typeof data.csrf !== 'string' ||
    !data.csrf ||
    !Array.isArray(data.items)
  )
    throw new Error('Довідник не відповідає запитаному контексту.');
  const items = data.items.map(decodeManagedReference);
  counts(data, items);
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some(
      (item) =>
        item.field !== expected.field ||
        item.state !== expected.state ||
        (expected.field === 'category' &&
          ((expected.parentId !== null && item.parentId !== expected.parentId) ||
            (expected.parentType !== null && item.parentType !== expected.parentType))),
    )
  )
    throw new Error('Некоректний запис сторінки довідника.');
  return { ...data, items } as ReferencePage;
}
export function decodeReferenceDetails(
  value: unknown,
  selected: SelectedReference[],
): ReferenceDetails {
  const data = object(value);
  exact(data, ['contract', 'items', 'canEdit']);
  if (
    data.contract !== 'catalog-reference-details-v1' ||
    typeof data.canEdit !== 'boolean' ||
    !Array.isArray(data.items) ||
    data.items.length !== selected.length ||
    selected.length > 20
  )
    throw new Error('Некоректні вибрані значення довідника.');
  const items = data.items.map((raw, index) => {
    const row = object(raw);
    exact(row, ['selected', 'item', 'resolved']);
    const echo = object(row.selected),
      expected = selected[index]!;
    if (
      Object.keys(echo).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => echo[key] !== value) ||
      typeof row.resolved !== 'boolean' ||
      row.resolved !== (row.item !== null)
    )
      throw new Error('Підпис не відповідає вибраному значенню.');
    const item = row.item === null ? null : decodeManagedReference(row.item);
    if (
      item &&
      (item.field !== expected.field || (expected.id !== undefined && item.id !== expected.id))
    )
      throw new Error('ID належить іншому вибраному значенню.');
    return { ...row, item };
  });
  return { ...data, items } as ReferenceDetails;
}
export function decodeImpactPage(
  value: unknown,
  snapshot: string,
  section: ImpactSection,
): ImpactPage {
  const data = object(value);
  exact(data, ['contract', 'snapshot', 'section', 'items', 'total', 'page', 'pages', 'limit']);
  if (
    data.contract !== 'catalog-reference-impact-page-v1' ||
    data.snapshot !== snapshot ||
    !token(snapshot) ||
    data.section !== section ||
    !Array.isArray(data.items)
  )
    throw new Error('Вплив не відповідає переглянутій зміні.');
  counts(data, data.items);
  const ids = new Set<string>();
  for (const raw of data.items) {
    const item = object(raw);
    let identity: string;
    if (section === 'references') {
      exact(item, ['before', 'after']);
      const before = decodeManagedReference(item.before),
        after = decodeManagedReference(item.after);
      if (before.id !== after.id || before.field !== after.field)
        throw new Error('Некоректна зміна запису.');
      identity = before.id;
    } else if (section === 'coalesced') {
      exact(item, ['sourceId', 'targetId', 'value']);
      if (!id(item.sourceId) || !id(item.targetId) || typeof item.value !== 'string')
        throw new Error('Некоректне об’єднання.');
      identity = item.sourceId;
    } else {
      const key = section === 'products' ? 'name' : 'reason';
      exact(item, ['id', key]);
      if (!id(item.id) || typeof item[key] !== 'string')
        throw new Error('Некоректний рядок впливу.');
      identity = item.id;
    }
    if (ids.has(identity)) throw new Error('Повторений рядок впливу.');
    ids.add(identity);
  }
  return data as ImpactPage;
}
export function createReferenceDirectoryApi(getCsrf?: () => string | undefined) {
  let csrf: string | undefined;
  const client = createApiClient({ getCsrf: () => getCsrf?.() || csrf });
  return {
    async page(query: ReferenceQuery, page = 1, signal?: AbortSignal) {
      const params = new URLSearchParams(
        Object.entries({ ...query, page })
          .filter(([, value]) => value !== null)
          .map(([key, value]) => [key, String(value)]),
      );
      const result = await client.get(
        '/api/v1/catalog/references/page?' + params,
        (value) => decodeReferencePage(value, query),
        signal,
      );
      csrf = result.csrf;
      return result;
    },
    details(items: SelectedReference[], signal?: AbortSignal) {
      return client.mutate(
        'POST',
        '/api/v1/catalog/references/details',
        { items },
        (value) => decodeReferenceDetails(value, items),
        signal,
      );
    },
    impact(
      request: ReferenceMutation,
      snapshot: string,
      section: ImpactSection,
      page = 1,
      signal?: AbortSignal,
    ) {
      return client.mutate(
        'POST',
        '/api/v1/catalog/references/impact-page',
        { request, snapshot, section, page },
        (value) => decodeImpactPage(value, snapshot, section),
        signal,
      );
    },
  };
}
export type ReferenceDirectoryApi = ReturnType<typeof createReferenceDirectoryApi>;
export type { ManagedReference };
