/** Order controls use their own revision. Stored inputs never grant stock or access. */
import type { Json, Payload } from '../recovery/storage';
import type { DraftSession } from '../recovery/session';
const fail = (): never => {
  throw Error('Намір дії замовлення не підтверджено.');
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
const id = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail();
const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : fail());
const uuid = (v: unknown): string =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(text(v, 36)) ? String(v) : fail();
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const date = (v: unknown): string => {
  const s = text(v, 10),
    d = new Date(s + 'T12:00:00Z');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    s.startsWith('0000') ||
    Number.isNaN(d.getTime()) ||
    d.toISOString().slice(0, 10) !== s
  )
    fail();
  return s;
};
const decimal = (v: unknown): string =>
  /^\d+(?:\.\d{1,3})?$/.test(text(v, 80)) ? String(v) : fail();
export type Action = 'reserve' | 'release' | 'expire' | 'close' | 'expected_date';
const action = (v: unknown): Action =>
  v === 'reserve' || v === 'release' || v === 'expire' || v === 'close' || v === 'expected_date'
    ? v
    : fail();
const lifecycle = (v: unknown): string =>
  ['draft', 'approved', 'partial', 'fulfilled', 'closed', 'cancelled'].includes(text(v, 10))
    ? String(v)
    : fail();
export type Row = { line: number; quantity: string };
function rows(v: unknown): Row[] {
  if (!Array.isArray(v) || v.length > 200) return fail();
  const seen = new Set<number>();
  return v.map((x) => {
    const r = object(x);
    exact(r, ['line', 'quantity']);
    const line = id(r.line);
    if (seen.has(line)) fail();
    seen.add(line);
    return { line, quantity: text(r.quantity, 80) };
  });
}
export type Body = {
  action: Action;
  revision: number;
  idempotencyKey: string;
  reason?: string;
  expires_on?: string;
  lines?: Row[];
  reservation?: number;
  quantity?: string;
  expected_date?: string;
};
export type Terms = {
  id: number;
  kind: 'customer_order' | 'purchase_order';
  store: number;
  body: Body;
};
export function decodeTerms(value: unknown): Terms {
  const v = object(value);
  exact(v, ['id', 'kind', 'store', 'body']);
  const b = object(v.body),
    a = action(b.action);
  exact(b, [
    'action',
    'revision',
    'idempotencyKey',
    ...(a === 'reserve'
      ? ['expires_on', 'lines']
      : a === 'release'
        ? ['reservation', 'quantity', 'reason']
        : a === 'close'
          ? ['reason']
          : a === 'expected_date'
            ? ['expected_date']
            : []),
  ]);
  if (v.kind !== 'customer_order' && v.kind !== 'purchase_order') return fail();
  if (
    (a === 'reserve' && v.kind !== 'customer_order') ||
    (a === 'expected_date' && v.kind !== 'purchase_order')
  )
    fail();
  const body: Body = {
    action: a,
    revision: id(b.revision),
    idempotencyKey: uuid(b.idempotencyKey),
  };
  if (a === 'reserve') {
    body.expires_on = text(b.expires_on, 80);
    body.lines = rows(b.lines);
  }
  if (a === 'release') {
    body.reservation = id(b.reservation);
    body.quantity = text(b.quantity, 80);
    body.reason = text(b.reason);
  }
  if (a === 'close') body.reason = text(b.reason);
  if (a === 'expected_date') body.expected_date = text(b.expected_date, 80);
  return { id: id(v.id), kind: v.kind, store: id(v.store), body };
}
export function termsEqual(a: unknown, b: unknown) {
  return JSON.stringify(decodeTerms(a)) === JSON.stringify(decodeTerms(b));
}
export type Raw = {
  reason: string;
  quantity: string;
  expires_on: string;
  expected_date: string;
  lines: Row[];
};
export function decodeRaw(value: unknown): Raw {
  const v = object(value);
  exact(v, ['reason', 'quantity', 'expires_on', 'expected_date', 'lines']);
  return {
    reason: text(v.reason),
    quantity: text(v.quantity, 80),
    expires_on: text(v.expires_on, 80),
    expected_date: text(v.expected_date, 80),
    lines: rows(v.lines),
  };
}
export function capture(terms: Terms, value: unknown): Terms {
  const raw = decodeRaw(value),
    b = { ...terms.body };
  const qty = (v: string) => {
    decimal(v);
    if (!/[1-9]/.test(v)) throw Error('Вкажіть додатну кількість.');
    return v;
  };
  if (b.action === 'reserve') {
    b.expires_on = date(raw.expires_on);
    b.lines = raw.lines
      .filter((r) => r.quantity !== '')
      .map((r) => ({ ...r, quantity: qty(r.quantity) }));
    if (!b.lines.length) throw Error('Вкажіть кількість хоча б одного рядка.');
  }
  if (b.action === 'release') {
    b.quantity = qty(raw.quantity);
    b.reason = raw.reason;
  }
  if (b.action === 'close') b.reason = raw.reason;
  if ((b.action === 'close' || b.action === 'release') && !b.reason?.trim())
    throw Error('Вкажіть причину.');
  if (b.action === 'expected_date')
    b.expected_date = raw.expected_date === '' ? '' : date(raw.expected_date);
  return decodeTerms({ ...terms, body: b });
}
export type Outcome = { id: number; revision: number; state: string };
function outcome(v: unknown, t: Terms): Outcome {
  const r = object(v);
  exact(r, ['id', 'revision', 'state']);
  if (r.id !== t.id || r.revision !== t.body.revision + 1) fail();
  const state = lifecycle(r.state);
  if (t.body.action === 'close' && state !== 'closed') fail();
  return { id: id(r.id), revision: id(r.revision), state };
}
export type State = {
  recordId: string;
  terms: Terms;
  observedState: string;
  observedDate: string;
  needsReview: boolean;
  outcome: Outcome | null;
};
export function decodeState(value: unknown): State {
  const v = object(value);
  exact(v, ['recordId', 'terms', 'observedState', 'observedDate', 'needsReview', 'outcome']);
  const recordId = text(v.recordId, 90);
  if (!recordId.startsWith('order_action_')) fail();
  uuid(recordId.slice(13));
  const terms = decodeTerms(v.terms);
  return {
    recordId,
    terms,
    observedState: lifecycle(v.observedState),
    observedDate: date(v.observedDate),
    needsReview: bool(v.needsReview),
    outcome: v.outcome === null ? null : outcome(v.outcome, terms),
  };
}
export function decodeAck(value: unknown, t: Terms) {
  const v = object(value);
  exact(v, ['contract', 'request', 'outcome']);
  if (v.contract !== 'order-action-v1' || !termsEqual(v.request, t)) fail();
  return { request: decodeTerms(v.request), outcome: outcome(v.outcome, t) };
}
export function decodeIdentity(value: unknown, t: Terms) {
  const v = object(value);
  if (v.confirmed === false) {
    exact(v, ['contract', 'confirmed', 'request']);
    if (v.contract !== 'order-action-v1' || !termsEqual(v.request, t)) fail();
    return null;
  }
  exact(v, ['contract', 'confirmed', 'request', 'outcome']);
  if (v.confirmed !== true) fail();
  const { confirmed, ...rest } = v;
  void confirmed;
  return decodeAck(rest, t);
}
export function decodePayload(value: unknown): Payload {
  const v = object(value);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeState(v.baseline),
    raw = decodeRaw(v.draft);
  if (
    s.terms.body.action === 'reserve' &&
    s.terms.body.lines?.some((r) => !raw.lines.some((x) => x.line === r.line))
  )
    fail();
  let first: Payload['firstIntent'] = null;
  if (v.firstIntent !== null) {
    const f = object(v.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    if (
      f.method !== 'POST' ||
      f.path !== '/api/v1/trading/order-actions/execute' ||
      f.key !== s.terms.body.idempotencyKey ||
      f.revision !== s.terms.body.revision ||
      f.possiblySent !== true ||
      !termsEqual(f.body, s.terms) ||
      s.outcome
    )
      fail();
    first = {
      method: 'POST',
      path: '/api/v1/trading/order-actions/execute',
      key: s.terms.body.idempotencyKey,
      body: json(s.terms),
      revision: s.terms.body.revision,
      possiblySent: true,
    };
  }
  if (v.confirmation !== null) {
    const c = object(v.confirmation);
    exact(c, ['request', 'outcome']);
    if (
      !termsEqual(c.request, s.terms) ||
      JSON.stringify(outcome(c.outcome, s.terms)) !== JSON.stringify(s.outcome)
    )
      fail();
  } else if (s.outcome) fail();
  return {
    baseline: json(s),
    draft: json(raw),
    firstIntent: first,
    confirmation: json(v.confirmation),
  };
}
export function decodeContext(value: unknown, t: Terms, session: DraftSession) {
  const v = object(value);
  exact(v, [
    'contract',
    'id',
    'kind',
    'store',
    'action',
    'revision',
    'state',
    'date',
    'canExecute',
    'expected_date',
    'lines',
    'selected',
    'limits',
    'role',
    'storeId',
  ]);
  if (
    v.contract !== 'order-action-context-v1' ||
    v.id !== t.id ||
    v.kind !== t.kind ||
    v.store !== t.store ||
    v.action !== t.body.action
  )
    fail();
  if (v.role !== session.role || v.storeId !== session.storeId)
    throw Object.assign(Error('Доступ змінився.'), { status: 403 });
  const lineValues = v.lines;
  if (!Array.isArray(lineValues) || lineValues.length > 200) return fail();
  const seen = new Set<number>();
  const lines = lineValues.map((x) => {
    const r = object(x);
    exact(r, ['line', 'name', 'unit', 'quantity', 'fulfilled', 'remaining', 'reserved']);
    const line = id(r.line);
    if (seen.has(line)) fail();
    seen.add(line);
    return {
      line,
      name: text(r.name, 500),
      unit: text(r.unit, 100),
      quantity: decimal(r.quantity),
      fulfilled: decimal(r.fulfilled),
      remaining: decimal(r.remaining),
      reserved: decimal(r.reserved),
    };
  });
  let selected = null;
  if (t.body.action === 'release') {
    const r = object(v.selected);
    exact(r, ['id', 'line', 'name', 'code', 'expires_on', 'unused']);
    if (r.id !== t.body.reservation || !seen.has(id(r.line))) fail();
    selected = {
      id: id(r.id),
      line: id(r.line),
      name: text(r.name, 500),
      code: text(r.code, 250),
      expires_on: date(r.expires_on),
      unused: decimal(r.unused),
    };
  } else if (v.selected !== null) fail();
  if (
    !Array.isArray(v.limits) ||
    v.limits.length > 200 ||
    (t.body.action !== 'reserve' && v.limits.length)
  )
    return fail();
  const limits = v.limits.map((x) => {
    const r = object(x);
    exact(r, ['line', 'name', 'unit', 'needed', 'available', 'max_date', 'canReserveFull']);
    if (!seen.has(id(r.line))) fail();
    return {
      line: id(r.line),
      name: text(r.name, 500),
      unit: text(r.unit, 100),
      needed: decimal(r.needed),
      available: decimal(r.available),
      max_date: r.max_date === null ? null : date(r.max_date),
      canReserveFull: bool(r.canReserveFull),
    };
  });
  if (
    t.body.action === 'reserve' &&
    (limits.length !== lines.length || new Set(limits.map((r) => r.line)).size !== limits.length)
  )
    fail();
  return {
    revision: id(v.revision),
    state: lifecycle(v.state),
    date: date(v.date),
    canExecute: bool(v.canExecute),
    expected_date: v.expected_date === null ? null : date(v.expected_date),
    lines,
    selected,
    limits,
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
