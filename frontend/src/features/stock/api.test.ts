import { describe, it, expect } from 'vitest';
import {
  decodeStockPage,
  decodeAssortmentPage,
  decodeAssortmentAck,
  decodeDocuments,
  createStockApi,
  displayDecimal,
} from './api';
import { stockPage, stockQuery, assortmentPage, documents } from './fixtures';
describe('Stock contracts', () => {
  it('requires exact query/page/unique resource, dates and aggregate/private semantics', () => {
    expect(decodeStockPage(stockPage, stockQuery)).toEqual(stockPage);
    expect(displayDecimal('1999999999998.00')).toBe('1\u00a0999\u00a0999\u00a0999\u00a0998');
    for (const bad of [
      { ...stockPage, query: { ...stockQuery, q: 'old' } },
      { ...stockPage, total: 31, pages: 1 },
      { ...stockPage, items: [] },
      {
        ...stockPage,
        items: [...stockPage.items, ...stockPage.items],
        total: 2,
        summary: { ...stockPage.summary, products: 2 },
      },
      { ...stockPage, asOf: '2026-02-31' },
      { ...stockPage, policy: { ...stockPage.policy, role: 'cashier' } },
      { ...stockPage, items: [{ ...stockPage.items[0], quantity: 2 }] },
    ])
      expect(() => decodeStockPage(bad, stockQuery)).toThrow();
  });
  it('cashier has no costs and no journal/editor authority', () => {
    const policy = {
      ...stockPage.policy,
      role: 'cashier',
      costVisible: false,
      canEditAssortment: false,
      canControl: false,
      canLegacyRecipes: false,
      canRecipeVersions: false,
      canReplenish: false,
      documentKinds: [],
    };
    const item = { ...stockPage.items[0]! };
    delete item.value;
    const summary = { ...stockPage.summary };
    delete summary.value;
    expect(
      decodeStockPage({ ...stockPage, policy, items: [item], summary, alerts: null }, stockQuery)
        .policy.costVisible,
    ).toBe(false);
    expect(() => decodeStockPage({ ...stockPage, policy, alerts: null }, stockQuery)).toThrow();
  });
  it('binds row ACK and inheritance/zero; refuses missing and wrong selected ID', () => {
    expect(decodeAssortmentPage(assortmentPage, 1)).toEqual(assortmentPage);
    expect(() => decodeAssortmentPage(assortmentPage, 2)).toThrow();
    expect(() =>
      decodeAssortmentPage(
        { ...assortmentPage, query: { q: '', product: 'wrong' } },
        1,
        '',
        'wrong',
      ),
    ).toThrow();
    const intent = { warehouse: 1, product: 'p', sold: true, min_stock: '0', revision: null };
    const ack = {
      warehouse: 1,
      row: {
        ...assortmentPage.rows[0],
        min_stock: '0.000',
        minimum: '0.000',
        revision: 'a'.repeat(32),
      },
      policy: stockPage.policy,
    };
    expect(decodeAssortmentAck(ack, intent).row.min_stock).toBe('0.000');
    for (const bad of [
      { ...ack, warehouse: 2 },
      { ...ack, row: { ...ack.row, product: 'other' } },
      { ...ack, row: { ...ack.row, min_stock: null } },
    ])
      expect(() => decodeAssortmentAck(bad, intent)).toThrow();
    expect(() =>
      decodeDocuments({ ...documents, query: { store: 2, status: '' } }, null, ''),
    ).toThrow();
  });
  it('preserves status/code, JSON200 protocol and abort; cannot issue CSV URL on403', async () => {
    const api = createStockApi(
      () => '',
      async () =>
        new Response(JSON.stringify({ error: 'Відкликано', code: 'scope' }), { status: 403 }),
    );
    await expect(api.stock(stockQuery)).rejects.toMatchObject({ status: 403, code: 'scope' });
    await expect(api.csv(stockQuery)).rejects.toMatchObject({ status: 403 });
    const malformed = createStockApi(
      () => '',
      async () => new Response('html'),
    );
    await expect(malformed.stock(stockQuery)).rejects.toMatchObject({ code: 'protocol' });
    const abort = createStockApi(
      () => '',
      async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    );
    await expect(abort.stock(stockQuery)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
