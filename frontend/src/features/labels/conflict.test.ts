import { describe, expect, it } from 'vitest';
import { compareThreeWay, resolveThreeWay } from '../../shared/merge/threeWay';
import { LABEL_MERGE_FIELDS } from './conflict';
import type { LabelDraft } from './conflict';
import { studioConfig, studioSettings } from './fixtures';
const original = (): LabelDraft =>
  structuredClone({ config: studioConfig, settings: studioSettings });

describe('Label property comparison', () => {
  it('merges an independent font and color without materializing default sizes', () => {
    const base = original(),
      mine = original(),
      server = original();
    mine.config.styles.name = { ...mine.config.styles.name, font: 'arial' };
    server.config.styles.name = { ...server.config.styles.name, color: '#123456' };
    const merged = resolveThreeWay(base, mine, server, LABEL_MERGE_FIELDS, {});
    expect(merged?.config.styles.name).toEqual({ size: 13, font: 'arial', color: '#123456' });
    expect(merged?.config.styles.unit).toBeUndefined();
    expect(base).toEqual(original());
  });
  it('requires a choice for the same property and preserves independent changes', () => {
    const base = original(),
      mine = original(),
      server = original();
    mine.config.styles.name = { size: 18, font: 'georgia' };
    server.config.styles.name = { size: 20, color: '#ff0000' };
    const rows = compareThreeWay(base, mine, server, LABEL_MERGE_FIELDS);
    expect(rows.find((row) => row.id === 'style.name.size')).toMatchObject({
      label: 'Назва товару — Розмір шрифту',
      status: 'conflict',
    });
    expect(resolveThreeWay(base, mine, server, LABEL_MERGE_FIELDS, {})).toBeNull();
    const merged = resolveThreeWay(base, mine, server, LABEL_MERGE_FIELDS, {
      'style.name.size': 'mine',
    });
    expect(merged?.config.styles.name).toEqual({ size: 18, font: 'georgia', color: '#ff0000' });
  });
  it('treats the store list and selected store index as one atomic choice', () => {
    const base = original(),
      mine = original(),
      server = original();
    base.settings.storeNames = ['Перший', 'Другий'];
    mine.settings.storeNames = ['Перший', 'Другий'];
    mine.config.storeIdx = 1;
    server.settings.storeNames = ['Другий'];
    server.config.storeIdx = 0;
    const row = compareThreeWay(base, mine, server, LABEL_MERGE_FIELDS).find(
      (row) => row.id === 'settings.stores',
    );
    expect(row?.status).toBe('conflict');
    expect(row?.label).toBe('Магазини — список і вибраний магазин');
    const merged = resolveThreeWay(base, mine, server, LABEL_MERGE_FIELDS, {
      'settings.stores': 'server',
    });
    expect(merged?.settings.storeNames).toEqual(['Другий']);
    expect(merged?.config.storeIdx).toBe(0);
    expect(LABEL_MERGE_FIELDS.some((field) => field.id === 'config.storeIdx')).toBe(false);
  });
  it('preserves explicit removal of an override alongside server edits', () => {
    const base = original(),
      mine = original(),
      server = original();
    delete mine.config.styles.name;
    server.config.styles.price = { size: 35 };
    const merged = resolveThreeWay(base, mine, server, LABEL_MERGE_FIELDS, {});
    expect(merged?.config.styles.name).toBeUndefined();
    expect(merged?.config.styles.price).toEqual({ size: 35 });
  });
});
