import { expect, it } from 'vitest';
import {
  decodeLegacyRecord,
  legacyFields,
  legacyIdentityMatches,
  legacyPatch,
  legacyProjection,
} from './legacy';
import { nativeFields } from './fields';
import { resolveThreeWay } from '../merge/threeWay';
const record = {
  collection: 'expenses' as const,
  id: 'qa',
  revision: 'a'.repeat(32),
  data: { name: 'Оренда', group: 'fixed', amount: '21.99', category: 'Інше', custom: 'preserve' },
  permissions: { canEdit: true, canDelete: true },
  managed: false,
  initiative: null,
};
it('rejects malformed exact ID/permissions/revision/decimal, no money defaults', () => {
  for (const patch of [
    { id: 'other' },
    { revision: undefined },
    { permissions: { canEdit: 1, canDelete: true } },
    { data: { ...record.data, amount: undefined } },
    { data: { ...record.data, amount: '1.001' } },
  ])
    expect(() => decodeLegacyRecord({ ...record, ...patch }, 'expenses', 'qa')).toThrow();
});
it('financial classification and money resolve together; PATCH excludes unknown metadata', () => {
  const base = legacyProjection(record),
    mine = { ...base, amount: '30.00' },
    server = { ...base, name: 'Нова назва', group: 'variable' };
  const fields = nativeFields(legacyFields(record));
  expect(resolveThreeWay(base, mine, server, fields, {})).toBeNull();
  const merged = resolveThreeWay(base, mine, server, fields, { financialTerms: 'mine' })!;
  expect(merged).toEqual({ ...mine, name: 'Нова назва' });
  expect(legacyPatch(record, merged)).toEqual({ name: 'Нова назва', amount: '30.00' });
});
it('grandfather missing optional values stay explicit and unchanged PATCH does not invent them', () => {
  const task = decodeLegacyRecord(
    { ...record, collection: 'tasks', data: { title: 'Стара задача' } },
    'tasks',
    'qa',
  );
  expect(legacyProjection(task)).toEqual({
    title: 'Стара задача',
    status: null,
    dueDate: null,
    stage: null,
  });
  expect(legacyPatch(task, { ...legacyProjection(task), title: 'Нова задача' })).toEqual({
    title: 'Нова задача',
  });
  expect(
    legacyIdentityMatches(task, { ...task, data: { ...task.data, scope: 'operations' } }),
  ).toBe(false);
});
