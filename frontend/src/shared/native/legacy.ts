import type { NativeDraft, NativeField } from './fields';
export type LegacyCollection = 'tasks' | 'ideas' | 'expenses';
export type LegacyRecord = {
  collection: LegacyCollection;
  id: string;
  revision: string;
  data: Record<string, unknown>;
  permissions: { canEdit: boolean; canDelete: boolean };
  managed: boolean;
  initiative: string | null;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (): never => {
  throw Error('Некоректні дані запису. Повторіть читання; чернетка збережена.');
};
const text = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : fail());
const optional = (v: unknown, max: number) => (v === undefined || v === null ? null : text(v, max));
export const legacyMoney = (v: unknown): string => {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/.test(s)) return fail();
  const [whole, fraction = ''] = s.split('.');
  return whole + '.' + fraction.padEnd(2, '0');
};
export function legacyProjection(record: LegacyRecord): NativeDraft {
  const d = record.data,
    collection = record.collection;
  if (collection === 'tasks') {
    const title = text(d.title, 250);
    if (!title.trim()) return fail();
    if (
      d.status !== undefined &&
      d.status !== null &&
      !(typeof d.status === 'string' && ['todo', 'doing', 'done'].includes(d.status))
    )
      return fail();
    if (
      d.scope !== undefined &&
      d.scope !== null &&
      !(typeof d.scope === 'string' && ['operations', 'development'].includes(d.scope))
    )
      return fail();
    if (
      d.store !== undefined &&
      d.store !== null &&
      !(typeof d.store === 'number' && Number.isSafeInteger(d.store) && d.store > 0)
    )
      return fail();
    const due = optional(d.dueDate, 10);
    if (
      due !== null &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(due) ||
        !Number.isFinite(Date.parse(due)) ||
        new Date(due).toISOString().slice(0, 10) !== due)
    )
      return fail();
    const result: NativeDraft = {
      title,
      status: (d.status as string | null) ?? null,
      dueDate: due,
    };
    if (d.scope !== 'operations') {
      if (
        d.stage !== undefined &&
        d.stage !== null &&
        !(typeof d.stage === 'number' && Number.isInteger(d.stage) && d.stage >= 1 && d.stage <= 4)
      )
        return fail();
      result.stage = (d.stage as number | null) ?? null;
    }
    return result;
  }
  if (collection === 'ideas') {
    const title = text(d.title, 250);
    if (!title.trim()) return fail();
    if (
      d.reaction !== undefined &&
      d.reaction !== null &&
      !(typeof d.reaction === 'string' && ['yes', 'no'].includes(d.reaction))
    )
      return fail();
    return { title, text: optional(d.text, 4000), reaction: (d.reaction as string | null) ?? null };
  }
  const name = text(d.name, 250);
  if (!name.trim() || !(typeof d.group === 'string' && ['fixed', 'variable'].includes(d.group)))
    return fail();
  const category = optional(d.category, 80);
  if (category !== null && !categories.includes(category)) return fail();
  return { name, group: d.group, amount: legacyMoney(d.amount), category };
}
export const categories = [
  'Оренда',
  'Комунальні',
  'Логістика',
  'Обслуговування',
  'Маркетинг',
  'Податки',
  'Зарплата',
  'Інше',
];
export function decodeLegacyRecord(
  v: unknown,
  collection: LegacyCollection,
  id: string,
): LegacyRecord {
  if (
    !object(v) ||
    v.collection !== collection ||
    v.id !== id ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(id) ||
    typeof v.revision !== 'string' ||
    !/^[a-f0-9]{32}$/.test(v.revision) ||
    !object(v.data) ||
    !object(v.permissions) ||
    typeof v.permissions.canEdit !== 'boolean' ||
    typeof v.permissions.canDelete !== 'boolean' ||
    typeof v.managed !== 'boolean' ||
    !(
      v.initiative === null ||
      (typeof v.initiative === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.initiative))
    )
  )
    return fail();
  const record = v as LegacyRecord;
  legacyProjection(record);
  return record;
}
export function legacyFields(record: LegacyRecord): NativeField[] {
  if (record.collection === 'tasks')
    return [
      { id: 'title', label: 'Назва задачі', keys: ['title'] },
      {
        id: 'status',
        label: 'Статус',
        keys: ['status'],
        valueLabels: { todo: 'Не почато', doing: 'В роботі', done: 'Готово' },
      },
      { id: 'dueDate', label: 'Термін', keys: ['dueDate'] },
      ...(record.data.scope !== 'operations'
        ? [{ id: 'stage', label: 'Етап розвитку', keys: ['stage'] }]
        : []),
    ];
  if (record.collection === 'ideas')
    return [
      { id: 'title', label: 'Назва ідеї', keys: ['title'] },
      { id: 'text', label: 'Опис ідеї', keys: ['text'] },
      {
        id: 'reaction',
        label: 'Рішення',
        keys: ['reaction'],
        valueLabels: { yes: 'Обрано для реалізації', no: 'Відкладено' },
      },
    ];
  return [
    { id: 'name', label: 'Назва статті', keys: ['name'] },
    {
      id: 'financialTerms',
      label: 'Сума та класифікація витрати',
      keys: ['amount', 'group', 'category'],
      decimals: ['amount'],
      labels: { amount: 'Сума, грн', group: 'Група', category: 'Категорія' },
      valueLabels: { fixed: 'Постійна', variable: 'Змінна' },
    },
  ];
}
export function legacyIdentityMatches(a: LegacyRecord, b: LegacyRecord): boolean {
  return (
    a.collection === b.collection &&
    a.id === b.id &&
    a.managed === b.managed &&
    a.initiative === b.initiative &&
    ['scope', 'store', 'ideaId'].every((k) => (a.data[k] ?? null) === (b.data[k] ?? null))
  );
}
export function legacyPatch(record: LegacyRecord, draft: NativeDraft): NativeDraft {
  const base = legacyProjection(record),
    result: NativeDraft = {};
  for (const field of legacyFields(record))
    for (const key of field.keys) if (draft[key] !== base[key]) result[key] = draft[key] ?? null;
  legacyProjection({ ...record, data: { ...record.data, ...result } });
  return result;
}
