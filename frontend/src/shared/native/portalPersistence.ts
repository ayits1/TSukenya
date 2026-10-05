import {
  legacyProjection,
  legacyIdentityMatches,
  type LegacyCollection,
  type LegacyRecord,
} from './legacy';
import type { Json, Payload } from '../recovery/storage';
export type PortalState = {
  recordId: string;
  key: string;
  collection: LegacyCollection;
  mode: 'create' | 'edit' | 'delete';
  entry: string;
  id: string | null;
  revision: string | null;
  original: Record<string, Json>;
  metadata: {
    scope: string | null;
    store: number | null;
    ideaId: string | null;
    order: number;
    byOwner: boolean | null;
  };
  review: boolean;
};
const fail = (): never => {
  throw Error('Локальна чернетка задачі або ідеї некоректна.');
};
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || !keys.every((k) => Object.hasOwn(v, k))) fail();
};
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v) ? v : fail();
const id = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v) ? v : fail());
const revision = (v: unknown) => (typeof v === 'string' && /^[a-f0-9]{32}$/.test(v) ? v : fail());
export function recordForState(
  s: PortalState,
  permissions = { canEdit: true, canDelete: true },
): LegacyRecord {
  if (!s.id || !s.revision) fail();
  return {
    collection: s.collection,
    id: s.id ?? fail(),
    revision: s.revision ?? fail(),
    data: {
      ...s.original,
      ...(s.collection === 'tasks'
        ? { scope: s.metadata.scope, store: s.metadata.store, ideaId: s.metadata.ideaId }
        : {}),
    },
    permissions,
    managed: false,
    initiative: null,
  };
}
function terms(s: Pick<PortalState, 'collection' | 'metadata'>, value: unknown, empty = false) {
  const v = object(value);
  const keys =
    s.collection === 'tasks'
      ? ['title', 'status', 'dueDate', ...(s.metadata.scope !== 'operations' ? ['stage'] : [])]
      : s.collection === 'ideas'
        ? ['title', 'text', 'reaction']
        : ['name', 'group', 'amount', 'category'];
  exact(v, keys);
  const result = legacyProjection({
    collection: s.collection,
    id: 'validation',
    revision: 'a'.repeat(32),
    data: {
      ...v,
      ...(empty && v.title === '' ? { title: 'validation' } : {}),
      ...(s.collection === 'tasks' ? { scope: s.metadata.scope, store: s.metadata.store } : {}),
    },
    permissions: { canEdit: true, canDelete: true },
    managed: false,
    initiative: null,
  });
  if (empty && v.title === '') result.title = '';
  return result as Record<string, Json>;
}
export function decodePortalState(value: unknown): PortalState {
  const s = object(value);
  exact(s, [
    'recordId',
    'key',
    'collection',
    'mode',
    'entry',
    'id',
    'revision',
    'original',
    'metadata',
    'review',
  ]);
  const key = uuid(s.key),
    collection = s.collection;
  if (
    !['tasks', 'ideas', 'expenses'].includes(String(collection)) ||
    typeof collection !== 'string' ||
    !['create', 'edit', 'delete'].includes(String(s.mode)) ||
    typeof s.mode !== 'string' ||
    typeof s.entry !== 'string' ||
    s.entry.length > 150 ||
    s.recordId !== 'portal_' + key ||
    typeof s.review !== 'boolean'
  )
    fail();
  if (
    (collection === 'expenses' && s.mode !== 'delete') ||
    (collection === 'ideas' && s.mode === 'delete')
  )
    fail();
  if (
    (s.id === null) !== (s.revision === null) ||
    (s.mode === 'create' && s.id !== null) ||
    (s.mode !== 'create' && s.id === null)
  )
    fail();
  const m = object(s.metadata);
  exact(m, ['scope', 'store', 'ideaId', 'order', 'byOwner']);
  if (
    !(m.scope === null || m.scope === 'operations' || m.scope === 'development') ||
    !(
      m.store === null ||
      (typeof m.store === 'number' && Number.isSafeInteger(m.store) && m.store > 0)
    ) ||
    !(
      m.ideaId === null ||
      (typeof m.ideaId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(m.ideaId))
    ) ||
    typeof m.order !== 'number' ||
    !Number.isSafeInteger(m.order) ||
    m.order < 0 ||
    !(m.byOwner === null || typeof m.byOwner === 'boolean')
  )
    fail();
  if (collection !== 'tasks' && (m.scope !== null || m.store !== null || m.ideaId !== null)) fail();
  const result = {
    ...s,
    key,
    collection,
    metadata: { ...m },
    id: s.id === null ? null : id(s.id),
    revision: s.revision === null ? null : revision(s.revision),
  } as unknown as PortalState;
  result.original = terms(result, s.original, result.mode === 'create');
  return result;
}
export function decodePortalRaw(value: unknown, state: PortalState): Record<string, string> {
  const v = object(value),
    keys =
      state.mode === 'delete'
        ? []
        : state.collection === 'tasks'
          ? ['title', 'status', 'dueDate', 'stage']
          : ['title', 'text', 'reaction'];
  exact(v, keys);
  const result: Record<string, string> = {};
  for (const k of keys) {
    if (typeof v[k] !== 'string' || v[k].length > 8000) fail();
    result[k] = v[k] as string;
  }
  return result;
}
export function capturePortalTerms(s: PortalState, raw: unknown) {
  const r = decodePortalRaw(raw, s);
  if (s.mode === 'delete') return { ...s.original };
  const v: Record<string, unknown> = { ...r, title: r.title!.trim() };
  if (s.collection === 'tasks') {
    v.dueDate = r.dueDate || null;
    v.status = r.status || null;
    if (s.metadata.scope === 'operations') delete v.stage;
    else v.stage = r.stage === '' ? null : Number(r.stage);
  } else v.reaction = r.reaction || null;
  return terms(s, v);
}
export function createPortalBody(s: PortalState, raw: unknown): Record<string, Json> {
  if (s.mode !== 'create') fail();
  const t = capturePortalTerms(s, raw);
  return {
    ...t,
    ...(s.collection === 'tasks'
      ? {
          scope: s.metadata.scope,
          store: s.metadata.store,
          ...(s.metadata.ideaId ? { ideaId: s.metadata.ideaId } : {}),
        }
      : { byOwner: s.metadata.byOwner }),
    order: s.metadata.order,
  };
}
export function decodePortalPayload(value: unknown): Payload {
  const v = object(value);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodePortalState(v.baseline),
    raw = decodePortalRaw(v.draft, s);
  let first: Payload['firstIntent'] = null;
  if (v.firstIntent !== null) {
    const f = object(v.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    if (f.key !== s.key || f.possiblySent !== true) fail();
    if (s.mode === 'create') {
      if (f.method !== 'POST' || f.path !== '/api/' + s.collection || f.revision !== null) fail();
      const b = object(f.body);
      const rawBody =
        s.collection === 'tasks'
          ? {
              title: b.title,
              status: b.status,
              dueDate: b.dueDate ?? '',
              stage: b.stage === null || b.stage === undefined ? '' : String(b.stage),
            }
          : { title: b.title, text: b.text, reaction: b.reaction ?? '' };
      const expected = createPortalBody(s, rawBody);
      if (
        JSON.stringify(Object.keys(b).sort()) !== JSON.stringify(Object.keys(expected).sort()) ||
        Object.keys(expected).some((k) => expected[k] !== b[k])
      )
        fail();
      first = {
        method: 'POST',
        path: f.path as string,
        key: s.key,
        body: expected,
        revision: null,
        possiblySent: true,
      };
    } else {
      if (
        f.method !== (s.mode === 'delete' ? 'DELETE' : 'PATCH') ||
        f.path !== '/api/docs/' + s.collection + '/' + s.id ||
        f.revision !== s.revision
      )
        fail();
      if (s.mode === 'delete') {
        if (f.body !== null) fail();
      } else {
        const b = object(f.body);
        if (Object.keys(b).some((k) => !Object.hasOwn(s.original, k))) fail();
        terms(s, { ...s.original, ...b });
      }
      first = {
        method: f.method as 'PATCH' | 'DELETE',
        path: f.path as string,
        key: s.key,
        body: f.body as Json,
        revision: s.revision,
        possiblySent: true,
      };
    }
  }
  let confirmation: Json = null;
  if (v.confirmation !== null) {
    const c = object(v.confirmation);
    exact(c, ['id', 'revision', 'original', 'missing']);
    if (first || typeof c.missing !== 'boolean') fail();
    const target = id(c.id);
    if (s.id && s.id !== target) fail();
    confirmation = {
      id: target,
      revision: c.revision === null ? null : revision(c.revision),
      original: c.original === null ? null : terms(s, c.original),
      missing: c.missing === true,
    };
  }
  return { baseline: s as unknown as Json, draft: raw, firstIntent: first, confirmation };
}
export function decodePortalContext(
  value: unknown,
  state: PortalState,
  actor: { role: string; storeId: number | null; networkOwner: boolean },
  targetId: string | null = state.id,
) {
  const v = object(value);
  exact(v, [
    'collection',
    'id',
    'scope',
    'store',
    'ideaId',
    'exists',
    'role',
    'storeId',
    'networkOwner',
    'canWrite',
  ]);
  if (
    v.collection !== state.collection ||
    v.id !== targetId ||
    v.scope !== state.metadata.scope ||
    v.store !== state.metadata.store ||
    v.ideaId !== state.metadata.ideaId ||
    v.role !== actor.role ||
    v.storeId !== actor.storeId ||
    v.networkOwner !== actor.networkOwner ||
    typeof v.canWrite !== 'boolean' ||
    !(v.exists === null || typeof v.exists === 'boolean') ||
    (targetId === null) !== (v.exists === null)
  )
    fail();
  return v;
}
export function safePortalRecord(record: LegacyRecord) {
  if (record.managed || record.initiative) fail();
  return {
    terms: legacyProjection(record) as Record<string, Json>,
    metadata: {
      scope: record.collection === 'tasks' ? ((record.data.scope as string) ?? null) : null,
      store: record.collection === 'tasks' ? ((record.data.store as number) ?? null) : null,
      ideaId: record.collection === 'tasks' ? ((record.data.ideaId as string) ?? null) : null,
      order:
        typeof record.data.order === 'number' && Number.isSafeInteger(record.data.order)
          ? record.data.order
          : 0,
      byOwner: typeof record.data.byOwner === 'boolean' ? record.data.byOwner : null,
    },
  };
}
export function confirmPortalPayload(value: Payload, event: unknown): Payload {
  const p = decodePortalPayload(value),
    s = decodePortalState(p.baseline),
    e = object(event);
  exact(e, ['type', 'id', 'revision', 'original', 'draft', 'missing']);
  p.draft = decodePortalRaw(e.draft, s);
  const target = id(e.id);
  if (s.id && s.id !== target) fail();
  const rev = e.revision === null ? null : revision(e.revision),
    original = e.original === null ? null : terms(s, e.original);
  if (e.type === 'apply') {
    if (!rev || !original || (s.mode === 'create' && !p.confirmation)) fail();
    s.id = target;
    s.revision = rev;
    s.original = original ?? fail();
    s.review = false;
    if (s.mode === 'create') s.mode = 'edit';
    p.firstIntent = null;
    p.confirmation = null;
  } else if (e.type === 'identity' || e.type === 'saved') {
    const intent = p.firstIntent ?? fail();
    if (e.type === 'identity' && intent.method !== 'POST') fail();
    if (original && intent.method === 'POST') {
      const b = object(intent.body);
      for (const k of Object.keys(s.original)) if (b[k] !== original[k]) fail();
    } else if (original && intent.method === 'PATCH') {
      const expected = { ...s.original, ...object(intent.body) };
      if (Object.keys(expected).some((k) => expected[k] !== original[k])) fail();
    }
    p.firstIntent = null;
    p.confirmation = { id: target, revision: rev, original, missing: e.missing === true };
    s.review = true;
  } else if (e.type === 'missing') {
    if (
      s.mode !== 'delete' ||
      target !== s.id ||
      e.missing !== true ||
      rev !== null ||
      original !== null
    )
      fail();
    p.firstIntent = null;
    p.confirmation = { id: target, revision: null, original: null, missing: true };
    s.review = true;
  } else fail();
  p.baseline = s as unknown as Json;
  return decodePortalPayload(p);
}
export function portalIdentityMatches(s: PortalState, current: LegacyRecord) {
  const original = {
    ...recordForState({ ...s, id: current.id, revision: s.revision ?? current.revision }),
    id: current.id,
  };
  return legacyIdentityMatches(original, current) && !current.managed && !current.initiative;
}
