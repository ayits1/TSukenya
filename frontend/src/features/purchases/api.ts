import type { components } from '../../shared/api/purchases.generated';
import { ApiError } from '../../shared/api/client';
export type Policy = components['schemas']['PurchasePolicy'];
export type DocumentQuery = components['schemas']['PurchaseQuery'];
export type ReplenishmentQuery = components['schemas']['ReplenishmentQuery'];
export type Group = components['schemas']['ReplenishmentGroup'];
export type Line = components['schemas']['ReplenishmentLine'];
export type Documents = components['schemas']['PurchaseDocuments'];
export type Groups = components['schemas']['ReplenishmentGroups'];
export type Lines = components['schemas']['ReplenishmentLines'];
export type Draft = components['schemas']['ReplenishmentDraft'];
export const kinds = {
  purchase_order: 'Замовлення постачальнику',
  receipt: 'Надходження',
  supplier_return: 'Повернення постачальнику',
};
export const statuses = { draft: 'Чернетка', posted: 'Проведено', reversed: 'Сторновано' };
const fail = (): never => {
  throw new ApiError(
    200,
    'Сервер повернув некоректні дані закупівель. Оновіть список.',
    'protocol',
  );
};
const check = (v: unknown) => {
  if (!v) fail();
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
const keys = (v: Record<string, unknown>, names: string[]) =>
  check(Object.keys(v).length === names.length && names.every((k) => Object.hasOwn(v, k)));
const int = (v: unknown, min = 0): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const text = (v: unknown): v is string => typeof v === 'string';
const decimal = (v: unknown, places: number): v is string =>
  text(v) && v.length <= 40 && new RegExp('^\\d+\\.\\d{' + places + '}$').test(v);
const date = (v: unknown): v is string =>
  text(v) &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v + 'T00:00:00Z')) &&
  new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const binding = (v: unknown): v is string => text(v) && /^[a-f0-9]{64}$/.test(v);
export function decodePolicy(raw: unknown): Policy {
  const p = object(raw);
  keys(p, ['role', 'store', 'documentKinds']);
  check(
    text(p.role) &&
      ['owner', 'manager', 'warehouse'].includes(p.role) &&
      (p.store === null || int(p.store, 1)) &&
      JSON.stringify(p.documentKinds) === JSON.stringify(Object.keys(kinds)),
  );
  return p as Policy;
}
function scoped(policy: Policy, store: number, queryStore: number | null) {
  check(
    (policy.store === null || policy.store === store) &&
      (queryStore === null || queryStore === store),
  );
}
function page(v: Record<string, unknown>, items: unknown[], key: (x: unknown) => string) {
  check(int(v.total) && int(v.page, 1) && int(v.pages, 1) && v.limit === 30);
  const total = Number(v.total),
    p = Number(v.page);
  check(
    v.pages === Math.max(1, Math.ceil(total / 30)) &&
      p <= Number(v.pages) &&
      items.length === Math.min(30, Math.max(0, total - (p - 1) * 30)) &&
      new Set(items.map(key)).size === items.length,
  );
}
function echoed(raw: unknown, expected: object) {
  const v = object(raw);
  keys(v, Object.keys(expected));
  for (const [key, value] of Object.entries(expected)) check(v[key] === value);
}
export function decodeDocuments(raw: unknown, query: DocumentQuery): Documents {
  const v = object(raw);
  keys(v, ['items', 'total', 'page', 'pages', 'limit', 'query', 'policy']);
  echoed(v.query, query);
  const policy = decodePolicy(v.policy);
  check(Array.isArray(v.items));
  const items = v.items as unknown[];
  for (const raw of items) {
    const r = object(raw);
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
        int(r.store, 1) &&
        text(r.storeName) &&
        (r.party === null || int(r.party, 1)) &&
        text(r.partyName) &&
        decimal(r.total, 2) &&
        int(r.revision, 1),
    );
    scoped(policy, Number(r.store), query.store);
    if (query.kind) check(r.kind === query.kind);
    if (query.status) check(r.status === query.status);
    if (query.from) check(String(r.date) >= query.from);
    if (query.to) check(String(r.date) <= query.to);
  }
  page(v, items, (r) => String(object(r).id));
  return v as Documents;
}
export function decodeLine(raw: unknown): Line {
  const r = object(raw);
  keys(r, [
    'product',
    'name',
    'unit',
    'quantity',
    'price',
    'available',
    'minimum',
    'onOrder',
    'costKnown',
  ]);
  check(
    text(r.product) &&
      r.product.length > 0 &&
      r.product.length <= 120 &&
      !r.product.includes('/') &&
      text(r.name) &&
      text(r.unit) &&
      typeof r.costKnown === 'boolean',
  );
  for (const k of ['quantity', 'available', 'minimum', 'onOrder']) check(decimal(r[k], 3));
  check(decimal(r.price, 4) && /[1-9]/.test(String(r.quantity)));
  return r as Line;
}
export function decodeGroup(raw: unknown, policy: Policy, store: number | null): Group {
  const g = object(raw);
  keys(g, [
    'key',
    'store',
    'storeName',
    'warehouse',
    'warehouseName',
    'party',
    'partyName',
    'linesCount',
    'total',
    'preview',
    'binding',
    'parts',
  ]);
  check(
    int(g.store, 1) &&
      text(g.storeName) &&
      int(g.warehouse, 1) &&
      text(g.warehouseName) &&
      (g.party === null || int(g.party, 1)) &&
      text(g.partyName) &&
      g.key === g.warehouse + ':' + (g.party ?? 0) &&
      int(g.linesCount, 1) &&
      decimal(g.total, 2) &&
      binding(g.binding) &&
      g.parts === Math.ceil(Number(g.linesCount) / 200) &&
      Array.isArray(g.preview),
  );
  const preview = (g.preview as unknown[]).map(decodeLine);
  check(
    preview.length === Math.min(3, Number(g.linesCount)) &&
      new Set(preview.map((l) => l.product)).size === preview.length,
  );
  scoped(policy, Number(g.store), store);
  return { ...g, preview } as Group;
}
export function decodeGroups(raw: unknown, query: ReplenishmentQuery): Groups {
  const v = object(raw);
  keys(v, ['items', 'total', 'page', 'pages', 'limit', 'query', 'policy', 'asOf', 'summary']);
  echoed(v.query, query);
  check(date(v.asOf) && Array.isArray(v.items));
  const policy = decodePolicy(v.policy),
    items = (v.items as unknown[]).map((r) => decodeGroup(r, policy, query.store));
  if (query.warehouse) items.forEach((g) => check(g.warehouse === query.warehouse));
  page(v, items, (r) => String(object(r).key));
  const s = object(v.summary);
  keys(s, ['groups', 'lines', 'covered', 'total']);
  check(
    s.groups === v.total &&
      int(s.lines) &&
      Number(s.lines) >= Number(s.groups) &&
      int(s.covered) &&
      decimal(s.total, 2),
  );
  return { ...v, items } as Groups;
}
const selection = (query: ReplenishmentQuery, group: Group) => ({
  ...query,
  warehouse: group.warehouse,
  party: group.party,
});
function boundGroup(raw: unknown, p: Policy, query: ReplenishmentQuery, expected: Group): Group {
  const group = decodeGroup(raw, p, query.store);
  // Every header and preview field belongs to the displayed, binding-confirmed snapshot.
  // The native editor uses these values directly when preparing an unsaved order.
  const { preview: expectedPreview, ...expectedHeader } = expected;
  for (const key of Object.keys(expectedHeader) as (keyof typeof expectedHeader)[]) {
    check(group[key] === expectedHeader[key]);
  }
  check(group.preview.length === expectedPreview.length);
  expectedPreview.forEach((line, index) => {
    const actual = group.preview[index] ?? fail();
    for (const key of Object.keys(line) as (keyof Line)[]) {
      check(actual[key] === line[key]);
    }
  });
  return group;
}
export function decodeLines(raw: unknown, query: ReplenishmentQuery, group: Group): Lines {
  const v = object(raw);
  keys(v, [
    'items',
    'total',
    'page',
    'pages',
    'limit',
    'query',
    'policy',
    'group',
    'binding',
    'asOf',
  ]);
  echoed(v.query, selection(query, group));
  check(date(v.asOf));
  const policy = decodePolicy(v.policy);
  boundGroup(v.group, policy, query, group);
  check(v.binding === group.binding && v.total === group.linesCount && Array.isArray(v.items));
  const items = (v.items as unknown[]).map(decodeLine);
  page(v, items, (r) => String(object(r).product));
  return { ...v, items } as Lines;
}
export function decodeDraft(
  raw: unknown,
  query: ReplenishmentQuery,
  group: Group,
  part: number,
): Draft {
  const v = object(raw);
  keys(v, ['group', 'binding', 'lines', 'policy', 'part', 'parts', 'limit', 'total']);
  const policy = decodePolicy(v.policy);
  boundGroup(v.group, policy, query, group);
  check(
    v.binding === group.binding &&
      v.part === part &&
      int(part, 1) &&
      part <= group.parts &&
      v.parts === group.parts &&
      v.limit === 200 &&
      v.total === group.linesCount &&
      Array.isArray(v.lines),
  );
  const lines = (v.lines as unknown[]).map(decodeLine);
  check(
    lines.length === Math.min(200, group.linesCount - (part - 1) * 200) &&
      new Set(lines.map((l) => l.product)).size === lines.length,
  );
  return { ...v, lines } as Draft;
}
const params = (values: object) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== null && value !== undefined && value !== '') q.set(key, String(value));
  return q;
};
export function createPurchasesApi(transport: typeof fetch = fetch) {
  async function read<T>(
    path: string,
    decode: (v: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await transport('/api/v1/trading/purchases/' + path, {
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
      const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      throw new ApiError(
        response.status,
        typeof v.error === 'string' ? v.error : 'Не вдалося прочитати закупівлі.',
        typeof v.code === 'string' ? v.code : undefined,
      );
    }
    return decode(raw);
  }
  const chosen = (q: ReplenishmentQuery, g: Group) => ({
    ...selection(q, g),
    party: g.party ?? 0,
    binding: g.binding,
  });
  return {
    documents: (q: DocumentQuery, page = 1, signal?: AbortSignal) =>
      read('documents?' + params({ ...q, page }), (v) => decodeDocuments(v, q), signal),
    groups: (q: ReplenishmentQuery, page = 1, signal?: AbortSignal) =>
      read('replenishment?' + params({ ...q, page }), (v) => decodeGroups(v, q), signal),
    lines: (q: ReplenishmentQuery, g: Group, page = 1, signal?: AbortSignal) =>
      read(
        'replenishment/lines?' + params({ ...chosen(q, g), page }),
        (v) => decodeLines(v, q, g),
        signal,
      ),
    draft: (q: ReplenishmentQuery, g: Group, part = 1, signal?: AbortSignal) =>
      read(
        'replenishment/draft?' + params({ ...chosen(q, g), part }),
        (v) => decodeDraft(v, q, g, part),
        signal,
      ),
  };
}
export type PurchasesApi = ReturnType<typeof createPurchasesApi>;
export const decimalText = (value: string, minimumFraction = 0) => {
  const [whole = '', fraction = ''] = value.split('.');
  const digits = fraction.replace(/0+$/, '').padEnd(minimumFraction, '0');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (digits ? ',' + digits : '');
};
