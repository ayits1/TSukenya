import type { Json, Payload, FirstIntent } from '../../../shared/recovery/storage';
import {
  decodeEnvelope,
  decodeAcknowledgement,
  exact,
  object,
  type Envelope,
  type Acknowledgement,
} from './api';
import type { ProductDraft } from '../productMerge';
import { referenceFields } from '../api';
import { decodeManagedReference, type ManagedReference } from '../referenceManagementApi';
export const codecName = 'catalog_editor';
export type ProductRaw = {
  values: ProductDraft;
  manualAmount: string;
  creation: { field: (typeof referenceFields)[number]; value: string } | null;
};
export type ManagerRaw = {
  field: (typeof referenceFields)[number];
  recordState: ManagedReference['state'];
  source: ManagedReference | null;
  target: ManagedReference | null;
  operation: 'rename' | 'merge' | 'archive' | 'restore';
  name: string;
  reviewed: Record<string, string> | null;
};
export type Baseline = {
  recordId: string;
  kind: 'product' | 'references';
  store: number | null;
  target: string | null;
  revision: string | null;
  hidden: boolean;
  referenceIds: Partial<Record<(typeof referenceFields)[number], string>>;
  defaultMarkup: string;
  original: ProductRaw | ManagerRaw;
  intentHash: string | null;
};
export type Confirmation = { ack: Acknowledgement; envelope: Envelope };
export type CatalogPayload = {
  baseline: Baseline;
  draft: ProductRaw | ManagerRaw;
  firstIntent: FirstIntent | null;
  confirmation: Confirmation | null;
};
export const encodePayload = (v: CatalogPayload): Payload =>
  JSON.parse(JSON.stringify(v)) as Payload;
const fail = (): never => {
  throw Error('Чернетку каталогу не підтверджено.');
};
const text = (v: unknown, max = 1000): string =>
  typeof v === 'string' && v.length <= max ? v : fail();
const identifier = (v: unknown): string =>
  /^[A-Za-z0-9_-]{1,120}$/.test(text(v, 120)) ? String(v) : fail();
const token = (v: unknown): string => (/^[a-f0-9]{64}$/.test(text(v, 64)) ? String(v) : fail());
const copy = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
export function decodeProductRaw(input: unknown): ProductRaw {
  const v = object(input);
  exact(v, ['values', 'manualAmount', 'creation']);
  const d = object(v.values);
  exact(d, [
    'name',
    'type',
    'category',
    'pack',
    'size',
    'unit',
    'barcode',
    'cost',
    'markup',
    'price',
    'manualPrice',
    'promotion',
    'promotionPrice',
    'priceAt',
    'priceReviewed',
    'minStock',
    'expiryAlertDays',
  ]);
  for (const key of [
    'name',
    'type',
    'category',
    'pack',
    'size',
    'unit',
    'barcode',
    'cost',
    'markup',
    'priceAt',
    'minStock',
    'expiryAlertDays',
  ])
    text(d[key]);
  for (const key of ['price', 'promotionPrice']) if (d[key] !== null) text(d[key]);
  for (const key of ['manualPrice', 'promotion', 'priceReviewed'])
    if (typeof d[key] !== 'boolean') fail();
  text(v.manualAmount);
  if (v.creation !== null) {
    const c = object(v.creation);
    exact(c, ['field', 'value']);
    if (!referenceFields.includes(c.field as (typeof referenceFields)[number])) fail();
    text(c.value);
  }
  return structuredClone(v) as ProductRaw;
}
export function managed(input: unknown): ManagedReference | null {
  if (input === null) return null;
  const v = object(input);
  exact(v, ['id', 'field', 'value', 'parentType', 'parentId', 'state', 'mergedInto', 'revision']);
  return decodeManagedReference(v);
}
export function projectReference(v: ManagedReference | null): ManagedReference | null {
  return v
    ? {
        id: v.id,
        field: v.field,
        value: v.value,
        parentType: v.parentType,
        parentId: v.parentId,
        state: v.state,
        mergedInto: v.mergedInto,
        revision: v.revision,
      }
    : null;
}
export function decodeManagerRaw(input: unknown): ManagerRaw {
  const v = object(input);
  exact(v, ['field', 'recordState', 'source', 'target', 'operation', 'name', 'reviewed']);
  if (
    !referenceFields.includes(v.field as (typeof referenceFields)[number]) ||
    !['active', 'archived', 'merged'].includes(String(v.recordState)) ||
    !['rename', 'merge', 'archive', 'restore'].includes(String(v.operation)) ||
    typeof v.recordState !== 'string' ||
    typeof v.operation !== 'string'
  )
    fail();
  text(v.name);
  managed(v.source);
  managed(v.target);
  if (v.reviewed !== null) {
    const r = object(v.reviewed);
    const e = decodeEnvelope({
      key: r.idempotencyKey,
      operation: 'reference_commit',
      target: r.sourceId,
      store: null,
      request: r,
    });
    void e;
  }
  return structuredClone(v) as ManagerRaw;
}
export function decodeCatalogPayload(input: unknown): CatalogPayload {
  const v = object(input);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const b = object(v.baseline);
  exact(b, [
    'recordId',
    'kind',
    'store',
    'target',
    'revision',
    'hidden',
    'referenceIds',
    'defaultMarkup',
    'original',
    'intentHash',
  ]);
  identifier(b.recordId);
  if (
    !['product', 'references'].includes(String(b.kind)) ||
    typeof b.kind !== 'string' ||
    !(
      b.store === null ||
      (typeof b.store === 'number' && Number.isSafeInteger(b.store) && b.store > 0)
    ) ||
    typeof b.hidden !== 'boolean'
  )
    fail();
  if (b.target !== null) identifier(b.target);
  if (b.revision !== null) token(b.revision);
  if ((b.target === null) !== (b.revision === null)) fail();
  if (b.intentHash !== null) token(b.intentHash);
  text(b.defaultMarkup);
  const ids = object(b.referenceIds);
  for (const [key, id] of Object.entries(ids)) {
    if (!referenceFields.includes(key as (typeof referenceFields)[number])) fail();
    identifier(id);
  }
  const bound = (body: Envelope) => {
    if (
      body.store !== b.store ||
      (b.kind === 'references'
        ? body.operation !== 'reference_commit'
        : body.operation === 'reference_commit')
    )
      fail();
    if (
      !['product_create', 'reference_create'].includes(body.operation) &&
      (body.target !== b.target || body.request.revision !== b.revision)
    )
      fail();
    if (body.operation === 'product_create' && b.target !== null) fail();
  };
  const raw = b.kind === 'product' ? decodeProductRaw : decodeManagerRaw;
  raw(b.original);
  raw(v.draft);
  if (v.firstIntent !== null) {
    const i = object(v.firstIntent);
    exact(i, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const body = decodeEnvelope(i.body);
    bound(body);
    if (
      i.method !== 'POST' ||
      i.path !== '/api/v1/catalog/recovery/execute' ||
      i.key !== body.key ||
      i.possiblySent !== true ||
      i.revision !== null ||
      body.store !== b.store ||
      (b.kind === 'references'
        ? body.operation !== 'reference_commit'
        : body.operation === 'reference_commit')
    )
      fail();
  }
  if (v.confirmation !== null) {
    const c = object(v.confirmation);
    exact(c, ['ack', 'envelope']);
    const e = decodeEnvelope(c.envelope);
    bound(e);
    if (b.intentHash === null) fail();
    const ack = decodeAcknowledgement(c.ack, e, String(b.intentHash));
    if (!ack.confirmed || v.firstIntent !== null) fail();
  }
  return structuredClone(v) as unknown as CatalogPayload;
}
export function confirmed(input: Payload, value: unknown): Payload {
  const v = decodeCatalogPayload(input),
    intent = v.firstIntent,
    hash = v.baseline.intentHash;
  if (!intent || !hash) return fail();
  const e = decodeEnvelope(intent.body);
  const r = object(value);
  if (r.write_rejected === true) {
    exact(r, ['write_rejected', 'key', 'operation', 'requestHash']);
    if (r.key !== e.key || r.operation !== e.operation || r.requestHash !== hash) fail();
    return {
      baseline: copy({ ...v.baseline, intentHash: null }),
      draft: copy(v.draft),
      firstIntent: null,
      confirmation: null,
    };
  }
  const ack = decodeAcknowledgement(value, e, hash);
  if (!ack.confirmed) fail();
  return {
    baseline: copy(v.baseline),
    draft: copy(v.draft),
    firstIntent: null,
    confirmation: copy({ ack, envelope: e }),
  };
}
