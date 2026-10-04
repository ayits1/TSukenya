import type { components } from '../../shared/api/staff.generated';
import { ApiError } from '../../shared/api/client';

export type Resource = 'employees' | 'work-shifts' | 'documents';
export type Pages = {
  employees: components['schemas']['StaffEmployeesPage'];
  'work-shifts': components['schemas']['StaffWorkShiftsPage'];
  documents: components['schemas']['StaffDocumentsPage'];
};
export type Policy = components['schemas']['StaffPolicy'];
export type Queries = { [R in Resource]: Pages[R]['query'] };
export type Page = Pages[Resource];
export const tabs: Record<Resource, string> = {
  employees: 'Працівники',
  'work-shifts': 'Табель',
  documents: 'Документи',
};
export const kinds = {
  payroll: 'Нарахування зарплати',
  payroll_payment: 'Виплата зарплати / аванс',
};
export const statuses = { draft: 'Чернетка', posted: 'Проведено', reversed: 'Скасовано' };
export const bases = {
  store: 'Виторг магазину за касову зміну',
  personal: 'Особисті продажі',
  profit: 'Валовий прибуток',
};
const invalid = (): never => {
  throw new ApiError(200, 'Некоректна відповідь команди. Повторіть читання.', 'protocol');
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, expected: readonly string[]) => {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value)))
    invalid();
};
const text = (value: unknown) => {
  if (typeof value !== 'string') invalid();
};
const bool = (value: unknown) => {
  if (typeof value !== 'boolean') invalid();
};
const id = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid();
};
const nullableId = (value: unknown) => {
  if (value !== null) id(value);
};
const date = (value: unknown, empty = false) => {
  text(value);
  if (empty && value === '') return;
  const parsed = new Date(value as string);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value as string) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    invalid();
};
const decimal = (value: unknown, places = 2, signed = true, digits = 40) => {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^${signed ? '-?' : ''}(?:0|[1-9][0-9]{0,${digits - 1}})\\.[0-9]{${places}}$`).test(
      value,
    )
  )
    invalid();
};
const hmac = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) invalid();
};
const basis = (value: unknown) => {
  if (typeof value !== 'string' || !Object.hasOwn(bases, value)) invalid();
};
const percent = (value: unknown) => {
  decimal(value, 3, false, 3);
  if (BigInt((value as string).replace('.', '')) > 100000n) invalid();
};
const nonnegativeMoney = (value: unknown) => decimal(value, 2, false, 12);
const common = ['id', 'store', 'storeName'];
const fields: Record<Resource, string[]> = {
  employees: [
    ...common,
    'name',
    'active',
    'shiftRate',
    'bonusPercent',
    'bonusBasis',
    'payrollDebt',
    'revision',
  ],
  'work-shifts': [
    ...common,
    'employee',
    'employeeName',
    'employeeActive',
    'date',
    'cashShift',
    'units',
    'shiftRate',
    'bonusPercent',
    'bonusBasis',
    'basisAmount',
    'accrued',
    'payroll',
    'revision',
    'canEdit',
  ],
  documents: [
    ...common,
    'number',
    'kind',
    'status',
    'date',
    'employee',
    'employeeName',
    'total',
    'revision',
  ],
};

function decodePolicy(value: unknown): Policy {
  const p = object(value);
  keys(p, [
    'role',
    'store',
    'canManageEmployees',
    'canWriteWorkShifts',
    'documentKinds',
    'closedThrough',
  ]);
  if (p.role !== 'owner' && p.role !== 'accountant') invalid();
  nullableId(p.store);
  bool(p.canManageEmployees);
  bool(p.canWriteWorkShifts);
  if (
    p.canManageEmployees !== (p.role === 'owner') ||
    p.canWriteWorkShifts !== true ||
    !Array.isArray(p.documentKinds) ||
    p.documentKinds.length !== 2 ||
    p.documentKinds[0] !== 'payroll' ||
    p.documentKinds[1] !== 'payroll_payment'
  )
    invalid();
  if (p.closedThrough !== null) date(p.closedThrough);
  return p as Policy;
}

function decodeItem(resource: Resource, value: unknown, policy: Policy) {
  const row = object(value);
  keys(row, fields[resource]);
  id(row.id);
  id(row.store);
  text(row.storeName);
  if (policy.store !== null && row.store !== policy.store) invalid();
  if (resource === 'employees') {
    text(row.name);
    bool(row.active);
    nonnegativeMoney(row.shiftRate);
    percent(row.bonusPercent);
    basis(row.bonusBasis);
    decimal(row.payrollDebt);
    if (policy.canManageEmployees) hmac(row.revision);
    else if (row.revision !== null) invalid();
  } else if (resource === 'work-shifts') {
    id(row.employee);
    text(row.employeeName);
    bool(row.employeeActive);
    date(row.date);
    nullableId(row.cashShift);
    decimal(row.units, 2, false, 2);
    const units = BigInt((row.units as string).replace('.', ''));
    if (units === 0n || units > 1000n) invalid();
    nonnegativeMoney(row.shiftRate);
    percent(row.bonusPercent);
    basis(row.bonusBasis);
    decimal(row.basisAmount);
    decimal(row.accrued);
    nullableId(row.payroll);
    hmac(row.revision);
    bool(row.canEdit);
    if (
      row.canEdit !==
      (row.payroll === null &&
        (policy.closedThrough === null || (row.date as string) > policy.closedThrough))
    )
      invalid();
  } else {
    text(row.number);
    date(row.date);
    nullableId(row.employee);
    text(row.employeeName);
    decimal(row.total);
    if (
      row.number !== String(row.id).padStart(6, '0') ||
      typeof row.kind !== 'string' ||
      !Object.hasOwn(kinds, row.kind) ||
      typeof row.status !== 'string' ||
      !Object.hasOwn(statuses, row.status)
    )
      invalid();
    id(row.revision);
  }
  return row;
}

export function decodeStaffPage<R extends Resource>(
  resource: R,
  value: unknown,
  expected: Queries[R],
): Pages[R] {
  const raw = object(value);
  keys(raw, ['items', 'total', 'page', 'pages', 'limit', 'query', 'policy']);
  const policy = decodePolicy(raw.policy),
    query = object(raw.query);
  keys(query, Object.keys(expected));
  for (const [key, v] of Object.entries(expected)) if (query[key] !== v) invalid();
  if (!Number.isSafeInteger(raw.total) || (raw.total as number) < 0 || raw.limit !== 30) invalid();
  id(raw.page);
  id(raw.pages);
  const total = raw.total as number,
    page = raw.page as number;
  if (
    raw.pages !== Math.max(1, Math.ceil(total / 30)) ||
    page > (raw.pages as number) ||
    !Array.isArray(raw.items) ||
    raw.items.length !== Math.min(30, Math.max(0, total - (page - 1) * 30))
  )
    invalid();
  const seen = new Set<unknown>();
  for (const value of raw.items as unknown[]) {
    const item = decodeItem(resource, value, policy);
    if (seen.has(item.id)) invalid();
    seen.add(item.id);
  }
  return raw as Pages[R];
}

export type StaffApi = {
  read: <R extends Resource>(
    resource: R,
    query: Queries[R],
    page?: number,
    signal?: AbortSignal,
  ) => Promise<Pages[R]>;
};
export function createStaffApi(transport: typeof fetch = fetch): StaffApi {
  return {
    async read(resource, query, page = 1, signal) {
      const params = new URLSearchParams({ page: String(page) });
      Object.entries(query).forEach(([key, value]) => {
        if (value !== null && value !== '') params.set(key, String(value));
      });
      const response = await transport('/api/v1/trading/staff/' + resource + '?' + params, {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        ...(signal ? { signal } : {}),
      });
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new ApiError(response.status, 'Некоректна відповідь сервера.', 'protocol');
      }
      if (!response.ok) {
        const error =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
        throw new ApiError(
          response.status,
          typeof error.error === 'string' ? error.error : 'Не вдалося прочитати команду.',
          typeof error.code === 'string' ? error.code : undefined,
        );
      }
      return decodeStaffPage(resource, raw, query);
    },
  };
}

export function moneyText(value: string): string {
  const negative = value.startsWith('-'),
    [whole, fraction] = (negative ? value.slice(1) : value).split('.');
  return (negative ? '-' : '') + whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + fraction;
}
export function quantityText(value: string): string {
  return value.replace(/\.?0+$/, '').replace('.', ',');
}
