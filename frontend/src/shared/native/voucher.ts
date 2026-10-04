import type { NativeDraft, NativeField } from './fields';

const lineKinds = new Set([
  'receipt',
  'opening',
  'sale',
  'customer_return',
  'supplier_return',
  'transfer',
  'writeoff',
  'inventory',
  'production',
  'purchase_order',
  'customer_order',
]);
const roles: Record<string, string[]> = {
  owner: [
    'receipt',
    'opening',
    'sale',
    'customer_return',
    'supplier_return',
    'transfer',
    'writeoff',
    'inventory',
    'production',
    'purchase_order',
    'customer_order',
    'payment',
    'advance_allocation',
    'payment_refund',
    'expense',
    'cash_opening',
    'payroll',
    'payroll_payment',
    'debt_opening',
    'cash_transfer',
    'cash_difference',
  ],
  manager: [
    'receipt',
    'opening',
    'sale',
    'customer_return',
    'supplier_return',
    'transfer',
    'writeoff',
    'inventory',
    'production',
    'purchase_order',
    'customer_order',
    'payment',
    'advance_allocation',
    'payment_refund',
    'expense',
    'cash_transfer',
    'cash_difference',
  ],
  cashier: ['sale', 'customer_return', 'customer_order'],
  warehouse: [
    'purchase_order',
    'receipt',
    'opening',
    'supplier_return',
    'transfer',
    'writeoff',
    'inventory',
    'production',
  ],
  accountant: [
    'payment',
    'advance_allocation',
    'payment_refund',
    'expense',
    'cash_opening',
    'payroll',
    'payroll_payment',
    'debt_opening',
    'cash_transfer',
    'cash_difference',
  ],
};
type RecordValue = Record<string, unknown>;
export type VoucherBody = {
  kind: string;
  date: string;
  store: number;
  note: string;
  lines: RecordValue[];
  payload: RecordValue;
  allocations?: RecordValue[];
  [key: string]: unknown;
};
export type VoucherRecord = VoucherBody & {
  id: number;
  revision: number;
  status: 'draft' | 'posted' | 'reversed';
  total: string;
  editing?: {
    role: string;
    storeId: number | null;
    closedThrough: string | null;
    storeActive: boolean;
    canEdit: boolean;
  };
};
const fail = (): never => {
  throw Error('Не вдалося перевірити документ. Ваші поля збережено; повторіть читання.');
};
const object = (v: unknown): RecordValue =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as RecordValue) : fail();
const text = (v: unknown, max = 4000): string =>
  typeof v === 'string' && v.length <= max ? v : fail();
const positive = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail();
const identifier = (v: unknown): number | null =>
  v === null || v === undefined || v === ''
    ? null
    : positive(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
const day = (v: unknown): string => {
  const s = text(v, 10),
    d = new Date(s + 'T00:00:00Z');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(d.valueOf()) &&
    d.toISOString().slice(0, 10) === s
    ? s
    : fail();
};
const decimal = (v: unknown, places = 2, zero = true): string => {
  const s = String(v).replace(',', '.');
  if (
    !new RegExp('^\\d{1,12}(?:\\.\\d{1,' + places + '})?$').test(s) ||
    (!zero && !/[1-9]/.test(s))
  )
    return fail();
  const [a, b = ''] = s.split('.');
  return String(BigInt(a!)) + (b.replace(/0+$/, '') ? '.' + b.replace(/0+$/, '') : '');
};
const product = (v: unknown): string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v) ? v : fail();
const array = (v: unknown, max: number): unknown[] =>
  Array.isArray(v) && v.length <= max ? v : fail();
const uuid = (v: unknown): string =>
  typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v) ? v : fail();
const normalized = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(normalized)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, normalized(x)]),
        )
      : v;
const canonical = (v: unknown): string => JSON.stringify(normalized(v));
/** Whitelisted writable business terms only. Server totals, costs, snapshots and movements never enter Save. */
export function captureVoucherDraft(value: unknown): VoucherBody {
  const raw = object(value),
    kind = text(raw.kind, 40);
  if (!roles.owner!.includes(kind) || kind === 'cash_difference') return fail();
  const body: VoucherBody = {
    kind,
    date: day(raw.date),
    store: positive(identifier(raw.store)),
    note: text(raw.note ?? ''),
    lines: [],
    payload: {
      additional_cost: '0',
      fiscal_ref: '',
      due_date: '',
      category_id: null,
      category: 'Інше',
      discount_reason: '',
      target_account: null,
      shift_ids: [],
      payments: [],
      recipe: [],
    },
  };
  for (const key of ['warehouse', 'target', 'party', 'employee', 'account', 'shift', 'reference'])
    body[key] = identifier(raw[key]);
  if (lineKinds.has(kind)) {
    body.lines = array(raw.lines, 200).map((value) => {
      const r = object(value);
      return {
        product: product(r.product),
        quantity: decimal(r.quantity, 3, kind === 'inventory'),
        price: decimal(r.price ?? '0', 4, !['sale', 'customer_order'].includes(kind)),
        lot: text(r.lot ?? '', 80),
        expiry: r.expiry ? day(r.expiry) : '',
        line_key: uuid(r.line_key),
        reference_line: identifier(r.reference_line),
      };
    });
    if (!body.lines.length || new Set(body.lines.map((r) => r.line_key)).size !== body.lines.length)
      return fail();
    if (!body.warehouse || (kind === 'production' && body.lines.length !== 1)) return fail();
  } else body.amount = decimal(raw.amount ?? raw.total, 2, kind === 'payroll');
  const p = object(raw.payload ?? {});
  for (const key of ['fiscal_ref', 'discount_reason', 'category'])
    if (p[key] !== undefined)
      body.payload[key] = text(
        p[key],
        key === 'fiscal_ref' ? 160 : key === 'discount_reason' ? 300 : 100,
      );
  if (p.due_date) body.payload.due_date = day(p.due_date);
  if (p.expected_date) body.payload.expected_date = day(p.expected_date);
  if (p.minimum_order_amount !== undefined && p.minimum_order_amount !== '')
    body.payload.minimum_order_amount = decimal(p.minimum_order_amount, 2, false);
  if (p.additional_cost !== undefined) body.payload.additional_cost = decimal(p.additional_cost);
  if (p.category_id !== undefined)
    body.payload.category_id =
      p.category_id === null || p.category_id === '' ? null : uuid(p.category_id);
  if (p.target_account !== undefined) body.payload.target_account = identifier(p.target_account);
  if (p.expense_scope !== undefined) {
    if (
      !['store', 'network'].includes(String(p.expense_scope)) ||
      typeof p.expense_scope !== 'string'
    )
      return fail();
    body.payload.expense_scope = p.expense_scope;
  }
  if (p.order_revision !== undefined) body.payload.order_revision = positive(p.order_revision);
  if (p.shift_ids !== undefined) {
    body.payload.shift_ids = array(p.shift_ids, 200).map(positive);
    if (
      new Set(body.payload.shift_ids as number[]).size !==
      (body.payload.shift_ids as number[]).length
    )
      return fail();
  }
  if (p.payments !== undefined)
    body.payload.payments = array(p.payments, 10).map((v) => {
      const r = object(v);
      return { account: positive(identifier(r.account)), amount: decimal(r.amount, 2, false) };
    });
  if (p.recipe !== undefined)
    body.payload.recipe = array(p.recipe, 100).map((v) => {
      const r = object(v);
      return { product: product(r.product), quantity: decimal(r.quantity, 3, false) };
    });
  if (p.production !== undefined) {
    const r = object(p.production),
      components = array(r.actualComponents, 100).map((v) => {
        const c = object(v);
        return {
          product: product(c.product),
          quantity: decimal(c.quantity, 3),
          lot: text(c.lot ?? '', 80),
        };
      });
    if (new Set(components.map((c) => c.product)).size !== components.length) return fail();
    // Approved version owns its normative recipe; the stored recipe copy is a server snapshot.
    body.payload.recipe = [];
    body.payload.production = {
      recipeVersion: uuid(r.recipeVersion),
      plannedOutput: decimal(r.plannedOutput, 3, false),
      actualComponents: components,
      varianceReason: text(r.varianceReason ?? '', 500),
      ...(r.expiryOverride
        ? {
            expiryOverride: {
              date: day(object(r.expiryOverride).date),
              reason: text(object(r.expiryOverride).reason, 500),
            },
          }
        : {}),
    };
  }
  if (['payment', 'advance_allocation'].includes(kind)) {
    body.allocations = array(raw.allocations ?? [], 200).map((v) => {
      const r = object(v);
      return { source: positive(identifier(r.source)), amount: decimal(r.amount, 2, false) };
    });
    if (new Set(body.allocations.map((r) => r.source)).size !== body.allocations.length)
      return fail();
    const cents = (value: unknown): bigint => {
      const [whole, fraction = ''] = String(value).split('.');
      return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
    };
    const total = body.allocations.reduce((sum, row) => sum + cents(row.amount), 0n);
    if (
      total > cents(body.amount) ||
      (kind === 'advance_allocation' && total !== cents(body.amount))
    )
      return fail();
    if (
      kind === 'payment' &&
      body.reference &&
      (body.allocations.length !== 1 ||
        body.allocations[0]!.source !== body.reference ||
        total !== cents(body.amount))
    )
      return fail();
  }
  if (kind === 'payment_refund') body.allocations = [];
  if (
    ['advance_allocation', 'payment_refund', 'customer_return', 'supplier_return'].includes(kind) &&
    !body.reference
  )
    return fail();
  return body;
}
export function voucherBodyFromRecord(value: unknown): VoucherBody {
  const raw = object(value),
    payload = { ...object(raw.payload) },
    p = payload.production;
  if (p) {
    const r = object(p);
    if (r.source === 'version') {
      const terms = object(r.terms);
      payload.production = {
        recipeVersion: terms.id,
        plannedOutput: r.plannedOutput,
        actualComponents: r.components,
        varianceReason: r.varianceReason,
        expiryOverride: r.expiryOverride,
      };
    } else {
      delete payload.production;
      payload.recipe = object(r.terms).components;
    }
  }
  return captureVoucherDraft({ ...raw, amount: raw.total, payload });
}
export function decodeVoucher(
  value: unknown,
  expected: { id?: number; kind: string },
  policy = true,
): VoucherRecord {
  const r = object(value),
    id = positive(r.id),
    revision = positive(r.revision),
    kind = text(r.kind, 40);
  if (
    id !== (expected.id ?? id) ||
    kind !== expected.kind ||
    !['draft', 'posted', 'reversed'].includes(String(r.status)) ||
    typeof r.status !== 'string'
  )
    return fail();
  if (lineKinds.has(kind))
    for (const value of array(r.lines, 200)) {
      const line = object(value);
      text(line.name, 250);
      text(line.unit, 30);
      if (typeof line.quantity !== 'string' || typeof line.price !== 'string') return fail();
      if (line.cost !== undefined) decimal(line.cost);
    }
  if (typeof r.total !== 'string') return fail();
  if (r.cost !== undefined) decimal(r.cost);
  for (const key of [
    'note',
    'date',
    'store',
    'warehouse',
    'target',
    'party',
    'employee',
    'account',
    'shift',
    'reference',
    'payload',
    'lines',
  ])
    if (!Object.hasOwn(r, key)) return fail();
  text(r.note);
  positive(r.store);
  for (const key of ['warehouse', 'target', 'party', 'employee', 'account', 'shift', 'reference'])
    if (r[key] !== null) positive(r[key]);
  if (['payment', 'advance_allocation'].includes(kind))
    for (const value of array(r.allocations, 200)) {
      const allocation = object(value);
      positive(allocation.source);
      if (typeof allocation.amount !== 'string') return fail();
      decimal(allocation.amount, 2, false);
    }
  const body = voucherBodyFromRecord(r),
    record = { ...body, id, revision, status: r.status, total: decimal(r.total) } as VoucherRecord;
  if (policy) {
    const e = object(r.editing),
      role = text(e.role, 20),
      storeId = identifier(e.storeId),
      closedThrough = e.closedThrough === null ? null : day(e.closedThrough);
    if (
      !(role in roles) ||
      typeof e.storeActive !== 'boolean' ||
      typeof e.canEdit !== 'boolean' ||
      !roles[role]!.includes(kind) ||
      (storeId !== null && storeId !== body.store) ||
      (kind === 'expense' &&
        body.payload.expense_scope === 'network' &&
        !['owner', 'accountant'].includes(role))
    )
      return fail();
    if (
      e.canEdit &&
      (record.status !== 'draft' ||
        !e.storeActive ||
        (closedThrough !== null && body.date <= closedThrough))
    )
      return fail();
    record.editing = {
      role,
      storeId,
      closedThrough,
      storeActive: e.storeActive,
      canEdit: e.canEdit,
    };
  }
  return record;
}
export function voucherProjection(body: VoucherBody): NativeDraft {
  const { note, ...terms } = captureVoucherDraft(body);
  return { note, terms: canonical(terms) };
}
export function voucherFromProjection(draft: NativeDraft): VoucherBody {
  try {
    return captureVoucherDraft({
      ...object(JSON.parse(text(draft.terms, 200000))),
      note: text(draft.note),
    });
  } catch {
    return fail();
  }
}
export function voucherFields(captions: Record<string, string>): NativeField[] {
  return [
    { id: 'note', label: 'Примітка', keys: ['note'] },
    {
      id: 'terms',
      label: 'Умови документа: реквізити, товари, суми й розподіли',
      keys: ['terms'],
      valueLabels: captions,
    },
  ];
}

export function voucherReceipt(value: unknown, expected: { id?: number; kind: string }) {
  const r = object(value),
    id = positive(r.id),
    revision = positive(r.revision);
  if (
    id !== (expected.id ?? id) ||
    r.kind !== expected.kind ||
    !['draft', 'posted', 'reversed'].includes(String(r.status)) ||
    typeof r.status !== 'string'
  )
    return fail();
  return { id, revision };
}
