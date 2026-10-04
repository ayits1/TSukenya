/** Local raw strings never become salary calculations or a permission grant. */
import type { Json, Payload } from '../recovery/storage';
import { decimalKey } from '../merge/threeWay';
import type { DraftSession } from '../recovery/session';
import {
  captureWorkShiftDraft,
  decodeWorkShift,
  workShiftIdentityMatches,
  workShiftProjection,
  type WorkShift,
} from './workShift';
const fail = (): never => {
  throw Error('Чернетка табеля не підтверджена. Поля не відновлено.');
};
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail();
};
const text = (v: unknown, max = 2000): string =>
  typeof v === 'string' && v.length <= max ? v : fail();
const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : fail());
const id = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail();
const nullableId = (v: unknown) => (v === null ? null : id(v));
const uuid = (v: unknown) =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(text(v, 36)) ? String(v) : fail();
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
export const rawKeys = [
  'employee',
  'date',
  'cash_shift',
  'units',
  'shift_rate',
  'bonus_percent',
  'bonus_basis',
  'note',
];
export function decodeRawWorkShift(value: unknown): Record<string, string> {
  const v = obj(value);
  exact(v, rawKeys);
  return Object.fromEntries(rawKeys.map((k) => [k, text(v[k])]));
}
export type WorkShiftState = {
  recordId: string;
  key: string;
  id: number | null;
  store: number | null;
  employee: number | null;
  date: string;
  original: WorkShift | null;
  createBase: Record<string, string> | null;
  needsReview: boolean;
  confirmed: boolean;
};
export function decodeWorkShiftState(value: unknown): WorkShiftState {
  const v = obj(value);
  exact(v, [
    'recordId',
    'key',
    'id',
    'store',
    'employee',
    'date',
    'original',
    'createBase',
    'needsReview',
    'confirmed',
  ]);
  const recordId = text(v.recordId, 80);
  if (!recordId.startsWith('workshift_')) fail();
  uuid(recordId.slice(10));
  if (v.original !== null)
    exact(obj(v.original), [
      'id',
      'employee_id',
      'store_id',
      'date',
      'cash_shift_id',
      'units',
      'shift_rate',
      'bonus_percent',
      'bonus_basis',
      'accrued',
      'basis_amount',
      'payroll_id',
      'note',
      'revision',
    ]);
  const selected = idOrNull(v.id),
    original =
      v.original === null
        ? null
        : decodeWorkShift({ items: [v.original], total: 1, page: 1, pages: 1 }, selected || fail());
  const s = {
    recordId,
    key: uuid(v.key),
    id: selected,
    store: nullableId(v.store),
    employee: nullableId(v.employee),
    date: text(v.date, 10),
    original,
    createBase: v.createBase === null ? null : decodeRawWorkShift(v.createBase),
    needsReview: bool(v.needsReview),
    confirmed: bool(v.confirmed),
  };
  if (
    original &&
    (original.store_id !== s.store ||
      original.employee_id !== s.employee ||
      original.date !== s.date)
  )
    fail();
  if (s.createBase) {
    captureWorkShiftDraft(s.createBase);
    if (Number(s.createBase.employee) !== s.employee || s.createBase.date !== s.date) fail();
  }
  if ((s.id && !s.original && !s.createBase) || (s.confirmed && !s.id)) fail();
  return s;
}
const idOrNull = nullableId;
function bodyFor(s: WorkShiftState, value: unknown) {
  const v = obj(value),
    creating = Object.hasOwn(v, 'idempotency_key');
  exact(v, [...rawKeys, ...(creating ? ['idempotency_key'] : ['id', 'revision'])]);
  const raw = decodeRawWorkShift(Object.fromEntries(rawKeys.map((k) => [k, v[k]])));
  captureWorkShiftDraft(raw);
  if (
    !/^[1-9]\d*$/.test(raw.employee || '') ||
    !Number.isSafeInteger(Number(raw.employee)) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw.date || '')
  )
    fail();
  if (creating) {
    if (s.id || v.idempotency_key !== s.key) fail();
  } else if (v.id !== s.id || v.revision !== s.original?.revision) fail();
  if (s.employee !== Number(raw.employee) || s.date !== raw.date) fail();
  return json(v);
}
export function decodeWorkShiftPayload(value: unknown): Payload {
  const v = obj(value);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeWorkShiftState(v.baseline),
    draft = decodeRawWorkShift(v.draft);
  let first: Payload['firstIntent'] = null;
  if (v.firstIntent !== null) {
    const f = obj(v.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const body = bodyFor(s, f.body),
      creating = Object.hasOwn(obj(body), 'idempotency_key');
    if (
      f.method !== 'POST' ||
      f.path !== '/api/erp/work-shifts' ||
      f.key !== s.key ||
      f.possiblySent !== true ||
      f.revision !== (creating ? null : s.original?.revision)
    )
      fail();
    first = {
      method: 'POST',
      path: '/api/erp/work-shifts',
      key: s.key,
      body,
      revision: creating ? null : s.original!.revision,
      possiblySent: true,
    };
  }
  let confirmation: Json = null;
  if (v.confirmation !== null) {
    const c = obj(v.confirmation);
    exact(c, ['id', 'kind']);
    if (c.id !== s.id || !['create', 'update', 'apply'].includes(text(c.kind))) fail();
    confirmation = json(c);
  }
  return { baseline: json(s), draft: json(draft), firstIntent: first, confirmation };
}
export function decodeWorkShiftContext(value: unknown, s: WorkShiftState, session: DraftSession) {
  const v = obj(value);
  exact(v, [
    'type',
    'id',
    'store',
    'employee',
    'role',
    'storeId',
    'networkOwner',
    'exists',
    'canEdit',
  ]);
  nullableId(v.id);
  nullableId(v.store);
  nullableId(v.employee);
  nullableId(v.storeId);
  bool(v.networkOwner);
  bool(v.canEdit);
  if (v.networkOwner !== (v.role === 'owner' && v.storeId === null)) fail();
  if (!['owner', 'accountant'].includes(text(v.role))) fail();
  if (
    v.role !== session.role ||
    v.storeId !== session.storeId ||
    v.networkOwner !== session.networkOwner
  )
    throw Object.assign(Error('Доступ до чернетки змінився.'), { status: 403 });
  if (
    v.type !== 'work_shift' ||
    v.id !== s.id ||
    v.store !== (s.store ?? session.storeId) ||
    (s.employee !== null && v.employee !== s.employee)
  )
    fail();
  if (s.id ? typeof v.exists !== 'boolean' : v.exists !== null) fail();
  return v;
}
/** Key + exact echoed first request, never a mutable revision returned by identity. */
export function decodeWorkShiftReceipt(value: unknown, key: string, request: unknown): number {
  const v = obj(value);
  exact(v, ['id', 'type', 'request_key', 'request']);
  if (v.type !== 'work_shift' || v.request_key !== key) fail();
  const actual = obj(v.request),
    expected = obj(request);
  exact(actual, Object.keys(expected));
  if (Object.keys(expected).some((k) => actual[k] !== expected[k])) fail();
  return id(v.id);
}
export function decodeWorkShiftIdentity(
  value: unknown,
  key: string,
  request: unknown,
): number | null {
  const v = obj(value);
  if (v.confirmed === false) {
    exact(v, ['confirmed', 'type', 'request_key']);
    if (v.type !== 'work_shift' || v.request_key !== key) fail();
    return null;
  }
  if (v.confirmed !== true) fail();
  exact(v, ['confirmed', 'id', 'type', 'request_key', 'request']);
  const { confirmed, ...receipt } = v;
  void confirmed;
  return decodeWorkShiftReceipt(receipt, key, request);
}
export function confirmWorkShiftPayload(value: unknown, event: unknown): Payload | null {
  const p = decodeWorkShiftPayload(value),
    s = decodeWorkShiftState(p.baseline),
    e = obj(event);
  exact(e, ['type', 'raw', 'draft']);
  p.draft = json(decodeRawWorkShift(e.draft));
  if (e.type === 'create' || e.type === 'identity') {
    const body = p.firstIntent ? obj(p.firstIntent.body) : fail();
    if (body.idempotency_key !== s.key) fail();
    const found =
      e.type === 'create'
        ? decodeWorkShiftReceipt(e.raw, s.key, body)
        : decodeWorkShiftIdentity(e.raw, s.key, body);
    if (found === null) return p;
    s.id = found;
    s.createBase = decodeRawWorkShift(Object.fromEntries(rawKeys.map((k) => [k, body[k]])));
    s.confirmed = true;
    s.needsReview = true;
    p.firstIntent = null;
    p.confirmation = { id: found, kind: 'create' };
  } else if (e.type === 'update') {
    const r = obj(e.raw);
    exact(r, ['id']);
    if (!s.id || r.id !== s.id || !p.firstIntent || obj(p.firstIntent.body).id !== s.id) fail();
    s.needsReview = true;
    p.firstIntent = null;
    p.confirmation = { id: s.id, kind: 'update' };
  } else if (e.type === 'apply' || e.type === 'complete') {
    const r = decodeWorkShift(e.raw, s.id || fail());
    if (
      r.employee_id !== s.employee ||
      r.store_id !== s.store ||
      r.date !== s.date ||
      (s.original && !workShiftIdentityMatches(s.original, r))
    )
      fail();
    if (e.type === 'complete') {
      try {
        const raw = decodeRawWorkShift(p.draft);
        const mine = captureWorkShiftDraft(raw),
          current = captureWorkShiftDraft(workShiftProjection(r));
        if (
          Number(raw.employee) !== r.employee_id ||
          raw.date !== r.date ||
          Object.keys(current).some((k) =>
            ['units', 'shift_rate', 'bonus_percent'].includes(k)
              ? decimalKey(mine[k]) !== decimalKey(current[k])
              : mine[k] !== current[k],
          )
        )
          return p;
      } catch {
        return p;
      }
      return null;
    }
    s.original = r;
    s.createBase = null;
    s.needsReview = false;
    p.firstIntent = null;
    p.confirmation = { id: s.id, kind: 'apply' };
  } else if (e.type === 'rejected') {
    const r = obj(e.raw);
    if (
      !p.firstIntent ||
      obj(p.firstIntent.body).idempotency_key !== s.key ||
      r.type !== 'work_shift' ||
      r.request_key !== s.key ||
      r.write_rejected !== true
    )
      fail();
    p.firstIntent = null;
  } else fail();
  p.baseline = json(s);
  return decodeWorkShiftPayload(p);
}
