import { bootstrap, directoryApi } from '../stock/fixtures';
import {
  decodeStaffPage,
  type Policy,
  type Pages,
  type Resource,
  type Queries,
  type StaffApi,
} from './api';
import type { Options } from './state';
export const policy: Policy = {
  role: 'owner',
  store: null,
  canManageEmployees: true,
  canWriteWorkShifts: true,
  documentKinds: ['payroll', 'payroll_payment'],
  closedThrough: null,
};
const store = { store: 1, storeName: 'Крамниця з довгою українською назвою на центральній площі' };
export const items: { [R in Resource]: Pages[R]['items'][number] } = {
  employees: {
    id: 1,
    ...store,
    name: 'Олександра — працівниця з довгим українським прізвищем',
    active: false,
    shiftRate: '777.99',
    bonusPercent: '77.777',
    bonusBasis: 'store',
    payrollDebt: '-75.98',
    revision: 'a'.repeat(32),
  },
  'work-shifts': {
    id: 1,
    ...store,
    employee: 1,
    employeeName: 'Олександра — працівниця з довгим українським прізвищем',
    employeeActive: false,
    date: '2026-10-05',
    cashShift: 21,
    units: '2.00',
    shiftRate: '200.00',
    bonusPercent: '5.000',
    bonusBasis: 'store',
    basisAmount: '300.00',
    accrued: '415.00',
    payroll: 10,
    revision: 'b'.repeat(32),
    canEdit: false,
  },
  documents: {
    id: 1,
    ...store,
    number: '000001',
    kind: 'payroll',
    status: 'posted',
    date: '2026-10-05',
    employee: 1,
    employeeName: 'Олександра — працівниця з довгим українським прізвищем',
    total: '99999999999999.99',
    revision: 1,
  },
};
export function fixture<R extends Resource>(
  resource: R,
  query: Queries[R],
  page = 1,
  total = 1,
  auth = policy,
): Pages[R] {
  const pages = Math.max(1, Math.ceil(total / 30)),
    selected = Math.min(page, pages),
    start = (selected - 1) * 30;
  return decodeStaffPage(
    resource,
    {
      query,
      policy: auth,
      total,
      page: selected,
      pages,
      limit: 30,
      items: Array.from({ length: Math.min(30, total - start) }, (_, i) => ({
        ...items[resource],
        id: start + i + 1,
        ...(resource === 'documents' ? { number: String(start + i + 1).padStart(6, '0') } : {}),
        ...(resource === 'employees' && !auth.canManageEmployees ? { revision: null } : {}),
      })),
    },
    query,
  );
}
export const fixtureApi = (): StaffApi => ({
  read: async (r, q, p = 1) => fixture(r, q, p, r === 'employees' ? 31 : 1),
});
export const options: Options = {
  bootstrap,
  directoryApi,
  store: null,
  selectedStore: null,
  onStore: () => {},
  onCreateDocument: () => {},
  onViewDocument: () => {},
  onEditEmployee: () => {},
  onWorkShift: () => {},
  onDrafts: () => {},
  onRefresh: async () => {},
};
