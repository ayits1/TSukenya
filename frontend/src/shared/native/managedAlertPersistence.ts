/** Managed lifecycle drafts are separate from editable legacy tasks. */
import type { Json, Payload, FirstIntent } from '../recovery/storage';
import type { DraftSession } from '../recovery/session';

export const actions = ['accept', 'defer', 'complete', 'resume'] as const;
export type Action = (typeof actions)[number];
export type Raw = { until: string; reason: string };
export type Task = {
  id: string;
  kind: 'auto' | 'reprint';
  title: string;
  revision: string;
  scope: string | null;
  store: number | null;
  cycle: number;
  active: boolean;
  workState: 'open' | 'accepted' | 'deferred' | 'completed' | 'resolved';
  until: string | null;
  reason: string;
};
export type Context = {
  contract: 'managed-alert-context-v1';
  role: DraftSession['role'];
  storeId: number | null;
  networkOwner: boolean;
  task: Task;
  canAct: boolean;
};
export type State = {
  recordId: string;
  key: string;
  original: Task;
  action: Action;
  review: boolean;
};
export type Receipt = {
  contract: 'managed-alert-identity-v1';
  confirmed: boolean;
  key: string;
  task: string;
  action: Action;
  observedRevision: string;
  appliedRevision?: string;
  appliedCycle?: number;
};
const fail = (): never => {
  throw Error('Чернетку системної задачі не підтверджено. Початковий запит не змінено.');
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail();
};
const text = (v: unknown, max = 8000): string =>
  typeof v === 'string' && v.length <= max ? v : fail();
const id = (v: unknown): string =>
  /^(?:auto_|reprint_)[a-f0-9]{32}$/.test(text(v, 40)) ? String(v) : fail();
const revision = (v: unknown): string => (/^[a-f0-9]{32}$/.test(text(v, 32)) ? String(v) : fail());
const uuid = (v: unknown): string =>
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(text(v, 36)) ? String(v) : fail();
const number = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail();
const nullableNumber = (v: unknown) => (v === null ? null : number(v));
const boolean = (v: unknown): boolean => (typeof v === 'boolean' ? v : fail());
const action = (v: unknown): Action =>
  typeof v === 'string' && actions.includes(v as Action) ? (v as Action) : fail();
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const day = (v: unknown): string => (/^\d{4}-\d{2}-\d{2}$/.test(text(v, 10)) ? String(v) : fail());

export function decodeRaw(value: unknown): Raw {
  const v = object(value);
  exact(v, ['until', 'reason']);
  return { until: text(v.until), reason: text(v.reason) };
}
export function decodeTask(value: unknown): Task {
  const v = object(value);
  exact(v, [
    'id',
    'kind',
    'title',
    'revision',
    'scope',
    'store',
    'cycle',
    'active',
    'workState',
    'until',
    'reason',
  ]);
  const identifier = id(v.id);
  if (
    v.kind !== (identifier.startsWith('auto_') ? 'auto' : 'reprint') ||
    typeof v.workState !== 'string' ||
    !['open', 'accepted', 'deferred', 'completed', 'resolved'].includes(v.workState) ||
    (v.scope !== null && v.scope !== 'operations' && v.scope !== 'development')
  )
    fail();
  return {
    id: identifier,
    kind: v.kind as Task['kind'],
    title: text(v.title),
    revision: revision(v.revision),
    scope: v.scope as string | null,
    store: nullableNumber(v.store),
    cycle: number(v.cycle),
    active: boolean(v.active),
    workState: v.workState as Task['workState'],
    until: v.until === null ? null : day(v.until),
    reason: text(v.reason),
  };
}
export function decodeContext(value: unknown, identifier: string, session: DraftSession): Context {
  const v = object(value);
  exact(v, ['contract', 'role', 'storeId', 'networkOwner', 'task', 'canAct']);
  if (v.contract !== 'managed-alert-context-v1') fail();
  const task = decodeTask(v.task);
  if (task.id !== id(identifier)) fail();
  if (
    v.role !== session.role ||
    nullableNumber(v.storeId) !== session.storeId ||
    boolean(v.networkOwner) !== session.networkOwner
  )
    throw Object.assign(Error('Права або сеанс змінилися. Повторіть перевірку доступу.'), {
      status: 403,
    });
  return {
    contract: 'managed-alert-context-v1',
    role: session.role,
    storeId: session.storeId,
    networkOwner: session.networkOwner,
    task,
    canAct: boolean(v.canAct),
  };
}
export function decodeState(value: unknown): State {
  const v = object(value);
  exact(v, ['recordId', 'key', 'original', 'action', 'review']);
  const recordId = text(v.recordId, 48);
  if (recordId !== 'managed_' + id(object(v.original).id)) fail();
  return {
    recordId,
    key: uuid(v.key),
    original: decodeTask(v.original),
    action: action(v.action),
    review: boolean(v.review),
  };
}
export function requestBody(state: State, raw: Raw): Record<string, Json> {
  const body: Record<string, Json> = {
    action: state.action,
    revision: state.original.revision,
    idempotencyKey: state.key,
  };
  if (state.action === 'defer') {
    if (!raw.reason.trim() || raw.reason.trim().length > 500)
      throw Error('Поясніть причину відкладення (до 500 символів).');
    body.until = day(raw.until);
    body.reason = raw.reason;
  }
  return body;
}
export function firstIntent(value: unknown): FirstIntent {
  const p = decodePayload(value),
    s = decodeState(p.baseline);
  if (p.firstIntent) return p.firstIntent;
  if (p.confirmation || s.review)
    throw Error('Спершу прочитайте поточні умови та застосуйте рішення локально.');
  return {
    method: 'POST',
    path: '/api/erp/alerts/tasks/' + s.original.id + '/actions',
    key: s.key,
    body: requestBody(s, decodeRaw(p.draft)),
    revision: s.original.revision,
    possiblySent: true,
  };
}
function receipt(value: unknown): Receipt {
  const v = object(value),
    confirmed = boolean(v.confirmed);
  exact(v, [
    'contract',
    'confirmed',
    'key',
    'task',
    'action',
    'observedRevision',
    ...(confirmed ? ['appliedRevision', 'appliedCycle'] : []),
  ]);
  if (v.contract !== 'managed-alert-identity-v1') fail();
  return {
    contract: 'managed-alert-identity-v1',
    confirmed,
    key: uuid(v.key),
    task: id(v.task),
    action: action(v.action),
    observedRevision: revision(v.observedRevision),
    ...(confirmed
      ? { appliedRevision: revision(v.appliedRevision), appliedCycle: number(v.appliedCycle) }
      : {}),
  };
}
export function decodeIdentity(value: unknown, payload: unknown): Receipt {
  const p = decodePayload(payload),
    s = decodeState(p.baseline),
    r = receipt(value);
  if (
    !p.firstIntent ||
    r.key !== s.key ||
    r.task !== s.original.id ||
    r.action !== s.action ||
    r.observedRevision !== s.original.revision
  )
    fail();
  return r;
}
export function decodePayload(value: unknown): Payload {
  const p = object(value);
  exact(p, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeState(p.baseline),
    raw = decodeRaw(p.draft);
  let first: FirstIntent | null = null,
    confirmation: Json = null;
  if (p.firstIntent !== null) {
    const f = object(p.firstIntent),
      b = object(f.body);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    exact(b, [
      'action',
      'revision',
      'idempotencyKey',
      ...(s.action === 'defer' ? ['until', 'reason'] : []),
    ]);
    const expected = requestBody(
      s,
      s.action === 'defer'
        ? { until: text(b.until), reason: text(b.reason) }
        : { until: '', reason: '' },
    );
    if (
      f.method !== 'POST' ||
      f.path !== '/api/erp/alerts/tasks/' + s.original.id + '/actions' ||
      f.key !== s.key ||
      f.revision !== s.original.revision ||
      f.possiblySent !== true ||
      Object.keys(expected).some((k) => expected[k] !== b[k])
    )
      fail();
    first = {
      method: 'POST',
      path: String(f.path),
      key: s.key,
      body: expected,
      revision: s.original.revision,
      possiblySent: true,
    };
  }
  if (p.confirmation !== null) {
    const v = object(p.confirmation);
    exact(v, ['receipt', 'raw']);
    const r = receipt(v.receipt);
    if (
      first ||
      !r.confirmed ||
      r.key !== s.key ||
      r.task !== s.original.id ||
      r.action !== s.action ||
      r.observedRevision !== s.original.revision
    )
      fail();
    confirmation = json({ receipt: r, raw: decodeRaw(v.raw) });
  }
  return { baseline: json(s), draft: raw, firstIntent: first, confirmation };
}
export function confirmPayload(value: unknown, event: unknown): Payload | null {
  const p = decodePayload(value),
    s = decodeState(p.baseline),
    e = object(event);
  if (e.type === 'identity') {
    exact(e, ['type', 'identity', 'draft']);
    const r = decodeIdentity(e.identity, p);
    if (!r.confirmed || !p.firstIntent) fail();
    const body = object((p.firstIntent ?? fail()).body);
    p.confirmation = json({
      receipt: r,
      raw:
        s.action === 'defer'
          ? { until: body.until, reason: body.reason }
          : { until: '', reason: '' },
    });
    p.firstIntent = null;
    p.draft = decodeRaw(e.draft);
    s.review = true;
  } else if (e.type === 'rejected') {
    exact(e, ['type', 'key', 'task', 'action', 'revision', 'status', 'code', 'draft']);
    if (
      !p.firstIntent ||
      s.review ||
      e.key !== s.key ||
      e.task !== s.original.id ||
      e.action !== s.action ||
      e.revision !== s.original.revision ||
      !(
        (e.status === 400 && e.code === null) ||
        (e.status === 409 && e.code === 'revision_conflict')
      )
    )
      fail();
    // The consumer supplies this only for a first live definitive response. An
    // earlier uncertain/reloaded attempt never grants this transition.
    p.firstIntent = null;
    p.draft = decodeRaw(e.draft);
    s.review = true;
  } else if (e.type === 'apply') {
    exact(e, ['type', 'current', 'draft', 'key']);
    const current = decodeTask(e.current);
    if (p.firstIntent || current.id !== s.original.id || current.kind !== s.original.kind) fail();
    s.original = current;
    s.key = uuid(e.key);
    s.review = false;
    p.confirmation = null;
    p.draft = decodeRaw(e.draft);
  } else if (e.type === 'complete') {
    exact(e, ['type', 'current']);
    const current = decodeTask(e.current);
    if (!p.confirmation || current.id !== s.original.id || current.kind !== s.original.kind) fail();
    if (
      JSON.stringify(decodeRaw(object(p.confirmation).raw)) === JSON.stringify(decodeRaw(p.draft))
    )
      return null;
    s.review = true;
  } else fail();
  p.baseline = json(s);
  return decodePayload(p);
}
