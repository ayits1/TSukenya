import { bootstrap, directoryApi } from '../stock/fixtures';
import type { Documents, Shifts, Policy, SalesApi } from './api';
import type { Options } from './state';
export const policy: Policy = {
  role: 'owner',
  store: null,
  documentKinds: ['sale', 'customer_return', 'customer_order'],
};
export const documents: Documents = {
  items: [
    {
      id: 1,
      number: '000001',
      kind: 'sale',
      status: 'posted',
      date: '2026-10-05',
      store: 1,
      storeName: 'Крамниця на центральній площі',
      party: 1,
      partyName: 'Покупець із довгою українською назвою',
      employee: 1,
      employeeName: 'Олена',
      total: '123456.78',
      revision: 1,
    },
  ],
  page: 1,
  pages: 1,
  total: 1,
  limit: 30,
  query: { q: '', store: null, status: '', kind: '', from: '', to: '' },
  policy,
  fiscalRequired: false,
};
export const shifts: Shifts = {
  items: [
    {
      id: 1,
      store: 1,
      storeName: 'Крамниця на центральній площі',
      account: 1,
      accountName: 'Основна каса',
      employee: 1,
      employeeName: 'Олена',
      openedAt: '2026-10-05T06:00:00+00:00',
      closedAt: null,
      openedBy: 'owner',
      openingCash: '1234.56',
      expectedCash: null,
      countedCash: null,
      difference: null,
      canClose: true,
    },
  ],
  page: 1,
  pages: 1,
  total: 1,
  limit: 30,
  query: { store: null, employee: null, status: '', from: '', to: '' },
  policy,
};
export function fixtureApi(): SalesApi {
  return {
    documents: async (query, page = 1) => ({
      ...documents,
      query,
      total: 61,
      pages: 3,
      page,
      items: Array.from({ length: Math.min(30, 61 - (page - 1) * 30) }, (_, i) => ({
        ...documents.items[0]!,
        id: 61 - (page - 1) * 30 - i,
        number: String(61 - (page - 1) * 30 - i).padStart(6, '0'),
      })),
    }),
    shifts: async (query) => ({ ...shifts, query }),
  };
}
export const options: Options = {
  bootstrap,
  directoryApi,
  store: null,
  selectedStore: null,
  onStore: () => {},
  onCreateDocument: () => {},
  onViewDocument: () => {},
  onOpenShift: () => {},
  onCloseShift: () => {},
  onRefresh: async () => {},
};
