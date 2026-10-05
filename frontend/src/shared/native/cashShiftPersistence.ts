/** Till drafts retain raw input independently of normalized authoritative action receipts. */
import type { Json, Payload } from '../recovery/storage';
import type { DraftSession } from '../recovery/session';
const fail = (): never => {
  throw Error('Касову зміну не підтверджено. Ваші поля збережено.');
};
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail();
};
const text = (v: unknown, max = 4000): string =>
  typeof v === 'string' && v.length <= max ? v : fail();
const id = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail();
const nilId = (v: unknown): number | null => (v === null ? null : id(v));
const uuid = (v: unknown): string =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(text(v, 36)) ? String(v) : fail();
const rev = (v: unknown): string => (/^[0-9a-f]{32}$/.test(text(v, 32)) ? String(v) : fail());
const mode = (v: unknown): 'open' | 'close' => (v === 'open' || v === 'close' ? v : fail());
const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : fail());
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const inputId = (v: unknown): number =>
  typeof v === 'number' ? id(v) : /^[1-9]\d*$/.test(text(v, 16)) ? id(Number(v)) : fail();
export const rawKeys = ['account', 'employee', 'counted', 'note'];
export function decodeRaw(value: unknown): Record<string, string> {
  const v = obj(value);
  exact(v, rawKeys);
  return Object.fromEntries(rawKeys.map((k) => [k, text(v[k], k === 'note' ? 4000 : 80)]));
}
function count(value: unknown): string {
  const v = text(value, 30).replace(',', '.');
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(v)) fail();
  const [whole, fraction = ''] = v.split('.');
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > 99999999999900n) fail();
  return (cents / 100n).toString() + '.' + (cents % 100n).toString().padStart(2, '0');
}
export function captureClose(raw: unknown) {
  const v = decodeRaw(raw);
  return { counted: count(v.counted), note: v.note };
}
export type Original =
  | { action: 'open'; account: number; employee: number | null }
  | { action: 'close'; id: number; counted: string; note: string; revision: string };
export function normalizeBody(value: unknown): Original {
  const v = obj(value),
    action = mode(v.action);
  uuid(v.idempotency_key);
  exact(
    v,
    action === 'open'
      ? ['action', 'account', 'employee', 'idempotency_key']
      : ['action', 'id', 'counted', 'note', 'revision', 'idempotency_key'],
  );
  if (action === 'open')
    return {
      action,
      account: inputId(v.account),
      employee: v.employee === null || v.employee === '' ? null : inputId(v.employee),
    };
  return {
    action,
    id: inputId(v.id),
    counted: count(v.counted),
    note: text(v.note),
    revision: rev(v.revision),
  };
}
function decodeOriginal(value: unknown): Original {
  const v = obj(value),
    action = mode(v.action);
  exact(
    v,
    action === 'open'
      ? ['action', 'account', 'employee']
      : ['action', 'id', 'counted', 'note', 'revision'],
  );
  if (action === 'open') return { action, account: id(v.account), employee: nilId(v.employee) };
  const counted = count(v.counted);
  if (counted !== v.counted) fail();
  return { action, id: id(v.id), counted, note: text(v.note), revision: rev(v.revision) };
}
const equal = (a: Original, b: Original) => JSON.stringify(a) === JSON.stringify(b);
export function decodeReceipt(value: unknown, key: string, body: unknown) {
  const v = obj(value);
  exact(v, ['id', 'type', 'action', 'request_key', 'original']);
  if (v.type !== 'cash_shift' || v.request_key !== key || obj(body).idempotency_key !== key) fail();
  const original = decodeOriginal(v.original);
  if (v.action !== original.action || !equal(original, normalizeBody(body))) fail();
  const found = id(v.id);
  if (original.action === 'close' && found !== original.id) fail();
  return { id: found, type: 'cash_shift', action: original.action, request_key: key, original };
}
export function decodeIdentity(value: unknown, key: string, body: unknown) {
  const v = obj(value);
  if (v.confirmed === false) {
    exact(v, ['confirmed', 'type', 'action', 'request_key']);
    if (v.type !== 'cash_shift' || v.action !== normalizeBody(body).action || v.request_key !== key)
      fail();
    return null;
  }
  if (v.confirmed !== true) fail();
  const { confirmed, ...ack } = v;
  void confirmed;
  return decodeReceipt(ack, key, body);
}
export type Current = {
  id: number;
  store: number;
  account: number;
  employee: number | null;
  openedBy: number;
  openedAt: string;
  closedAt: string | null;
  openingCash: string;
  expectedCash: string | null;
  countedCash: string | null;
  note: string;
  revision: string;
  editing: { role: string; storeId: number | null; networkOwner: boolean; canWrite: boolean };
};
function stamp(v: unknown): string {
  const s = text(v, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(s) ||
    Number.isNaN(Date.parse(s))
  )
    fail();
  return s;
}
function money(v: unknown): string {
  const s = text(v, 24);
  if (!/^-?\d{1,16}\.\d{2}$/.test(s)) fail();
  return s;
}
function policy(value: unknown) {
  const v = obj(value);
  exact(v, ['role', 'storeId', 'networkOwner', 'canWrite']);
  const role = text(v.role, 20),
    storeId = nilId(v.storeId);
  if (
    !['owner', 'manager', 'cashier'].includes(role) ||
    bool(v.networkOwner) !== (role === 'owner' && storeId === null)
  )
    fail();
  return { role, storeId, networkOwner: bool(v.networkOwner), canWrite: bool(v.canWrite) };
}
export function decodeCurrent(value: unknown, expectedId: number): Current {
  const v = obj(value);
  exact(v, [
    'id',
    'store',
    'account',
    'employee',
    'openedBy',
    'openedAt',
    'closedAt',
    'openingCash',
    'expectedCash',
    'countedCash',
    'note',
    'revision',
    'editing',
  ]);
  if (id(v.id) !== expectedId) fail();
  const closedAt = v.closedAt === null ? null : stamp(v.closedAt),
    expectedCash = v.expectedCash === null ? null : money(v.expectedCash),
    countedCash = v.countedCash === null ? null : money(v.countedCash),
    editing = policy(v.editing);
  if (
    (closedAt === null) !== (expectedCash === null) ||
    (closedAt === null) !== (countedCash === null) ||
    editing.canWrite !== (closedAt === null)
  )
    fail();
  return {
    id: expectedId,
    store: id(v.store),
    account: id(v.account),
    employee: nilId(v.employee),
    openedBy: id(v.openedBy),
    openedAt: stamp(v.openedAt),
    closedAt,
    openingCash: money(v.openingCash),
    expectedCash,
    countedCash,
    note: text(v.note),
    revision: rev(v.revision),
    editing,
  };
}
export type State = {
  recordId: string;
  key: string;
  action: 'open' | 'close';
  id: number | null;
  account: number | null;
  store: number | null;
  original: Current | null;
  needsReview: boolean;
};
export function decodeState(value: unknown): State {
  const v = obj(value);
  exact(v, ['recordId', 'key', 'action', 'id', 'account', 'store', 'original', 'needsReview']);
  const recordId = text(v.recordId, 80);
  if (!recordId.startsWith('cashshift_')) fail();
  uuid(recordId.slice(10));
  const selected = nilId(v.id),
    original = v.original === null ? null : decodeCurrent(v.original, selected || fail()),
    s = {
      recordId,
      key: uuid(v.key),
      action: mode(v.action),
      id: selected,
      account: nilId(v.account),
      store: nilId(v.store),
      original,
      needsReview: bool(v.needsReview),
    };
  if (
    (original && (original.account !== s.account || original.store !== s.store)) ||
    (s.action === 'close' && !selected)
  )
    fail();
  return s;
}
export function decodeContext(value: unknown, s: State, session: DraftSession) {
  const v = obj(value);
  exact(v, [
    'type',
    'action',
    'id',
    'account',
    'store',
    'role',
    'storeId',
    'networkOwner',
    'canWrite',
  ]);
  const p = policy(
    Object.fromEntries(['role', 'storeId', 'networkOwner', 'canWrite'].map((k) => [k, v[k]])),
  );
  if (
    v.type !== 'cash_shift' ||
    v.action !== s.action ||
    nilId(v.id) !== (s.action === 'close' ? s.id : null) ||
    (s.account !== null && nilId(v.account) !== s.account) ||
    (s.store !== null && nilId(v.store) !== s.store) ||
    p.role !== session.role ||
    p.storeId !== session.storeId ||
    p.networkOwner !== session.networkOwner
  )
    fail();
  return p;
}
export function decodePayload(value: unknown): Payload {
  const v = obj(value);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeState(v.baseline),
    draft = decodeRaw(v.draft);
  let first: Payload['firstIntent'] = null;
  if (v.firstIntent !== null) {
    const f = obj(v.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const original = normalizeBody(f.body);
    if (
      f.method !== 'POST' ||
      f.path !== '/api/erp/shifts' ||
      f.key !== s.key ||
      f.possiblySent !== true ||
      obj(f.body).idempotency_key !== s.key ||
      original.action !== s.action ||
      (original.action === 'close' && (original.id !== s.id || f.revision !== original.revision)) ||
      (original.action === 'open' &&
        (s.id !== null || f.revision !== null || s.account !== original.account))
    )
      fail();
    first = {
      method: 'POST',
      path: '/api/erp/shifts',
      key: s.key,
      body: json(f.body),
      revision: f.revision as string | null,
      possiblySent: true,
    };
  }
  let confirmation: Json = null;
  if (v.confirmation !== null) {
    const c = obj(v.confirmation);
    exact(c, ['id', 'type', 'action', 'request_key', 'original']);
    const o = decodeOriginal(c.original);
    if (
      c.type !== 'cash_shift' ||
      c.request_key !== s.key ||
      c.action !== s.action ||
      o.action !== s.action ||
      id(c.id) !== s.id ||
      first
    )
      fail();
    confirmation = json(c);
  }
  return { baseline: json(s), draft: json(draft), firstIntent: first, confirmation };
}
export function confirmPayload(value: unknown, event: unknown): Payload {
  const p = decodePayload(value),
    s = decodeState(p.baseline),
    e = obj(event);
  exact(e, ['type', 'raw', 'draft']);
  p.draft = json(decodeRaw(e.draft));
  if (e.type === 'ack' || e.type === 'identity') {
    const body = p.firstIntent?.body ?? fail();
    const receipt =
      e.type === 'ack' ? decodeReceipt(e.raw, s.key, body) : decodeIdentity(e.raw, s.key, body);
    if (!receipt) return p;
    s.id = receipt.id;
    s.needsReview = true;
    p.firstIntent = null;
    p.confirmation = json(receipt);
  } else if (e.type === 'apply') {
    const row = decodeCurrent(e.raw, s.id || fail());
    if (
      p.firstIntent ||
      p.confirmation ||
      s.action !== 'close' ||
      !row.editing.canWrite ||
      row.account !== s.account ||
      row.store !== s.store ||
      (s.original &&
        (row.employee !== s.original.employee ||
          row.openedBy !== s.original.openedBy ||
          row.openedAt !== s.original.openedAt))
    )
      fail();
    s.original = row;
    s.needsReview = false;
    p.firstIntent = null;
    p.confirmation = null;
  } else if (e.type === 'rejected') {
    const r = obj(e.raw),
      original = p.firstIntent ? normalizeBody(p.firstIntent.body) : fail();
    if (
      r.write_rejected !== true ||
      r.type !== 'cash_shift' ||
      r.action !== s.action ||
      r.request_key !== s.key ||
      r.resource !== (original.action === 'open' ? original.account : original.id)
    )
      fail();
    p.firstIntent = null;
    if (r.code === 'revision_conflict') s.needsReview = true;
  } else fail();
  p.baseline = json(s);
  return decodePayload(p);
}
