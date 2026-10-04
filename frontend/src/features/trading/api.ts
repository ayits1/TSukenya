import type { components } from '../../shared/api/trading.generated';
export type DirectoryType = components['schemas']['DirectoryType'];
export type DirectoryItem = components['schemas']['DirectoryItem'];
export type DirectoryPage = components['schemas']['DirectoryPage'];
export type DirectoryRef = components['schemas']['DirectoryRef'];
export type DirectoryDetails = components['schemas']['DirectoryDetails'];
export type TradingBootstrap = components['schemas']['TradingBootstrap'];
export type DirectoryQuery = {
  q?: string;
  page?: number;
  store?: number | null;
  kind?: string;
  active?: '' | 'yes' | 'no';
  purpose?: string;
  exclude?: string;
  sort?: string;
};
const types: readonly string[] = [
  'stores',
  'warehouses',
  'accounts',
  'employees',
  'parties',
  'products',
  'expense_categories',
  'cash_shifts',
];
const fields = [
  'id',
  'name',
  'store_id',
  'account_id',
  'active',
  'kind',
  'phone',
  'email',
  'notes',
  'revision',
  'unit',
  'barcode',
  'hidden',
  'promotion',
  'cost',
  'regularPrice',
  'salePrice',
  'shift_rate',
  'bonus_percent',
  'bonus_basis',
  'balance',
  'payroll_debt',
  'semantic_key',
];
const object = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw Error('Некоректна відповідь довідника. Чернетку збережено.');
  return raw as Record<string, unknown>;
};
const check = (ok: boolean): void => {
  if (!ok) throw Error('Некоректна відповідь довідника. Чернетку збережено.');
};
const integer = (raw: unknown, min = 0) =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= min;
const text = (raw: unknown) => typeof raw === 'string';
const amount = (raw: unknown, signed = false) =>
  typeof raw === 'string' && (signed ? /^-?\d+\.\d{2}$/ : /^\d+\.\d{2}$/).test(raw);
const identifier = (raw: unknown) =>
  typeof raw === 'string' &&
  raw.length > 0 &&
  raw.length <= 120 &&
  !raw.includes('/') &&
  ![...raw].some((char) => char.charCodeAt(0) < 32);
export function decodeDirectoryItem(raw: unknown): DirectoryItem {
  const v = object(raw);
  check(Object.keys(v).every((key) => fields.includes(key)) && identifier(v.id) && text(v.name));
  for (const key of ['phone', 'email', 'notes', 'revision', 'unit', 'barcode', 'semantic_key'])
    if (key in v) check(text(v[key]));
  for (const key of ['active', 'hidden', 'promotion'])
    if (key in v) check(typeof v[key] === 'boolean');
  for (const key of ['store_id', 'account_id']) if (key in v) check(integer(v[key], 1));
  if ('kind' in v)
    check(
      typeof v.kind === 'string' &&
        ['supplier', 'customer', 'cash', 'bank', 'terminal'].includes(v.kind),
    );
  if ('bonus_basis' in v)
    check(
      typeof v.bonus_basis === 'string' && ['store', 'personal', 'profit'].includes(v.bonus_basis),
    );
  for (const key of ['cost', 'bonus_percent'])
    if (key in v) check(typeof v[key] === 'string' && /^\d+(?:\.\d+)?$/.test(v[key]));
  for (const key of ['regularPrice', 'salePrice', 'shift_rate'])
    if (key in v) check(amount(v[key]));
  for (const key of ['balance', 'payroll_debt']) if (key in v) check(amount(v[key], true));
  return v as DirectoryItem;
}
export function decodeDirectoryPage(raw: unknown): DirectoryPage {
  const v = object(raw);
  check(
    Array.isArray(v.items) &&
      v.items.length <= 30 &&
      integer(v.total) &&
      integer(v.page, 1) &&
      integer(v.pages, 1) &&
      Number(v.page) <= Number(v.pages) &&
      v.limit === 30,
  );
  return {
    items: (v.items as unknown[]).map(decodeDirectoryItem),
    total: Number(v.total),
    page: Number(v.page),
    pages: Number(v.pages),
    limit: 30,
  };
}
function decodeRef(raw: unknown): DirectoryRef {
  const v = object(raw);
  check(typeof v.type === 'string' && types.includes(v.type) && identifier(v.id));
  if (v.type === 'expense_categories')
    check(typeof v.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.id));
  else if (v.type !== 'products') check(typeof v.id === 'string' && /^[1-9]\d{0,11}$/.test(v.id));
  return { type: v.type as DirectoryType, id: String(v.id) };
}
export function decodeDirectoryDetails(raw: unknown): DirectoryDetails {
  const v = object(raw);
  check(
    Array.isArray(v.items) &&
      v.items.length <= 200 &&
      Array.isArray(v.unavailable) &&
      v.unavailable.length <= 200,
  );
  const items = (v.items as unknown[]).map((raw) => {
    const row = object(raw);
    const ref = decodeRef(row);
    const value = { ...row };
    delete value.type;
    return { ...decodeDirectoryItem(value), type: ref.type };
  });
  const unavailable = (v.unavailable as unknown[]).map(decodeRef),
    keys = [...items, ...unavailable].map((row) => row.type + ':' + row.id);
  check(new Set(keys).size === keys.length && keys.length <= 200);
  return { items, unavailable };
}
export function decodeTradingBootstrap(raw: unknown): TradingBootstrap {
  const v = object(raw);
  check(
    Object.keys(v).every((key) =>
      [
        'csrf',
        'role',
        'username',
        'storeId',
        'defaultStoreId',
        'defaultCategoryId',
        'canViewAudit',
        'closed_through',
        'fiscal_required',
        'max_discount',
        'alerts_status',
      ].includes(key),
    ),
  );
  check(
    text(v.csrf) &&
      String(v.csrf).length > 0 &&
      text(v.username) &&
      typeof v.role === 'string' &&
      ['owner', 'manager', 'cashier', 'warehouse', 'accountant'].includes(v.role),
  );
  check(
    text(v.defaultCategoryId) &&
      [v.storeId, v.defaultStoreId].every((id) => id === null || integer(id, 1)) &&
      typeof v.canViewAudit === 'boolean' &&
      typeof v.fiscal_required === 'boolean' &&
      typeof v.max_discount === 'string' &&
      /^\d+(?:\.\d+)?$/.test(v.max_discount),
  );
  check(
    v.closed_through === null ||
      (typeof v.closed_through === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.closed_through)),
  );
  if ('alerts_status' in v) object(v.alerts_status);
  return v as TradingBootstrap;
}
export function createTradingApi(transport: typeof fetch = fetch) {
  let csrf = '';
  async function request<T>(
    path: string,
    decode: (raw: unknown) => T,
    signal?: AbortSignal,
    body?: unknown,
  ) {
    const response = await transport('/api/v1/trading/' + path, {
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(body === undefined ? {} : { 'X-CSRF-Token': csrf }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) throw Object.assign(Error('Сеанс завершився.'), { status: 401 });
    const raw: unknown = await response.json();
    if (!response.ok) {
      const error = object(raw);
      throw Object.assign(
        Error(typeof error.error === 'string' ? error.error : 'Не вдалося прочитати довідник.'),
        { status: response.status, code: error.code },
      );
    }
    return decode(raw);
  }
  return {
    async bootstrap(signal?: AbortSignal) {
      const value = await request('bootstrap', decodeTradingBootstrap, signal);
      csrf = value.csrf;
      return value;
    },
    list(type: DirectoryType, query: DirectoryQuery = {}, signal?: AbortSignal) {
      const params = new URLSearchParams();
      Object.entries(query).forEach(([key, value]) => {
        if (value !== null && value !== undefined) params.set(key, String(value));
      });
      return request('directories/' + type + '?' + params, decodeDirectoryPage, signal);
    },
    async details(
      ids: DirectoryRef[],
      query: Pick<DirectoryQuery, 'store' | 'purpose'> = {},
      signal?: AbortSignal,
    ) {
      if (!csrf) await this.bootstrap(signal);
      const value = await request('directories/details', decodeDirectoryDetails, signal, {
        ids,
        ...(query.store ? { store: query.store } : {}),
        ...(query.purpose ? { purpose: query.purpose } : {}),
      });
      const expected = new Set(ids.map((row) => row.type + ':' + row.id));
      check(
        [...value.items, ...value.unavailable].length === expected.size &&
          [...value.items, ...value.unavailable].every((row) =>
            expected.has(row.type + ':' + row.id),
          ),
      );
      return value;
    },
    lookup(mode: 'barcode' | 'name', q: string, store: number, signal?: AbortSignal) {
      return request(
        'products/lookup?' + new URLSearchParams({ mode, q, store: String(store) }),
        decodeDirectoryPage,
        signal,
      );
    },
  };
}
export type TradingApi = ReturnType<typeof createTradingApi>;
