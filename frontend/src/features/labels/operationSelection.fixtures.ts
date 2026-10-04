/** Synthetic operation and current terms for targeted component checks only. */
import { catalogProducts } from '../catalog/fixtures';
import type { OperationPriceResultPage } from '../../shared/api/operationPrices';
import type { PromotionContext } from '../promotions/api';
import type { PriceOperation, SelectionReview } from './operationSelection';
export const fixtureOperation: PriceOperation = {
  kind: 'pricing',
  id: '00000000-0000-4000-8000-000000000001',
  token: 'synthetic',
};
export const fixtureContext: PromotionContext = {
  storeId: null,
  storeName: null,
  effectiveDay: '2026-10-04',
  csrf: 'synthetic',
  stores: [{ id: 1, name: 'Магазин 1' }],
  canManage: true,
  canSelectNetwork: true,
  canViewHistory: true,
};
const terms = (price: string) => ({
  productRevision: 'a'.repeat(64),
  effectivePriceRevision: 'b'.repeat(64),
  regularPrice: price,
  salePrice: price,
  effectivePromotion: null,
  display: { promotion: false, oldPrice: null },
});
export function fixtureResult(): OperationPriceResultPage {
  return {
    operation: { kind: fixtureOperation.kind, id: fixtureOperation.id },
    comparisonUnavailable: false,
    priceContext: { storeId: null, storeName: null },
    status: 'completed',
    group: 'retail',
    total: 1,
    page: 1,
    pages: 1,
    limit: 100,
    items: [
      {
        id: 'sample-1',
        ordinal: 1,
        line: null,
        outcome: 'updated',
        before: terms('13.00'),
        after: terms('14.00'),
        retailChanged: true,
        displayChanged: false,
        created: false,
        context: { storeId: null, storeName: null, effectiveDay: fixtureContext.effectiveDay },
        committedAt: '2026-10-04T12:00:00+03:00',
      },
    ],
  };
}
export function fixtureReview(): SelectionReview {
  const operationResult = fixtureResult().items[0]!;
  return {
    operation: fixtureResult().operation,
    priceContext: { storeId: null, storeName: null },
    effectiveDay: fixtureContext.effectiveDay,
    snapshot: 'c'.repeat(64),
    ordinals: [1],
    selection: [{ ordinal: 1, id: 'sample-1' }],
    counts: { selected: 1, available: 1, hidden: 0, missing: 0, changedAfterOperation: 0 },
    canApply: true,
    total: 1,
    page: 1,
    pages: 1,
    limit: 100,
    items: [
      {
        operationResult,
        state: 'available',
        current: {
          ...catalogProducts[0]!,
          revision: 'a'.repeat(64),
          salePrice: '14.00',
          regularPrice: '14.00',
          promotionPrice: null,
          promotion: false,
          price: '14.00',
          effectivePromotion: null,
          effectiveDay: fixtureContext.effectiveDay,
          effectivePriceRevision: 'b'.repeat(64),
          priceContext: { storeId: null, storeName: null },
        },
        currentTerms: operationResult.after,
        amountChanged: false,
        displayChanged: false,
        revisionChanged: false,
      },
    ],
  };
}
