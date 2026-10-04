import type { NativeDraft, NativeField } from './fields';

export type BudgetLine = {
  id: string;
  category: string;
  mode: 'fixed_amount' | 'variable_amount' | 'revenue_rate';
  amount: string;
  rate: string;
  base: 'revenue';
  category_name?: string;
};
export type BudgetTerms = { planned_revenue: string; lines: BudgetLine[] };
export const modes = {
  fixed_amount: 'Постійна сума',
  variable_amount: 'Змінна сума',
  revenue_rate: '% від планового виторгу',
};
const fail = (): never => {
  throw Error('Не вдалося перевірити всі поля бюджету. Чернетка збережена; повторіть читання.');
};
export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
export const uuid = (v: unknown): string =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v) ? v : fail();
export const positive = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail();
export function month(v: unknown): string {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d{2}$/.test(v) ||
    Number(v.slice(0, 4)) < 1 ||
    Number(v.slice(0, 4)) > 9998 ||
    Number(v.slice(5)) < 1 ||
    Number(v.slice(5)) > 12
  )
    return fail();
  return v;
}
/** Exact decimal normalization follows the legacy budget display/ACK rule; no Number money conversion. */
export function decimal(value: unknown, places = 2, max = 999999999999n): string {
  if (typeof value !== 'string' || value.length > 256) return fail();
  const match = value
    .trim()
    .replace(',', '.')
    .match(/^([+-]?)(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:[eE]([+-]?[0-9]+))?$/);
  if (!match) return fail();
  const fraction = match[3] ?? match[4] ?? '',
    exponent = match[5] ? Number(match[5]) : 0;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return fail();
  const digits = BigInt((match[2] || '0') + fraction),
    shift = places + exponent - fraction.length;
  let scaled: bigint;
  if (shift >= 0) scaled = digits * 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    if (digits % divisor !== 0n) return fail();
    scaled = digits / divisor;
  }
  if (match[1] === '-') scaled = -scaled;
  const factor = 10n ** BigInt(places);
  if (scaled < 0n || scaled > max * factor) return fail();
  return `${scaled / factor}.${String(scaled % factor).padStart(places, '0')}`;
}
export function lines(v: unknown): BudgetLine[] {
  if (!Array.isArray(v) || v.length > 200) return fail();
  const seen = new Set<string>();
  return v.map((raw) => {
    const r = object(raw),
      id = uuid(r.id),
      category = uuid(r.category);
    if (
      seen.has(id) ||
      typeof r.mode !== 'string' ||
      !Object.hasOwn(modes, r.mode) ||
      r.base !== 'revenue'
    )
      return fail();
    seen.add(id);
    const amount = decimal(r.amount),
      rate = decimal(r.rate, 3, 100n);
    if (r.mode === 'revenue_rate' ? amount !== '0.00' : rate !== '0.000') return fail();
    return { id, category, mode: r.mode as BudgetLine['mode'], amount, rate, base: 'revenue' };
  });
}
export function terms(v: unknown): BudgetTerms {
  const r = object(v);
  return { planned_revenue: decimal(r.planned_revenue), lines: lines(r.lines) };
}
export const encodeLines = (value: unknown): string => JSON.stringify(lines(value));
/** Structure change uses one whole-list descriptor; there is deliberately no row union. */
export function comparison(
  records: BudgetTerms[],
  names: Record<string, string> = {},
): { snapshots: NativeDraft[]; fields: NativeField[]; structural: boolean } {
  if (records.length !== 3) return fail();
  const checked = records.map(terms),
    membership = checked.map((r) => r.lines.map((l) => l.id).join('|'));
  const structural = membership.some((x) => x !== membership[0]);
  const keys = structural ? ['lines'] : checked[0]!.lines.map((l) => `row:${l.id}`);
  const snapshots: NativeDraft[] = checked.map((r) => ({
    planned_revenue: r.planned_revenue,
    ...(structural
      ? { lines: encodeLines(r.lines) }
      : Object.fromEntries(r.lines.map((l) => [`row:${l.id}`, JSON.stringify(l)]))),
  }));
  const labels: Record<string, Record<string, string>> = {};
  const format = (rows: BudgetLine[]) =>
    rows.length
      ? rows
          .map(
            (l) =>
              `${names[l.category] || l.category} · ${modes[l.mode]} · ${l.mode === 'revenue_rate' ? l.rate + ' %' : l.amount + ' грн'}`,
          )
          .join('\n')
      : 'Без рядків';
  for (const key of keys) {
    labels[key] = {};
    for (const s of snapshots) {
      const raw = String(s[key]);
      labels[key]![raw] = format(structural ? lines(JSON.parse(raw)) : lines([JSON.parse(raw)]));
    }
  }
  return {
    snapshots,
    structural,
    fields: [
      {
        id: 'planned_revenue',
        label: 'Плановий виторг місяця, грн',
        keys: ['planned_revenue'],
        decimals: ['planned_revenue'],
      },
      ...keys.map((key, i) => ({
        id: key,
        label: structural
          ? 'Склад і порядок усіх рядків'
          : `Рядок ${i + 1} · стаття та умови планування`,
        keys: [key],
        keyValueLabels: { [key]: labels[key]! },
      })),
    ],
  };
}
export function fromComparison(
  draft: NativeDraft,
  reference: BudgetTerms,
  structural: boolean,
): BudgetTerms {
  let rows: unknown;
  try {
    rows = structural
      ? JSON.parse(String(draft.lines))
      : reference.lines.map((l) => JSON.parse(String(draft[`row:${l.id}`])));
  } catch {
    return fail();
  }
  const result = terms({ planned_revenue: draft.planned_revenue, lines: rows });
  if (!structural && result.lines.some((l, i) => l.id !== reference.lines[i]?.id)) return fail();
  return result;
}

export type BudgetRecord = BudgetTerms & {
  id: string;
  month: string;
  store: number | null;
  revision: number;
  captions: Record<string, string>;
};
export type BudgetCurrent = { record: BudgetRecord; canEdit: boolean };
export type BudgetContext = { month: string; store: number | null; id?: string };
function record(v: unknown, expected: BudgetContext): BudgetRecord {
  const r = object(v),
    id = uuid(r.id),
    store = r.store === null ? null : positive(r.store);
  if (
    month(r.month) !== expected.month ||
    store !== expected.store ||
    (expected.id !== undefined && id !== uuid(expected.id))
  )
    return fail();
  const projection = terms(r),
    captions: Record<string, string> = {};
  if (!Array.isArray(r.lines)) return fail();
  for (const raw of r.lines) {
    const l = object(raw);
    if (
      typeof l.category_name !== 'string' ||
      !l.category_name.trim() ||
      l.category_name.length > 160
    )
      return fail();
    captions[uuid(l.id)] = l.category_name;
  }
  return {
    ...projection,
    id,
    month: expected.month,
    store,
    revision: positive(r.revision),
    captions,
  };
}
export function decodeCurrent(v: unknown, expected: BudgetContext): BudgetCurrent {
  const r = object(v),
    permissions = object(r.permissions);
  if (r.resource !== 'monthly_budget' || typeof permissions.canEdit !== 'boolean') return fail();
  return { record: record(r.record, expected), canEdit: permissions.canEdit };
}
export type BudgetRequest = BudgetTerms & {
  month: string;
  store: number | null;
  idempotency_key?: string;
  revision?: number;
};
export function request(
  value: unknown,
  context: BudgetContext,
  key?: string,
  revision?: number,
): BudgetRequest {
  const result: BudgetRequest = {
    ...terms(value),
    month: month(context.month),
    store: context.store === null ? null : positive(context.store),
  };
  if (key !== undefined) {
    if (typeof key !== 'string' || !key.length || key.length > 100) return fail();
    result.idempotency_key = key;
  }
  if (revision !== undefined) result.revision = positive(revision);
  return result;
}
export function decodeAck(v: unknown, submitted: BudgetRequest, expectedId?: string): BudgetRecord {
  const r = object(v),
    result = record(v, {
      month: submitted.month,
      store: submitted.store,
      ...(expectedId ? { id: expectedId } : {}),
    });
  if (
    JSON.stringify(terms(result)) !== JSON.stringify(terms(submitted)) ||
    result.revision !== (submitted.revision === undefined ? 1 : submitted.revision + 1)
  )
    return fail();
  if (
    submitted.idempotency_key !== undefined &&
    (r.resource !== 'monthly_budget' || r.request_key !== submitted.idempotency_key)
  )
    return fail();
  return result;
}
export type BudgetIdentity =
  | { confirmed: false; status: 'legacy_unknown' }
  | { confirmed: true; status: 'deleted' | 'present'; id: string; canEdit?: boolean };
export function decodeIdentity(v: unknown, submitted: BudgetRequest): BudgetIdentity {
  const r = object(v);
  if (
    r.resource !== 'monthly_budget' ||
    r.request_key !== submitted.idempotency_key ||
    typeof r.confirmed !== 'boolean'
  )
    return fail();
  if (!r.confirmed) {
    if (
      r.status !== 'legacy_unknown' ||
      ['id', 'revision', 'month', 'store', 'permissions'].some((k) => k in r)
    )
      return fail();
    return { confirmed: false, status: 'legacy_unknown' };
  }
  const id = uuid(r.id);
  if (r.month !== submitted.month || r.store !== submitted.store) return fail();
  if (r.status === 'deleted') {
    if ('revision' in r || 'permissions' in r) return fail();
    return { confirmed: true, status: 'deleted', id };
  }
  const permissions = object(r.permissions);
  if (r.status !== 'present' || typeof permissions.canEdit !== 'boolean') return fail();
  positive(r.revision);
  return { confirmed: true, status: 'present', id, canEdit: permissions.canEdit };
}
export type CategoryChoice = { id: string; name: string; active: boolean };
export function validateCategories(
  value: BudgetTerms,
  categories: CategoryChoice[],
  baseline?: BudgetTerms,
): BudgetTerms {
  const checked = terms(value),
    choices = new Map(categories.map((c) => [uuid(c.id), c])),
    prior = new Map((baseline?.lines || []).map((l) => [l.id, l.category]));
  for (const l of checked.lines) {
    const c = choices.get(l.category);
    if (!c || (!c.active && prior.get(l.id) !== l.category))
      throw Error(
        'Статтю вилучено або архівовано. Виберіть активну статтю; історичний рядок можна залишити без зміни статті.',
      );
  }
  return checked;
}
