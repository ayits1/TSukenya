import { bootstrap, directoryApi } from '../stock/fixtures';
import type { FinanceApi, Pages, Policy, Resource, Queries } from './api';
import { kinds, decodePage } from './api';
import type { Options } from './state';
export const policy: Policy = {
  role: 'owner',
  store: null,
  documentKinds: Object.keys(kinds) as Policy['documentKinds'],
  createKinds: Object.keys(kinds).filter((x) => x !== 'cash_difference') as Policy['createKinds'],
  canManageAccounts: true,
};
const store = { store: 1, storeName: 'Крамниця з довгою українською назвою на центральній площі' },
  base = {
    id: 1,
    number: '000001',
    date: '2026-10-05',
    ...store,
    party: 1,
    partyName: 'ТОВ «Постачальник солодощів і кави»',
  };
export const items: { [R in Resource]: Pages[R]['items'][number] } = {
  accounts: {
    id: 1,
    name: 'Основний банківський рахунок',
    ...store,
    kind: 'bank',
    balance: '99999999999999.99',
    revision: 'a'.repeat(32),
  },
  debts: {
    ...base,
    kind: 'receipt',
    originalKind: 'receipt',
    total: '1000.99',
    amount: '500.98',
    dueDate: '2026-10-04',
    overdue: true,
  },
  advances: { ...base, direction: 'supplier', unallocated: '250.99' },
  ledger: {
    id: 1,
    voucher: 1,
    number: '000001',
    date: '2026-10-05',
    ...store,
    account: 1,
    accountName: 'Основний банківський рахунок',
    kind: 'receipt',
    amount: '-250.98',
    note: 'Оплата постачальнику · довга українська примітка',
    reversal: false,
  },
  documents: { ...base, kind: 'expense', status: 'draft', total: '1000.99', revision: 1 },
};
export function fixture<R extends Resource>(
  resource: R,
  query: Queries[R],
  page = 1,
  total = 1,
): Pages[R] {
  const pages = Math.max(1, Math.ceil(total / 30)),
    selected = Math.min(page, pages),
    start = (selected - 1) * 30;
  const raw = {
    query,
    policy,
    total,
    page: selected,
    pages,
    limit: 30,
    items: Array.from({ length: Math.min(30, total - start) }, (_, i) => ({
      ...items[resource],
      id: start + i + 1,
      ...(resource !== 'accounts' && resource !== 'ledger'
        ? { number: String(start + i + 1).padStart(6, '0') }
        : {}),
    })),
    ...(resource === 'debts'
      ? { totals: { owedToUs: '0.00', owedByUs: '50000.98' } }
      : resource === 'advances'
        ? { totals: { customer: '0.00', supplier: '99999999999999.99' } }
        : {}),
  };
  return decodePage(raw, resource, query);
}
export const fixtureApi = (): FinanceApi => ({
  read: async (resource, query, page = 1) =>
    fixture(resource, query, page, resource === 'accounts' ? 31 : 1),
});
export const options: Options = {
  bootstrap,
  directoryApi,
  store: null,
  selectedStore: null,
  onStore: () => {},
  onCreateDocument: () => {},
  onViewDocument: () => {},
  onEditAccount: () => {},
  onPayDebt: () => {},
  onAdvance: () => {},
  onStatement: () => {},
  onDrafts: () => {},
  onRefresh: async () => {},
};
