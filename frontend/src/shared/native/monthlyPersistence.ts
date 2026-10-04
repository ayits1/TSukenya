/** Raw planning drafts are separate from server facts and validated Save terms. */
import type { Json, Payload } from '../recovery/storage';
import type { DraftSession } from '../recovery/session';
import * as budget from './monthlyBudget';
const fail = (): never => {
  throw Error('Чернетка бюджету не підтверджена. Поля не відновлено.');
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail();
};
const text = (v: unknown, max = 8000) => (typeof v === 'string' && v.length <= max ? v : fail());
const bool = (v: unknown) => (typeof v === 'boolean' ? v : fail());
const json = (v: unknown): Json =>
  v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number'
    ? v
    : Array.isArray(v)
      ? v.map(json)
      : Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, json(x)]));
export type MonthlyRaw = {
  month: string;
  store: string;
  planned_revenue: string;
  lines: budget.BudgetLine[];
};
export type MonthlyState = {
  recordId: string;
  key: string;
  id: string | null;
  month: string;
  store: number | null;
  original: budget.BudgetRecord | null;
  base: budget.BudgetTerms;
  needsReview: boolean;
  confirmed: boolean;
  deleted: boolean;
  pendingRefresh: boolean;
  existingReview: boolean;
};
export function decodeMonthlyRaw(value: unknown): MonthlyRaw {
  const v = obj(value);
  exact(v, ['month', 'store', 'planned_revenue', 'lines']);
  if (!Array.isArray(v.lines) || v.lines.length > 200) return fail();
  const ids = new Set<string>();
  const lines = v.lines.map((raw) => {
    const r = obj(raw);
    exact(r, ['id', 'category', 'mode', 'amount', 'rate', 'base']);
    const id = budget.uuid(r.id);
    if (ids.has(id)) fail();
    ids.add(id);
    if (typeof r.mode !== 'string' || !Object.hasOwn(budget.modes, r.mode) || r.base !== 'revenue')
      fail();
    const category = text(r.category, 36);
    if (category !== '') budget.uuid(category);
    return {
      id,
      category,
      mode: r.mode as budget.BudgetLine['mode'],
      amount: text(r.amount),
      rate: text(r.rate),
      base: 'revenue' as const,
    };
  });
  return {
    month: text(v.month, 100),
    store: text(v.store, 100),
    planned_revenue: text(v.planned_revenue),
    lines,
  };
}
function checkedTerms(v: unknown) {
  const r = obj(v);
  exact(r, ['planned_revenue', 'lines']);
  if (!Array.isArray(r.lines)) return fail();
  for (const l of r.lines) exact(obj(l), ['id', 'category', 'mode', 'amount', 'rate', 'base']);
  return budget.terms(r);
}
export function decodeMonthlyState(value: unknown): MonthlyState {
  const s = obj(value);
  exact(s, [
    'recordId',
    'key',
    'id',
    'month',
    'store',
    'original',
    'base',
    'needsReview',
    'confirmed',
    'deleted',
    'pendingRefresh',
    'existingReview',
  ]);
  const key = budget.uuid(s.key),
    recordId = text(s.recordId, 90);
  if (recordId !== 'monthly_' + key) fail();
  const id = s.id === null ? null : budget.uuid(s.id),
    month = budget.month(s.month),
    store = s.store === null ? null : budget.positive(s.store),
    base = checkedTerms(s.base);
  let original: budget.BudgetRecord | null = null;
  if (s.original !== null) {
    const r = obj(s.original);
    exact(r, ['id', 'month', 'store', 'revision', 'planned_revenue', 'lines', 'captions']);
    if (r.id !== id || r.month !== month || r.store !== store) fail();
    const terms = checkedTerms({ planned_revenue: r.planned_revenue, lines: r.lines }),
      captions = obj(r.captions);
    if (Object.keys(captions).some((k) => !terms.lines.some((l) => l.id === k))) fail();
    const checked: Record<string, string> = {};
    for (const [k, v] of Object.entries(captions)) checked[k] = text(v, 160);
    original = {
      ...terms,
      id: id || fail(),
      month,
      store,
      revision: budget.positive(r.revision),
      captions: checked,
    };
  }
  const result = {
    recordId,
    key,
    id,
    month,
    store,
    original,
    base,
    needsReview: bool(s.needsReview),
    confirmed: bool(s.confirmed),
    deleted: bool(s.deleted),
    pendingRefresh: bool(s.pendingRefresh),
    existingReview: bool(s.existingReview),
  };
  if ((result.confirmed && !id) || (result.deleted && !result.confirmed)) fail();
  return result;
}
export function decodeMonthlyPayload(value: unknown): Payload {
  const v = obj(value);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeMonthlyState(v.baseline),
    draft = decodeMonthlyRaw(v.draft);
  let first: Payload['firstIntent'] = null;
  if (v.firstIntent !== null) {
    const f = obj(v.firstIntent),
      b = obj(f.body);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const create = f.method === 'POST';
    if ((!create && f.method !== 'PUT') || f.key !== s.key || f.possiblySent !== true) fail();
    exact(
      b,
      create
        ? ['month', 'store', 'planned_revenue', 'lines', 'idempotency_key']
        : ['month', 'store', 'planned_revenue', 'lines', 'revision'],
    );
    const checked = budget.request(
      b,
      { month: s.month, store: s.store },
      create ? s.key : undefined,
      create ? undefined : s.original?.revision,
    );
    if (
      JSON.stringify(checked) !==
      JSON.stringify(
        budget.request(
          b,
          {
            month: budget.month(b.month),
            store: b.store === null ? null : budget.positive(b.store),
          },
          create ? text(b.idempotency_key, 100) : undefined,
          create ? undefined : budget.positive(b.revision),
        ),
      )
    )
      fail();
    if (
      create
        ? s.id !== null || f.path !== '/api/erp/monthly-budgets' || f.revision !== null
        : !s.id ||
          !s.original ||
          f.path !== '/api/erp/monthly-budgets/' + s.id ||
          f.revision !== s.original.revision
    )
      fail();
    first = {
      method: create ? 'POST' : 'PUT',
      path: String(f.path),
      key: s.key,
      body: json(checked),
      revision: create ? null : s.original!.revision,
      possiblySent: true,
    };
  }
  let confirmation: Json = null;
  if (v.confirmation !== null) {
    const c = obj(v.confirmation);
    exact(c, ['id', 'kind']);
    if (c.id !== s.id || !['create', 'update', 'apply'].includes(String(c.kind))) fail();
    confirmation = json(c);
  }
  return { baseline: json(s), draft: json(draft), firstIntent: first, confirmation };
}
export function decodeMonthlyContext(value: unknown, s: MonthlyState, session: DraftSession) {
  const v = obj(value);
  exact(v, [
    'resource',
    'id',
    'month',
    'store',
    'exists',
    'role',
    'storeId',
    'networkOwner',
    'canEdit',
  ]);
  if (
    v.resource !== 'monthly_budget' ||
    v.id !== s.id ||
    v.month !== s.month ||
    v.store !== s.store ||
    v.role !== session.role ||
    v.storeId !== session.storeId ||
    v.networkOwner !== session.networkOwner
  )
    throw Object.assign(Error('Доступ до бюджету змінився.'), { status: 403 });
  if (
    v.role !== 'owner' ||
    v.canEdit !== true ||
    (s.id ? typeof v.exists !== 'boolean' : v.exists !== null)
  )
    fail();
  return v;
}
export function confirmMonthlyPayload(value: unknown, event: unknown): Payload | null {
  const p = decodeMonthlyPayload(value),
    s = decodeMonthlyState(p.baseline),
    e = obj(event);
  exact(e, ['type', 'raw', 'draft']);
  const draft = decodeMonthlyRaw(e.draft);
  p.draft = json(draft);
  const body = p.firstIntent ? obj(p.firstIntent.body) : null;
  if (e.type === 'create' || e.type === 'identity') {
    if (!body || p.firstIntent?.method !== 'POST') fail();
    const request = budget.request(body, { month: s.month, store: s.store }, s.key),
      found =
        e.type === 'identity'
          ? budget.decodeIdentity(e.raw, request)
          : { confirmed: true, status: 'present', id: budget.decodeAck(e.raw, request).id };
    if (!found.confirmed) return p;
    s.id = found.id;
    s.base = budget.terms(body);
    s.original = null;
    s.confirmed = true;
    s.needsReview = true;
    s.deleted = found.status === 'deleted';
    s.pendingRefresh = true;
    p.firstIntent = null;
    p.confirmation = { id: s.id, kind: 'create' };
  } else if (e.type === 'update') {
    if (!body || p.firstIntent?.method !== 'PUT' || !s.id || !s.original) fail();
    budget.decodeAck(
      e.raw,
      budget.request(body, { month: s.month, store: s.store }, undefined, s.original!.revision),
      s.id || fail(),
    );
    s.needsReview = true;
    s.pendingRefresh = true;
    p.firstIntent = null;
    p.confirmation = { id: s.id, kind: 'update' };
  } else if (e.type === 'apply') {
    const fresh = budget.decodeCurrent(e.raw, {
      month: s.month,
      store: s.store,
      ...(s.id ? { id: s.id } : {}),
    });
    if (!fresh.canEdit) fail();
    s.id = fresh.record.id;
    s.original = fresh.record;
    s.base = budget.terms(fresh.record);
    s.needsReview = false;
    s.existingReview = false;
    s.pendingRefresh = false;
    p.firstIntent = null;
    p.confirmation = { id: s.id, kind: 'apply' };
  } else if (e.type === 'rejected') {
    const r = obj(e.raw);
    if (
      !body ||
      p.firstIntent?.method !== 'POST' ||
      r.resource !== 'monthly_budget' ||
      r.request_key !== s.key ||
      r.write_rejected !== true
    )
      fail();
    p.firstIntent = null;
  } else if (e.type === 'complete') {
    const fresh = budget.decodeCurrent(e.raw, {
      month: s.month,
      store: s.store,
      id: s.id || fail(),
    });
    if (!fresh.canEdit) fail();
    try {
      if (JSON.stringify(budget.terms(draft)) === JSON.stringify(budget.terms(fresh.record)))
        return null;
    } catch {
      /* Invalid newer fields remain separate. */
    }
    return p;
  } else fail();
  p.baseline = json(s);
  return decodeMonthlyPayload(p);
}
