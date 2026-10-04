import { describe, it, expect } from 'vitest';
import {
  decodeDocuments,
  decodeGroups,
  decodeDraft,
  decodeLines,
  decimalText,
  createPurchasesApi,
} from './api';
import { documents, groups, group, groupQuery, fixtureApi } from './fixtures';
describe('purchases scoped API boundary', () => {
  it('rejects foreign scopes, payloads, contradictory page counts and kinds', () => {
    expect(decodeDocuments(documents, documents.query)).toEqual(documents);
    for (const changed of [
      { ...documents, total: 31 },
      { ...documents, items: [{ ...documents.items[0], payload: { secret: true } }] },
      { ...documents, policy: { ...documents.policy, store: 2 } },
      { ...documents, items: [{ ...documents.items[0], kind: 'payroll' }] },
    ])
      expect(() => decodeDocuments(changed, documents.query)).toThrow();
  });
  it('keeps whole-group totals independent of preview and rejects projection/private caches', () => {
    expect(decodeGroups(groups, groupQuery).summary.lines).toBe(205);
    expect(() =>
      decodeGroups(
        { ...groups, items: [{ ...group, preview: group.preview.slice(0, 1) }] },
        groupQuery,
      ),
    ).toThrow();
    expect(() =>
      decodeGroups({ ...groups, items: [{ ...group, binding: 'wrong' }] }, groupQuery),
    ).toThrow();
    expect(() =>
      decodeGroups({ ...groups, policy: { ...groups.policy, role: 'cashier' } }, groupQuery),
    ).toThrow();
  });
  it('binds all205 rows into disjoint explicit200/5 parts, no truncation or changed projection', async () => {
    const api = fixtureApi(),
      one = decodeDraft(await api.draft(groupQuery, group, 1), groupQuery, group, 1),
      two = decodeDraft(await api.draft(groupQuery, group, 2), groupQuery, group, 2);
    expect([one.lines.length, two.lines.length]).toEqual([200, 5]);
    expect(new Set([...one.lines, ...two.lines].map((x) => x.product)).size).toBe(205);
    expect(() =>
      decodeDraft({ ...one, lines: one.lines.slice(0, 199) }, groupQuery, group, 1),
    ).toThrow();
    expect(() => decodeDraft({ ...two, part: 1 }, groupQuery, group, 2)).toThrow();
    expect(() => decodeDraft({ ...two, binding: 'b'.repeat(64) }, groupQuery, group, 2)).toThrow();
    const page = await api.lines(groupQuery, group, 7);
    expect(decodeLines(page, groupQuery, group).items).toHaveLength(25);
    expect(() =>
      decodeLines({ ...page, group: { ...group, linesCount: 204 } }, groupQuery, group),
    ).toThrow();
  });
  it('shows money with cents and preserves four-place source prices without Number', () => {
    expect(decimalText('87.50', 2)).toBe('87,50');
    expect(decimalText('0.00', 2)).toBe('0,00');
    expect(decimalText('12.3456', 2)).toBe('12,3456');
    expect(decimalText('12345678901234567890.10', 2)).toBe('12 345 678 901 234 567 890,10');
  });
  it('sends only bounded GET reads and binds null supplier+full group fingerprint+part', async () => {
    let url = '',
      init: RequestInit | undefined;
    const api = createPurchasesApi(async (input, options) => {
      url = String(input);
      init = options;
      return new Response(
        JSON.stringify(
          await fixtureApi().draft(groupQuery, { ...group, key: '1:0', party: null }, 2),
        ),
      );
    });
    await api.draft(groupQuery, { ...group, key: '1:0', party: null }, 2);
    expect(url).toContain('party=0');
    expect(url).toContain('binding=' + group.binding);
    expect(url).toContain('part=2');
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    expect(init?.cache).toBe('no-store');
  });
});
