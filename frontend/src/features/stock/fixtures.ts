import type { TradingApi, TradingBootstrap } from '../trading/api';
import type {
  StockApi,
  StockPage,
  AssortmentPage,
  StockDocuments,
  StockPolicy,
  StockQuery,
} from './api';
import type { StockOptions } from './state';
export const stockPolicy: StockPolicy = {
  role: 'owner',
  store: null,
  costVisible: true,
  canEditAssortment: true,
  documentKinds: ['opening', 'transfer', 'writeoff', 'inventory', 'production'],
  canControl: true,
  canLegacyRecipes: true,
  canRecipeVersions: true,
  canReplenish: true,
};
export const stockQuery: StockQuery = { q: '', store: null, warehouse: null, view: 'totals' };
export const row = {
  warehouse: 1,
  product: 'p',
  name: 'Кава · довга українська назва для складу',
  unit: 'кг',
  sold: true,
  low: true,
  quantity: '2.000',
  available: '1.000',
  reserved: '1.000',
  minimum: '5.000',
  value: '1999999999998.00',
};
export const stockPage: StockPage = {
  items: [row],
  total: 1,
  page: 1,
  pages: 1,
  limit: 30,
  view: 'totals',
  summary: { products: 1, low: 1, lots: 1, expiry: 0, value: row.value },
  query: stockQuery,
  asOf: '2026-10-04',
  policy: stockPolicy,
  alerts: { ok: null, error: null, stale: true },
};
export const assortmentRow = {
  product: 'p',
  name: row.name,
  unit: 'кг',
  sold: true,
  min_stock: null,
  minimum: '5.000',
  default_min: '5.000',
  revision: null,
};
export const assortmentPage: AssortmentPage = {
  warehouse: 1,
  rows: [assortmentRow],
  total: 1,
  page: 1,
  pages: 1,
  limit: 30,
  query: { q: '', product: '' },
  policy: stockPolicy,
};
export const documents: StockDocuments = {
  items: [],
  total: 0,
  page: 1,
  pages: 1,
  limit: 30,
  query: { store: null, status: '' },
  policy: stockPolicy,
};
export const bootstrap: TradingBootstrap = {
  role: 'owner',
  csrf: 'synthetic',
  username: 'synthetic',
  storeId: null,
  defaultStoreId: 1,
  defaultCategoryId: 'synthetic',
  canViewAudit: true,
  closed_through: null,
  fiscal_required: false,
  max_discount: '10',
};
export function fixtureApi(): StockApi {
  return {
    stock: async (query) => ({
      ...stockPage,
      query,
      view: query.view,
      items:
        query.view === 'totals'
          ? [row]
          : [
              {
                id: 1,
                warehouse: 1,
                product: 'p',
                name: row.name,
                unit: 'кг',
                lot: 'LOT',
                expiry: null,
                expired: false,
                quantity: '2.000',
                available: '1.000',
                reserved: '1.000',
                value: row.value,
              },
            ],
    }),
    assortment: async (warehouse, q = '', _page = 1, product = '') => ({
      ...assortmentPage,
      warehouse,
      page: Math.min(_page, 1),
      query: { q, product },
    }),
    documents: async (store, status = '') => ({
      ...documents,
      query: { store, status: status as StockDocuments['query']['status'] },
    }),
    save: async (intent) => ({
      warehouse: intent.warehouse,
      row: {
        ...assortmentRow,
        ...intent,
        minimum: intent.min_stock ?? '5.000',
        revision: 'a'.repeat(32),
      },
      policy: stockPolicy,
    }),
    csv: async () => new Blob(['synthetic']),
  };
}
export const directoryApi: TradingApi = {
  bootstrap: async () => bootstrap,
  list: async (type) => ({
    items:
      type === 'stores'
        ? [{ id: '1', name: 'Магазин', active: true }]
        : type === 'warehouses'
          ? [{ id: '1', name: 'Довга українська назва складу', store_id: 1 }]
          : [],
    total: 1,
    page: 1,
    pages: 1,
    limit: 30,
  }),
  details: async (ids) => ({
    items: ids.map((ref) => ({
      ...ref,
      name: ref.type === 'warehouses' ? 'Склад' : 'Магазин',
      ...(ref.type === 'warehouses' ? { store_id: 1 } : {}),
      ...(ref.type === 'stores' ? { active: true } : {}),
    })),
    unavailable: [],
  }),
  lookup: async () => ({ items: [], total: 0, page: 1, pages: 1, limit: 30 }),
};
export const options: StockOptions = {
  bootstrap,
  directoryApi,
  store: null,
  selectedStore: null,
  onStore: () => {},
  onCreateDocument: () => {},
  onViewDocument: () => {},
  onLegacyRecipes: () => {},
  onRecipeVersions: () => {},
  onControl: async () => {},
  onReplenishment: () => {},
};
