import { createApiClient } from '../../shared/api/client';
import type { components } from '../../shared/api/generated';
import {
  createOperationPriceApi,
  decodeOperationPriceResult,
  decodeOperationPriceTerms,
} from '../../shared/api/operationPrices';
import type { OperationKind } from '../../shared/api/operationPrices';
import { decodeProduct } from '../catalog/api';
export type PriceOperation = { kind: OperationKind; id: string; token: string };
export type SelectionReview = components['schemas']['OperationPriceSelectionPage'];
export type SelectionRequest = components['schemas']['OperationPriceSelectionRequest'];
function invalid(): never {
  throw Error('Некоректний перегляд цінників операції.');
}
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid();
  return v as Record<string, unknown>;
}
function integer(v: unknown, min = 1, max = 100000): number {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) invalid();
  return Number(v);
}
function text(v: unknown, pattern?: RegExp): string {
  if (typeof v !== 'string' || (pattern && !pattern.test(v))) invalid();
  return v;
}
function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') invalid();
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function decodeSelectionReview(
  v: unknown,
  operation: Pick<PriceOperation, 'kind' | 'id'>,
  request: SelectionRequest,
): SelectionReview {
  const value = obj(v),
    identity = obj(value.operation),
    ctx = obj(value.priceContext),
    storeId = ctx.storeId === null ? null : integer(ctx.storeId, 1, Number.MAX_SAFE_INTEGER),
    storeName = ctx.storeName === null ? null : text(ctx.storeName),
    effectiveDay = text(value.effectiveDay, /^\d{4}-\d{2}-\d{2}$/),
    snapshot = text(value.snapshot, /^[a-f0-9]{64}$/),
    counts = obj(value.counts);
  if (
    identity.kind !== operation.kind ||
    identity.id !== operation.id ||
    (storeId === null) !== (storeName === null) ||
    storeName === '' ||
    !Number.isFinite(Date.parse(effectiveDay)) ||
    new Date(effectiveDay).toISOString().slice(0, 10) !== effectiveDay
  )
    invalid();
  const ordinals = [...request.ordinals].sort((a, b) => a - b),
    total = integer(value.total, 1, 1000),
    pages = integer(value.pages, 1, 10),
    page = integer(value.page, 1, pages);
  if (
    !same(value.ordinals, ordinals) ||
    total !== ordinals.length ||
    value.limit !== 100 ||
    pages !== Math.ceil(total / 100) ||
    page !== Math.min(request.page ?? 1, pages) ||
    (request.snapshot && snapshot !== request.snapshot) ||
    !Array.isArray(value.selection) ||
    value.selection.length !== total ||
    !Array.isArray(value.items) ||
    value.items.length !== Math.min(100, total - (page - 1) * 100)
  )
    invalid();
  const selection = value.selection.map((raw, index) => {
    const row = obj(raw),
      ordinal = integer(row.ordinal),
      id = text(row.id, /^[A-Za-z0-9_-]{1,120}$/);
    if (ordinal !== ordinals[index]) invalid();
    return { ordinal, id };
  });
  if (new Set(selection.map((r) => r.id)).size !== total) invalid();
  const checkedCounts = {
    selected: integer(counts.selected, 0, 1000),
    available: integer(counts.available, 0, 1000),
    hidden: integer(counts.hidden, 0, 1000),
    missing: integer(counts.missing, 0, 1000),
    changedAfterOperation: integer(counts.changedAfterOperation, 0, 1000),
  };
  if (
    checkedCounts.selected !== total ||
    checkedCounts.available + checkedCounts.hidden + checkedCounts.missing !== total ||
    checkedCounts.changedAfterOperation > total
  )
    invalid();
  const items = value.items.map((raw, index) => {
    const row = obj(raw),
      operationResult = decodeOperationPriceResult(row.operationResult),
      state = text(row.state),
      binding = selection[(page - 1) * 100 + index];
    if (
      !['available', 'hidden', 'missing'].includes(state) ||
      operationResult.ordinal !== binding?.ordinal ||
      operationResult.id !== binding.id ||
      operationResult.context.storeId !== storeId
    )
      invalid();
    const current = row.current === null ? null : decodeProduct(row.current),
      currentTerms = row.currentTerms === null ? null : decodeOperationPriceTerms(row.currentTerms);
    if (
      (state === 'missing') !== (current === null) ||
      (current === null) !== (currentTerms === null) ||
      (current &&
        (current.id !== operationResult.id ||
          current.hidden !== (state === 'hidden') ||
          current.priceContext?.storeId !== storeId ||
          current.priceContext?.storeName !== storeName ||
          !same(current.effectivePromotion, currentTerms!.effectivePromotion) ||
          current.effectiveDay !== effectiveDay ||
          current.revision !== currentTerms!.productRevision ||
          current.effectivePriceRevision !== currentTerms!.effectivePriceRevision ||
          current.salePrice !== currentTerms!.salePrice ||
          current.regularPrice !== currentTerms!.regularPrice))
    )
      invalid();
    const amountChanged = bool(row.amountChanged),
      displayChanged = bool(row.displayChanged),
      revisionChanged = bool(row.revisionChanged);
    if (
      amountChanged !==
        (currentTerms !== null && currentTerms.salePrice !== operationResult.after.salePrice) ||
      displayChanged !==
        (currentTerms !== null && !same(currentTerms.display, operationResult.after.display)) ||
      revisionChanged !==
        (currentTerms !== null &&
          (currentTerms.productRevision !== operationResult.after.productRevision ||
            currentTerms.effectivePriceRevision !== operationResult.after.effectivePriceRevision))
    )
      invalid();
    return {
      operationResult,
      state: state as 'available' | 'hidden' | 'missing',
      current,
      currentTerms,
      amountChanged,
      displayChanged,
      revisionChanged,
    };
  });
  for (const state of ['available', 'hidden', 'missing'] as const)
    if (items.filter((row) => row.state === state).length > checkedCounts[state]) invalid();
  if (items.filter((row) => row.revisionChanged).length > checkedCounts.changedAfterOperation)
    invalid();
  const canApply = bool(value.canApply);
  if (canApply !== (checkedCounts.hidden === 0 && checkedCounts.missing === 0)) invalid();
  return {
    operation: { kind: operation.kind, id: operation.id },
    priceContext: { storeId, storeName },
    effectiveDay,
    snapshot,
    counts: checkedCounts,
    canApply,
    ordinals,
    selection,
    total,
    page,
    pages,
    limit: 100,
    items,
  };
}
export function createSelectionApi(getCsrf: () => string | undefined, transport?: typeof fetch) {
  const client = createApiClient({ getCsrf, ...(transport ? { transport } : {}) }),
    results = createOperationPriceApi(transport);
  return {
    result: results.result,
    preview(
      operation: Pick<PriceOperation, 'kind' | 'id'>,
      request: SelectionRequest,
      signal?: AbortSignal,
    ) {
      if (
        !['pricing', 'import'].includes(operation.kind) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation.id) ||
        !Array.isArray(request.ordinals) ||
        !request.ordinals.length ||
        request.ordinals.length > 1000 ||
        new Set(request.ordinals).size !== request.ordinals.length
      )
        invalid();
      request.ordinals.forEach((n) => integer(n));
      return client.mutate(
        'POST',
        `/api/v1/catalog/price-results/${operation.kind}/${operation.id}/selection-preview`,
        request,
        (v) => decodeSelectionReview(v, operation, request),
        signal,
      );
    },
  };
}
export type SelectionApi = ReturnType<typeof createSelectionApi>;
export function mergedSelection(
  previous: Record<string, number>,
  ids: string[],
  mode: 'replace' | 'add',
): Record<string, number> {
  const next = {
    ...(mode === 'add' ? previous : {}),
    ...Object.fromEntries(ids.map((id) => [id, previous[id] || 1])),
  };
  if (
    Object.values(next).some((q) => !Number.isSafeInteger(q) || q < 1 || q > 500) ||
    Object.values(next).reduce((a, b) => a + b, 0) > 1000
  )
    throw Error(
      'Вибір перевищує 1000 цінників або 500 копій товару. Зменште кількість чи розмір пакета.',
    );
  return next;
}
