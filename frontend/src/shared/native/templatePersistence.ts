import { decodeBudgetTemplate } from './budgetTemplate';
import type { Json, Payload } from '../recovery/storage';
export type TemplateState = {
  recordId: string;
  key: string;
  original: { budgetStores: number; revision: string };
  review: boolean;
};
function fail(): never {
  throw Error('Локальна чернетка кількості магазинів некоректна.');
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
  return v as Record<string, unknown>;
}
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || !keys.every((k) => Object.hasOwn(v, k))) fail();
};
const uuid = (v: unknown): string =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v) ? v : fail();
function terms(v: unknown) {
  const r = object(v);
  exact(r, ['budgetStores', 'revision']);
  if (
    !Number.isSafeInteger(r.budgetStores) ||
    Number(r.budgetStores) < 1 ||
    Number(r.budgetStores) > 1000 ||
    typeof r.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.revision)
  )
    fail();
  return { budgetStores: r.budgetStores as number, revision: r.revision };
}
export function decodeTemplateRaw(v: unknown) {
  const r = object(v);
  exact(r, ['budgetStores']);
  if (typeof r.budgetStores !== 'string' || r.budgetStores.length > 8000) fail();
  return { budgetStores: r.budgetStores };
}
export function decodeTemplateState(v: unknown): TemplateState {
  const r = object(v);
  exact(r, ['recordId', 'key', 'original', 'review']);
  const key = uuid(r.key);
  if (r.recordId !== 'template_' + key || typeof r.review !== 'boolean') fail();
  return { recordId: r.recordId, key, original: terms(r.original), review: r.review };
}
export function decodeTemplatePayload(v: unknown): Payload {
  const r = object(v);
  exact(r, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeTemplateState(r.baseline),
    draft = decodeTemplateRaw(r.draft);
  let first: Payload['firstIntent'] = null,
    confirmation: Json = null;
  if (r.firstIntent !== null) {
    const f = object(r.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const body = terms(f.body);
    if (
      f.method !== 'PATCH' ||
      f.path !== '/api/v1/portal/budget-template' ||
      f.key !== s.key ||
      f.revision !== s.original.revision ||
      body.revision !== s.original.revision ||
      f.possiblySent !== true
    )
      fail();
    first = {
      method: 'PATCH',
      path: '/api/v1/portal/budget-template',
      key: s.key,
      body,
      revision: s.original.revision,
      possiblySent: true,
    };
  }
  if (r.confirmation !== null) {
    confirmation = terms(r.confirmation);
    if (first) fail();
  }
  return { baseline: s as unknown as Json, draft, firstIntent: first, confirmation };
}
export function confirmTemplatePayload(v: unknown, event: unknown): Payload | null {
  const p = decodeTemplatePayload(v),
    s = decodeTemplateState(p.baseline),
    e = object(event);
  exact(e, ['type', 'raw', 'draft']);
  p.draft = decodeTemplateRaw(e.draft);
  const current = decodeBudgetTemplate(e.raw),
    projection = { budgetStores: current.budgetStores, revision: current.revision };
  if (e.type === 'saved') {
    if (!p.firstIntent || object(p.firstIntent.body).budgetStores !== current.budgetStores) fail();
    p.firstIntent = null;
    p.confirmation = projection;
    s.review = true;
  } else if (e.type === 'apply') {
    s.original = projection;
    s.review = false;
    p.firstIntent = null;
    p.confirmation = null;
  } else if (e.type === 'complete') {
    if (!p.confirmation || JSON.stringify(p.confirmation) !== JSON.stringify(projection)) fail();
    const raw = decodeTemplateRaw(p.draft).budgetStores,
      n = Number(raw);
    if (raw.trim() !== '' && Number.isSafeInteger(n) && n === current.budgetStores) return null;
    s.review = true;
  } else fail();
  p.baseline = s as unknown as Json;
  return decodeTemplatePayload(p);
}
