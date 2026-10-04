/** Reload storage is a raw whitelist, independent of category Save validation. */
import type { Json, Payload } from '../recovery/storage';
import type { DraftSession } from '../recovery/session';
import {
  captureCategory,
  decodeCategory,
  decodeCategoryRead,
  confirmCategory,
  decodeCategoryIdentity,
  type Category,
} from './planningCategory';
const fail = (): never => {
  throw Error('Чернетка статті не підтверджена. Поля не відновлено.');
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail();
};
const text = (v: unknown, max = 8000) => (typeof v === 'string' && v.length <= max ? v : fail());
const bool = (v: unknown) => (typeof v === 'boolean' ? v : fail());
const uuid = (v: unknown) =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(text(v, 36)) ? String(v) : fail();
const json = (v: unknown): Json =>
  v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number'
    ? v
    : Object.fromEntries(Object.entries(object(v)).map(([k, x]) => [k, json(x)]));
export type CategoryState = {
  recordId: string;
  key: string;
  id: string | null;
  original: Category | null;
  base: { name: string; active: boolean };
  needsReview: boolean;
  confirmed: boolean;
  deleted: boolean;
};
export function decodeCategoryRaw(value: unknown) {
  const v = object(value);
  exact(v, ['name', 'active']);
  return { name: text(v.name), active: bool(v.active) };
}
export function decodeCategoryState(value: unknown): CategoryState {
  const v = object(value);
  exact(v, ['recordId', 'key', 'id', 'original', 'base', 'needsReview', 'confirmed', 'deleted']);
  const key = uuid(v.key),
    recordId = text(v.recordId, 80);
  if (!recordId.startsWith('category_')) fail();
  uuid(recordId.slice(9));
  const id = v.id === null ? null : uuid(v.id),
    original = v.original === null ? null : decodeCategory(v.original, id || fail());
  if (original) exact(object(v.original), ['id', 'name', 'active', 'revision', 'semantic_key']);
  const base = decodeCategoryRaw(v.base),
    result = {
      recordId,
      key,
      id,
      original,
      base,
      needsReview: bool(v.needsReview),
      confirmed: bool(v.confirmed),
      deleted: bool(v.deleted),
    };
  if ((original && !id) || (result.confirmed && !id) || (result.deleted && !result.confirmed))
    fail();
  return result;
}
export function decodeCategoryPayload(value: unknown): Payload {
  const v = object(value);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeCategoryState(v.baseline),
    draft = decodeCategoryRaw(v.draft);
  let first: Payload['firstIntent'] = null;
  if (v.firstIntent !== null) {
    const f = object(v.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const b = object(f.body),
      creating = f.method === 'POST';
    if (f.key !== s.key || f.possiblySent !== true || !['POST', 'PUT'].includes(String(f.method)))
      fail();
    exact(b, creating ? ['id', 'name', 'active'] : ['name', 'active', 'revision']);
    captureCategory(b as { name: string; active: boolean });
    if (
      creating
        ? s.id !== null ||
          b.id !== s.key ||
          f.path !== '/api/erp/budget-categories' ||
          f.revision !== null
        : !s.id ||
          !s.original ||
          f.path !== '/api/erp/budget-categories/' + s.id ||
          b.revision !== s.original.revision ||
          f.revision !== s.original.revision
    )
      fail();
    first = {
      method: creating ? 'POST' : 'PUT',
      path: String(f.path),
      key: s.key,
      body: json(b),
      revision: creating ? null : s.original!.revision,
      possiblySent: true,
    };
  }
  let confirmation: Json = null;
  if (v.confirmation !== null) {
    const c = object(v.confirmation);
    exact(c, ['id', 'kind']);
    if (c.id !== s.id || !['create', 'update', 'apply'].includes(String(c.kind))) fail();
    confirmation = json(c);
  }
  return { baseline: json(s), draft: json(draft), firstIntent: first, confirmation };
}
export function decodeCategoryContext(value: unknown, s: CategoryState, session: DraftSession) {
  const v = object(value);
  exact(v, ['resource', 'id', 'role', 'storeId', 'networkOwner', 'exists', 'canEdit']);
  if (
    v.resource !== 'category' ||
    v.id !== s.id ||
    v.role !== session.role ||
    v.storeId !== session.storeId ||
    v.networkOwner !== session.networkOwner
  )
    throw Object.assign(Error('Доступ до чернетки змінився.'), { status: 403 });
  if (
    v.networkOwner !== (v.role === 'owner' && v.storeId === null) ||
    v.canEdit !== (v.role === 'owner') ||
    (s.id ? typeof v.exists !== 'boolean' : v.exists !== null)
  )
    fail();
  return { canEdit: bool(v.canEdit), exists: v.exists };
}
export function confirmCategoryPayload(value: unknown, event: unknown): Payload | null {
  const p = decodeCategoryPayload(value),
    s = decodeCategoryState(p.baseline),
    e = object(event);
  exact(e, ['type', 'raw', 'draft']);
  const draft = decodeCategoryRaw(e.draft);
  p.draft = json(draft);
  const body = p.firstIntent ? object(p.firstIntent.body) : null;
  if (e.type === 'create' || e.type === 'identity') {
    if (!body || p.firstIntent?.method !== 'POST') fail();
    const intent = { id: s.key, ...captureCategory(body as { name: string; active: boolean }) };
    const found =
      e.type === 'identity'
        ? decodeCategoryIdentity(e.raw, intent)
        : {
            confirmed: true,
            status: 'present',
            id: confirmCategory(e.raw, intent, s.key, true).id,
          };
    if (!found.confirmed) return p;
    s.id = s.key;
    s.base = { name: intent.name, active: intent.active };
    s.original = null;
    s.confirmed = true;
    s.deleted = found.status === 'deleted';
    s.needsReview = true;
    p.firstIntent = null;
    p.confirmation = { id: s.id, kind: 'create' };
  } else if (e.type === 'update') {
    if (!body || p.firstIntent?.method !== 'PUT' || !s.id) fail();
    confirmCategory(
      e.raw,
      {
        ...captureCategory(body as { name: string; active: boolean }),
        revision: s.original!.revision,
      },
      s.id || fail(),
      false,
    );
    s.needsReview = true;
    p.firstIntent = null;
    p.confirmation = { id: s.id, kind: 'update' };
  } else if (e.type === 'apply') {
    const read = decodeCategoryRead(e.raw, s.id || fail()),
      row = read.record;
    if (!read.permissions.canEdit || (s.original && s.original.semantic_key !== row.semantic_key))
      fail();
    s.original = row;
    s.base = { name: row.name, active: row.active };
    s.needsReview = false;
    p.firstIntent = null;
    p.confirmation = { id: s.id, kind: 'apply' };
  } else if (e.type === 'rejected') {
    const r = object(e.raw);
    if (
      !body ||
      p.firstIntent?.method !== 'POST' ||
      r.write_rejected !== true ||
      r.resource !== 'category' ||
      r.request_key !== s.key
    )
      fail();
    p.firstIntent = null;
  } else if (e.type === 'complete') {
    const row = decodeCategoryRead(e.raw, s.id || fail()).record;
    try {
      const mine = captureCategory(draft);
      if (mine.name === row.name && mine.active === row.active) return null;
    } catch {
      /* Invalid newer input must remain a draft. */
    }
    return p;
  } else fail();
  p.baseline = json(s);
  return decodeCategoryPayload(p);
}
