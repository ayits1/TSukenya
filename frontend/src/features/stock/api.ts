import type { components } from '../../shared/api/stock.generated';
import { ApiError } from '../../shared/api/client';
export type StockPolicy = components['schemas']['StockPolicy'];
export type StockPage = components['schemas']['StockPage'];
export type StockTotal = components['schemas']['StockTotal'];
export type StockLot = components['schemas']['StockLot'];
export type AssortmentRow = components['schemas']['AssortmentRow'];
export type AssortmentPage = components['schemas']['AssortmentPage'];
export type AssortmentRequest = components['schemas']['AssortmentRequest'];
export type AssortmentAck = components['schemas']['AssortmentAck'];
export type StockDocuments = components['schemas']['StockDocuments'];
export type StockQuery = components['schemas']['StockQuery'];
export const documentLabels = {
  opening: 'Початкові залишки',
  transfer: 'Переміщення',
  writeoff: 'Списання',
  inventory: 'Інвентаризація',
  production: 'Виробництво',
};
export const statusLabels = { draft: 'Чернетка', posted: 'Проведено', reversed: 'Сторновано' };
const fail = () => {
  throw new ApiError(200, 'Сервер повернув некоректні дані. Чернетки збережено.', 'protocol');
};
const check = (v: unknown): void => {
  if (!v) fail();
};
const object = (v: unknown): Record<string, unknown> => {
  check(v && typeof v === 'object' && !Array.isArray(v));
  return v as Record<string, unknown>;
};
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => {
  check(
    required.every((k) => Object.hasOwn(v, k)) &&
      Object.keys(v).every((k) => [...required, ...optional].includes(k)),
  );
};
const integer = (v: unknown, min = 0) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const text = (v: unknown) => typeof v === 'string';
const id = (v: unknown) =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 120 &&
  !v.includes('/') &&
  ![...v].some((char) => char.charCodeAt(0) < 32);
const decimal = (v: unknown, places: number, signed = true) =>
  typeof v === 'string' &&
  v.length <= 40 &&
  new RegExp(`^${signed ? '-?' : ''}\\d+\\.\\d{${places}}$`).test(v);
const term = (v: unknown) =>
  typeof v === 'string' &&
  /^\d{1,12}(?:\.\d{1,3})?$/.test(v) &&
  BigInt(v.split('.')[0]!) <= 999999999999n;
const date = (v: unknown) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v + 'T00:00:00Z')) &&
  new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
export function decodePolicy(raw: unknown): StockPolicy {
  const v = object(raw);
  keys(v, [
    'role',
    'store',
    'costVisible',
    'canEditAssortment',
    'documentKinds',
    'canControl',
    'canLegacyRecipes',
    'canRecipeVersions',
    'canReplenish',
  ]);
  check(
    typeof v.role === 'string' &&
      ['owner', 'manager', 'warehouse', 'cashier', 'accountant'].includes(v.role),
  );
  check(v.store === null || integer(v.store, 1));
  for (const k of [
    'costVisible',
    'canEditAssortment',
    'canControl',
    'canLegacyRecipes',
    'canRecipeVersions',
    'canReplenish',
  ])
    check(typeof v[k] === 'boolean');
  check(
    Array.isArray(v.documentKinds) &&
      v.documentKinds.every((k) => typeof k === 'string' && Object.hasOwn(documentLabels, k)) &&
      new Set(v.documentKinds).size === v.documentKinds.length,
  );
  const edit = ['owner', 'manager', 'warehouse'].includes(String(v.role)),
    control = ['owner', 'manager'].includes(String(v.role));
  check(
    v.costVisible === (v.role !== 'cashier') &&
      v.canEditAssortment === edit &&
      v.canLegacyRecipes === edit &&
      v.canControl === control &&
      v.canRecipeVersions === control &&
      v.canReplenish === edit,
  );
  check(
    JSON.stringify(v.documentKinds) === JSON.stringify(edit ? Object.keys(documentLabels) : []),
  );
  return v as StockPolicy;
}
function page(v: Record<string, unknown>, items: unknown[], key: (v: unknown) => string) {
  check(integer(v.total) && integer(v.page, 1) && integer(v.pages, 1) && v.limit === 30);
  const total = Number(v.total),
    p = Number(v.page);
  check(v.pages === Math.max(1, Math.ceil(total / 30)) && p <= Number(v.pages));
  check(
    items.length === Math.min(30, Math.max(0, total - (p - 1) * 30)) &&
      new Set(items.map(key)).size === items.length,
  );
}
function privateValue(v: Record<string, unknown>, visible: boolean) {
  check(visible ? decimal(v.value, 2) : !Object.hasOwn(v, 'value'));
}
export function decodeStockPage(raw: unknown, query: StockQuery): StockPage {
  const v = object(raw);
  keys(v, [
    'items',
    'total',
    'page',
    'pages',
    'limit',
    'view',
    'summary',
    'query',
    'asOf',
    'policy',
    'alerts',
  ]);
  const policy = decodePolicy(v.policy),
    q = object(v.query);
  keys(q, ['q', 'store', 'warehouse', 'view']);
  check(
    JSON.stringify([q.q, q.store, q.warehouse, q.view]) ===
      JSON.stringify([query.q, query.store, query.warehouse, query.view]) &&
      v.view === query.view &&
      date(v.asOf),
  );
  check(Array.isArray(v.items));
  const items = v.items as unknown[];
  for (const raw of items) {
    const row = object(raw),
      lot = query.view === 'lots';
    keys(
      row,
      lot
        ? [
            'id',
            'warehouse',
            'product',
            'name',
            'unit',
            'lot',
            'expiry',
            'expired',
            'quantity',
            'available',
            'reserved',
          ]
        : [
            'warehouse',
            'product',
            'name',
            'unit',
            'sold',
            'low',
            'quantity',
            'available',
            'reserved',
            'minimum',
          ],
      ['value'],
    );
    check(
      integer(row.warehouse, 1) &&
        id(row.product) &&
        text(row.name) &&
        text(row.unit) &&
        String(row.unit).length > 0,
    );
    for (const k of ['quantity', 'available', 'reserved']) check(decimal(row[k], 3));
    privateValue(row, policy.costVisible);
    if (lot)
      check(
        integer(row.id, 1) &&
          text(row.lot) &&
          (row.expiry === null || date(row.expiry)) &&
          typeof row.expired === 'boolean' &&
          row.expired === (typeof row.expiry === 'string' && row.expiry < String(v.asOf)),
      );
    else
      check(
        typeof row.sold === 'boolean' &&
          typeof row.low === 'boolean' &&
          decimal(row.minimum, 3, false),
      );
  }
  page(v, items, (raw) => {
    const r = object(raw);
    return query.view === 'lots' ? String(r.id) : r.warehouse + ':' + r.product;
  });
  const summary = object(v.summary);
  keys(summary, ['products', 'low', 'lots', 'expiry'], ['value']);
  for (const k of ['products', 'low', 'lots', 'expiry']) check(integer(summary[k]));
  check(
    Number(summary.low) <= Number(summary.products) &&
      Number(summary.expiry) <= Number(summary.lots) &&
      v.total === (query.view === 'lots' ? summary.lots : summary.products),
  );
  privateValue(summary, policy.costVisible);
  if (v.alerts !== null) {
    const a = object(v.alerts);
    keys(a, ['ok', 'error', 'stale']);
    check(policy.canControl && typeof a.stale === 'boolean');
    for (const k of ['ok', 'error'])
      if (a[k] !== null) {
        const r = object(a[k]);
        keys(
          r,
          ['at', 'source'],
          k === 'ok' ? ['active', 'created', 'resolved', 'reopened'] : ['message', 'reference'],
        );
        check(
          text(r.at) &&
            !Number.isNaN(Date.parse(String(r.at))) &&
            ['manual', 'scheduler'].includes(String(r.source)),
        );
        for (const c of ['active', 'created', 'resolved', 'reopened'])
          if (c in r) check(integer(r[c]));
        if ('message' in r) check(text(r.message));
        if ('reference' in r)
          check(typeof r.reference === 'string' && /^[a-f0-9]{12}$/.test(r.reference));
      }
  } else check(!policy.canControl);
  return v as StockPage;
}
export function decodeAssortmentRow(raw: unknown): AssortmentRow {
  const v = object(raw);
  keys(v, ['product', 'name', 'unit', 'default_min', 'sold', 'min_stock', 'minimum', 'revision']);
  check(
    id(v.product) &&
      text(v.name) &&
      text(v.unit) &&
      String(v.unit).length > 0 &&
      typeof v.sold === 'boolean' &&
      term(v.default_min) &&
      term(v.minimum) &&
      (v.min_stock === null || term(v.min_stock)) &&
      (v.revision === null ||
        (typeof v.revision === 'string' && /^[a-f0-9]{32}$/.test(v.revision))),
  );
  check(normalTerm(String(v.minimum)) === normalTerm(String(v.min_stock ?? v.default_min)));
  return v as AssortmentRow;
}
export function normalTerm(v: string): string {
  const [whole = '', frac = ''] = v.replace(',', '.').split('.');
  return (
    whole.replace(/^0+(?=\d)/, '') + (frac.replace(/0+$/, '') ? '.' + frac.replace(/0+$/, '') : '')
  );
}
export function decodeAssortmentPage(
  raw: unknown,
  warehouse: number,
  q = '',
  product = '',
): AssortmentPage {
  const v = object(raw);
  keys(v, ['warehouse', 'rows', 'total', 'page', 'pages', 'limit', 'query', 'policy']);
  check(v.warehouse === warehouse);
  const query = object(v.query);
  keys(query, ['q', 'product']);
  check(query.q === q && query.product === product && Array.isArray(v.rows));
  const rows = (v.rows as unknown[]).map(decodeAssortmentRow);
  const policy = decodePolicy(v.policy);
  check(policy.canEditAssortment);
  page(v, rows, (r) => object(r).product as string);
  if (product) check(rows.length === 1 && rows[0]!.product === product);
  return { ...v, rows } as AssortmentPage;
}
export function decodeAssortmentAck(raw: unknown, intent: AssortmentRequest): AssortmentAck {
  const v = object(raw);
  keys(v, ['warehouse', 'row', 'policy']);
  const row = decodeAssortmentRow(v.row),
    policy = decodePolicy(v.policy);
  check(
    v.warehouse === intent.warehouse &&
      row.product === intent.product &&
      row.revision !== null &&
      row.sold === intent.sold &&
      (row.min_stock === null
        ? intent.min_stock === null
        : intent.min_stock !== null &&
          normalTerm(row.min_stock) === normalTerm(intent.min_stock)) &&
      policy.canEditAssortment,
  );
  return { warehouse: intent.warehouse, row, policy };
}
export function decodeDocuments(
  raw: unknown,
  store: number | null,
  status: string,
): StockDocuments {
  const v = object(raw);
  keys(v, ['items', 'total', 'page', 'pages', 'limit', 'query', 'policy']);
  const policy = decodePolicy(v.policy),
    q = object(v.query);
  keys(q, ['store', 'status']);
  check(q.store === store && q.status === status && Array.isArray(v.items));
  for (const raw of v.items as unknown[]) {
    const r = object(raw);
    keys(r, [
      'id',
      'number',
      'kind',
      'status',
      'date',
      'store',
      'party',
      'employee',
      'total',
      'revision',
    ]);
    check(
      integer(r.id, 1) &&
        r.number === String(r.id).padStart(6, '0') &&
        policy.documentKinds.includes(r.kind as never) &&
        Object.hasOwn(statusLabels, String(r.status)) &&
        date(r.date) &&
        integer(r.store, 1) &&
        [r.party, r.employee].every((x) => x === null || integer(x, 1)) &&
        decimal(r.total, 2) &&
        integer(r.revision, 1),
    );
    if (status) check(r.status === status);
    if (store) check(r.store === store);
    if (policy.store) check(r.store === policy.store);
  }
  page(v, v.items as unknown[], (raw) => String(object(raw).id));
  return v as StockDocuments;
}
const params = (v: Record<string, unknown>) => {
  const p = new URLSearchParams();
  Object.entries(v).forEach(([k, x]) => {
    if (x !== null && x !== undefined && x !== '') p.set(k, String(x));
  });
  return p;
};
export function createStockApi(getCsrf: () => string, transport: typeof fetch = fetch) {
  async function request<T>(
    path: string,
    decode: (raw: unknown) => T,
    signal?: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await transport('/api/v1/trading/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        ...(signal ? { signal } : {}),
        ...(body === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
              body: JSON.stringify(body),
            }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'Не вдалося з’єднатися із сервером.');
    }
    const raw: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      throw new ApiError(
        response.status,
        typeof v.error === 'string' ? v.error : 'Не вдалося виконати запит.',
        typeof v.code === 'string' ? v.code : undefined,
      );
    }
    return decode(raw);
  }
  return {
    stock: (query: StockQuery, page = 1, signal?: AbortSignal) =>
      request('stock?' + params({ ...query, page }), (v) => decodeStockPage(v, query), signal),
    assortment: (warehouse: number, q = '', page = 1, product = '', signal?: AbortSignal) =>
      request(
        'assortment?' + params({ warehouse, q, page, product }),
        (v) => decodeAssortmentPage(v, warehouse, q, product),
        signal,
      ),
    save: (body: AssortmentRequest, signal?: AbortSignal) =>
      request('assortment', (v) => decodeAssortmentAck(v, body), signal, body),
    documents: (store: number | null, status = '', page = 1, signal?: AbortSignal) =>
      request(
        'stock/documents?' + params({ store, status, page }),
        (v) => decodeDocuments(v, store, status),
        signal,
      ),
    async csv(query: StockQuery, signal?: AbortSignal) {
      const response = await transport(
        '/api/v1/trading/stock.csv?' + params({ ...query, view: 'totals' }),
        {
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok) {
        const v: unknown = await response.json().catch(() => null);
        throw new ApiError(
          response.status,
          v && typeof v === 'object' && 'error' in v && typeof v.error === 'string'
            ? v.error
            : 'Не вдалося завантажити CSV.',
        );
      }
      if (!response.headers.get('content-type')?.startsWith('text/csv')) fail();
      return response.blob();
    },
  };
}
export type StockApi = ReturnType<typeof createStockApi>;
/** Exact formatting only: no stock/money calculations or Number conversion. */
export function displayDecimal(v: string): string {
  const [whole = '', fraction = ''] = v.split('.');
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') +
    (fraction ? ',' + fraction.replace(/0+$/, '') : '').replace(/,$/, '')
  );
}
