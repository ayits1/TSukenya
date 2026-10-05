import type { components } from '../../shared/api/reports.generated';
import { ApiError } from '../../shared/api/client';
export { moneyText } from '../finance/api';
export type Summary = components['schemas']['Summary'];
export type Page = components['schemas']['Page'];
export type Section = Page['section'];
export type Mode = Summary['mode'];
export type Context = { mode: Mode; store: number | null; from: string; to: string; as_of: string };
export type Query = Context & { section: Section; q: string; page: number };
export const sections: Record<Mode, Section[]> = {
  period: ['products', 'by_store', 'expenses_by_category', 'cashiers'],
  balances: ['stock', 'cash', 'debts', 'advances', 'payroll_debts'],
};
export const titles: Record<Section, string> = {
  products: 'Товари',
  by_store: 'Магазини',
  expenses_by_category: 'Статті витрат',
  cashiers: 'Касири',
  stock: 'Товарні залишки',
  cash: 'Кошти',
  debts: 'Історичні борги',
  advances: 'Аванси',
  payroll_debts: 'Борги із зарплати',
};
export const labels = {
  revenue: 'Виторг',
  cogs: 'Собівартість',
  expenses: 'Витрати',
  payroll: 'Зарплата',
  writeoffs: 'Списання',
  inventory_adjustment: 'Інвентаризаційне коригування',
  supplier_return_variance: 'Різниця повернень постачальнику',
  cash_difference: 'Касове розходження',
  cash_net: 'Чистий рух коштів',
  gross_profit: 'Валовий прибуток',
  profit: 'Операційний результат',
  unallocated_expenses: 'Мережеві нерозподілені витрати',
};
export type Metric = keyof typeof labels;
export const moneyKeys = Object.keys(labels) as Metric[];
const fail = (): never => {
  throw new ApiError(200, 'Сервер повернув некоректний звіт. Повторіть читання.', 'protocol');
};
function check(value: unknown): asserts value {
  if (!value) fail();
}
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const text = (v: unknown): v is string => typeof v === 'string';
const integer = (v: unknown, min = 0): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const decimal = (v: unknown, scale = 2) =>
  text(v) && v.length <= 60 && new RegExp('^-?[0-9]+\\.[0-9]{' + scale + '}$').test(v);
const nullable = (v: unknown, validate: (v: unknown) => boolean) => v === null || validate(v);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  check(
    required.every((k) => Object.hasOwn(v, k)) &&
      Object.keys(v).every((k) => required.includes(k) || optional.includes(k)),
  );
export const day = (v: unknown): v is string =>
  text(v) &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v + 'T12:00:00Z')) &&
  new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v;
const textFields: Record<Section, string[]> = {
  products: ['product', 'name', 'unit'],
  by_store: ['name'],
  expenses_by_category: ['category', 'scope'],
  cashiers: ['name'],
  stock: ['code', 'warehouse_name', 'product', 'name', 'unit'],
  cash: ['name', 'kind'],
  debts: ['number', 'kind', 'original_kind', 'date', 'party', 'due_date'],
  advances: ['number', 'party', 'direction', 'date'],
  payroll_debts: ['name'],
};
const numericFields: Record<Section, string[]> = {
  products: [
    'quantity',
    'revenue',
    'cogs',
    'writeoff_quantity',
    'writeoff',
    'inventory',
    'gross_profit',
    'result',
  ],
  by_store: moneyKeys.filter((k) => k !== 'unallocated_expenses'),
  expenses_by_category: ['amount'],
  cashiers: ['shortage', 'surplus', 'revenue', 'hours', 'net'],
  stock: ['quantity', 'value'],
  cash: ['amount'],
  debts: ['total', 'amount'],
  advances: ['amount'],
  payroll_debts: ['amount'],
};
const idFields: Record<Section, string[]> = {
  products: [],
  by_store: ['store'],
  expenses_by_category: ['store'],
  cashiers: ['employee'],
  stock: ['lot', 'warehouse', 'store'],
  cash: ['account', 'store'],
  debts: ['voucher', 'store', 'party_id'],
  advances: ['payment', 'store', 'party_id'],
  payroll_debts: ['employee', 'store'],
};
const extras: Record<Section, string[]> = {
  products: ['margin'],
  by_store: [],
  expenses_by_category: ['store_name'],
  cashiers: ['shifts', 'with_difference', 'revenue_per_hour'],
  stock: ['expiry', 'expired'],
  cash: [],
  debts: ['overdue'],
  advances: [],
  payroll_debts: [],
};
export function decodeSummary(raw: unknown, expected: Context, payroll: boolean): Summary {
  const v = object(raw),
    common = [
      'contract',
      'mode',
      'store',
      'scope_name',
      'generated_at',
      'basis',
      'reversal_policy',
      'snapshot',
      'snapshot_notice',
      'counts',
      'can_view_payroll',
    ];
  check(v.mode === expected.mode);
  keys(
    v,
    expected.mode === 'period'
      ? [...common, 'from', 'to', ...moneyKeys, 'cashiers_basis', 'debts_basis']
      : [...common, 'as_of', 'stock_value', 'cash_total', 'debt_totals', 'advance_totals'],
  );
  check(
    v.contract === 'trading-reports-v1' &&
      v.basis === 'accounting_dates' &&
      v.reversal_policy === 'kyiv_reversed_at' &&
      v.snapshot === 'current' &&
      text(v.scope_name) &&
      text(v.snapshot_notice) &&
      text(v.generated_at) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        v.generated_at,
      ) &&
      Number.isFinite(Date.parse(v.generated_at)) &&
      v.store === expected.store &&
      v.can_view_payroll === payroll,
  );
  const counts = object(v.counts);
  keys(
    counts,
    sections[expected.mode].filter((s) => s !== 'payroll_debts' || payroll),
  );
  check(Object.values(counts).every((x) => integer(x)));
  if (expected.mode === 'period')
    check(
      day(v.from) &&
        day(v.to) &&
        v.from <= v.to &&
        v.from === expected.from &&
        v.to === expected.to &&
        moneyKeys.every((k) => decimal(v[k])) &&
        v.cashiers_basis === 'current_posted_closed_shifts' &&
        v.debts_basis === 'current',
    );
  else {
    check(
      day(v.as_of) && v.as_of === expected.as_of && decimal(v.stock_value) && decimal(v.cash_total),
    );
    const debt = object(v.debt_totals),
      advance = object(v.advance_totals);
    keys(debt, ['owed_to_us', 'owed_by_us']);
    keys(advance, ['customer', 'supplier']);
    check([...Object.values(debt), ...Object.values(advance)].every((x) => decimal(x)));
  }
  return v as Summary;
}
function row(raw: unknown, section: Section, payroll: boolean) {
  const v = object(raw);
  keys(v, [
    ...textFields[section],
    ...numericFields[section],
    ...idFields[section],
    ...extras[section],
    ...(section === 'cashiers' && payroll ? ['late_return_bonus'] : []),
  ]);
  check(
    textFields[section].every((k) => text(v[k])) &&
      numericFields[section].every((k) =>
        decimal(v[k], k === 'quantity' || k === 'writeoff_quantity' ? 3 : k === 'hours' ? 1 : 2),
      ),
  );
  check(
    idFields[section].every(
      (k) =>
        nullable(v[k], (x) => integer(x, 1)) &&
        (v[k] !== null || section === 'cashiers' || section === 'expenses_by_category'),
    ),
  );
  if (section === 'products') check(nullable(v.margin, (x) => decimal(x, 1)));
  if (section === 'cashiers')
    check(
      integer(v.shifts) &&
        integer(v.with_difference) &&
        v.with_difference <= v.shifts &&
        nullable(v.revenue_per_hour, (x) => decimal(x)) &&
        (!payroll || decimal(v.late_return_bonus)),
    );
  if (section === 'stock') check(nullable(v.expiry, day) && typeof v.expired === 'boolean');
  if (section === 'cash') check(text(v.kind) && ['cash', 'bank', 'terminal'].includes(v.kind));
  if (section === 'debts')
    check(
      day(v.date) &&
        (!v.due_date || day(v.due_date)) &&
        text(v.kind) &&
        ['sale', 'receipt'].includes(v.kind) &&
        text(v.original_kind) &&
        ['sale', 'receipt', 'debt_opening'].includes(v.original_kind) &&
        typeof v.overdue === 'boolean',
    );
  if (section === 'advances')
    check(day(v.date) && text(v.direction) && ['customer', 'supplier'].includes(v.direction));
  if (section === 'expenses_by_category')
    check(
      text(v.scope) &&
        ['store', 'network'].includes(v.scope) &&
        nullable(v.store_name, text) &&
        (v.scope === 'network') === (v.store === null),
    );
  return v;
}
export function decodePage(raw: unknown, expected: Query, payroll: boolean): Page {
  const v = object(raw);
  keys(v, ['contract', 'section', 'items', 'total', 'page', 'pages', 'limit', 'q', 'summary']);
  check(
    v.contract === 'trading-reports-v1' &&
      v.section === expected.section &&
      integer(v.total) &&
      integer(v.page, 1) &&
      integer(v.pages, 1) &&
      v.limit === 30 &&
      v.pages === Math.max(1, Math.ceil(v.total / 30)) &&
      v.page === Math.min(expected.page, v.pages) &&
      v.q === expected.q.trim() &&
      Array.isArray(v.items) &&
      v.items.length === Math.min(30, Math.max(0, v.total - (v.page - 1) * 30)),
  );
  const summary = decodeSummary(v.summary, expected, payroll),
    counts = summary.counts as Record<string, number>;
  check(
    Object.hasOwn(counts, expected.section) &&
      v.total <= counts[expected.section]! &&
      (!!v.q || v.total === counts[expected.section]),
  );
  const rows = v.items.map((x) => row(x, expected.section, payroll));
  const identity = (r: Record<string, unknown>) =>
    expected.section === 'expenses_by_category'
      ? JSON.stringify([r.store, r.category])
      : expected.section === 'cashiers'
        ? JSON.stringify([r.employee, r.employee === null ? r.name : null])
        : String(
            r[
              (
                {
                  products: 'product',
                  by_store: 'store',
                  stock: 'lot',
                  cash: 'account',
                  debts: 'voucher',
                  advances: 'payment',
                  payroll_debts: 'employee',
                } as Record<string, string>
              )[expected.section]!
            ],
          );
  check(new Set(rows.map(identity)).size === rows.length);
  return v as Page;
}
export function params(query: Context) {
  return new URLSearchParams({
    mode: query.mode,
    store: query.store === null ? '' : String(query.store),
    ...(query.mode === 'period' ? { from: query.from, to: query.to } : { as_of: query.as_of }),
  });
}
export function exportURL(query: Context, section: Section | 'summary' | 'all', q = '') {
  const p = params(query);
  p.set('section', section);
  p.set('q', q);
  return '/api/v1/trading/reports/export.csv?' + p;
}
export type ReportsApi = {
  read: (query: Query, payroll: boolean, signal: AbortSignal) => Promise<Page>;
};
export function createReportsApi(request: typeof fetch = fetch): ReportsApi {
  return {
    async read(query, payroll, signal) {
      const p = params(query);
      p.set('section', query.section);
      p.set('q', query.q);
      p.set('page', String(query.page));
      const response = await request('/api/v1/trading/reports/rows?' + p, {
        signal,
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (signal.aborted) throw new DOMException('Скасовано', 'AbortError');
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        if (!response.ok)
          throw new ApiError(response.status, 'Не вдалося прочитати звіт. Повторіть читання.');
        fail();
      }
      if (signal.aborted) throw new DOMException('Скасовано', 'AbortError');
      if (!response.ok)
        throw new ApiError(
          response.status,
          response.status === 401
            ? 'Сеанс завершився.'
            : response.status === 403
              ? 'Немає доступу до звіту.'
              : 'Не вдалося прочитати звіт. Повторіть читання.',
        );
      return decodePage(raw, query, payroll);
    },
  };
}
export type Sources = components['schemas']['Sources'];
export type SourceQuery = Context & { metric: Metric | 'stock' | 'cash'; source?: number };
export function decodeSources(
  raw: unknown,
  expected: SourceQuery,
  page: number,
  role: string,
  policyStore: number | null,
): Sources {
  const v = object(raw),
    balance = expected.mode === 'balances';
  keys(v, [
    'contract',
    'limit',
    'store',
    'policy',
    'mode',
    'metric',
    'title',
    'formula',
    'amount',
    'items',
    'total',
    'page',
    'pages',
    'snapshot',
    'basis',
    'reversal_policy',
    'snapshot_notice',
    ...(balance ? ['as_of', 'source'] : ['from', 'to']),
  ]);
  const policy = object(v.policy);
  keys(policy, ['role', 'store']);
  check(text(policy.role) && policy.role === role && policy.store === policyStore);
  check(
    v.contract === 'trading-report-sources-v1' &&
      v.limit === 30 &&
      v.store === expected.store &&
      v.mode === expected.mode &&
      v.metric === expected.metric &&
      text(v.title) &&
      text(v.formula) &&
      decimal(v.amount) &&
      text(v.snapshot_notice) &&
      v.snapshot === 'current' &&
      v.basis === 'accounting_dates' &&
      v.reversal_policy === 'kyiv_reversed_at',
  );
  check(
    balance
      ? day(v.as_of) &&
          v.as_of === expected.as_of &&
          integer(v.source, 1) &&
          v.source === expected.source
      : day(v.from) && day(v.to) && v.from === expected.from && v.to === expected.to,
  );
  check(
    integer(v.total) &&
      integer(v.pages, 1) &&
      integer(v.page, 1) &&
      v.pages === Math.max(1, Math.ceil(v.total / 30)) &&
      v.page === Math.min(page, v.pages) &&
      Array.isArray(v.items) &&
      v.items.length === Math.min(30, Math.max(0, v.total - (v.page - 1) * 30)),
  );
  const allowed =
    expected.metric === 'profit'
      ? [
          'revenue',
          'cogs',
          'expenses',
          'payroll',
          'writeoffs',
          'inventory_adjustment',
          'supplier_return_variance',
          'cash_difference',
          'unallocated_expenses',
        ]
      : expected.metric === 'gross_profit'
        ? ['revenue', 'cogs']
        : expected.metric === 'expenses'
          ? ['expenses', 'unallocated_expenses']
          : [expected.metric];
  for (const raw of v.items) {
    const r = object(raw);
    check(text(r.metric) && allowed.includes(r.metric) && decimal(r.amount));
    if (r.type === 'aggregate') {
      keys(r, ['type', 'metric', 'amount', 'label', 'canOpen']);
      check(role === 'manager' && r.canOpen === false && text(r.label));
      continue;
    }
    keys(
      r,
      [
        'type',
        'metric',
        'amount',
        'sign',
        'date',
        'voucher_date',
        'reversal',
        'store',
        'kind',
        'voucher',
        'number',
        'canOpen',
      ],
      ['entry', 'quantity'],
    );
    check(
      r.type === 'voucher' &&
        text(r.kind) &&
        [
          'purchase_order',
          'receipt',
          'opening',
          'sale',
          'customer_return',
          'supplier_return',
          'transfer',
          'writeoff',
          'inventory',
          'production',
          'payment',
          'advance_allocation',
          'payment_refund',
          'expense',
          'cash_opening',
          'debt_opening',
          'cash_transfer',
          'cash_difference',
          'payroll',
          'payroll_payment',
          'customer_order',
        ].includes(r.kind) &&
        integer(r.store, 1) &&
        day(r.date) &&
        day(r.voucher_date) &&
        (r.sign === 1 || r.sign === -1) &&
        r.reversal === (r.sign === -1) &&
        typeof r.canOpen === 'boolean',
    );
    check(expected.store === null || r.store === expected.store);
    check(policyStore === null || r.store === policyStore);
    check(
      r.canOpen
        ? integer(r.voucher, 1) && r.number === String(r.voucher).padStart(6, '0')
        : r.voucher === null && r.number === null,
    );
    if (role === 'manager') check(!['payroll', 'payroll_payment'].includes(r.kind));
    if (Object.hasOwn(r, 'entry')) check(integer(r.entry, 1));
    if (Object.hasOwn(r, 'quantity')) check(expected.metric === 'stock' && decimal(r.quantity, 3));
  }
  return v as Sources;
}
