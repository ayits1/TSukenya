import { decimalKey } from '../../shared/merge/threeWay';
import type { components } from '../../shared/api/receipt-pricing.generated';
import { createApiClient } from '../../shared/api/client';
import { decodeProduct, createCatalogApi } from '../catalog/api';
import {
  decodeOperationPriceComparison,
  decodeOperationPriceResult,
} from '../../shared/api/operationPrices';
export type Current = components['schemas']['Current'];
export type Source = components['schemas']['ReceiptSource'];
export type Proposal = components['schemas']['Proposal'];
export type Commit = components['schemas']['CommitRequest'];
export type Preview = components['schemas']['Preview'];
export type Receipt = components['schemas']['Receipt'];
export type Values = components['schemas']['PriceValues'];
const hash = /^[0-9a-f]{64}$/,
  uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  productId = /^[A-Za-z0-9_-]{1,120}$/;
function fail(): never {
  throw Error('Некоректний перегляд цін накладної.');
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail();
  return v as Record<string, unknown>;
};
const text = (v: unknown, pattern?: RegExp): string => {
  if (typeof v !== 'string' || (pattern && !pattern.test(v))) fail();
  return v;
};
const int = (v: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > max) fail();
  return Number(v);
};
const flag = (v: unknown): boolean => {
  if (typeof v !== 'boolean') fail();
  return v;
};
const list = (v: unknown, max = 200): unknown[] => {
  if (!Array.isArray(v) || v.length > max) fail();
  return v;
};
function day(v: unknown, optional = false): string {
  const s = text(v);
  if (optional && s === '') return s;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s).toISOString().slice(0, 10) !== s
  )
    fail();
  return s;
}
function decimal(v: unknown, digits: number): string {
  return text(v, new RegExp(`^\\d{1,15}(?:\\.\\d{1,${digits}})?$`));
}
function context(v: unknown): Current['priceContext'] {
  const o = object(v),
    storeId = o.storeId === null ? null : int(o.storeId),
    storeName = o.storeName === null ? null : text(o.storeName);
  if ((storeId === null) !== (storeName === null) || storeName === '') fail();
  return { storeId, storeName };
}
function source(v: unknown, id: number): Source {
  const o = object(v),
    status = text(o.status);
  if (!['draft', 'posted', 'reversed'].includes(status) || o.id !== id) fail();
  const lines = list(o.lines).map((v) => {
    const r = object(v);
    return {
      id: int(r.id),
      lineKey: text(r.lineKey, uuid),
      product: text(r.product, productId),
      name: text(r.name),
      unit: text(r.unit),
      quantity: decimal(r.quantity, 3),
      price: decimal(r.price, 4),
      amount: decimal(r.amount, 2),
      landedAmount: r.landedAmount === null ? null : decimal(r.landedAmount, 2),
      lot: text(r.lot),
      expiry: day(r.expiry, true),
    };
  });
  if (
    !lines.length ||
    new Set(lines.map((r) => r.id)).size !== lines.length ||
    new Set(lines.map((r) => r.lineKey)).size !== lines.length ||
    lines.some((r) => (status === 'posted') !== (r.landedAmount !== null))
  )
    fail();
  const cents = (value: string) =>
    BigInt(value.split('.')[0]!) * 100n + BigInt((value.split('.')[1] || '').padEnd(2, '0'));
  if (
    lines.reduce((sum, row) => sum + cents(row.amount), 0n) +
      cents(decimal(o.additionalCost, 2)) !==
    cents(decimal(o.total, 2))
  )
    fail();
  return {
    id,
    revision: int(o.revision),
    status: status as Source['status'],
    date: day(o.date),
    store: int(o.store),
    storeName: text(o.storeName),
    total: decimal(o.total, 2),
    additionalCost: decimal(o.additionalCost, 2),
    lines,
  };
}
export function decodeCurrent(v: unknown, id: number, expectedStore?: number | null): Current {
  const o = object(v),
    invoice = source(o.source, id),
    priceContext = context(o.priceContext),
    canEdit = flag(o.canEdit),
    effectiveDay = day(o.effectiveDay);
  const products = list(o.products).map(decodeProduct),
    ids = new Set(invoice.lines.map((r) => r.product));
  const canSelectNetwork = flag(o.canSelectNetwork);
  if (
    priceContext.storeId !== (expectedStore === undefined ? invoice.store : expectedStore) ||
    new Set(products.map((p) => p.id)).size !== products.length ||
    (canEdit && invoice.status === 'reversed') ||
    (!canSelectNetwork && priceContext.storeId === null) ||
    products.some(
      (p) =>
        !ids.has(p.id) ||
        !hash.test(p.revision) ||
        p.cost === null ||
        p.markup === null ||
        p.effectiveDay !== effectiveDay ||
        p.priceContext?.storeId !== priceContext.storeId,
    )
  )
    fail();
  return {
    source: invoice,
    sourceSnapshot: text(o.sourceSnapshot, hash),
    priceContext,
    effectiveDay,
    csrf: text(o.csrf, /^.{16,}$/),
    canEdit,
    canSelectNetwork,
    products,
  };
}
const sourceBinding = (v: unknown): Proposal['entries'][number]['sourceLine'] => {
  if (v === null) return null;
  const o = object(v);
  return { id: int(o.id), lineKey: text(o.lineKey, uuid) };
};
export function decodePreview(v: unknown, id: number, request: Proposal): Preview {
  const o = object(v),
    invoice = source(o.source, id),
    priceContext = context(o.priceContext),
    valid = flag(o.valid);
  const entries = list(o.entries).map((v, index) => {
    const r = object(v),
      expected = request.entries[index];
    if (!expected || r.id !== expected.id || r.revision !== expected.revision) fail();
    const sourceLine = sourceBinding(r.sourceLine);
    if (
      sourceLine?.id !== expected.sourceLine?.id ||
      sourceLine?.lineKey !== expected.sourceLine?.lineKey
    )
      fail();
    const error = r.error === null ? null : text(r.error);
    let values = null;
    if (r.values !== null) {
      const t = object(r.values);
      values = {
        cost: decimal(t.cost, 2),
        markup: decimal(t.markup, 4),
        manualPrice: flag(t.manualPrice),
        price: t.price === null ? null : decimal(t.price, 2),
      };
      if (
        values.manualPrice !== (values.price !== null) ||
        values.manualPrice !== expected.values.manualPrice ||
        decimalKey(values.cost) !== decimalKey(expected.values.cost) ||
        decimalKey(values.markup) !== decimalKey(expected.values.markup) ||
        decimalKey(values.price) !==
          decimalKey(expected.values.manualPrice ? expected.values.price : null)
      )
        fail();
    }
    const comparison = r.comparison === null ? null : decodeOperationPriceComparison(r.comparison);
    if (
      (error === null) !== (values !== null && comparison !== null) ||
      comparison?.created ||
      (comparison?.before?.productRevision &&
        comparison.before.productRevision !== expected.revision) ||
      r.priceReviewed !== expected.values.priceReviewed
    )
      fail();
    return {
      id: text(r.id, productId),
      revision: text(r.revision, hash),
      sourceLine,
      values,
      priceReviewed: flag(r.priceReviewed),
      error,
      comparison,
    };
  });
  if (
    entries.length !== request.entries.length ||
    invoice.revision !== request.sourceRevision ||
    o.sourceSnapshot !== request.sourceSnapshot ||
    priceContext.storeId !== request.priceContext.storeId ||
    valid !== entries.every((r) => r.error === null)
  )
    fail();
  return {
    source: invoice,
    sourceSnapshot: request.sourceSnapshot,
    priceContext,
    effectiveDay: day(o.effectiveDay),
    valid,
    entries,
    snapshot: text(o.snapshot, hash),
  };
}
export function decodeReceipt(v: unknown, id: number, request: Commit): Receipt {
  const o = object(v),
    invoice = source(o.source, id),
    priceContext = context(o.priceContext),
    counts = object(o.counts);
  if (
    o.ok !== true ||
    o.idempotencyKey !== request.idempotencyKey ||
    invoice.revision !== request.sourceRevision ||
    o.sourceSnapshot !== request.sourceSnapshot ||
    priceContext.storeId !== request.priceContext.storeId ||
    counts.created !== 0 ||
    counts.errors !== 0 ||
    counts.updated !== request.entries.length
  )
    fail();
  const entries = list(o.entries).map((v, index) => {
    const r = object(v),
      expected = request.entries[index],
      priceResult = decodeOperationPriceResult(r.priceResult);
    if (
      !expected ||
      r.id !== expected.id ||
      r.line !== index + 1 ||
      r.action !== 'update' ||
      priceResult.id !== expected.id ||
      priceResult.outcome !== 'updated' ||
      priceResult.before?.productRevision !== expected.revision ||
      priceResult.ordinal !== index + 1 ||
      priceResult.line !== index + 1 ||
      priceResult.context.storeId !== priceContext.storeId ||
      priceResult.after.productRevision !== r.revision
    )
      fail();
    return {
      line: index + 1,
      action: 'update' as const,
      id: expected.id,
      revision: text(r.revision, hash),
      priceResult,
    };
  });
  if (entries.length !== request.entries.length) fail();
  return {
    ok: true,
    idempotencyKey: request.idempotencyKey,
    source: invoice,
    sourceSnapshot: request.sourceSnapshot,
    priceContext,
    counts: { created: 0, updated: request.entries.length, errors: 0 },
    entries,
  };
}
export function createReceiptPricingApi() {
  let csrf: string | undefined;
  const client = createApiClient({ getCsrf: () => csrf }),
    sessions = createCatalogApi();
  const base = (id: number) => `/api/v1/receipt-pricing/${int(id)}`;
  async function freshSession(signal?: AbortSignal) {
    const session = await sessions.session(signal);
    csrf = session.csrf;
    if (signal?.aborted) throw new DOMException('Читання скасовано.', 'AbortError');
  }
  return {
    async current(id: number, store?: number | null, signal?: AbortSignal) {
      const value = await client.get(
        base(id) + (store === undefined ? '' : `?store=${store === null ? 'network' : store}`),
        (v) => decodeCurrent(v, id, store),
        signal,
      );
      csrf = value.csrf;
      return value;
    },
    async preview(id: number, body: Proposal, signal?: AbortSignal) {
      await freshSession(signal);
      return client.mutate(
        'POST',
        base(id) + '/preview',
        body,
        (v) => decodePreview(v, id, body),
        signal,
      );
    },
    async commit(id: number, body: Commit) {
      await freshSession();
      return client.mutate('POST', base(id) + '/commit', body, (v) => decodeReceipt(v, id, body));
    },
    result(id: number, body: Commit, signal?: AbortSignal) {
      return client.get(
        base(id) + '/results/' + text(body.idempotencyKey, uuid),
        (v) => decodeReceipt(v, id, body),
        signal,
      );
    },
  };
}
export type ReceiptPricingApi = ReturnType<typeof createReceiptPricingApi>;
