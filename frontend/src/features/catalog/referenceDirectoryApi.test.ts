import { expect, test } from 'vitest';
import {
  decodeReferencePage,
  decodeReferenceDetails,
  decodeImpactPage,
  referenceQuery,
} from './referenceDirectoryApi';
const query = referenceQuery('category', { parentId: 'group' });
const item = {
  id: 'category',
  field: 'category',
  value: 'Кава',
  parentType: 'Напої',
  parentId: 'group',
  state: 'active',
  mergedInto: null,
  revision: 'a'.repeat(64),
};
const page = {
  contract: 'catalog-reference-page-v1',
  items: [item],
  total: 1,
  page: 1,
  pages: 1,
  limit: 30,
  query,
  canEdit: true,
  csrf: 'synthetic',
};
test('bounded pages validate counts, resource/parent identity and query echo', () => {
  expect(decodeReferencePage(page, query).items[0]?.id).toBe('category');
  for (const change of [
    { total: 31 },
    { items: [] },
    { items: [item, item], total: 2 },
    { query: { ...query, parentId: 'other' } },
    { items: [{ ...item, parentId: 'other' }] },
    { items: [{ ...item, field: 'pack' }] },
    { canEdit: 'true' },
    { csrf: '' },
    { page: 2 },
  ])
    expect(() => decodeReferencePage({ ...page, ...change }, query)).toThrow();
});
test('selected unknown ID never falls back to text or another parent', () => {
  const selected = [
    { field: 'category' as const, id: 'missing', value: 'Кава', parentType: 'Напої' },
  ];
  const raw = {
    contract: 'catalog-reference-details-v1',
    items: [{ selected: selected[0], resolved: false, item: null }],
    canEdit: false,
  };
  expect(decodeReferenceDetails(raw, selected).items[0]?.resolved).toBe(false);
  for (const change of [
    { resolved: true },
    { resolved: false, item },
    { resolved: true, item },
    { selected: { ...selected[0], id: 'category' } },
  ])
    expect(() =>
      decodeReferenceDetails({ ...raw, items: [{ ...raw.items[0], ...change }] }, selected),
    ).toThrow();
});
test('complete impact paging rejects mixed snapshot, section, duplicate and malformed rows', () => {
  const snapshot = 'b'.repeat(64),
    raw = {
      contract: 'catalog-reference-impact-page-v1',
      snapshot,
      section: 'products',
      items: [{ id: 'coffee', name: 'Кава' }],
      total: 1,
      page: 1,
      pages: 1,
      limit: 30,
    };
  expect(decodeImpactPage(raw, snapshot, 'products').total).toBe(1);
  for (const change of [
    { snapshot: 'c'.repeat(64) },
    { section: 'blocked' },
    { total: 31 },
    {
      items: [
        { id: 'coffee', name: 'a' },
        { id: 'coffee', name: 'b' },
      ],
      total: 2,
    },
    { items: [{ id: 'coffee', name: 5 }] },
  ])
    expect(() => decodeImpactPage({ ...raw, ...change }, snapshot, 'products')).toThrow();
});
