/** Synthetic data only; accounting/price calculations belong to the server. */
import { catalogProducts } from '../catalog/fixtures';
import type { Current, Commit, Proposal, Receipt, Preview } from './api';
export const key = '00000000-0000-4000-8000-000000000001';
export function fixtureCurrent(): Current {
  return {
    source: {
      id: 1,
      revision: 1,
      status: 'draft',
      date: '2026-10-01',
      store: 1,
      storeName: 'QA магазин',
      total: '38.15',
      additionalCost: '0.03',
      lines: [
        {
          id: 1,
          lineKey: key,
          product: 'sample-1',
          name: 'Кава Американо',
          unit: 'шт',
          quantity: '2.000',
          price: '12.5000',
          amount: '25.00',
          landedAmount: null,
          lot: 'A',
          expiry: '',
        },
        {
          id: 2,
          lineKey: key.replace(/1$/, '2'),
          product: 'sample-1',
          name: 'Кава Американо',
          unit: 'шт',
          quantity: '1.000',
          price: '13.1234',
          amount: '13.12',
          landedAmount: null,
          lot: 'B',
          expiry: '',
        },
      ],
    },
    sourceSnapshot: 'c'.repeat(64),
    priceContext: { storeId: 1, storeName: 'QA магазин' },
    effectiveDay: '2026-10-04',
    csrf: 'synthetic-receipt-csrf',
    canEdit: true,
    canSelectNetwork: true,
    products: [
      {
        ...catalogProducts[0]!,
        revision: 'a'.repeat(64),
        cost: '10.00',
        markup: '30.0000',
        manualPrice: false,
        price: null,
        promotion: false,
        promotionPrice: null,
        regularPrice: '13.00',
        salePrice: '13.00',
        effectivePromotion: null,
        effectiveDay: '2026-10-04',
        effectivePriceRevision: 'b'.repeat(64),
        priceContext: { storeId: 1, storeName: 'QA магазин' },
      },
    ],
  };
}
const term = (price: string, revision = 'a'.repeat(64)) => ({
  productRevision: revision,
  effectivePriceRevision: 'b'.repeat(64),
  regularPrice: price,
  salePrice: price,
  effectivePromotion: null,
  display: { promotion: false, oldPrice: null },
});
export function fixturePreview(body: Proposal): Preview {
  const data = fixtureCurrent();
  return {
    source: data.source,
    sourceSnapshot: data.sourceSnapshot,
    priceContext: data.priceContext,
    effectiveDay: data.effectiveDay,
    valid: true,
    snapshot: 'd'.repeat(64),
    entries: body.entries.map((e) => ({
      ...e,
      values: {
        cost: e.values.cost,
        markup: e.values.markup,
        manualPrice: e.values.manualPrice,
        price: e.values.price,
      },
      priceReviewed: e.values.priceReviewed,
      error: null,
      comparison: {
        before: term('13.00'),
        after: term('16.50', 'e'.repeat(64)),
        retailChanged: true,
        displayChanged: false,
        created: false,
      },
    })),
  };
}
export function fixtureReceipt(body: Commit): Receipt {
  const data = fixtureCurrent(),
    preview = fixturePreview(body);
  return {
    ok: true,
    idempotencyKey: body.idempotencyKey,
    source: data.source,
    sourceSnapshot: body.sourceSnapshot,
    priceContext: data.priceContext,
    counts: { created: 0, updated: body.entries.length, errors: 0 },
    entries: preview.entries.map((e, i) => ({
      id: e.id,
      revision: 'e'.repeat(64),
      line: i + 1,
      action: 'update',
      priceResult: {
        ...e.comparison!,
        id: e.id,
        outcome: 'updated',
        line: i + 1,
        ordinal: i + 1,
        context: { ...data.priceContext, effectiveDay: data.effectiveDay },
        committedAt: '2026-10-04T12:00:00Z',
      },
    })),
  };
}
