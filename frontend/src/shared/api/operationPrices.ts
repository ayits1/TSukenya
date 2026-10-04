/** Immutable operation evidence. A print always needs a separate current server proof. */
import { createApiClient } from './client';
import type { components } from './generated';
import { validateEffectivePromotion } from './effectivePricing';

type Context = components['schemas']['PriceContext'];
type Terms = components['schemas']['OperationPriceTerms'];
export type OperationPriceComparison = components['schemas']['OperationPriceComparison'];
export type OperationPriceResult = components['schemas']['OperationPriceResult'];
export type OperationPriceResultPage = components['schemas']['OperationPriceResultPage'];
export type OperationKind = OperationPriceResultPage['operation']['kind'];
export type PriceResultGroup = OperationPriceResultPage['group'];
function fail(): never {
  throw new Error('Некоректна квитанція зміни цін.');
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail();
  return v as Record<string, unknown>;
}
function text(v: unknown, pattern?: RegExp): string {
  if (typeof v !== 'string' || (pattern && !pattern.test(v))) fail();
  return v;
}
function flag(v: unknown): boolean {
  if (typeof v !== 'boolean') fail();
  return v;
}
function integer(v: unknown, min = 1, max = 100000): number {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) fail();
  return Number(v);
}
function enumValue<const T extends readonly string[]>(v: unknown, values: T): T[number] {
  const value = text(v);
  if (!values.includes(value)) fail();
  return value as T[number];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const revision = /^[0-9a-f]{64}$/;
const amount = /^\d+\.\d{2}$/;
function day(v: unknown): string {
  const value = text(v, /^\d{4}-\d{2}-\d{2}$/);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)
    fail();
  return value;
}
function context(v: unknown): Context {
  const value = object(v),
    storeId = value.storeId === null ? null : integer(value.storeId, 1, Number.MAX_SAFE_INTEGER),
    storeName = value.storeName === null ? null : text(value.storeName);
  if ((storeId === null) !== (storeName === null) || storeName === '') fail();
  return { storeId, storeName };
}
function terms(v: unknown): Terms {
  const value = object(v),
    regularPrice = text(value.regularPrice, amount),
    salePrice = text(value.salePrice, amount),
    display = object(value.display),
    promotion = flag(display.promotion),
    oldPrice = display.oldPrice === null ? null : text(display.oldPrice, amount);
  const cents = (p: string) => BigInt(p.replace('.', ''));
  if (
    cents(salePrice) > cents(regularPrice) ||
    promotion !== cents(salePrice) < cents(regularPrice) ||
    oldPrice !== (promotion ? regularPrice : null)
  )
    fail();
  // The common validator owns raw legacy/campaign terms; don't invent a second price rule.
  validateEffectivePromotion(value.effectivePromotion);
  const effectivePromotion = value.effectivePromotion;
  if (
    (effectivePromotion !== null) !== promotion ||
    (effectivePromotion &&
      (effectivePromotion.price !== salePrice ||
        (effectivePromotion.source === 'campaign' && !uuid.test(effectivePromotion.id || ''))))
  )
    fail();
  return {
    productRevision: text(value.productRevision, revision),
    effectivePriceRevision: text(value.effectivePriceRevision, revision),
    regularPrice,
    salePrice,
    effectivePromotion,
    display: { promotion, oldPrice },
  };
}
export function decodeOperationPriceComparison(v: unknown): OperationPriceComparison {
  const value = object(v),
    before = value.before === null ? null : terms(value.before),
    after = terms(value.after),
    retailChanged = flag(value.retailChanged),
    displayChanged = flag(value.displayChanged),
    created = flag(value.created);
  if (
    created !== (before === null) ||
    retailChanged !== (before !== null && before.salePrice !== after.salePrice) ||
    displayChanged !==
      (before !== null &&
        (before.display.promotion !== after.display.promotion ||
          before.display.oldPrice !== after.display.oldPrice))
  )
    fail();
  return { before, after, retailChanged, displayChanged, created };
}
function result(v: unknown): OperationPriceResult {
  const value = object(v),
    compared = decodeOperationPriceComparison(value),
    rawContext = object(value.context),
    priceContext = { ...context(rawContext), effectiveDay: day(rawContext.effectiveDay) },
    outcome = enumValue(value.outcome, ['created', 'updated', 'unchanged', 'skipped']),
    committedAt = text(value.committedAt, /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/);
  if (
    !Number.isFinite(Date.parse(committedAt)) ||
    (outcome === 'created') !== compared.created ||
    (compared.after.effectivePromotion?.source === 'campaign' &&
      !(
        compared.after.effectivePromotion.startsOn! <= priceContext.effectiveDay &&
        compared.after.effectivePromotion.endsOn! >= priceContext.effectiveDay
      )) ||
    (compared.before?.effectivePromotion?.source === 'campaign' &&
      !(
        compared.before.effectivePromotion.startsOn! <= priceContext.effectiveDay &&
        compared.before.effectivePromotion.endsOn! >= priceContext.effectiveDay
      ))
  )
    fail();
  return {
    ...compared,
    id: text(value.id, /^[A-Za-z0-9_-]{1,120}$/),
    line: value.line === null ? null : integer(value.line, 1, 1000000),
    ordinal: integer(value.ordinal),
    outcome,
    context: priceContext,
    committedAt,
  };
}
export function decodeOperationPricePage(
  v: unknown,
  expected: { kind: OperationKind; id: string; group?: PriceResultGroup; page?: number },
): OperationPriceResultPage {
  const value = object(v),
    operation = object(value.operation),
    kind = enumValue(operation.kind, ['pricing', 'import']),
    id = text(operation.id, uuid),
    comparisonUnavailable = flag(value.comparisonUnavailable),
    priceContext = value.priceContext === null ? null : context(value.priceContext),
    group = enumValue(value.group, ['all', 'retail', 'display', 'new']),
    total = integer(value.total, 0),
    pages = integer(value.pages),
    page = integer(value.page, 1, pages);
  if (
    kind !== expected.kind ||
    id !== expected.id ||
    group !== (expected.group || 'all') ||
    page !== Math.min(integer(expected.page ?? 1), pages) ||
    value.limit !== 100 ||
    pages !== Math.max(1, Math.ceil(total / 100)) ||
    comparisonUnavailable !== (priceContext === null) ||
    !Array.isArray(value.items)
  )
    fail();
  const items = value.items.map(result);
  if (
    items.length !== Math.min(100, Math.max(0, total - (page - 1) * 100)) ||
    new Set(items.map((row) => row.ordinal)).size !== items.length ||
    new Set(items.map((row) => row.id)).size !== items.length ||
    (comparisonUnavailable && total !== 0) ||
    items.some(
      (row, index) =>
        row.context.storeId !== priceContext?.storeId ||
        (index > 0 && row.ordinal <= items[index - 1]!.ordinal) ||
        (group === 'retail' && !row.retailChanged) ||
        (group === 'display' && (!row.displayChanged || row.retailChanged)) ||
        (group === 'new' && !row.created),
    )
  )
    fail();
  const status = enumValue(value.status, [
    'uploading',
    'queued',
    'running',
    'ready',
    'invalid',
    'completed',
    'completed_with_issues',
    'blocked',
    'failed',
    'cancelled',
  ]);
  if (kind === 'pricing' && status !== 'completed') fail();
  return {
    operation: { kind, id },
    comparisonUnavailable,
    priceContext,
    group,
    status,
    total,
    page,
    pages,
    limit: 100,
    items,
  };
}
export function createOperationPriceApi(transport?: typeof fetch) {
  const client = createApiClient({ ...(transport ? { transport } : {}) });
  return {
    result(
      kind: OperationKind,
      id: string,
      options: { group?: PriceResultGroup; page?: number } = {},
      signal?: AbortSignal,
    ) {
      enumValue(kind, ['pricing', 'import']);
      text(id, uuid);
      const group = options.group || 'all',
        page = options.page ?? 1;
      enumValue(group, ['all', 'retail', 'display', 'new']);
      integer(page);
      return client.get(
        `/api/v1/catalog/price-results/${kind}/${id}?` +
          new URLSearchParams({ group, page: String(page) }),
        (value) => decodeOperationPricePage(value, { kind, id, group, page }),
        signal,
      );
    },
  };
}
