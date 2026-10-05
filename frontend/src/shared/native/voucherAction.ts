/** Standalone action storage is not a document cache or permission grant. */
import type { Json, Payload } from '../recovery/storage';
import type { DraftSession } from '../recovery/session';
const fail = (): never => {
  throw Error('Намір дії документа не підтверджено.');
};
const object = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail();
};
const text = (v: unknown, max = 4000): string =>
  typeof v === 'string' && v.length <= max ? v : fail();
const number = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail();
const boolean = (v: unknown): boolean => (typeof v === 'boolean' ? v : fail());
const uuid = (v: unknown): string =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(text(v, 36)) ? String(v) : fail();
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
export type Action = 'post' | 'reverse' | 'delete';
const action = (v: unknown): Action =>
  v === 'post' || v === 'reverse' || v === 'delete' ? v : fail();
const kinds = new Set([
  'purchase_order',
  'receipt',
  'opening',
  'sale',
  'customer_return',
  'supplier_return',
  'transfer',
  'writeoff',
  'inventory',
  'production',
  'payment',
  'advance_allocation',
  'payment_refund',
  'expense',
  'cash_opening',
  'payroll',
  'payroll_payment',
  'customer_order',
  'debt_opening',
  'cash_transfer',
  'cash_difference',
]);
const kind = (v: unknown): string => (kinds.has(text(v, 24)) ? String(v) : fail());
const date = (v: unknown): string => {
  const t = text(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || new Date(t + 'T12:00:00Z').toISOString().slice(0, 10) !== t)
    fail();
  return t;
};
const status = (v: unknown): string =>
  ['draft', 'posted', 'reversed'].includes(text(v, 8)) ? String(v) : fail();
export type Terms = {
  key: string;
  action: Action;
  id: number;
  kind: string;
  store: number;
  expenseScope: string;
  revision: number;
  reason: string;
};
export function decodeTerms(value: unknown): Terms {
  const v = object(value);
  exact(v, ['key', 'action', 'id', 'kind', 'store', 'expenseScope', 'revision', 'reason']);
  const t = {
    key: uuid(v.key),
    action: action(v.action),
    id: number(v.id),
    kind: kind(v.kind),
    store: number(v.store),
    expenseScope: text(v.expenseScope, 8),
    revision: number(v.revision),
    reason: text(v.reason),
  };
  if (
    !['store', 'network'].includes(t.expenseScope) ||
    (t.kind !== 'expense' && t.expenseScope !== 'store') ||
    (t.action !== 'reverse' && t.reason !== '')
  )
    fail();
  return t;
}
export function termsEqual(a: unknown, b: unknown) {
  const x = decodeTerms(a),
    y = decodeTerms(b);
  return Object.keys(x).every((k) => x[k as keyof Terms] === y[k as keyof Terms]);
}
export type State = {
  recordId: string;
  terms: Terms;
  observedStatus: string;
  observedDate: string;
  needsReview: boolean;
  outcome: string | null;
};
export function decodeState(value: unknown): State {
  const v = object(value);
  exact(v, ['recordId', 'terms', 'observedStatus', 'observedDate', 'needsReview', 'outcome']);
  const recordId = text(v.recordId, 90);
  if (!recordId.startsWith('voucher_action_')) fail();
  uuid(recordId.slice(15));
  const terms = decodeTerms(v.terms),
    outcome = v.outcome === null ? null : text(v.outcome, 8);
  if (
    outcome !== null &&
    outcome !== { post: 'posted', reverse: 'reversed', delete: 'deleted' }[terms.action]
  )
    fail();
  return {
    recordId,
    terms,
    observedStatus: status(v.observedStatus),
    observedDate: date(v.observedDate),
    needsReview: boolean(v.needsReview),
    outcome,
  };
}
export function decodeRaw(value: unknown): { reason: string } {
  const v = object(value);
  exact(v, ['reason']);
  return { reason: text(v.reason) };
}
export function decodePayload(value: unknown): Payload {
  const v = object(value);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeState(v.baseline),
    raw = decodeRaw(v.draft);
  let first: Payload['firstIntent'] = null;
  if (v.firstIntent !== null) {
    const f = object(v.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    if (
      f.method !== 'POST' ||
      f.path !== '/api/v1/trading/voucher-actions/execute' ||
      f.key !== s.terms.key ||
      f.revision !== s.terms.revision ||
      f.possiblySent !== true ||
      !termsEqual(f.body, s.terms) ||
      s.outcome
    )
      fail();
    first = {
      method: 'POST',
      path: '/api/v1/trading/voucher-actions/execute',
      key: s.terms.key,
      body: json(decodeTerms(f.body)),
      revision: s.terms.revision,
      possiblySent: true,
    };
  }
  if (v.confirmation !== null) {
    const c = object(v.confirmation);
    exact(c, ['request', 'outcome']);
    if (!termsEqual(c.request, s.terms) || c.outcome !== s.outcome || s.outcome === null) fail();
  } else if (s.outcome) fail();
  return {
    baseline: json(s),
    draft: json(raw),
    firstIntent: first,
    confirmation: json(v.confirmation),
  };
}
export function decodeAck(value: unknown, terms: Terms) {
  const v = object(value);
  exact(v, ['contract', 'request', 'outcome']);
  if (
    v.contract !== 'voucher-action-v1' ||
    !termsEqual(v.request, terms) ||
    v.outcome !== { post: 'posted', reverse: 'reversed', delete: 'deleted' }[terms.action]
  )
    fail();
  return { request: decodeTerms(v.request), outcome: text(v.outcome, 8) };
}
export function decodeIdentity(value: unknown, terms: Terms) {
  const v = object(value);
  if (v.confirmed === false) {
    exact(v, ['contract', 'confirmed', 'request']);
    if (v.contract !== 'voucher-action-v1' || !termsEqual(v.request, terms)) fail();
    return null;
  }
  exact(v, ['contract', 'confirmed', 'request', 'outcome']);
  if (v.confirmed !== true) fail();
  const { confirmed, ...rest } = v;
  void confirmed;
  return decodeAck(rest, terms);
}
export function decodeContext(value: unknown, terms: Terms, session: DraftSession) {
  const v = object(value);
  exact(v, [
    'contract',
    'id',
    'kind',
    'store',
    'expenseScope',
    'action',
    'exists',
    'status',
    'revision',
    'date',
    'canExecute',
    'closedThrough',
    'role',
    'storeId',
  ]);
  if (
    v.contract !== 'voucher-action-context-v1' ||
    v.id !== terms.id ||
    v.kind !== terms.kind ||
    v.store !== terms.store ||
    v.expenseScope !== terms.expenseScope ||
    v.action !== terms.action
  )
    fail();
  if (v.role !== session.role || v.storeId !== session.storeId)
    throw Object.assign(Error('Доступ змінився.'), { status: 403 });
  const exists = boolean(v.exists);
  boolean(v.canExecute);
  if (v.storeId !== null) number(v.storeId);
  if (v.closedThrough !== null) date(v.closedThrough);
  if (exists) {
    status(v.status);
    number(v.revision);
    date(v.date);
  } else if (v.status !== null || v.revision !== null || v.date !== null || v.canExecute !== false)
    fail();
  return {
    exists,
    canExecute: v.canExecute === true,
    status: v.status === null ? null : status(v.status),
    revision: v.revision === null ? null : number(v.revision),
    date: v.date === null ? null : date(v.date),
  };
}
export function confirm(value: unknown, event: unknown): Payload | null {
  const p = decodePayload(value),
    s = decodeState(p.baseline),
    e = object(event);
  exact(e, ['type', 'raw', 'draft']);
  p.draft = json(decodeRaw(e.draft));
  if (e.type === 'ack' || e.type === 'identity') {
    if (!p.firstIntent) fail();
    const ack = e.type === 'ack' ? decodeAck(e.raw, s.terms) : decodeIdentity(e.raw, s.terms);
    if (ack) {
      s.outcome = ack.outcome;
      s.needsReview = true;
      p.firstIntent = null;
      p.confirmation = json(ack);
    }
  } else if (e.type === 'rejected') {
    const r = object(e.raw);
    if (!p.firstIntent || r.write_rejected !== true || !termsEqual(r.request, s.terms)) fail();
    p.firstIntent = null;
    s.needsReview = true;
  } else if (e.type === 'complete') {
    if (!s.outcome) fail();
    return null;
  } else fail();
  p.baseline = json(s);
  return decodePayload(p);
}
