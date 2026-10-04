import { bootstrap, directoryApi } from '../stock/fixtures';
import type {
  Policy,
  Line,
  Group,
  Documents,
  Groups,
  PurchasesApi,
  ReplenishmentQuery,
} from './api';
import type { Options } from './state';
export const policy: Policy = {
  role: 'owner',
  store: null,
  documentKinds: ['purchase_order', 'receipt', 'supplier_return'],
};
export const line = (index = 1): Line => ({
  product: 'product_' + index,
  name: 'Карамель із довгою українською назвою № ' + index,
  unit: 'шт',
  quantity: '3.000',
  price: '12.3456',
  available: '1.000',
  minimum: '4.000',
  onOrder: '0.000',
  costKnown: true,
});
export const group: Group = {
  key: '1:1',
  store: 1,
  storeName: 'Крамниця на центральній площі',
  warehouse: 1,
  warehouseName: 'Основний склад із довгою назвою',
  party: 1,
  partyName: 'ТОВ «Українські солодощі»',
  linesCount: 205,
  total: '7592.60',
  preview: [line(), line(2), line(3)],
  binding: 'a'.repeat(64),
  parts: 2,
};
const bounds = (total: number, page: number) => ({
  total,
  page: Math.min(page, Math.max(1, Math.ceil(total / 30))),
  pages: Math.max(1, Math.ceil(total / 30)),
  limit: 30 as const,
});
export const documents: Documents = {
  ...bounds(1, 1),
  policy,
  query: { q: '', store: null, status: '', kind: '', from: '', to: '' },
  items: [
    {
      id: 1,
      number: '000001',
      kind: 'receipt',
      status: 'posted',
      date: '2026-10-05',
      store: 1,
      storeName: 'Крамниця',
      party: 1,
      partyName: group.partyName,
      total: '1250.00',
      revision: 1,
    },
  ],
};
export const groups: Groups = {
  ...bounds(1, 1),
  policy,
  query: { q: '', store: null, warehouse: null },
  asOf: '2026-10-05',
  summary: { groups: 1, lines: 205, covered: 3, total: group.total },
  items: [group],
};
export function fixtureApi(): PurchasesApi {
  return {
    documents: async (query, page = 1) => ({
      ...documents,
      ...bounds(67, page),
      query,
      items: Array.from({ length: Math.min(30, 67 - (page - 1) * 30) }, (_, i) => ({
        ...documents.items[0]!,
        id: 67 - (page - 1) * 30 - i,
        number: String(67 - (page - 1) * 30 - i).padStart(6, '0'),
      })),
    }),
    groups: async (query) => ({ ...groups, query }),
    lines: async (query, g, page = 1) => ({
      ...bounds(g.linesCount, page),
      query: { ...query, warehouse: g.warehouse, party: g.party },
      policy,
      group: g,
      binding: g.binding,
      asOf: '2026-10-05',
      items: Array.from({ length: Math.min(30, g.linesCount - (page - 1) * 30) }, (_, i) =>
        line((page - 1) * 30 + i + 1),
      ),
    }),
    draft: async (_query, g, part = 1) => ({
      group: g,
      binding: g.binding,
      policy,
      part,
      parts: g.parts,
      total: g.linesCount,
      limit: 200,
      lines: Array.from({ length: Math.min(200, g.linesCount - (part - 1) * 200) }, (_, i) =>
        line((part - 1) * 200 + i + 1),
      ),
    }),
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
  onReplenishment: () => {},
  onRefresh: async () => {},
};
export const groupQuery: ReplenishmentQuery = { q: '', store: null, warehouse: null };
