/** Durable native voucher state is distinct from validated Save and server accounting DTOs. */
import type { Json, Payload } from '../recovery/storage';
import type { DraftSession } from '../recovery/session';
import {
  captureVoucherDraft,
  voucherFromProjection,
  voucherProjection,
  voucherBodyFromRecord,
  decodeVoucherAck,
  decodeVoucher,
  decodeVoucherIdentity,
  validateVoucherMerge,
} from './voucher';
import { decodeVersion, type Version } from './recipe';
export const fieldNames = [
  'date',
  'store',
  'warehouse',
  'target',
  'party',
  'employee',
  'account',
  'shift',
  'reference',
  'amount',
  'note',
  'fiscal_ref',
  'due_date',
  'expected_date',
  'minimum_order_amount',
  'additional_cost',
  'category_id',
  'expense_scope',
  'discount_reason',
  'target_account',
  'order_revision',
] as const;
export const lineNames = [
  'line_key',
  'reference_line',
  'product',
  'quantity',
  'price',
  'lot',
  'expiry',
] as const;
export const kinds = [
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
  'payroll',
  'payroll_payment',
  'customer_order',
  'debt_opening',
  'cash_transfer',
] as const;
type Fields = Record<(typeof fieldNames)[number], string>;
type Line = Record<(typeof lineNames)[number], string>;
export type RawProduction = {
  mode: 'empty' | 'version' | 'legacy';
  terms: Version | null;
  plannedOutput: string;
  varianceReason: string;
  ownerExpiry: string;
  ownerExpiryReason: string;
  components: { product: string; quantity: string; lot: string }[];
  recipe: { product: string; quantity: string }[];
  clearedCost: boolean;
};
export type RawVoucher = {
  fields: Fields;
  lines: Line[];
  payments: { account: string; amount: string }[];
  payrollIds: number[];
  production: RawProduction | null;
  allocations: { source: number; amount: string }[];
  reference: number | null;
  available: string | null;
};
export type VoucherState = {
  identity: {
    recordId: string;
    kind: string;
    store: number;
    id: number | null;
    revision: number | null;
    key: string;
  };
  projection: { terms: string; note: string } | null;
  needsReview: boolean;
  postUnknown: boolean;
  confirmedId: number | null;
  confirmedRead: boolean;
};
const fail = (): never => {
  throw Error('Непідтримувана чернетка документа. Поля не відновлено.');
};
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
function exact(v: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(v).length !== keys.length || !keys.every((k) => Object.hasOwn(v, k))) fail();
}
const str = (v: unknown, max = 4000): string =>
  typeof v === 'string' && v.length <= max ? v : fail();
const id = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail();
const optionalId = (v: unknown) => (v === null ? null : id(v));
const bool = (v: unknown) => (typeof v === 'boolean' ? v : fail());
function array(v: unknown, max = 200): unknown[] {
  return Array.isArray(v) && v.length <= max ? v : fail();
}
function identifier(v: unknown): string {
  const s = str(v, 120);
  return s === '' || /^[A-Za-z0-9_-]+$/.test(s) ? s : fail();
}
function numericChoice(v: unknown): string {
  const s = str(v, 20);
  return s === '' || (/^[0-9]{1,16}$/.test(s) && BigInt(s) <= BigInt(Number.MAX_SAFE_INTEGER))
    ? s
    : fail();
}
function strings<K extends string>(value: unknown, keys: readonly K[]): Record<K, string> {
  const v = obj(value);
  exact(v, keys);
  return Object.fromEntries(keys.map((k) => [k, str(v[k])])) as Record<K, string>;
}
function json(v: unknown): Json {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.map(json);
  return Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, json(x)]));
}
function writable(value: unknown) {
  const b = obj(value);
  const keys = [
    'kind',
    'date',
    'store',
    'note',
    'lines',
    'payload',
    'warehouse',
    'target',
    'party',
    'employee',
    'account',
    'shift',
    'reference',
    'amount',
    'allocations',
    'idempotency_key',
    'revision',
  ];
  if (Object.keys(b).some((k) => !keys.includes(k))) fail();
  const p = obj(b.payload);
  const pkeys = [
    'additional_cost',
    'fiscal_ref',
    'due_date',
    'category_id',
    'category',
    'discount_reason',
    'target_account',
    'shift_ids',
    'payments',
    'recipe',
    'production',
    'expense_scope',
    'order_revision',
    'expected_date',
    'minimum_order_amount',
  ];
  if (Object.keys(p).some((k) => !pkeys.includes(k))) fail();
  for (const raw of array(b.lines)) {
    const r = obj(raw);
    exact(r, lineNames);
  }
  for (const raw of array(b.allocations ?? [])) {
    const r = obj(raw);
    exact(r, ['source', 'amount']);
  }
  for (const raw of array(p.payments ?? [], 10)) {
    const r = obj(raw);
    exact(r, ['account', 'amount']);
  }
  for (const raw of array(p.recipe ?? [], 100)) {
    const r = obj(raw);
    exact(r, ['product', 'quantity']);
  }
  if (p.production !== undefined) {
    const r = obj(p.production);
    if (
      Object.keys(r).some(
        (k) =>
          ![
            'recipeVersion',
            'plannedOutput',
            'actualComponents',
            'varianceReason',
            'expiryOverride',
          ].includes(k),
      )
    )
      fail();
    for (const raw of array(r.actualComponents, 100)) {
      const c = obj(raw);
      exact(c, ['product', 'quantity', 'lot']);
    }
    if (r.expiryOverride) {
      const e = obj(r.expiryOverride);
      exact(e, ['date', 'reason']);
    }
  }
  return captureVoucherDraft({ ...b, note: b.note ?? '' });
}
export function decodeRawVoucher(value: unknown): RawVoucher {
  const v = obj(value);
  exact(v, [
    'fields',
    'lines',
    'payments',
    'payrollIds',
    'production',
    'allocations',
    'reference',
    'available',
  ]);
  const fields = strings(v.fields, fieldNames);
  for (const k of [
    'store',
    'warehouse',
    'target',
    'party',
    'employee',
    'account',
    'shift',
    'reference',
    'target_account',
    'order_revision',
  ])
    fields[k as keyof Fields] = numericChoice(fields[k as keyof Fields]);
  for (const k of ['date', 'due_date', 'expected_date']) str(fields[k as keyof Fields], 10);
  for (const k of ['amount', 'minimum_order_amount', 'additional_cost'])
    str(fields[k as keyof Fields], 40);
  str(fields.note, 4000);
  str(fields.fiscal_ref, 160);
  str(fields.discount_reason, 300);
  str(fields.category_id, 36);
  str(fields.expense_scope, 10);
  const lines = array(v.lines).map((raw) => {
    const r = strings(raw, lineNames);
    identifier(r.product);
    numericChoice(r.reference_line);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.line_key)) fail();
    str(r.quantity, 40);
    str(r.price, 40);
    str(r.lot, 80);
    str(r.expiry, 10);
    return r;
  });
  if (new Set(lines.map((r) => r.line_key)).size !== lines.length) fail();
  const payments = array(v.payments).map((raw) => {
    const r = obj(raw);
    exact(r, ['account', 'amount']);
    return { account: numericChoice(r.account), amount: str(r.amount, 40) };
  });
  const allocations = array(v.allocations).map((raw) => {
    const r = obj(raw);
    exact(r, ['source', 'amount']);
    return { source: id(r.source), amount: str(r.amount, 40) };
  });
  if (new Set(allocations.map((r) => r.source)).size !== allocations.length) fail();
  const payrollIds = array(v.payrollIds, 1000).map(id);
  if (new Set(payrollIds).size !== payrollIds.length) fail();
  let production: RawProduction | null = null;
  if (v.production !== null) {
    const p = obj(v.production);
    exact(p, [
      'mode',
      'terms',
      'plannedOutput',
      'varianceReason',
      'ownerExpiry',
      'ownerExpiryReason',
      'components',
      'recipe',
      'clearedCost',
    ]);
    if (!['empty', 'version', 'legacy'].includes(str(p.mode, 10))) fail();
    const terms = p.terms === null ? null : decodeVersion(p.terms, str(obj(p.terms).product, 120));
    if ((p.mode === 'version') !== Boolean(terms)) fail();
    production = {
      mode: p.mode as RawProduction['mode'],
      terms,
      plannedOutput: str(p.plannedOutput, 40),
      varianceReason: str(p.varianceReason, 500),
      ownerExpiry: str(p.ownerExpiry, 10),
      ownerExpiryReason: str(p.ownerExpiryReason, 500),
      components: array(p.components, 100).map((raw) => {
        const r = obj(raw);
        exact(r, ['product', 'quantity', 'lot']);
        return {
          product: identifier(r.product),
          quantity: str(r.quantity, 40),
          lot: str(r.lot, 80),
        };
      }),
      recipe: array(p.recipe, 100).map((raw) => {
        const r = obj(raw);
        exact(r, ['product', 'quantity']);
        return { product: identifier(r.product), quantity: str(r.quantity, 40) };
      }),
      clearedCost: bool(p.clearedCost),
    };
    if (
      terms &&
      production.components.some((r) => !terms.components.some((c) => c.product === r.product))
    )
      fail();
  }
  return {
    fields,
    lines,
    payments,
    payrollIds,
    production,
    allocations,
    reference: optionalId(v.reference),
    available: v.available === null ? null : str(v.available, 40),
  };
}
export function decodeVoucherState(value: unknown): VoucherState {
  const v = obj(value);
  exact(v, [
    'identity',
    'projection',
    'needsReview',
    'postUnknown',
    'confirmedId',
    'confirmedRead',
  ]);
  const i = obj(v.identity);
  exact(i, ['recordId', 'kind', 'store', 'id', 'revision', 'key']);
  const kind = str(i.kind, 40);
  if (!kinds.some((k) => k === kind)) fail();
  const recordId = str(i.recordId, 120);
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(recordId)) fail();
  const identity = {
    recordId,
    kind,
    store: id(i.store),
    id: optionalId(i.id),
    revision: optionalId(i.revision),
    key: str(i.key, 80),
  };
  if (!identity.key || (identity.id === null && identity.revision !== null)) fail();
  let projection: VoucherState['projection'] = null;
  if (v.projection !== null) {
    const p = obj(v.projection);
    exact(p, ['terms', 'note']);
    projection = { terms: str(p.terms, 200000), note: str(p.note) };
    writable(JSON.parse(projection.terms));
    const body = voucherFromProjection(projection);
    if (body.kind !== identity.kind) fail();
  }
  const confirmedId = optionalId(v.confirmedId);
  if (confirmedId !== null && confirmedId !== identity.id) fail();
  return {
    identity,
    projection,
    needsReview: bool(v.needsReview),
    postUnknown: bool(v.postUnknown),
    confirmedId,
    confirmedRead: bool(v.confirmedRead),
  };
}
export function decodeVoucherPayload(value: unknown): Payload {
  const v = obj(value);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const state = decodeVoucherState(v.baseline),
    raw = decodeRawVoucher(v.draft);
  const f = v.firstIntent;
  if (f !== null) {
    const first = obj(f);
    exact(first, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    if (first.key !== state.identity.key) fail();
    if (!(
      first.revision === null ||
      typeof first.revision === 'string' ||
      Number.isSafeInteger(first.revision)
    ))
      fail();
    if (first.possiblySent !== true) fail();
    const expectedPath =
      state.identity.id === null ? '/api/erp/vouchers' : '/api/erp/vouchers/' + state.identity.id;
    const posting = first.path === expectedPath + '/post';
    if (posting) {
      if (first.method !== 'POST' || state.identity.id === null || !state.postUnknown) fail();
      const body = obj(first.body);
      exact(body, ['revision']);
      id(body.revision);
      if (first.revision !== body.revision || body.revision !== state.identity.revision) fail();
    } else {
      if (
        first.path !== expectedPath ||
        first.method !== (state.identity.id === null ? 'POST' : 'PUT')
      )
        fail();
      const body = obj(first.body);
      const allowed = [
        'kind',
        'date',
        'store',
        'note',
        'lines',
        'payload',
        'warehouse',
        'target',
        'party',
        'employee',
        'account',
        'shift',
        'reference',
        'amount',
        'allocations',
        'idempotency_key',
        'revision',
      ];
      if (
        Object.keys(body).some((k) => !allowed.includes(k)) ||
        body.idempotency_key !== state.identity.key ||
        body.kind !== state.identity.kind
      )
        fail();
      writable(body);
      if (state.identity.id !== null) {
        id(body.revision);
        if (body.revision !== state.identity.revision || first.revision !== body.revision) fail();
      } else if (first.revision !== null) fail();
    }
  }
  if (v.confirmation !== null) {
    const c = obj(v.confirmation);
    exact(c, ['id', 'status']);
    id(c.id);
    if (c.id !== state.identity.id || !['draft', 'posted', 'reversed'].includes(str(c.status, 10)))
      fail();
  }
  return {
    baseline: json(state),
    draft: json(raw),
    firstIntent: f === null ? null : (json(f) as Payload['firstIntent']),
    confirmation: json(v.confirmation),
  };
}
export function decodeContext(
  value: unknown,
  expected: { kind: string; store: number },
  session: DraftSession,
) {
  const r = obj(value);
  exact(r, ['kind', 'store', 'editing']);
  if (r.kind !== expected.kind || r.store !== expected.store) fail();
  const e = obj(r.editing);
  exact(e, ['role', 'storeId', 'closedThrough', 'storeActive', 'canEdit']);
  if (
    e.role !== session.role ||
    e.storeId !== session.storeId ||
    (session.storeId !== null && session.storeId !== expected.store)
  )
    fail();
  if (e.closedThrough !== null && !/^\d{4}-\d{2}-\d{2}$/.test(str(e.closedThrough, 10))) fail();
  return { canEdit: bool(e.canEdit), storeActive: bool(e.storeActive) };
}

/** Only domain-authoritative proofs may replace a possibly sent intent. Raw fields are independent. */
export function confirmVoucherPayload(input: Payload, acknowledgement: unknown): Payload | null {
  const old = decodeVoucherPayload(input),
    state = decodeVoucherState(old.baseline);
  const event = obj(acknowledgement),
    type = str(event.type, 30);
  exact(event, ['type', 'raw', 'draft']);
  const draft = decodeRawVoucher(event.draft);
  const next = structuredClone(state);
  let confirmation = old.confirmation;
  if (type === 'rejected') {
    const proof = obj(event.raw);
    exact(proof, ['error', 'write_rejected', 'request_key', 'kind']);
    str(proof.error, 8000);
    if (
      proof.write_rejected !== true ||
      proof.request_key !== state.identity.key ||
      proof.kind !== state.identity.kind ||
      !old.firstIntent ||
      old.firstIntent.method !== 'POST' ||
      old.firstIntent.path !== '/api/erp/vouchers' ||
      state.identity.id !== null
    )
      fail();
    return decodeVoucherPayload({ ...old, draft, firstIntent: null });
  }
  if (type === 'save') {
    if (!old.firstIntent || old.firstIntent.path.endsWith('/post')) return fail();
    const body = { ...writable(old.firstIntent.body), ...obj(old.firstIntent.body) };
    const saved = decodeVoucherAck(event.raw, body, state.identity.id ?? undefined);
    next.identity.id = saved.id;
    next.identity.revision = saved.revision;
    next.identity.store = saved.store;
    next.confirmedId = saved.id;
    const projection = voucherProjection(body);
    next.projection = { terms: str(projection.terms, 200000), note: str(projection.note) };
    next.needsReview = true;
    next.postUnknown = false;
    next.confirmedRead = false;
    confirmation = { id: saved.id, status: saved.status };
  } else if (type === 'identity') {
    if (
      !old.firstIntent ||
      state.identity.id !== null ||
      old.firstIntent.path !== '/api/erp/vouchers'
    )
      return fail();
    const body = { ...writable(old.firstIntent.body), ...obj(old.firstIntent.body) };
    const saved = decodeVoucherIdentity(event.raw, body);
    if (!saved.confirmed) return fail();
    next.identity.id = saved.id;
    next.identity.revision = null;
    next.identity.store = saved.store;
    next.confirmedId = saved.id;
    const projection = voucherProjection(body);
    next.projection = { terms: str(projection.terms, 200000), note: str(projection.note) };
    next.needsReview = true;
    next.postUnknown = false;
    next.confirmedRead = false;
    confirmation = { id: saved.id, status: saved.status };
  } else if (type === 'apply') {
    const source = obj(event.raw);
    exact(source, ['record', 'merged']);
    if (state.identity.id === null) return fail();
    const row = decodeVoucher(source.record, { id: state.identity.id, kind: state.identity.kind });
    const merged = obj(source.merged);
    exact(merged, ['terms', 'note']);
    validateVoucherMerge({ terms: str(merged.terms, 200000), note: str(merged.note) }, row);
    const projection = voucherProjection(voucherBodyFromRecord(source.record));
    next.projection = { terms: str(projection.terms, 200000), note: str(projection.note) };
    next.identity.revision = row.revision;
    next.identity.store = row.store;
    next.confirmedId = row.id;
    next.needsReview = false;
    next.postUnknown = false;
    next.confirmedRead = true;
    confirmation = null;
  } else if (type === 'post' || type === 'status') {
    if (state.identity.id === null) return fail();
    const row = decodeVoucher(
      event.raw,
      { id: state.identity.id, kind: state.identity.kind },
      type === 'status',
    );
    if (type === 'post' && row.status !== 'posted') fail();
    next.identity.revision = row.revision;
    next.confirmedId = row.id;
    next.needsReview = row.status !== 'draft';
    next.postUnknown = row.status === 'draft';
    next.confirmedRead = false;
    confirmation = { id: row.id, status: row.status };
  } else if (type === 'complete') {
    if (state.identity.id === null || old.firstIntent !== null) return fail();
    decodeVoucher(event.raw, { id: state.identity.id, kind: state.identity.kind }, false);
    return null;
  } else fail();
  return decodeVoucherPayload({ baseline: next, draft, firstIntent: null, confirmation });
}
