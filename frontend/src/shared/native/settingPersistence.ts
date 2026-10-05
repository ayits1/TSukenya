import type { NativeField } from './fields';
import type { Json, Payload } from '../recovery/storage';
import type { DraftSession } from '../recovery/session';
const fail = (): never => {
  throw Error('Налаштування не підтверджено. Ваші поля збережено.');
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
const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : fail());
const id = (v: unknown): number | null =>
  v === null ? null : typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail();
const uuid = (v: unknown): string =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(text(v, 36)) ? String(v) : fail();
const rev = (v: unknown): string => (/^[0-9a-f]{32}$/.test(text(v, 32)) ? String(v) : fail());
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
export type Kind = 'period' | 'fiscal' | 'discount-limit';
export const kind = (v: unknown): Kind =>
  v === 'period' || v === 'fiscal' || v === 'discount-limit' ? v : fail();
export const rawKeys = ['date', 'reason', 'mode', 'percent'];
export function decodeRaw(value: unknown): Record<string, string> {
  const v = obj(value);
  exact(v, rawKeys);
  return Object.fromEntries(rawKeys.map((k) => [k, text(v[k], k === 'reason' ? 4000 : 80)]));
}
function date(value: unknown): string | null {
  if (value === null || value === '') return null;
  const s = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s.startsWith('0000')) fail();
  const d = new Date(s + 'T12:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail();
  return s;
}
function percent(value: unknown): string {
  const s = text(value, 80).replace(',', '.');
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(s)) fail();
  const [whole, fraction = ''] = s.split('.');
  const n = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (n > 10000n) fail();
  return (
    (n / 100n).toString() +
    (n % 100n ? '.' + (n % 100n).toString().padStart(2, '0').replace(/0$/, '') : '')
  );
}
export type Value =
  { date: string | null; reason: string } | { required: boolean } | { percent: string };
function value(setting: Kind, input: unknown): Value {
  const v = obj(input);
  if (setting === 'period') {
    exact(v, ['date', 'reason']);
    const d = date(v.date);
    if (v.date !== d) fail();
    return { date: d, reason: text(v.reason) };
  }
  if (setting === 'fiscal') {
    exact(v, ['required']);
    return { required: bool(v.required) };
  }
  exact(v, ['percent']);
  const p = percent(v.percent);
  if (p !== v.percent) fail();
  return { percent: p };
}
export function capture(setting: Kind, raw: unknown): Value {
  const v = decodeRaw(raw);
  if (setting === 'period') {
    if (!v.reason!.trim()) throw Error('Вкажіть причину зміни періоду. Новіші поля збережено.');
    try {
      return { date: date(v.date), reason: v.reason! };
    } catch {
      throw Error('Дата закриття має бути РРРР-ММ-ДД або порожньою для відкриття періоду.');
    }
  }
  if (setting === 'fiscal') {
    if (!['required', 'optional'].includes(v.mode!)) throw Error('Виберіть режим обліку чеків.');
    return { required: v.mode === 'required' };
  }
  try {
    return { percent: percent(v.percent) };
  } catch {
    throw Error(
      'Максимальна знижка — від 0 до 100, до двох знаків після коми. Новіші поля збережено.',
    );
  }
}

export type Original = Value & { revision: string };
export function normalizeBody(setting: Kind, input: unknown): Original {
  const v = obj(input);
  uuid(v.idempotency_key);
  const revision = rev(v.revision);
  exact(v, [
    ...(setting === 'period'
      ? ['date', 'reason']
      : setting === 'fiscal'
        ? ['required']
        : ['percent']),
    'idempotency_key',
    'revision',
  ]);
  if (setting === 'period') {
    const reason = text(v.reason);
    if (!reason.trim()) fail();
    return { date: date(v.date), reason, revision };
  }
  if (setting === 'fiscal') return { required: bool(v.required), revision };
  return { percent: percent(v.percent), revision };
}
function original(setting: Kind, input: unknown): Original {
  const v = obj(input);
  const { revision, ...terms } = v;
  return { ...value(setting, terms), revision: rev(revision) };
}
function terms(input: Original): Value {
  const { revision, ...rest } = input;
  void revision;
  return rest;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function decodeReceipt(input: unknown, setting: Kind, key: string, body: unknown) {
  const v = obj(input);
  exact(v, ['type', 'setting', 'request_key', 'original', 'value', 'revision']);
  if (
    v.type !== 'setting' ||
    v.setting !== setting ||
    v.request_key !== key ||
    obj(body).idempotency_key !== key
  )
    fail();
  const o = original(setting, v.original),
    applied = value(setting, v.value);
  if (!equal(o, normalizeBody(setting, body)) || !equal(applied, terms(o))) fail();
  return {
    type: 'setting',
    setting,
    request_key: key,
    original: o,
    value: applied,
    revision: rev(v.revision),
  };
}
export function decodeIdentity(input: unknown, setting: Kind, key: string, body: unknown) {
  const v = obj(input);
  if (v.confirmed === false) {
    exact(v, ['confirmed', 'type', 'setting', 'request_key']);
    if (
      v.type !== 'setting' ||
      v.setting !== setting ||
      v.request_key !== key ||
      obj(body).idempotency_key !== key
    )
      fail();
    normalizeBody(setting, body);
    return null;
  }
  if (v.confirmed !== true) fail();
  const { confirmed, ...ack } = v;
  void confirmed;
  return decodeReceipt(ack, setting, key, body);
}
function policy(input: unknown) {
  const v = obj(input);
  exact(v, ['role', 'storeId', 'networkOwner', 'canWrite']);
  const storeId = id(v.storeId);
  if (v.role !== 'owner' || bool(v.networkOwner) !== (storeId === null) || v.canWrite !== true)
    fail();
  return {
    role: 'owner' as const,
    storeId,
    networkOwner: bool(v.networkOwner),
    canWrite: true as const,
  };
}
export type Current = {
  type: 'setting';
  setting: Kind;
  value: Value;
  revision: string;
  editing: ReturnType<typeof policy>;
};
export function decodeCurrent(input: unknown, setting: Kind): Current {
  const v = obj(input);
  exact(v, ['type', 'setting', 'value', 'revision', 'editing']);
  if (v.type !== 'setting' || v.setting !== setting) fail();
  return {
    type: 'setting',
    setting,
    value: value(setting, v.value),
    revision: rev(v.revision),
    editing: policy(v.editing),
  };
}
export type State = {
  recordId: string;
  key: string;
  setting: Kind;
  original: Current;
  needsReview: boolean;
};
export function decodeState(input: unknown): State {
  const v = obj(input);
  exact(v, ['recordId', 'key', 'setting', 'original', 'needsReview']);
  const recordId = text(v.recordId, 80);
  if (!recordId.startsWith('settings_')) fail();
  uuid(recordId.slice(9));
  const setting = kind(v.setting);
  return {
    recordId,
    key: uuid(v.key),
    setting,
    original: decodeCurrent(v.original, setting),
    needsReview: bool(v.needsReview),
  };
}
export function decodeContext(input: unknown, s: State | { setting: Kind }, session: DraftSession) {
  const v = obj(input);
  exact(v, ['type', 'setting', 'role', 'storeId', 'networkOwner', 'canWrite']);
  const p = policy(
    Object.fromEntries(['role', 'storeId', 'networkOwner', 'canWrite'].map((k) => [k, v[k]])),
  );
  if (
    v.type !== 'setting' ||
    v.setting !== s.setting ||
    p.role !== session.role ||
    p.storeId !== session.storeId ||
    p.networkOwner !== session.networkOwner
  )
    fail();
  return p;
}
export function decodePayload(input: unknown): Payload {
  const v = obj(input);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeState(v.baseline),
    draft = decodeRaw(v.draft);
  let first: Payload['firstIntent'] = null,
    confirmation: Json = null;
  if (v.firstIntent !== null) {
    const f = obj(v.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const o = normalizeBody(s.setting, f.body);
    if (
      f.method !== 'POST' ||
      f.path !== '/api/erp/' + s.setting ||
      f.key !== s.key ||
      obj(f.body).idempotency_key !== s.key ||
      f.revision !== o.revision ||
      o.revision !== s.original.revision ||
      f.possiblySent !== true
    )
      fail();
    first = {
      method: 'POST',
      path: '/api/erp/' + s.setting,
      key: s.key,
      body: json(f.body),
      revision: o.revision,
      possiblySent: true,
    };
  }
  if (v.confirmation !== null) {
    if (first) fail();
    const c = obj(v.confirmation),
      o = original(s.setting, c.original);
    confirmation = json(decodeReceipt(c, s.setting, s.key, { ...o, idempotency_key: s.key }));
  }
  return { baseline: json(s), draft: json(draft), firstIntent: first, confirmation };
}
export function confirmPayload(input: unknown, event: unknown): Payload {
  const p = decodePayload(input),
    s = decodeState(p.baseline),
    e = obj(event);
  exact(e, ['type', 'raw', 'draft']);
  p.draft = json(decodeRaw(e.draft));
  if (e.type === 'ack' || e.type === 'identity') {
    const body = p.firstIntent?.body ?? fail();
    const found =
      e.type === 'ack'
        ? decodeReceipt(e.raw, s.setting, s.key, body)
        : decodeIdentity(e.raw, s.setting, s.key, body);
    if (found) {
      p.firstIntent = null;
      p.confirmation = json(found);
      s.needsReview = true;
    }
  } else if (e.type === 'apply') {
    if (p.firstIntent) fail();
    const applied = obj(e.raw);
    exact(applied, ['current', 'merged', 'key']);
    const row = decodeCurrent(applied.current, s.setting);
    const raw = decodeRaw(applied.merged);
    capture(s.setting, raw);
    s.original = row;
    s.key = uuid(applied.key);
    s.needsReview = false;
    p.confirmation = null;
    p.draft = json(raw);
  } else if (e.type === 'rejected') {
    const proof = obj(e.raw);
    if (
      proof.write_rejected !== true ||
      proof.type !== 'setting' ||
      proof.setting !== s.setting ||
      proof.request_key !== s.key ||
      !p.firstIntent
    )
      fail();
    p.firstIntent = null;
    s.needsReview = proof.code === 'revision_conflict';
  } else fail();
  p.baseline = json(s);
  return decodePayload(p);
}
export function fields(setting: Kind): NativeField[] {
  return setting === 'period'
    ? [
        {
          id: 'period',
          label: 'Дата закриття та причина',
          keys: ['date', 'reason'],
          labels: { date: 'Закрито включно', reason: 'Причина' },
        },
      ]
    : setting === 'fiscal'
      ? [
          {
            id: 'mode',
            label: 'Облік чеків',
            keys: ['mode'],
            valueLabels: {
              required: 'Обов’язковий номер чека ПРРО',
              optional: 'Необов’язковий — управлінський облік',
            },
          },
        ]
      : [
          {
            id: 'percent',
            label: 'Максимальна знижка касира, %',
            keys: ['percent'],
            decimals: ['percent'],
          },
        ];
}
export function rawFrom(setting: Kind, v: Value): Record<string, string> {
  return {
    date: setting === 'period' ? (obj(v).date as string | null) || '' : '',
    reason: setting === 'period' ? String(obj(v).reason) : '',
    mode: setting === 'fiscal' ? (obj(v).required ? 'required' : 'optional') : '',
    percent: setting === 'discount-limit' ? String(obj(v).percent) : '',
  };
}
