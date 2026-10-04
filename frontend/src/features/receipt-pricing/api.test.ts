import { describe, it, expect } from 'vitest';
import { decodeCurrent, decodePreview, decodeReceipt, type Commit } from './api';
import { fixtureCurrent, fixturePreview, fixtureReceipt, key } from './fixtures';
import { fields, initialDraft, proposal, sourceCents } from './model';
import { compareThreeWay, resolveThreeWay } from '../../shared/merge/threeWay';
function body(): Commit {
  const current = fixtureCurrent(),
    draft = initialDraft(current);
  draft.reason = 'Явна закупівля';
  draft.rows['sample-1']!.selected = true;
  draft.rows['sample-1']!.values.cost = '12.50';
  return { ...proposal(current, draft), snapshot: 'd'.repeat(64), idempotencyKey: key };
}
describe('Invoice catalogue source and immutable operation boundary', () => {
  it('cent binding accepts only exact trailing-zero .0001, never silently rounds', () => {
    expect(sourceCents('12.5000')).toBe('12.50');
    expect(sourceCents('12.3456')).toBeNull();
    expect(sourceCents('0.0100')).toBe('0.01');
    expect(sourceCents('1e3')).toBeNull();
  });
  it('rejects unrelated resource, duplicate line identity, forbidden store, missing private terms and bad day', () => {
    expect(decodeCurrent(fixtureCurrent(), 1).source.id).toBe(1);
    const variants = [
      (v: ReturnType<typeof fixtureCurrent>) => (v.source.id = 2),
      (v: ReturnType<typeof fixtureCurrent>) =>
        (v.source.lines[1]!.lineKey = v.source.lines[0]!.lineKey),
      (v: ReturnType<typeof fixtureCurrent>) => (v.products[0]!.id = 'foreign'),
      (v: ReturnType<typeof fixtureCurrent>) => (v.products[0]!.cost = null),
      (v: ReturnType<typeof fixtureCurrent>) => (v.effectiveDay = '2026-02-30'),
      (v: ReturnType<typeof fixtureCurrent>) => {
        v.canSelectNetwork = false;
        v.priceContext = { storeId: null, storeName: null };
      },
    ];
    for (const change of variants) {
      const v = fixtureCurrent();
      change(v);
      expect(() => decodeCurrent(v, 1)).toThrow();
    }
    expect(() => decodeCurrent(fixtureCurrent(), 1, null)).toThrow();
    expect(() => decodeCurrent({ ...fixtureCurrent(), canEdit: ['true'] }, 1)).toThrow();
  });
  it('preview and ACK bind ordered IDs/source snapshot/key/context and coherent effect flags', () => {
    const request = body();
    expect(decodePreview(fixturePreview(request), 1, request).valid).toBe(true);
    expect(decodeReceipt(fixtureReceipt(request), 1, request).idempotencyKey).toBe(key);
    const preview = fixturePreview(request);
    preview.entries[0]!.comparison!.retailChanged = false;
    expect(() => decodePreview(preview, 1, request)).toThrow();
    const ack = fixtureReceipt(request);
    ack.idempotencyKey = key.replace(/1$/, '2');
    expect(() => decodeReceipt(ack, 1, request)).toThrow();
    const scope = fixtureReceipt(request);
    scope.entries[0]!.priceResult.context.storeId = 2;
    expect(() => decodeReceipt(scope, 1, request)).toThrow();
  });
  it('shared merge preserves unrelated reason, treats source+pricing atomically, requires same-group choice', () => {
    const current = fixtureCurrent(),
      base = initialDraft(current),
      mine = structuredClone(base),
      remote = structuredClone(base);
    mine.reason = 'Після надходження';
    mine.rows['sample-1']!.values.cost = '12.50';
    mine.rows['sample-1']!.sourceLine = { id: 1, lineKey: key };
    remote.rows['sample-1']!.values.markup = '40';
    const descriptor = fields(current);
    expect(
      compareThreeWay(base, mine, remote, descriptor).find((r) => r.id.endsWith(':pricing'))
        ?.status,
    ).toBe('conflict');
    expect(resolveThreeWay(base, mine, remote, descriptor, {})).toBeNull();
    const merged = resolveThreeWay(base, mine, remote, descriptor, {
      'sample-1:pricing': 'server',
    })!;
    expect(merged.reason).toBe(mine.reason);
    expect(merged.rows['sample-1']!.values.markup).toBe('40');
    expect(merged.rows['sample-1']!.sourceLine).toBeNull();
  });
  it('rejects a valid-shaped preview that changes normalized operator intent', () => {
    const request = body();
    for (const change of [
      (v: ReturnType<typeof fixturePreview>) => (v.entries[0]!.values!.cost = '99.00'),
      (v: ReturnType<typeof fixturePreview>) => (v.entries[0]!.values!.markup = '99'),
      (v: ReturnType<typeof fixturePreview>) => (v.entries[0]!.priceReviewed = true),
      (v: ReturnType<typeof fixturePreview>) =>
        (v.entries[0]!.comparison!.before!.productRevision = 'f'.repeat(64)),
    ]) {
      const value = fixturePreview(request);
      change(value);
      expect(() => decodePreview(value, 1, request)).toThrow();
    }
    const normalized = fixturePreview(request);
    normalized.entries[0]!.values!.cost = '12.500';
    expect(() => decodePreview(normalized, 1, request)).toThrow();
    const equivalent = fixturePreview(request);
    equivalent.entries[0]!.values!.markup = '30.0000';
    expect(decodePreview(equivalent, 1, request).valid).toBe(true);
  });
});
