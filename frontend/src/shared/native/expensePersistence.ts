import { categories, legacyMoney } from './legacy';
import type { Json, Payload } from '../recovery/storage';
export const expenseKeys = ['name', 'group', 'amount', 'category'] as const;
export type ExpenseTerms = { name: string; group: string; amount: string; category: string | null };
export type ExpenseState = {
  recordId: string;
  key: string;
  id: string | null;
  revision: string | null;
  original: ExpenseTerms;
  units: string[];
  review: boolean;
  order: number;
};
const fail = (): never => {
  throw Error('Локальна чернетка статті витрат некоректна.');
};
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
  return v as Record<string, unknown>;
};
const exact = (v: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(v).length !== keys.length || !keys.every((k) => Object.hasOwn(v, k))) fail();
};
const uuid = (v: unknown): string =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v) ? v : fail();
const id = (v: unknown): string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v) ? v : fail();
const revision = (v: unknown): string =>
  typeof v === 'string' && /^[a-f0-9]{32}$/.test(v) ? v : fail();
export function decodeExpenseRaw(v: unknown) {
  const r = object(v);
  exact(r, expenseKeys);
  for (const k of expenseKeys) if (typeof r[k] !== 'string' || r[k].length > 8000) fail();
  return {
    name: r.name as string,
    group: r.group as string,
    amount: r.amount as string,
    category: r.category as string,
  };
}
export function expenseTerms(v: unknown, empty = false): ExpenseTerms {
  const r = object(v);
  exact(r, expenseKeys);
  if (
    typeof r.name !== 'string' ||
    r.name.length > 250 ||
    (!empty && !r.name.trim()) ||
    !['fixed', 'variable'].includes(String(r.group)) ||
    !(r.category === null || (typeof r.category === 'string' && categories.includes(r.category)))
  )
    fail();
  const [whole, fraction] = legacyMoney(r.amount).split('.');
  return {
    name: r.name as string,
    group: String(r.group),
    amount: String(BigInt(whole!)) + '.' + fraction,
    category: r.category as string | null,
  };
}
export function decodeExpenseState(v: unknown): ExpenseState {
  const s = object(v);
  exact(s, ['recordId', 'key', 'id', 'revision', 'original', 'units', 'review', 'order']);
  const key = uuid(s.key);
  if (
    s.recordId !== 'expense_' + key ||
    typeof s.review !== 'boolean' ||
    !Number.isSafeInteger(s.order) ||
    Number(s.order) < 0 ||
    !Array.isArray(s.units) ||
    !s.units.length ||
    s.units.some(
      (k) => typeof k !== 'string' || !expenseKeys.includes(k as (typeof expenseKeys)[number]),
    ) ||
    new Set(s.units).size !== s.units.length
  )
    fail();
  if ((s.id === null) !== (s.revision === null)) fail();
  return {
    recordId: s.recordId as string,
    key,
    id: s.id === null ? null : id(s.id),
    revision: s.revision === null ? null : revision(s.revision),
    original: expenseTerms(s.original, s.id === null),
    units: s.units as string[],
    review: s.review as boolean,
    order: s.order as number,
  };
}
export function decodeExpensePayload(v: unknown): Payload {
  const r = object(v);
  exact(r, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeExpenseState(r.baseline),
    draft = decodeExpenseRaw(r.draft);
  let first: Payload['firstIntent'] = null;
  if (r.firstIntent !== null) {
    const f = object(r.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    if (f.key !== s.key || f.possiblySent !== true) fail();
    const b = object(f.body);
    if (f.method === 'POST') {
      if (s.id !== null || f.path !== '/api/expenses' || f.revision !== null) fail();
      exact(b, ['name', 'group', 'amount', 'category', 'order']);
      const t = expenseTerms({
        name: b.name,
        group: b.group,
        amount: b.amount as number,
        category: b.category,
      });
      if (typeof b.amount !== 'number' || !Number.isFinite(b.amount) || b.order !== s.order) fail();
      first = {
        method: 'POST',
        path: f.path as string,
        key: s.key,
        body: { ...t, amount: b.amount as number, order: s.order },
        revision: null,
        possiblySent: true,
      };
    } else if (f.method === 'PATCH') {
      if (!s.id || f.path !== '/api/docs/expenses/' + s.id || f.revision !== s.revision) fail();
      if (Object.keys(b).some((k) => !s.units.includes(k))) fail();
      const t = expenseTerms({ ...s.original, ...b });
      const patch: Record<string, Json> = {};
      for (const k of Object.keys(b)) patch[k] = t[k as keyof ExpenseTerms];
      first = {
        method: 'PATCH',
        path: f.path as string,
        key: s.key,
        body: patch,
        revision: s.revision,
        possiblySent: true,
      };
    } else fail();
  }
  let confirmation: Json = null;
  if (r.confirmation !== null) {
    const c = object(r.confirmation);
    exact(c, ['id', 'revision', 'original']);
    if (first) fail();
    const target = id(c.id);
    if (s.id && s.id !== target) fail();
    confirmation = {
      id: target,
      revision: c.revision === null && c.original === null ? null : revision(c.revision),
      original: c.original === null ? null : expenseTerms(c.original),
    };
  }
  return { baseline: s as unknown as Json, draft, firstIntent: first, confirmation };
}
export function confirmExpensePayload(v: unknown, event: unknown): Payload | null {
  const p = decodeExpensePayload(v),
    s = decodeExpenseState(p.baseline),
    e = object(event);
  exact(e, ['type', 'id', 'revision', 'terms', 'draft']);
  p.draft = decodeExpenseRaw(e.draft);
  const target = id(e.id);
  if (e.type === 'identityLegacy') {
    if (
      p.firstIntent?.method !== 'POST' ||
      e.terms !== null ||
      !(
        e.revision === null ||
        (typeof e.revision === 'string' && /^[a-f0-9]{32}$/.test(e.revision))
      )
    )
      fail();
    p.firstIntent = null;
    p.confirmation = { id: target, revision: e.revision as string | null, original: null };
    s.review = true;
    p.baseline = s as unknown as Json;
    return decodeExpensePayload(p);
  }
  const rev = revision(e.revision),
    terms = expenseTerms(e.terms);
  if (s.id && s.id !== target) fail();
  if (e.type === 'saved') {
    if (!p.firstIntent) fail();
    const expected = object(p.firstIntent!.body);
    for (const k of Object.keys(expected).filter((k) => k !== 'order')) {
      const actual = terms[k as keyof ExpenseTerms];
      if (k === 'amount' ? legacyMoney(expected[k]) !== actual : expected[k] !== actual) fail();
    }
    p.firstIntent = null;
    p.confirmation = { id: target, revision: rev, original: terms };
    s.review = true;
  } else if (e.type === 'identity') {
    if (p.firstIntent?.method !== 'POST') fail();
    const expected = object(p.firstIntent!.body);
    for (const k of expenseKeys)
      if (k === 'amount' ? legacyMoney(expected[k]) !== terms.amount : expected[k] !== terms[k])
        fail();
    p.firstIntent = null;
    p.confirmation = { id: target, revision: rev, original: terms };
    s.review = true;
  } else if (e.type === 'apply') {
    s.id = target;
    s.revision = rev;
    s.original = terms;
    s.review = false;
    p.firstIntent = null;
    p.confirmation = null;
  } else if (e.type === 'complete') {
    if (!p.confirmation) fail();
    const c = object(p.confirmation);
    if (
      c.id !== target ||
      c.revision !== rev ||
      !c.original ||
      expenseKeys.some((k) => object(c.original)[k] !== terms[k])
    )
      fail();
    const raw = decodeExpenseRaw(p.draft);
    try {
      const value = expenseTerms({ ...raw, name: raw.name.trim(), category: raw.category || null });
      if (expenseKeys.every((k) => value[k] === terms[k])) return null;
    } catch {
      /* Invalid newer input remains recoverable. */
    }
    s.review = true;
  } else fail();
  p.baseline = s as unknown as Json;
  return decodeExpensePayload(p);
}
