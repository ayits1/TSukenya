import { type Header, type Page, type Query, type DocumentApi } from './api';
export const fixture: Header = {
  contract: 'document-detail-v1',
  context: {
    document: 1,
    role: 'owner',
    scopeStore: null,
    store: 1,
    readAt: '2026-10-05T08:00:00Z',
  },
  document: {
    id: 1,
    number: '000001',
    kind: 'receipt',
    status: 'posted',
    date: '2026-10-05',
    store: { id: 1, name: 'Навчальна крамниця' },
    warehouse: { id: 1, name: 'Головний склад' },
    target: null,
    party: { id: 1, name: 'Постачальник із довгою українською назвою' },
    employee: null,
    account: null,
    shift: null,
    reference: null,
    revision: 1,
    total: '999999999999999.99',
    cost: '7.99',
    note: 'Синтетичний документ',
    createdBy: 'tester',
    createdAt: '2026-10-05T08:00:00Z',
    postedAt: '2026-10-05T08:00:00Z',
    fiscalRef: '',
    expenseScope: null,
    outstanding: '100.99',
    unallocated: null,
    order: null,
    production: null,
    actions: ['reverse', 'supplier_return', 'pay_debt', 'receipt_pricing'],
  },
  sections: [
    { key: 'lines', total: 35 },
    { key: 'stock_movements', total: 35 },
    { key: 'cash_movements', total: 0 },
  ],
};
export function fixturePage(q: Query): Page {
  const total = fixture.sections.find((s) => s.key === q.section)!.total,
    pages = Math.max(1, Math.ceil(total / q.limit)),
    page = Math.min(q.page, pages),
    count = Math.min(q.limit, Math.max(0, total - (page - 1) * q.limit));
  return {
    ...structuredClone(fixture),
    page: {
      section: q.section,
      page,
      pages,
      limit: q.limit,
      total,
      items: Array.from({ length: count }, (_, index) => {
        const id = (page - 1) * q.limit + index + 1;
        return q.section === 'lines'
          ? {
              id,
              lineKey: crypto.randomUUID(),
              referenceLine: null,
              product: String(id),
              name: 'Синтетичний шоколад із довгою назвою ' + id,
              unit: 'шт',
              quantity: '1.001',
              price: '12.3456',
              amount: '12.36',
              cost: '7.9900',
              lot: 'Тестова партія',
              expiry: '2027-10-05',
              originKnown: true,
              remaining: '1.001',
              remainingAmount: '12.36',
            }
          : {
              id,
              warehouse: { id: 1, name: 'Головний склад' },
              product: String(id),
              lot: 'Тестова партія',
              line: id,
              quantity: '1.001',
              value: '7.99',
              reversal: false,
            };
      }),
    },
  };
}
export const api: DocumentApi = {
  header: async () => structuredClone(fixture),
  page: async (q) => fixturePage(q),
};
