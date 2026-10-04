import { expect, it } from 'vitest';
import {
  confirmVersion,
  decodeLegacy,
  decodeList,
  decodeVersion,
  projection,
  recipeFields,
  validateDraft,
} from './recipe';
import { nativeFields } from './fields';
import { resolveThreeWay } from '../merge/threeWay';
const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const version = {
  id,
  product: 'output',
  version: 1,
  name: 'Кекс',
  unit: 'шт',
  outputQuantity: '10.000',
  components: [{ product: 'raw', name: 'Борошно', unit: 'кг', quantity: '2.000' }],
  expiryPolicy: 'components_min',
  shelfLifeDays: null,
  reason: 'Початковий норматив',
  approvedBy: 'owner',
  approvedAt: '2026-10-04T12:00:00Z',
};
const list = {
  items: [version],
  product: { id: 'output', name: 'Кекс', unit: 'шт' },
  catalogRevision: 'a'.repeat(64),
  latestVersion: id,
  canApprove: true,
  page: 1,
  pages: 1,
  total: 1,
  legacyRecipe: [{ product: 'raw', quantity: 2 }],
};
it('binds exact product, latest list and requested UUID; rejects malformed semantic quantity/policy', () => {
  expect(decodeList(list, 'output').items[0]?.id).toBe(id);
  for (const patch of [
    { product: { ...list.product, id: 'foreign' } },
    { items: [{ ...version, product: 'foreign' }] },
    { latestVersion: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' },
    { catalogRevision: [] },
    { canApprove: 'true' },
  ])
    expect(() => decodeList({ ...list, ...patch }, 'output')).toThrow();
  for (const patch of [
    { id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' },
    { components: [...version.components, ...version.components] },
    { components: [{ product: 'output', quantity: '1.000' }] },
    { outputQuantity: '0.000' },
    { expiryPolicy: ['components_min'] },
    { shelfLifeDays: 3 },
  ])
    expect(() => decodeVersion({ ...version, ...patch }, 'output', id)).toThrow();
  expect(() =>
    decodeLegacy(
      { product: list.product, revision: 'a'.repeat(64), recipe: [], canEdit: 1 },
      'output',
    ),
  ).toThrow();
});
it('components/output/policy are one conservative group while new approval reason stays local', () => {
  const base = projection(decodeList(list, 'output')),
    mine = { ...base, outputQuantity: '12.000', reason: 'Моя причина' },
    server = { ...base, components: '[{"product":"raw","quantity":"3.000"}]' };
  const fields = nativeFields(recipeFields([base, mine, server], { raw: 'Борошно' }));
  expect(resolveThreeWay(base, mine, server, fields, {})).toBeNull();
  expect(resolveThreeWay(base, mine, server, fields, { terms: 'server' })).toEqual({
    ...server,
    reason: 'Моя причина',
  });
  expect(fields[0]!.format!(fields[0]!.read(mine))).toContain('Борошно: 2.000');
});
it('canonical ordering/equivalent quantity do not create conflict; legacy empty differs from approved required recipe', () => {
  const legacy = decodeLegacy(
    {
      product: list.product,
      revision: 'a'.repeat(64),
      recipe: [{ product: 'raw', quantity: 2 }],
      canEdit: false,
    },
    'output',
  );
  expect(projection(legacy)).toEqual({ components: '[{"product":"raw","quantity":"2.000"}]' });
  expect(validateDraft({ components: '[]' }, 'output', true)).toEqual({ components: '[]' });
  expect(() =>
    validateDraft(
      { ...projection(decodeList(list, 'output')), components: '[]', reason: 'x' },
      'output',
    ),
  ).toThrow();
  expect(() =>
    validateDraft({ ...projection(decodeList(list, 'output')), reason: '' }, 'output'),
  ).toThrow();
});

it('valid UUID ACK with different submitted terms cannot confirm a durable create', () => {
  const payload = {
    idempotencyKey: id,
    product: 'output',
    outputQuantity: '10',
    components: version.components,
    expiryPolicy: 'components_min',
    shelfLifeDays: null,
    reason: version.reason,
  };
  expect(confirmVersion(version, payload).id).toBe(id);
  expect(() => confirmVersion({ ...version, outputQuantity: '12.000' }, payload)).toThrow();
  expect(() => confirmVersion({ ...version, reason: 'Other intention' }, payload)).toThrow();
});

it('valid saved leading-dot quantities remain selectable without weakening positivity or precision', () => {
  const saved = decodeLegacy(
    {
      product: list.product,
      revision: 'a'.repeat(64),
      recipe: [{ product: 'raw', quantity: '.5' }],
      canEdit: true,
    },
    'output',
  );
  expect(projection(saved)).toEqual({ components: '[{"product":"raw","quantity":"0.500"}]' });
  expect(() =>
    decodeLegacy({ ...saved, recipe: [{ product: 'raw', quantity: '.0001' }] }, 'output'),
  ).toThrow();
});
