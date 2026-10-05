import type { components } from '../../shared/api/stock.generated';
import type { Json, Payload } from '../../shared/recovery/storage';
import type { DraftSession } from '../../shared/recovery/session';
import { decodeAssortmentRow, normalTerm, type AssortmentRow } from './api';
export const CODEC = 'assortment_pair';
export const PATH = '/api/v1/trading/assortment/';
export type Raw = { sold: boolean; minimum: string };
export type Base = {
  recordId: string;
  warehouse: number;
  store: number;
  row: AssortmentRow;
  review: boolean;
};
export type Request = components['schemas']['AssortmentRecoveryRequest'];
export type Context = components['schemas']['AssortmentRecoveryContext'];
export type Original = components['schemas']['AssortmentRecoveryOriginal'];
export function fail(): never {
  throw Error('Некоректний запис відновлення асортименту.');
}
export const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail();
  return v as Record<string, unknown>;
};
export const exact = (v: Record<string, unknown>, fields: string[]) => {
  if (Object.keys(v).length !== fields.length || !fields.every((k) => Object.hasOwn(v, k))) fail();
};
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const id = (v: unknown): v is string =>
  text(v, 120) && !!v && !v.includes('/') && ![...v].some((c) => c.charCodeAt(0) < 32);
const revision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export const json = (v: unknown) => v as Json;
export async function recordId(warehouse: number, product: string) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([warehouse, product])),
  );
  return (
    'assortment_' + [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('')
  );
}
export function raw(v: unknown): Raw {
  const r = object(v);
  exact(r, ['sold', 'minimum']);
  if (typeof r.sold !== 'boolean' || !text(r.minimum, 1000)) fail();
  return { sold: r.sold, minimum: r.minimum };
}
export function baseline(v: unknown): Base {
  const b = object(v);
  exact(b, ['recordId', 'warehouse', 'store', 'row', 'review']);
  if (
    !text(b.recordId, 80) ||
    !/^assortment_[a-f0-9]{64}$/.test(b.recordId) ||
    !integer(b.warehouse) ||
    !integer(b.store) ||
    typeof b.review !== 'boolean'
  )
    fail();
  const row = decodeAssortmentRow(b.row);
  if (!text(row.name, 1000) || !text(row.unit, 64)) fail();
  return { recordId: b.recordId, warehouse: b.warehouse, store: b.store, row, review: b.review };
}
export function request(v: unknown): Request {
  const r = object(v);
  exact(r, ['key', 'warehouse', 'product', 'revision', 'unit', 'terms']);
  const t = object(r.terms);
  exact(t, ['sold', 'min_stock']);
  if (
    !uuid(r.key) ||
    !integer(r.warehouse) ||
    !id(r.product) ||
    !(r.revision === null || revision(r.revision)) ||
    !text(r.unit, 64) ||
    !r.unit ||
    typeof t.sold !== 'boolean' ||
    !(t.min_stock === null || text(t.min_stock, 40))
  )
    fail();
  return {
    key: r.key,
    warehouse: r.warehouse,
    product: r.product,
    revision: r.revision,
    unit: r.unit,
    terms: { sold: t.sold, min_stock: t.min_stock },
  };
}
export function decodePayload(v: unknown): Payload {
  const p = object(v);
  exact(p, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const b = baseline(p.baseline),
    d = raw(p.draft);
  if (p.firstIntent !== null) {
    const f = object(p.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const r = request(f.body);
    if (
      f.method !== 'POST' ||
      f.path !== PATH + 'execute' ||
      f.key !== r.key ||
      f.revision !== r.revision ||
      f.possiblySent !== true ||
      r.warehouse !== b.warehouse ||
      r.product !== b.row.product ||
      r.unit !== b.row.unit ||
      r.revision !== b.row.revision ||
      p.confirmation !== null
    )
      fail();
  }
  if (p.confirmation !== null) {
    const c = object(p.confirmation);
    exact(c, ['key', 'revision', 'raw']);
    raw(c.raw);
    if (!uuid(c.key) || !revision(c.revision) || !b.review) fail();
  }
  return {
    baseline: json(b),
    draft: json(d),
    firstIntent: p.firstIntent as Payload['firstIntent'],
    confirmation: json(p.confirmation),
  };
}
export function context(
  v: unknown,
  b: Pick<Base, 'warehouse' | 'row'>,
  session: DraftSession,
): Context {
  const c = object(v);
  exact(c, ['contract', 'warehouse', 'product', 'store', 'role', 'storeId', 'exists', 'row']);
  if (
    c.contract !== 'assortment-context-v1' ||
    c.warehouse !== b.warehouse ||
    c.product !== b.row.product ||
    !integer(c.store) ||
    c.role !== session.role ||
    c.storeId !== session.storeId ||
    !['owner', 'manager', 'warehouse'].includes(session.role) ||
    (session.storeId !== null && c.store !== session.storeId) ||
    typeof c.exists !== 'boolean' ||
    c.exists !== (c.row !== null)
  )
    fail();
  const row = c.row === null ? null : decodeAssortmentRow(c.row);
  if (row && (row.product !== c.product || !text(row.name, 1000) || !text(row.unit, 64))) fail();
  return { ...c, row } as Context;
}
export function acknowledgement(v: unknown, r: Request, identity = false): Original | null {
  const a = object(v);
  exact(a, [
    'contract',
    'key',
    'warehouse',
    'product',
    identity ? 'confirmed' : 'ok',
    ...(!identity || a.confirmed === true ? ['original'] : []),
  ]);
  if (
    a.contract !== 'assortment-action-v1' ||
    a.key !== r.key ||
    a.warehouse !== r.warehouse ||
    a.product !== r.product ||
    (identity ? typeof a.confirmed !== 'boolean' : a.ok !== true)
  )
    fail();
  if (identity && !a.confirmed) return null;
  const o = object(a.original);
  exact(o, ['warehouse', 'product', 'revision', 'sold', 'min_stock', 'unit']);
  if (
    o.warehouse !== r.warehouse ||
    o.product !== r.product ||
    o.unit !== r.unit ||
    o.sold !== r.terms.sold ||
    !revision(o.revision) ||
    (r.terms.min_stock === null
      ? o.min_stock !== null
      : !text(o.min_stock, 40) || normalTerm(o.min_stock) !== normalTerm(r.terms.min_stock))
  )
    fail();
  return o as Original;
}
export function confirm(value: unknown, event: unknown): Payload {
  const p = decodePayload(value),
    b = baseline(p.baseline),
    e = object(event);
  exact(e, ['type', 'value']);
  const r = request(p.firstIntent?.body);
  if (e.type === 'ack' || e.type === 'identity') {
    const original = acknowledgement(e.value, r, e.type === 'identity');
    if (!original) return p;
    return {
      ...p,
      baseline: json({ ...b, review: true }),
      firstIntent: null,
      confirmation: {
        key: r.key,
        revision: original.revision,
        raw: { sold: r.terms.sold, minimum: r.terms.min_stock ?? '' },
      },
    };
  }
  if (e.type === 'rejected') {
    const v = object(e.value);
    exact(v, ['error', 'code', 'write_rejected', 'contract', 'key', 'warehouse', 'product']);
    if (
      !text(v.error, 4000) ||
      v.write_rejected !== true ||
      v.contract !== 'assortment-action-v1' ||
      v.key !== r.key ||
      v.warehouse !== r.warehouse ||
      v.product !== r.product ||
      !['validation_error', 'revision_conflict'].includes(v.code as string)
    )
      fail();
    return { ...p, baseline: json({ ...b, review: true }), firstIntent: null };
  }
  return fail();
}
