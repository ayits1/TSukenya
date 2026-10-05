import type { FirstIntent, Payload, Json } from '../../../shared/recovery/storage';
import type { components } from '../../../shared/api/contactTasks.generated';
export type Terms = components['schemas']['Terms'];
export type Raw = {
  title: string;
  note: string;
  due_on: string;
  assignee: string;
  status: string;
  archived: boolean;
};
export type Task = components['schemas']['Task'];
export type TaskRead = components['schemas']['Current'];
export type TaskPage = components['schemas']['Page'];
export type State = {
  recordId: string;
  id: string;
  customer: number;
  store: number;
  revision: number | null;
  base: Raw;
  needsReview: boolean;
  confirmed: boolean;
};
export const fail = (): never => {
  throw Error('Не вдалося перевірити задачу. Чернетка збережена.');
};
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
export const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail();
};
export const text = (v: unknown, max = 8000) =>
  typeof v === 'string' && v.length <= max ? v : fail();
export const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v) ? v : fail();
export const integer = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail();
const bool = (v: unknown) => (typeof v === 'boolean' ? v : fail());
export const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const day = (v: unknown) => {
  const s = text(v, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s).toISOString().slice(0, 10) !== s
  )
    fail();
  return s;
};
export const statuses = [
  { id: 'todo', label: 'Заплановано' },
  { id: 'doing', label: 'У роботі' },
  { id: 'done', label: 'Завершено' },
  { id: 'cancelled', label: 'Скасовано' },
];
export function raw(v: unknown): Raw {
  const x = obj(v);
  exact(x, ['title', 'note', 'due_on', 'assignee', 'status', 'archived']);
  return {
    title: text(x.title),
    note: text(x.note),
    due_on: text(x.due_on, 80),
    assignee: text(x.assignee, 80),
    status: text(x.status, 40),
    archived: bool(x.archived),
  };
}
export function terms(v: unknown): Terms {
  const x = obj(v);
  exact(x, ['title', 'note', 'due_on', 'assignee', 'status', 'archived']);
  const title = text(x.title, 250).trim();
  if (!title || !statuses.some((s) => s.id === x.status)) fail();
  return {
    title,
    note: text(x.note, 4000),
    due_on: x.due_on === null ? null : day(x.due_on),
    assignee: x.assignee === null ? null : integer(x.assignee),
    status: x.status as Terms['status'],
    archived: bool(x.archived),
  };
}
export const project = (t: Terms): Raw => ({
  ...t,
  due_on: t.due_on || '',
  assignee: t.assignee === null ? '' : String(t.assignee),
});
export const capture = (r: Raw) =>
  terms({
    ...r,
    due_on: r.due_on || null,
    assignee:
      r.assignee === '' ? null : /^[1-9][0-9]*$/.test(r.assignee) ? Number(r.assignee) : fail(),
  });
export function task(v: unknown): Task {
  const x = obj(v);
  exact(x, [
    'id',
    'customer',
    'store',
    'revision',
    'terms',
    'customerName',
    'customerActive',
    'storeName',
    'assigneeName',
    'assigneeActive',
    'createdAt',
    'updatedAt',
    'completedAt',
  ]);
  for (const k of ['createdAt', 'updatedAt', 'completedAt'])
    if (x[k] !== null && (typeof x[k] !== 'string' || !Number.isFinite(Date.parse(x[k])))) fail();
  return {
    id: uuid(x.id),
    customer: integer(x.customer),
    store: integer(x.store),
    revision: integer(x.revision),
    terms: terms(x.terms),
    customerName: text(x.customerName, 160),
    customerActive: bool(x.customerActive),
    storeName: text(x.storeName, 160),
    assigneeName: x.assigneeName === null ? null : text(x.assigneeName, 150),
    assigneeActive: x.assigneeActive === null ? null : bool(x.assigneeActive),
    createdAt: text(x.createdAt),
    updatedAt: text(x.updatedAt),
    completedAt: x.completedAt === null ? null : text(x.completedAt),
  };
}
export function read(v: unknown, id: string): TaskRead {
  const x = obj(v);
  exact(x, ['resource', 'record', 'permissions']);
  const p = obj(x.permissions);
  exact(p, ['canEdit']);
  if (x.resource !== 'contact_task') fail();
  const r = task(x.record);
  if (r.id !== id) fail();
  return { resource: 'contact_task', record: r, permissions: { canEdit: bool(p.canEdit) } };
}
export function array(v: unknown): unknown[] {
  return Array.isArray(v) ? v : fail();
}
export function page(v: unknown): TaskPage {
  const x = obj(v);
  exact(x, ['items', 'total', 'page', 'pages', 'summary', 'scope', 'canEdit']);
  if (
    !Array.isArray(x.items) ||
    x.items.length > 30 ||
    typeof x.total !== 'number' ||
    !Number.isSafeInteger(x.total) ||
    x.total < 0
  )
    fail();
  const p = integer(x.page),
    pages = integer(x.pages);
  if (
    pages !== Math.max(1, Math.ceil(Number(x.total) / 30)) ||
    p > pages ||
    array(x.items).length !== Math.min(30, Math.max(0, Number(x.total) - (p - 1) * 30))
  )
    fail();
  const s = obj(x.summary);
  exact(s, ['todo', 'doing', 'done', 'cancelled', 'overdue']);
  if (Object.values(s).some((v) => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0))
    fail();
  if (
    ['todo', 'doing', 'done', 'cancelled'].reduce((sum, k) => sum + Number(s[k]), 0) !== x.total ||
    Number(s.overdue) > Number(s.todo) + Number(s.doing)
  )
    fail();
  const scope = obj(x.scope);
  exact(scope, ['store', 'today']);
  return {
    items: array(x.items).map(task),
    total: Number(x.total),
    page: p,
    pages,
    summary: {
      todo: Number(s.todo),
      doing: Number(s.doing),
      done: Number(s.done),
      cancelled: Number(s.cancelled),
      overdue: Number(s.overdue),
    },
    scope: { store: scope.store === null ? null : integer(scope.store), today: day(scope.today) },
    canEdit: bool(x.canEdit),
  };
}
function pagination(x: Record<string, unknown>) {
  const items = array(x.items),
    p = integer(x.page),
    pages = integer(x.pages),
    total = Number(x.total);
  if (
    typeof x.total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    items.length > 30 ||
    pages !== Math.max(1, Math.ceil(total / 30)) ||
    p > pages ||
    items.length !== Math.min(30, Math.max(0, total - (p - 1) * 30))
  )
    fail();
  return { total, page: p, pages };
}
export function assignees(v: unknown, store: number): components['schemas']['Assignees'] {
  const x = obj(v);
  exact(x, ['store', 'items', 'total', 'page', 'pages']);
  if (x.store !== store) fail();
  const bounds = pagination(x);
  return {
    store,
    ...bounds,
    items: array(x.items).map((v) => {
      const u = obj(v);
      exact(u, ['id', 'name']);
      return { id: integer(u.id), name: text(u.name, 150) };
    }),
  };
}
export function history(v: unknown, id: string): components['schemas']['History'] {
  const x = obj(v);
  exact(x, ['resource', 'id', 'items', 'total', 'page', 'pages']);
  if (x.resource !== 'contact_task_history' || x.id !== id) fail();
  const bounds = pagination(x);
  return {
    resource: 'contact_task_history',
    id,
    ...bounds,
    items: array(x.items).map((v) => {
      const h = obj(v);
      exact(h, ['request_key', 'actor', 'action', 'at', 'revision', 'terms']);
      if (
        !['create', 'update'].includes(String(h.action)) ||
        !Number.isFinite(Date.parse(text(h.at)))
      )
        fail();
      return {
        request_key: uuid(h.request_key),
        actor: text(h.actor, 150),
        action: h.action as 'create' | 'update',
        at: text(h.at),
        revision: integer(h.revision),
        terms: terms(h.terms),
      };
    }),
  };
}
export function state(v: unknown): State {
  const x = obj(v);
  exact(x, ['recordId', 'id', 'customer', 'store', 'revision', 'base', 'needsReview', 'confirmed']);
  const id = uuid(x.id),
    recordId = text(x.recordId, 100);
  if (recordId !== 'contact_' + id) fail();
  const s = {
    recordId,
    id,
    customer: integer(x.customer),
    store: integer(x.store),
    revision: x.revision === null ? null : integer(x.revision),
    base: raw(x.base),
    needsReview: bool(x.needsReview),
    confirmed: bool(x.confirmed),
  };
  if (
    (!s.confirmed && (s.revision !== null || s.needsReview)) ||
    (s.confirmed && s.revision === null && !s.needsReview)
  )
    fail();
  return s;
}
export function payload(v: unknown): Payload {
  const x = obj(v);
  exact(x, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = state(x.baseline),
    draft = raw(x.draft);
  let first: FirstIntent | null = null;
  if (x.firstIntent !== null) {
    const f = obj(x.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const b = obj(f.body),
      creating = f.method === 'POST';
    if (
      !['POST', 'PATCH'].includes(String(f.method)) ||
      f.possiblySent !== true ||
      f.key !== uuid(b.request_key)
    )
      fail();
    exact(
      b,
      creating
        ? ['id', 'request_key', 'customer', 'store', 'terms']
        : ['request_key', 'revision', 'terms'],
    );
    const t = terms(b.terms);
    if (
      creating
        ? s.confirmed ||
          b.id !== s.id ||
          b.customer !== s.customer ||
          b.store !== s.store ||
          f.revision !== null ||
          f.path !== '/api/v1/crm/contact-tasks' ||
          t.status !== 'todo' ||
          t.archived
        : !s.confirmed ||
          s.revision === null ||
          b.revision !== s.revision ||
          f.revision !== s.revision ||
          f.path !== '/api/v1/crm/contact-tasks/' + s.id
    )
      fail();
    first = {
      method: creating ? 'POST' : 'PATCH',
      path: String(f.path),
      key: String(f.key),
      body: json(b),
      revision: creating ? null : s.revision,
      possiblySent: true,
    };
  }
  if (x.confirmation !== null) {
    const c = obj(x.confirmation);
    exact(c, ['id', 'action']);
    if (c.id !== s.id || !['create', 'update', 'apply'].includes(String(c.action)) || !s.confirmed)
      fail();
  }
  return {
    baseline: json(s),
    draft: json(draft),
    firstIntent: first,
    confirmation: json(x.confirmation),
  };
}
export function ack(v: unknown, p: Payload, identity = false) {
  const x = obj(v),
    s = state(p.baseline),
    f = p.firstIntent || fail(),
    b = obj(f.body),
    creating = f.method === 'POST';
  exact(
    x,
    identity
      ? [
          'confirmed',
          'resource',
          'request_key',
          'action',
          ...(x.confirmed === true ? ['original'] : []),
        ]
      : ['resource', 'request_key', 'action', 'original'],
  );
  if (
    x.resource !== 'contact_task' ||
    x.request_key !== f.key ||
    x.action !== (creating ? 'create' : 'update') ||
    (identity && typeof x.confirmed !== 'boolean')
  )
    fail();
  if (identity && x.confirmed === false) return null;
  const r = obj(x.original);
  exact(r, ['id', 'customer', 'store', 'revision', 'terms']);
  if (
    r.id !== s.id ||
    r.customer !== s.customer ||
    r.store !== s.store ||
    r.revision !== (creating ? 1 : integer(b.revision) + 1) ||
    JSON.stringify(terms(r.terms)) !== JSON.stringify(terms(b.terms))
  )
    fail();
  return r;
}
export function confirm(v: unknown, event: unknown): Payload | null {
  const p = payload(v),
    s = state(p.baseline),
    e = obj(event);
  exact(e, ['type', 'raw', 'draft']);
  p.draft = json(raw(e.draft));
  if (e.type === 'ack' || e.type === 'identity') {
    const action = p.firstIntent?.method === 'PATCH' ? 'update' : 'create';
    const r = ack(e.raw, p, e.type === 'identity');
    if (!r) return p;
    s.confirmed = true;
    s.revision = null;
    s.base = project(terms(r.terms));
    s.needsReview = true;
    p.firstIntent = null;
    p.confirmation = { id: s.id, action };
  } else if (e.type === 'apply') {
    const r = read(e.raw, s.id);
    if (
      !r.permissions.canEdit ||
      r.record.customer !== s.customer ||
      r.record.store !== s.store ||
      !s.confirmed
    )
      fail();
    s.revision = r.record.revision;
    s.base = project(r.record.terms);
    s.needsReview = false;
    p.firstIntent = null;
    p.confirmation = { id: s.id, action: 'apply' };
  } else if (e.type === 'rejected') {
    const r = obj(e.raw);
    exact(r, ['error', 'write_rejected', 'resource', 'request_key', 'action']);
    if (
      !p.firstIntent ||
      r.write_rejected !== true ||
      r.resource !== 'contact_task' ||
      r.request_key !== p.firstIntent.key ||
      r.action !== 'create'
    )
      fail();
    p.firstIntent = null;
  } else if (e.type === 'complete') {
    const r = read(e.raw, s.id);
    try {
      if (JSON.stringify(capture(raw(p.draft))) === JSON.stringify(r.record.terms)) return null;
    } catch {
      /* invalid newer raw is retained */
    }
  } else fail();
  p.baseline = json(s);
  return payload(p);
}
export async function request(path: string, options: RequestInit = {}, signal?: AbortSignal) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    ...(signal ? { signal } : {}),
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw Object.assign(
      Error(
        typeof obj(value).error === 'string'
          ? String(obj(value).error)
          : 'Не вдалося прочитати задачу.',
      ),
      { status: response.status, body: value },
    );
  return value;
}
