import { describe, it, expect } from 'vitest';
import {
  decodeTemplatePayload,
  decodeTemplateRaw,
  confirmTemplatePayload,
} from './templatePersistence';
const key = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  revision = 'b'.repeat(64),
  nextRevision = 'c'.repeat(64);
const baseline = {
  recordId: 'template_' + key,
  key,
  original: { budgetStores: 2, revision },
  review: false,
};
const payload = () => ({
  baseline,
  draft: { budgetStores: '1..2' },
  firstIntent: null,
  confirmation: null,
});
const unknown = () => ({
  ...payload(),
  firstIntent: {
    method: 'PATCH',
    path: '/api/v1/portal/budget-template',
    key,
    body: { budgetStores: 3, revision },
    revision,
    possiblySent: true,
  },
});
const dto = (budgetStores = 3) => ({
  resource: 'budget-template',
  budgetStores,
  revision: nextRevision,
  source: 'explicit',
  canEdit: true,
});
describe('scalar template reload contract', () => {
  it('preserves invalid raw and refuses fields/cache/grants/foreign intent', () => {
    expect(decodeTemplateRaw({ budgetStores: '1..2' })).toEqual({ budgetStores: '1..2' });
    for (const p of [
      { ...payload(), draft: { budgetStores: '-', expenseTotal: '20' } },
      { ...payload(), baseline: { ...baseline, permissions: { canEdit: true } } },
      { ...unknown(), firstIntent: { ...unknown().firstIntent, path: '/api/docs/settings/main' } },
      { ...unknown(), firstIntent: { ...unknown().firstIntent, key: 'foreign' } },
      {
        ...unknown(),
        firstIntent: {
          ...unknown().firstIntent,
          body: { budgetStores: 3, revision, labelRevision: revision },
        },
      },
    ])
      expect(() => decodeTemplatePayload(p)).toThrow();
  });
  it('requires strict ACK count binding and retains old revision until independent read', () => {
    expect(() =>
      confirmTemplatePayload(unknown(), { type: 'saved', raw: dto(4), draft: payload().draft }),
    ).toThrow();
    const p = confirmTemplatePayload(unknown(), {
      type: 'saved',
      raw: dto(),
      draft: payload().draft,
    });
    expect(p?.firstIntent).toBeNull();
    expect(p?.confirmation).toEqual({ budgetStores: 3, revision: nextRevision });
    expect(p?.baseline).toEqual({ ...baseline, review: true });
    expect(
      confirmTemplatePayload(p, { type: 'complete', raw: dto(), draft: payload().draft })?.draft,
    ).toEqual(payload().draft);
    expect(() =>
      confirmTemplatePayload(p, { type: 'complete', raw: dto(4), draft: payload().draft }),
    ).toThrow();
  });
  it('unknown PATCH does not become a creator identity; explicit Apply installs current guard', () => {
    expect(() =>
      confirmTemplatePayload(unknown(), { type: 'identity', raw: dto(), draft: payload().draft }),
    ).toThrow();
    const p = confirmTemplatePayload(unknown(), {
      type: 'apply',
      raw: dto(4),
      draft: payload().draft,
    });
    expect(p?.firstIntent).toBeNull();
    expect(p?.confirmation).toBeNull();
    expect(p?.baseline).toEqual({
      ...baseline,
      original: { budgetStores: 4, revision: nextRevision },
    });
    expect(p?.draft).toEqual(payload().draft);
  });
  it('removes only a confirmed matching count after independent current read', () => {
    const p = confirmTemplatePayload(unknown(), {
      type: 'saved',
      raw: dto(),
      draft: { budgetStores: '3' },
    });
    expect(
      confirmTemplatePayload(p, { type: 'complete', raw: dto(), draft: { budgetStores: '3' } }),
    ).toBeNull();
    expect(() =>
      confirmTemplatePayload(payload(), {
        type: 'complete',
        raw: dto(),
        draft: { budgetStores: '3' },
      }),
    ).toThrow();
  });
});
