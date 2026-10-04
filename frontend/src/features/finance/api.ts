import type { components } from '../../shared/api/finance.generated';
import { ApiError } from '../../shared/api/client';
export type Policy = components['schemas']['FinancePolicy'];
export type Pages = {
  accounts: components['schemas']['Accounts'];
  debts: components['schemas']['Debts'];
  advances: components['schemas']['Advances'];
  ledger: components['schemas']['Ledger'];
  documents: components['schemas']['Documents'];
};
export type Resource = keyof Pages;
export type Queries = { [K in Resource]: Pages[K]['query'] };
export type Page = Pages[Resource];
export const tabs = {
  accounts: 'Рахунки',
  debts: 'Борги',
  advances: 'Аванси',
  ledger: 'Рух коштів',
  documents: 'Документи',
};
export const kinds = {
  payment: 'Платіж / аванс',
  advance_allocation: 'Використання авансу',
  payment_refund: 'Повернення авансу',
  expense: 'Витрата',
  cash_opening: 'Початкові кошти',
  debt_opening: 'Початкова заборгованість',
  cash_transfer: 'Переміщення коштів',
  cash_difference: 'Касове розходження',
};
export const documentKinds = {
  purchase_order: 'Замовлення постачальнику',
  receipt: 'Надходження',
  opening: 'Початкові залишки',
  sale: 'Продаж',
  customer_return: 'Повернення покупця',
  supplier_return: 'Повернення постачальнику',
  transfer: 'Переміщення',
  writeoff: 'Списання',
  inventory: 'Інвентаризація',
  production: 'Виробництво',
  payroll: 'Нарахування зарплати',
  payroll_payment: 'Виплата зарплати',
  customer_order: 'Замовлення покупця',
  ...kinds,
};
export const statuses = { draft: 'Чернетка', posted: 'Проведено', reversed: 'Скасовано' };
const fail = (): never => {
  throw new ApiError(
    200,
    'Сервер повернув некоректні фінансові дані. Повторіть читання.',
    'protocol',
  );
};
const check = (v: unknown) => {
  if (!v) fail();
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
const keys = (v: Record<string, unknown>, expected: string[]) =>
  check(Object.keys(v).length === expected.length && expected.every((k) => Object.hasOwn(v, k)));
const int = (v: unknown, min = 1): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const text = (v: unknown): v is string => typeof v === 'string';
const money = (v: unknown) => text(v) && v.length <= 40 && /^-?\d+\.\d{2}$/.test(v);
const date = (v: unknown) =>
  text(v) &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v + 'T00:00:00Z')) &&
  new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const nullableId = (v: unknown) => v === null || int(v);
export function decodePolicy(raw: unknown): Policy {
  const p = object(raw);
  keys(p, ['role', 'store', 'documentKinds', 'createKinds', 'canManageAccounts']);
  check(text(p.role) && ['owner', 'manager', 'accountant'].includes(p.role) && nullableId(p.store));
  const expected = Object.keys(kinds).filter(
    (k) => p.role !== 'manager' || !['cash_opening', 'debt_opening'].includes(k),
  );
  check(
    JSON.stringify(p.documentKinds) === JSON.stringify(expected) &&
      JSON.stringify(p.createKinds) ===
        JSON.stringify(expected.filter((k) => k !== 'cash_difference')) &&
      p.canManageAccounts === (p.role === 'owner'),
  );
  return p as Policy;
}
const rowFields = {
  accounts: ['id', 'name', 'store', 'storeName', 'kind', 'balance', 'revision'],
  debts: [
    'id',
    'number',
    'kind',
    'originalKind',
    'store',
    'storeName',
    'date',
    'party',
    'partyName',
    'total',
    'amount',
    'dueDate',
    'overdue',
  ],
  advances: [
    'id',
    'number',
    'store',
    'storeName',
    'date',
    'party',
    'partyName',
    'direction',
    'unallocated',
  ],
  ledger: [
    'id',
    'voucher',
    'number',
    'date',
    'account',
    'accountName',
    'store',
    'storeName',
    'kind',
    'amount',
    'note',
    'reversal',
  ],
  documents: [
    'id',
    'number',
    'kind',
    'status',
    'date',
    'store',
    'storeName',
    'party',
    'partyName',
    'total',
    'revision',
  ],
};
export function decodePage<R extends Resource>(
  raw: unknown,
  resource: R,
  query: Queries[R],
): Pages[R] {
  const v = object(raw);
  keys(v, [
    'items',
    'total',
    'page',
    'pages',
    'limit',
    'query',
    'policy',
    ...(['debts', 'advances'].includes(resource) ? ['totals'] : []),
  ]);
  const actual = object(v.query);
  keys(actual, Object.keys(query));
  for (const [k, val] of Object.entries(query)) check(actual[k] === val);
  const policy = decodePolicy(v.policy);
  check(Array.isArray(v.items) && int(v.total, 0) && int(v.page) && int(v.pages) && v.limit === 30);
  const items = v.items as unknown[],
    total = Number(v.total),
    page = Number(v.page);
  check(
    v.pages === Math.max(1, Math.ceil(total / 30)) &&
      page <= Number(v.pages) &&
      items.length === Math.min(30, Math.max(0, total - (page - 1) * 30)) &&
      new Set(items.map((x) => object(x).id)).size === items.length,
  );
  if (resource === 'debts' || resource === 'advances') {
    const totals = object(v.totals);
    keys(totals, resource === 'debts' ? ['owedToUs', 'owedByUs'] : ['customer', 'supplier']);
    Object.values(totals).forEach((x) => check(money(x)));
  }
  for (const rawRow of items) {
    const r = object(rawRow);
    keys(r, rowFields[resource]);
    check(
      int(r.id) &&
        int(r.store) &&
        text(r.storeName) &&
        (policy.store === null || r.store === policy.store) &&
        (query.store === null || r.store === query.store),
    );
    if (resource === 'accounts') {
      check(
        text(r.name) &&
          text(r.kind) &&
          ['cash', 'bank', 'terminal'].includes(r.kind) &&
          money(r.balance) &&
          (policy.canManageAccounts
            ? text(r.revision) && /^[a-f0-9]{32}$/.test(r.revision)
            : r.revision === null),
      );
      continue;
    }
    check(date(r.date));
    if ('from' in query && query.from) check(String(r.date) >= query.from);
    if ('to' in query && query.to) check(String(r.date) <= query.to);
    if (resource === 'ledger') {
      check(
        int(r.voucher) &&
          r.number === String(r.voucher).padStart(6, '0') &&
          int(r.account) &&
          text(r.accountName) &&
          text(r.kind) &&
          Object.hasOwn(documentKinds, r.kind) &&
          money(r.amount) &&
          text(r.note) &&
          r.note.length <= 4000 &&
          typeof r.reversal === 'boolean',
      );
      if ('account' in query && query.account) check(r.account === query.account);
      if (policy.role === 'manager')
        check(!['payroll', 'payroll_payment'].includes(String(r.kind)));
      continue;
    }
    check(r.number === String(r.id).padStart(6, '0') && nullableId(r.party) && text(r.partyName));
    if ('party' in query && query.party) check(r.party === query.party);
    if (resource === 'advances') {
      check(
        int(r.party) &&
          text(r.direction) &&
          ['customer', 'supplier'].includes(r.direction) &&
          money(r.unallocated),
      );
      continue;
    }
    check(money(r.total));
    if (resource === 'debts') {
      check(
        money(r.amount) &&
          text(r.kind) &&
          ['sale', 'receipt'].includes(r.kind) &&
          text(r.originalKind) &&
          ['sale', 'receipt', 'debt_opening'].includes(r.originalKind) &&
          text(r.dueDate) &&
          typeof r.overdue === 'boolean',
      );
      if ('status' in query && query.status) check(r.overdue === (query.status === 'overdue'));
      continue;
    }
    check(
      text(r.kind) &&
        policy.documentKinds.includes(r.kind as Policy['documentKinds'][number]) &&
        text(r.status) &&
        Object.hasOwn(statuses, r.status) &&
        int(r.revision),
    );
    if ('status' in query && query.status) check(r.status === query.status);
  }
  return v as Pages[R];
}
export function createFinanceApi(transport: typeof fetch = fetch) {
  return {
    async read<R extends Resource>(
      resource: R,
      query: Queries[R],
      page = 1,
      signal?: AbortSignal,
    ): Promise<Pages[R]> {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...query, page }))
        if (v !== null && v !== '') p.set(k, String(v));
      let response: Response;
      try {
        response = await transport('/api/v1/trading/finance/' + resource + '?' + p, {
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') throw e;
        throw new ApiError(0, 'Не вдалося з’єднатися із сервером.');
      }
      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        throw new ApiError(
          response.status,
          text(e.error) ? e.error : 'Не вдалося прочитати фінанси.',
          text(e.code) ? e.code : undefined,
        );
      }
      return decodePage(raw, resource, query);
    },
  };
}
export type FinanceApi = ReturnType<typeof createFinanceApi>;
export const moneyText = (value: string) => {
  const [whole = '', fraction = ''] = value.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + fraction;
};
