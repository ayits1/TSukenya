import type { components } from '../../shared/api/sales.generated';
import { ApiError } from '../../shared/api/client';
export type Policy = components['schemas']['SalesPolicy'];
export type DocumentQuery = components['schemas']['SalesQuery'];
export type ShiftQuery = components['schemas']['CashShiftQuery'];
export type Documents = components['schemas']['SalesDocuments'];
export type Shifts = components['schemas']['CashShifts'];
export type Shift = components['schemas']['CashShift'];
export const kinds = {
  sale: 'Продаж',
  customer_return: 'Повернення покупця',
  customer_order: 'Замовлення покупця',
};
export const statuses = { draft: 'Чернетка', posted: 'Проведено', reversed: 'Скасовано' };
const fail = (): never => {
  throw new ApiError(200, 'Сервер повернув некоректні дані продажів. Оновіть список.', 'protocol');
};
const check = (value: unknown) => {
  if (!value) fail();
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
const keys = (value: Record<string, unknown>, fields: string[]) =>
  check(
    Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key)),
  );
const text = (value: unknown): value is string => typeof value === 'string';
const int = (value: unknown, min = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const money = (value: unknown, signed = false): value is string =>
  text(value) && value.length <= 40 && (signed ? /^-?\d+\.\d{2}$/ : /^\d+\.\d{2}$/).test(value);
const date = (value: unknown): value is string =>
  text(value) &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
  new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const stamp = (value: unknown): value is string =>
  text(value) &&
  date(value.slice(0, 10)) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
export function decodePolicy(raw: unknown): Policy {
  const p = object(raw);
  keys(p, ['role', 'store', 'documentKinds']);
  check(
    text(p.role) &&
      ['owner', 'manager', 'cashier'].includes(p.role) &&
      (p.store === null || int(p.store, 1)) &&
      JSON.stringify(p.documentKinds) === JSON.stringify(Object.keys(kinds)),
  );
  return p as Policy;
}
function scoped(policy: Policy, store: unknown, selected: number | null) {
  check(
    int(store, 1) &&
      (policy.store === null || policy.store === store) &&
      (selected === null || selected === store),
  );
}
function envelope(raw: unknown, query: object, extra: string[] = []) {
  const v = object(raw);
  keys(v, ['items', 'total', 'page', 'pages', 'limit', 'query', 'policy', ...extra]);
  const q = object(v.query);
  keys(q, Object.keys(query));
  for (const [key, value] of Object.entries(query)) check(q[key] === value);
  check(Array.isArray(v.items));
  const items = v.items as unknown[];
  check(int(v.total) && int(v.page, 1) && int(v.pages, 1) && v.limit === 30);
  const total = Number(v.total),
    page = Number(v.page);
  check(
    v.pages === Math.max(1, Math.ceil(total / 30)) &&
      page <= Number(v.pages) &&
      items.length === Math.min(30, Math.max(0, total - (page - 1) * 30)) &&
      new Set(items.map((row) => object(row).id)).size === items.length,
  );
  return { v, items, policy: decodePolicy(v.policy) };
}
export function decodeDocuments(raw: unknown, query: DocumentQuery): Documents {
  const { v, items, policy } = envelope(raw, query, ['fiscalRequired']);
  check(typeof v.fiscalRequired === 'boolean');
  for (const rawRow of items) {
    const r = object(rawRow);
    keys(r, [
      'id',
      'number',
      'kind',
      'status',
      'date',
      'store',
      'storeName',
      'party',
      'partyName',
      'employee',
      'employeeName',
      'total',
      'revision',
    ]);
    check(
      int(r.id, 1) &&
        r.number === String(r.id).padStart(6, '0') &&
        text(r.kind) &&
        Object.hasOwn(kinds, r.kind) &&
        text(r.status) &&
        Object.hasOwn(statuses, r.status) &&
        date(r.date) &&
        text(r.storeName) &&
        text(r.partyName) &&
        text(r.employeeName) &&
        (r.party === null || int(r.party, 1)) &&
        (r.employee === null || int(r.employee, 1)) &&
        money(r.total) &&
        int(r.revision, 1),
    );
    scoped(policy, r.store, query.store);
    if (query.kind) check(r.kind === query.kind);
    if (query.status) check(r.status === query.status);
    if (query.from) check(String(r.date) >= query.from);
    if (query.to) check(String(r.date) <= query.to);
  }
  return v as Documents;
}
export function decodeShifts(raw: unknown, query: ShiftQuery): Shifts {
  const { v, items, policy } = envelope(raw, query);
  for (const rawRow of items) {
    const r = object(rawRow);
    keys(r, [
      'id',
      'store',
      'storeName',
      'account',
      'accountName',
      'employee',
      'employeeName',
      'openedAt',
      'closedAt',
      'openedBy',
      'openingCash',
      'expectedCash',
      'countedCash',
      'difference',
      'canClose',
    ]);
    check(
      int(r.id, 1) &&
        int(r.account, 1) &&
        text(r.storeName) &&
        text(r.accountName) &&
        (r.employee === null || int(r.employee, 1)) &&
        text(r.employeeName) &&
        text(r.openedBy) &&
        stamp(r.openedAt) &&
        (r.closedAt === null || stamp(r.closedAt)) &&
        money(r.openingCash, true) &&
        typeof r.canClose === 'boolean',
    );
    for (const field of ['expectedCash', 'countedCash', 'difference'])
      check(r[field] === null || money(r[field], true));
    scoped(policy, r.store, query.store);
    if (query.employee) check(r.employee === query.employee);
    if (query.status) check((r.closedAt === null ? 'open' : 'closed') === query.status);
    if (r.closedAt !== null)
      check(
        r.canClose === false && Date.parse(String(r.closedAt)) >= Date.parse(String(r.openedAt)),
      );
    else check(r.expectedCash === null && r.countedCash === null && r.difference === null);
    const openedDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(String(r.openedAt)));
    if (query.from) check(openedDay >= query.from);
    if (query.to) check(openedDay <= query.to);
  }
  return v as Shifts;
}
const params = (query: object) => {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== null && value !== '') p.set(key, String(value));
  return p;
};
export function createSalesApi(transport: typeof fetch = fetch) {
  async function read<T>(
    path: string,
    decode: (raw: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await transport('/api/v1/trading/sales/' + path, {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'Не вдалося з’єднатися із сервером.');
    }
    const raw: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      throw new ApiError(
        response.status,
        text(value.error) ? value.error : 'Не вдалося прочитати продажі.',
        text(value.code) ? value.code : undefined,
      );
    }
    return decode(raw);
  }
  return {
    documents: (query: DocumentQuery, page = 1, signal?: AbortSignal) =>
      read('documents?' + params({ ...query, page }), (v) => decodeDocuments(v, query), signal),
    shifts: (query: ShiftQuery, page = 1, signal?: AbortSignal) =>
      read('cash-shifts?' + params({ ...query, page }), (v) => decodeShifts(v, query), signal),
  };
}
export type SalesApi = ReturnType<typeof createSalesApi>;
export const moneyText = (value: string) => {
  const [whole = '', fraction = ''] = value.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + fraction;
};
