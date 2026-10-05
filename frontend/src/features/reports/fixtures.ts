import { bootstrap, directoryApi } from '../stock/fixtures';
import { fixtureReport } from '../abc/fixtures';
import { fixtureApi as financeFixture } from '../finance/fixtures';
import { decodePage, moneyKeys, sections, type Query, type ReportsApi, type Section } from './api';
import type { Options } from './state';
export { bootstrap };
export const query: Query = {
  mode: 'period',
  store: null,
  from: '2026-10-01',
  to: '2026-10-05',
  as_of: '2026-10-05',
  section: 'products',
  page: 1,
  q: '',
};
const zeros = Object.fromEntries(moneyKeys.map((k) => [k, '0.00']));
export const rows: Record<Section, Record<string, unknown>> = {
  products: {
    product: 'p',
    name: 'Шоколад із фундуком · велика українська назва товару',
    unit: 'шт',
    quantity: '2.000',
    revenue: '99999999999999.99',
    cogs: '3.01',
    gross_profit: '99999999999996.98',
    margin: '100.0',
    writeoff_quantity: '0.000',
    writeoff: '0.00',
    inventory: '0.00',
    result: '99999999999996.98',
  },
  by_store: {
    ...Object.fromEntries(Object.entries(zeros).filter(([k]) => k !== 'unallocated_expenses')),
    store: 1,
    name: 'Крамниця солодощів у центрі',
    profit: '1000.99',
  },
  expenses_by_category: {
    store: 1,
    scope: 'store',
    store_name: 'Крамниця солодощів у центрі',
    category: 'Оренда та господарські витрати',
    amount: '10.07',
  },
  cashiers: {
    employee: 1,
    name: 'Ірина Тестова',
    shifts: 1,
    with_difference: 0,
    hours: '8.0',
    revenue: '1000.99',
    revenue_per_hour: '125.12',
    shortage: '0.00',
    surplus: '0.00',
    net: '0.00',
    late_return_bonus: '0.99',
  },
  stock: {
    lot: 1,
    code: 'Партія № 25',
    warehouse: 1,
    warehouse_name: 'Головний склад',
    store: 1,
    product: 'p',
    name: 'Шоколад із фундуком',
    unit: 'шт',
    expiry: null,
    quantity: '2.000',
    value: '3.01',
    expired: false,
  },
  cash: {
    account: 1,
    name: 'Банківський рахунок',
    store: 1,
    kind: 'bank',
    amount: '99999999999999.99',
  },
  debts: {
    voucher: 1,
    number: '000001',
    kind: 'receipt',
    original_kind: 'receipt',
    store: 1,
    date: '2026-10-01',
    party: 'Постачальник',
    party_id: 1,
    total: '100.00',
    amount: '99.99',
    due_date: '2026-10-02',
    overdue: true,
  },
  advances: {
    payment: 2,
    number: '000002',
    store: 1,
    party_id: 1,
    party: 'Постачальник',
    direction: 'supplier',
    date: '2026-10-01',
    amount: '0.99',
  },
  payroll_debts: { employee: 1, store: 1, name: 'Ірина Тестова', amount: '600.99' },
};
export function fixturePage(q: Query = query, payroll = true, empty = false) {
  const common = {
    contract: 'trading-reports-v1',
    mode: q.mode,
    store: q.store,
    scope_name: q.store ? 'Крамниця солодощів' : 'Усі доступні магазини',
    generated_at: '2026-10-05T12:00:00+03:00',
    basis: 'accounting_dates',
    reversal_policy: 'kyiv_reversed_at',
    snapshot: 'current',
    snapshot_notice: 'Кожне читання має окремий поточний знімок.',
    can_view_payroll: payroll,
    counts: Object.fromEntries(
      sections[q.mode]
        .filter((s) => s !== 'payroll_debts' || payroll)
        .map((s) => [s, empty ? 0 : 1]),
    ),
  };
  const summary =
    q.mode === 'period'
      ? {
          ...common,
          ...zeros,
          from: q.from,
          to: q.to,
          revenue: '99999999999999.99',
          cashiers_basis: 'current_posted_closed_shifts',
          debts_basis: 'current',
        }
      : {
          ...common,
          as_of: q.as_of,
          stock_value: '3.01',
          cash_total: '99999999999999.99',
          debt_totals: { owed_to_us: '0.00', owed_by_us: '99.99' },
          advance_totals: { customer: '0.00', supplier: '0.99' },
        };
  const row = { ...rows[q.section] };
  if (!payroll) delete row.late_return_bonus;
  return decodePage(
    {
      contract: 'trading-reports-v1',
      section: q.section,
      items: empty ? [] : [row],
      total: empty ? 0 : 1,
      page: 1,
      pages: 1,
      limit: 30,
      q: q.q.trim(),
      summary,
    },
    q,
    payroll,
  );
}
export const api: ReportsApi = { read: async (q, payroll) => fixturePage(q, payroll) };
export const options: Options = {
  bootstrap,
  directoryApi,
  store: null,
  selectedStore: null,
  onStore: () => {},
  onSources: () => {},
  onPayDebt: () => {},
};
export const abcApi = {
  read: async (filters: Parameters<typeof fixtureReport>[0]) => fixtureReport(filters),
  csv: async () => new Blob(['synthetic']),
};
export const financeApi = financeFixture();
