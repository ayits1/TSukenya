import type { Current, Proposal, Values } from './api';
import type { MergeField } from '../../shared/merge/threeWay';
import { decimalKey, mergeEqual } from '../../shared/merge/threeWay';
export type Row = {
  selected: boolean;
  sourceLine: Proposal['entries'][number]['sourceLine'];
  values: Values;
};
export type Draft = { reason: string; rows: Record<string, Row> };
export function initialDraft(current: Current): Draft {
  return {
    reason: '',
    rows: Object.fromEntries(
      current.products.map((p) => [
        p.id,
        {
          selected: false,
          sourceLine: null,
          values: {
            cost: p.cost!,
            markup: p.markup!,
            manualPrice: p.manualPrice,
            price: p.price,
            priceReviewed: false,
          },
        },
      ]),
    ),
  };
}
/** Only exact cent values can use a .0001 invoice source. Other values need explicit entry. */
export function sourceCents(price: string): string | null {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(price);
  if (!match) return null;
  const fraction = (match[2] || '').padEnd(4, '0');
  if (fraction.slice(2) !== '00') return null;
  return `${match[1]}.${fraction.slice(0, 2)}`;
}
export function proposal(current: Current, draft: Draft): Proposal {
  return {
    sourceRevision: current.source.revision,
    sourceSnapshot: current.sourceSnapshot,
    priceContext: { storeId: current.priceContext.storeId },
    reason: draft.reason,
    entries: Object.entries(draft.rows)
      .filter(([, r]) => r.selected)
      .map(([id, row]) => {
        const product = current.products.find((p) => p.id === id);
        if (!product || product.hidden || !product.canEdit)
          throw Error(
            'Вибраний товар відсутній, прихований або недоступний. Узгодьте поточний каталог.',
          );
        return {
          id,
          revision: product.revision,
          sourceLine: row.sourceLine,
          values: { ...row.values, price: row.values.manualPrice ? row.values.price : null },
        };
      }),
  };
}
export function fields(current: Current): MergeField<Draft>[] {
  return [
    {
      id: 'reason',
      label: 'Причина перегляду',
      read: (v) => v.reason,
      write: (t, s) => ({ ...t, reason: s.reason }),
    },
    ...current.products.flatMap((p) => {
      const id = p.id;
      const write = (target: Draft, source: Draft, term: 'selected' | 'pricing') => {
        const t = target.rows[id],
          s = source.rows[id];
        if (!s) return target;
        return {
          ...target,
          rows: {
            ...target.rows,
            [id]:
              term === 'selected'
                ? { ...t!, selected: s.selected }
                : { ...t!, values: s.values, sourceLine: s.sourceLine },
          },
        };
      };
      return [
        {
          id: id + ':selected',
          label: p.name + ' · включення у перегляд',
          read: (v: Draft) => v.rows[id]?.selected,
          write: (t: Draft, s: Draft) => write(t, s, 'selected'),
        },
        {
          id: id + ':pricing',
          label: p.name + ' · закупівля й умови продажу',
          read: (v: Draft) =>
            v.rows[id] ? { values: v.rows[id]!.values, sourceLine: v.rows[id]!.sourceLine } : null,
          equal: (a: unknown, b: unknown) => {
            const key = (v: unknown) => {
              if (!v || typeof v !== 'object' || !('values' in v)) return v;
              const r = v as { values: Values; sourceLine: unknown };
              return {
                ...r,
                values: {
                  ...r.values,
                  cost: decimalKey(r.values.cost),
                  markup: decimalKey(r.values.markup),
                  price: decimalKey(r.values.price),
                },
              };
            };
            return mergeEqual(key(a), key(b));
          },
          format: (value: unknown) => {
            if (!value || typeof value !== 'object' || !('values' in value))
              return 'Товар відсутній';
            const r = value as { values: Values; sourceLine: Row['sourceLine'] };
            return `Закупівля ${r.values.cost || 'не задана'} грн; націнка ${r.values.markup || 'не задана'} %; ${r.values.manualPrice ? 'ручний продаж ' + (r.values.price || 'не задано') + ' грн' : 'продаж за формулою'}; ${r.sourceLine ? 'рядок № ' + r.sourceLine.id : 'явне введення'}; перевірено сьогодні: ${r.values.priceReviewed ? 'так' : 'ні'}`;
          },
          write: (t: Draft, s: Draft) => write(t, s, 'pricing'),
        },
      ];
    }),
  ];
}
