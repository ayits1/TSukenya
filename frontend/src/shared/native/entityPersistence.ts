/** Raw entity drafts are deliberately independent of the Save validator. */
import type { Json, Payload } from '../recovery/storage';
import type { DraftSession } from '../recovery/session';
import {
  captureEntityCreate,
  decodeEntity,
  decodeEntityReceipt,
  decodeEntityIdentity,
  entityIdentityMatches,
  type EntityResource,
  type EntityRecord,
} from './entity';
const resources = ['stores', 'warehouses', 'accounts', 'employees', 'parties'];
const fail = (): never => {
  throw Error('Чернетка довідника не підтверджена. Поля не відновлено.');
};
const object = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail();
};
const text = (v: unknown, max = 8000) => (typeof v === 'string' && v.length <= max ? v : fail());
const boolean = (v: unknown) => (typeof v === 'boolean' ? v : fail());
const uuid = (v: unknown) =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(text(v, 36)) ? String(v) : fail();
const id = (v: unknown): string =>
  typeof v === 'string' && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v)) ? v : fail();
const store = (v: unknown): number | null =>
  v === null ? null : typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail();
function json(v: unknown): Json {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.map(json);
  return Object.fromEntries(Object.entries(object(v)).map(([k, x]) => [k, json(x)]));
}
export function resource(value: unknown): EntityResource {
  const s = text(value, 20);
  return resources.includes(s) ? (s as EntityResource) : fail();
}
export function rawKeys(r: EntityResource): string[] {
  return [
    'name',
    ...(['warehouses', 'accounts', 'employees'].includes(r) ? ['store'] : []),
    ...(['accounts', 'parties'].includes(r) ? ['kind'] : []),
    ...(r === 'parties' ? ['phone', 'email', 'notes'] : []),
    ...(r === 'employees' ? ['shift_rate', 'bonus_percent', 'bonus_basis'] : []),
    ...(['stores', 'employees', 'parties'].includes(r) ? ['active'] : []),
  ];
}
export function decodeRawEntity(r: EntityResource, value: unknown): Record<string, string> {
  const v = object(value),
    keys = rawKeys(r);
  exact(v, keys);
  return Object.fromEntries(keys.map((k) => [k, text(v[k])]));
}
export type EntityState = {
  recordId: string;
  resource: EntityResource;
  key: string;
  id: string | null;
  store: number | null;
  kind: string | null;
  original: EntityRecord | null;
  needsReview: boolean;
  confirmed: boolean;
  deleted: boolean;
};
export function decodeEntityState(value: unknown): EntityState {
  const v = object(value);
  exact(v, [
    'recordId',
    'resource',
    'key',
    'id',
    'store',
    'kind',
    'original',
    'needsReview',
    'confirmed',
    'deleted',
  ]);
  const r = resource(v.resource),
    recordId = text(v.recordId, 80);
  if (!/^entity_[0-9a-f-]{36}$/.test(recordId)) fail();
  uuid(recordId.slice(7));
  const selectedId = v.id === null ? null : id(v.id);
  let original: EntityRecord | null = null;
  if (v.original !== null) {
    const o = object(v.original),
      keys = rawKeys(r).map((k) => (k === 'store' ? 'store_id' : k));
    exact(o, ['id', 'revision', ...keys]);
    original = decodeEntity(r, { type: r, ...o }, selectedId || fail());
  }
  const kind = v.kind === null ? null : text(v.kind, 20);
  if (
    kind !== null &&
    !(
      r === 'parties'
        ? ['customer', 'supplier']
        : r === 'accounts'
          ? ['cash', 'bank', 'terminal']
          : []
    ).includes(kind)
  )
    fail();
  const selectedStore = store(v.store);
  if (original && (original.store_id ?? null) !== selectedStore) fail();
  if (original && (original.kind ?? null) !== kind) fail();
  const result = {
    recordId,
    resource: r,
    key: uuid(v.key),
    id: selectedId,
    store: selectedStore,
    kind,
    original,
    needsReview: boolean(v.needsReview),
    confirmed: boolean(v.confirmed),
    deleted: boolean(v.deleted),
  };
  if ((selectedId && !original) || (result.deleted && !result.confirmed)) fail();
  return result;
}
function writable(s: EntityState, value: unknown, creating: boolean) {
  const v = object(value),
    mutable = rawKeys(s.resource).filter((k) => k !== 'store' && k !== 'kind');
  const keys = creating
    ? [...rawKeys(s.resource), 'idempotency_key']
    : [...mutable, 'id', 'revision', ...(s.store ? ['store'] : []), ...(s.kind ? ['kind'] : [])];
  exact(v, keys);
  if (creating) {
    if (v.idempotency_key !== s.key) fail();
    const body = captureEntityCreate(s.resource, v);
    if (s.store && body.store !== s.store) fail();
    if (s.kind && body.kind !== s.kind) fail();
  } else {
    if (
      v.id !== s.id ||
      v.revision !== s.original?.revision ||
      (v.store !== undefined && v.store !== s.store) ||
      (v.kind !== undefined && v.kind !== s.kind)
    )
      fail();
    decodeEntity(
      s.resource,
      { ...s.original, ...v, type: s.resource, store_id: s.store },
      s.id || fail(),
    );
  }
  return json(v);
}
export function decodeEntityPayload(value: unknown): Payload {
  const v = object(value);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeEntityState(v.baseline),
    draft = decodeRawEntity(s.resource, v.draft);
  let first: Payload['firstIntent'] = null;
  if (v.firstIntent !== null) {
    const f = object(v.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    if (
      f.method !== 'POST' ||
      f.path !== '/api/erp/entities/' + s.resource ||
      f.key !== s.key ||
      f.possiblySent !== true
    )
      fail();
    const b = object(f.body),
      creating = Object.hasOwn(b, 'idempotency_key');
    if ((creating && s.id) || (!creating && !s.id)) fail();
    if (f.revision !== (creating ? null : s.original?.revision)) fail();
    first = {
      method: 'POST',
      path: String(f.path),
      key: s.key,
      body: writable(s, b, creating),
      revision: creating ? null : text(f.revision, 32),
      possiblySent: true,
    };
  }
  let confirmation: Json = null;
  if (v.confirmation !== null) {
    const c = object(v.confirmation);
    exact(c, ['id', 'kind']);
    if (c.id !== s.id || !['create', 'update', 'apply'].includes(text(c.kind, 10))) fail();
    confirmation = json(c);
  }
  if (s.confirmed && !s.id) fail();
  return { baseline: json(s), draft: json(draft), firstIntent: first, confirmation };
}
export function decodeEntityContext(value: unknown, s: EntityState, session: DraftSession) {
  const v = object(value);
  exact(v, ['type', 'id', 'store', 'role', 'storeId', 'networkOwner', 'canCreate', 'exists']);
  if (
    typeof v.role !== 'string' ||
    !['owner', 'manager', 'accountant', 'warehouse', 'cashier'].includes(v.role)
  )
    fail();
  store(v.store);
  store(v.storeId);
  boolean(v.networkOwner);
  if (v.networkOwner !== (v.role === 'owner' && v.storeId === null)) fail();
  if (
    v.role !== session.role ||
    v.storeId !== session.storeId ||
    v.networkOwner !== session.networkOwner
  )
    throw Object.assign(Error('Доступ до чернетки змінився.'), { status: 403 });
  if (
    v.type !== s.resource ||
    v.id !== s.id ||
    v.role !== session.role ||
    v.storeId !== session.storeId ||
    v.networkOwner !== session.networkOwner ||
    v.store !==
      (s.store ??
        (['warehouses', 'accounts', 'employees'].includes(s.resource) ? session.storeId : null))
  )
    fail();
  boolean(v.canCreate);
  if (s.id ? typeof v.exists !== 'boolean' : v.exists !== null) fail();
  return { exists: v.exists, canCreate: v.canCreate };
}
export function confirmEntityPayload(value: unknown, event: unknown): Payload | null {
  const p = decodeEntityPayload(value),
    s = decodeEntityState(p.baseline),
    e = object(event);
  exact(e, ['type', 'raw', 'draft']);
  p.draft = json(decodeRawEntity(s.resource, e.draft));
  const body = p.firstIntent ? object(p.firstIntent.body) : null;
  if (e.type === 'create' || e.type === 'identity') {
    if (!body || !Object.hasOwn(body, 'idempotency_key')) fail();
    const intent = captureEntityCreate(s.resource, body || fail());
    const found =
      e.type === 'identity'
        ? decodeEntityIdentity(s.resource, e.raw, s.key, intent)
        : {
            confirmed: true as const,
            original: decodeEntityReceipt(s.resource, e.raw, s.key, intent),
            exists: true,
          };
    if (!found.confirmed) return p;
    s.id = found.original.id;
    s.original = found.original;
    s.store = store(found.original.store_id ?? null);
    s.kind = found.original.kind === undefined ? null : text(found.original.kind, 20);
    s.confirmed = true;
    s.deleted = !found.exists;
    s.needsReview = true;
    p.firstIntent = null;
    p.confirmation = { id: s.id, kind: 'create' };
  } else if (e.type === 'update') {
    const r = object(e.raw);
    exact(r, ['id']);
    if (
      !body ||
      body.id !== s.id ||
      String(r.id) !== s.id ||
      typeof r.id !== 'number' ||
      !Number.isSafeInteger(r.id)
    )
      fail();
    s.needsReview = true;
    p.firstIntent = null;
    p.confirmation = { id: s.id, kind: 'update' };
  } else if (e.type === 'apply') {
    const latest = decodeEntity(s.resource, e.raw, s.id || fail());
    if (!s.original || !entityIdentityMatches(s.original, latest)) fail();
    s.original = latest;
    s.needsReview = false;
    p.firstIntent = null;
    p.confirmation = { id: s.id, kind: 'apply' };
  } else if (e.type === 'rejected') {
    const r = object(e.raw);
    if (
      !body ||
      !Object.hasOwn(body, 'idempotency_key') ||
      r.write_rejected !== true ||
      r.request_key !== s.key ||
      r.type !== s.resource
    )
      fail();
    p.firstIntent = null;
  } else if (e.type === 'complete') {
    const latest = decodeEntity(s.resource, e.raw, s.id || fail());
    if (!s.original || !entityIdentityMatches(s.original, latest)) fail();
    const draft = decodeRawEntity(s.resource, p.draft),
      normalized = captureEntityCreate(s.resource, { ...draft, active: draft.active === 'yes' });
    const current = captureEntityCreate(s.resource, { ...latest, store: latest.store_id });
    if (JSON.stringify(normalized) !== JSON.stringify(current)) return p;
    return null;
  } else fail();
  p.baseline = json(s);
  return decodeEntityPayload(p);
}
