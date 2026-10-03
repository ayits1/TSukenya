import { expect, test } from 'vitest';
import { decodeProduct, decodeReferences } from './api';
import { catalogProducts } from './fixtures';
import { decodeManagement, decodeImpact, decodeCommitResult } from './referenceManagementApi';
const source = {
  id: 'stable_group',
  field: 'type',
  value: 'Напої',
  parentType: '',
  parentId: null,
  mergedInto: null,
  state: 'active',
  revision: 'a'.repeat(64),
};
const impact = {
  snapshot: 'b'.repeat(64),
  operation: 'archive',
  source,
  target: null,
  productCount: 0,
  usageCount: 2,
  referenceCount: 1,
  coalescedCategories: [],
  examples: [],
  blocked: [],
  blockedCount: 0,
  warnings: ['Наявні значення лишаються.'],
};
test('server-owned reference IDs decode only known keys and valid identities', () => {
  expect(
    decodeProduct({ ...catalogProducts[0], referenceIds: { type: 'stable_group' } }).referenceIds
      ?.type,
  ).toBe('stable_group');
  for (const ids of [
    null,
    [],
    { type: null },
    { type: '' },
    { type: 'a/b' },
    { unknown: 'id' },
    { unit: 3 },
  ])
    expect(() => decodeProduct({ ...catalogProducts[0], referenceIds: ids })).toThrow();
});
test('active/archive boundaries reject malformed maps and duplicated identities', () => {
  const item = { id: 'archived', field: 'pack', value: 'Пакет', parentType: '' };
  expect(
    decodeReferences({ items: [], archivedItems: [item], canEdit: true }).archivedItems,
  ).toEqual([item]);
  expect(() => decodeReferences({ items: [item], archivedItems: [item], canEdit: true })).toThrow();
  expect(() => decodeReferences({ items: [], archivedItems: {}, canEdit: true })).toThrow();
  for (const changed of [
    { parentId: undefined },
    { revision: 'old' },
    { state: 'hidden' },
    { state: ['active'] },
    { mergedInto: 'invalid/path' },
    { state: 'merged', mergedInto: null },
  ])
    expect(() =>
      decodeManagement({ items: [{ ...source, ...changed }], canEdit: true, csrf: 'qa' }),
    ).toThrow();
  expect(decodeManagement({ items: [source], canEdit: false, csrf: 'qa' }).canEdit).toBe(false);
});
test('impact and immutable commit result require validated counts and dependency IDs', () => {
  expect(decodeImpact(impact).usageCount).toBe(2);
  expect(decodeCommitResult({ ...impact, ok: true }).ok).toBe(true);
  for (const changed of [
    { snapshot: 'stale' },
    { operation: 'delete' },
    { operation: ['archive'] },
    { productCount: -1 },
    { blocked: [3] },
    { target: {} },
    { examples: [{ id: '../x', name: 'x' }] },
    { coalescedCategories: [{ sourceId: 'x', targetId: null, value: 'x' }] },
  ])
    expect(() => decodeImpact({ ...impact, ...changed })).toThrow();
  expect(() => decodeCommitResult({ ...impact, ok: false })).toThrow();
});
