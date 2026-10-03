import { expect, test } from 'vitest';
import { compareThreeWay, decimalKey, mergeEqual, resolveThreeWay } from './threeWay';
import type { MergeField } from './threeWay';

type Draft = { name: string; pack: string; price: string; manual: boolean };
const base: Draft = { name: 'Кава', pack: 'Пакет', price: '10.00', manual: false };
const fields: MergeField<Draft>[] = [
  ...(['name', 'pack'] as const).map((key) => ({
    id: key,
    label: key,
    read: (v: Draft) => v[key],
    write: (target: Draft, source: Draft) => ({ ...target, [key]: source[key] }),
  })),
  {
    id: 'pricing',
    label: 'Ціни',
    read: (v) => [decimalKey(v.price), v.manual],
    write: (target, source) => ({ ...target, price: source.price, manual: source.manual }),
  },
];
test('independent edits merge from fresh baseline without mutating any version', () => {
  const mine = Object.freeze({ ...base, pack: 'Коробка' }),
    server = Object.freeze({ ...base, name: 'Кава зернова' });
  const before = JSON.stringify([base, mine, server]);
  expect(compareThreeWay(base, mine, server, fields).map((v) => [v.id, v.status])).toEqual([
    ['name', 'server'],
    ['pack', 'mine'],
  ]);
  expect(resolveThreeWay(base, mine, server, fields, {})).toEqual({ ...server, pack: 'Коробка' });
  expect(JSON.stringify([base, mine, server])).toBe(before);
});
test('a dependent group requires an explicit choice, even if different properties changed', () => {
  const mine = { ...base, price: '12.01' },
    server = { ...base, manual: true };
  expect(compareThreeWay(base, mine, server, fields)[0]?.status).toBe('conflict');
  expect(resolveThreeWay(base, mine, server, fields, {})).toBeNull();
  expect(resolveThreeWay(base, mine, server, fields, { pricing: 'mine' })).toEqual(mine);
  expect(resolveThreeWay(base, mine, server, fields, { pricing: 'server' })).toEqual(server);
});
test('equivalent decimals and equal edits do not require a choice; a repeated server edit does', () => {
  const mine = { ...base, price: '010,000' },
    server = { ...base, price: '10.0' };
  expect(compareThreeWay(base, mine, server, fields)).toEqual([]);
  const changed = { ...base, name: 'Чай' };
  expect(compareThreeWay(base, changed, changed, fields)[0]?.status).toBe('same');
  const merged = resolveThreeWay(base, { ...base, price: '12' }, { ...base, price: '13' }, fields, {
    pricing: 'mine',
  })!;
  expect(
    resolveThreeWay({ ...base, price: '13' }, merged, { ...base, price: '14' }, fields, {}),
  ).toBeNull();
  expect(decimalKey('99999999.99')).toBe('99999999.99');
  expect(decimalKey('-0.00')).toBe('0');
  expect(decimalKey('')).toBe('');
});
test('object ordering does not create conflicts, but array order and absent overrides do', () => {
  expect(mergeEqual({ size: 12, color: '#ffffff' }, { color: '#ffffff', size: 12 })).toBe(true);
  expect(mergeEqual({}, { size: undefined })).toBe(false);
  expect(mergeEqual(['A', 'B'], ['B', 'A'])).toBe(false);
});
