/** Durable label terms only. Product/PDF/session grants never belong in this codec. */
import { DEFAULT_LABEL_CONFIG, LABEL_FIELDS } from './domain';
import type { LabelField } from './domain';
import { LABEL_MERGE_FIELDS, type LabelDraft } from './conflict';
import { mergeEqual, type MergeField } from '../../shared/merge/threeWay';
import type { Payload, FirstIntent, Json } from '../../shared/recovery/storage';
import type { components } from '../../shared/api/generated';
import type { DraftSession } from '../../shared/recovery/session';

export const LABEL_DRAFT = 'label-workspace-v1';
export const RECORD_ID = 'label-workspace';
export const EXECUTE = '/api/v1/labels/workspace/execute';
export type Raw = LabelDraft & { fontSizes: Partial<Record<LabelField, string>> };
export type Baseline = {
  original: LabelDraft;
  revision: string;
  key: string;
  review: boolean;
  frozenRaw: Raw | null;
};
export type Request = LabelDraft & { key: string; revision: string };
export type Confirmation = { key: string; appliedRevision: string };
export type Context = components['schemas']['LabelRecoveryContext'];
export type Receipt = {
  contract: 'label-layout-save-v1';
  key: string;
  confirmed: boolean;
  appliedRevision?: string;
};
function fail(): never {
  throw Error('Чернетку макета не підтверджено. Первісний запит збережено.');
}
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const keys = (v: Record<string, unknown>, names: string[]) => {
  if (Object.keys(v).length !== names.length || names.some((n) => !Object.hasOwn(v, n))) fail();
};
const text = (v: unknown, max = 10000): v is string => typeof v === 'string' && v.length <= max;
const revision = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const fields = new Set<string>(LABEL_FIELDS.map(([name]) => name));
const member = (v: unknown, values: string[]) => typeof v === 'string' && values.includes(v);
export function terms(value: unknown): LabelDraft {
  const v = obj(value);
  keys(v, ['config', 'settings']);
  const c = obj(v.config),
    s = obj(v.settings);
  keys(c, Object.keys(DEFAULT_LABEL_CONFIG));
  keys(s, ['chainName', 'storeNames', 'staleDays']);
  if (
    c.styleVersion !== 2 ||
    !member(c.size, ['s', 'm', 'l']) ||
    !member(c.border, ['dash', 'solid', 'none']) ||
    !Number.isSafeInteger(c.storeIdx) ||
    Number(c.storeIdx) < 0 ||
    Number(c.storeIdx) > 100 ||
    !text(c.custom)
  )
    fail();
  for (const [key, initial] of Object.entries(DEFAULT_LABEL_CONFIG))
    if (typeof initial === 'boolean' && typeof c[key] !== 'boolean') fail();
  for (const [field, input] of Object.entries(obj(c.styles))) {
    if (!fields.has(field)) fail();
    const style = obj(input);
    if (
      Object.keys(style).some((key) => !['font', 'size', 'color', 'weight', 'align'].includes(key))
    )
      fail();
    if ('font' in style && !member(style.font, ['rubik', 'arial', 'georgia', 'courier'])) fail();
    if (
      'size' in style &&
      !(
        typeof style.size === 'number' &&
        Number.isFinite(style.size) &&
        style.size >= 5 &&
        style.size <= 72
      )
    )
      fail();
    if (
      'color' in style &&
      !(typeof style.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(style.color))
    )
      fail();
    if ('weight' in style && !member(style.weight, ['400', '600', '700'])) fail();
    if ('align' in style && !member(style.align, ['left', 'center', 'right'])) fail();
  }
  if (
    !text(s.chainName) ||
    !Array.isArray(s.storeNames) ||
    s.storeNames.length > 100 ||
    !s.storeNames.every((n) => text(n)) ||
    !Number.isSafeInteger(s.staleDays) ||
    Number(s.staleDays) < 1 ||
    Number(s.staleDays) > 3650
  )
    fail();
  return structuredClone(v) as LabelDraft;
}
export function raw(value: unknown): Raw {
  const v = obj(value);
  keys(v, ['config', 'settings', 'fontSizes']);
  const sizes = obj(v.fontSizes);
  if (Object.entries(sizes).some(([field, value]) => !fields.has(field) || !text(value, 100)))
    fail();
  return {
    ...terms({ config: v.config, settings: v.settings }),
    fontSizes: structuredClone(sizes) as Raw['fontSizes'],
  };
}
export function baseline(value: unknown): Baseline {
  const v = obj(value);
  keys(v, ['original', 'revision', 'key', 'review', 'frozenRaw']);
  if (!revision(v.revision) || !uuid(v.key) || typeof v.review !== 'boolean') fail();
  return {
    original: terms(v.original),
    revision: v.revision,
    key: v.key,
    review: v.review,
    frozenRaw: v.frozenRaw === null ? null : raw(v.frozenRaw),
  };
}
export function request(value: unknown): Request {
  const v = obj(value);
  keys(v, ['key', 'revision', 'config', 'settings']);
  if (!uuid(v.key) || !revision(v.revision)) fail();
  return { ...terms({ config: v.config, settings: v.settings }), key: v.key, revision: v.revision };
}
export function decodePayload(value: unknown): Payload {
  const p = obj(value);
  keys(p, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const b = baseline(p.baseline),
    d = raw(p.draft);
  let intent: FirstIntent | null = null,
    confirmation: Confirmation | null = null;
  if (p.firstIntent !== null) {
    const i = obj(p.firstIntent);
    keys(i, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const body = request(i.body);
    if (
      i.method !== 'POST' ||
      i.path !== EXECUTE ||
      i.key !== b.key ||
      body.key !== b.key ||
      i.revision !== b.revision ||
      body.revision !== b.revision ||
      i.possiblySent !== true ||
      b.frozenRaw === null ||
      p.confirmation !== null ||
      !mergeEqual(body, bodyFromRaw(b, b.frozenRaw))
    )
      fail();
    intent = {
      method: 'POST',
      path: EXECUTE,
      key: b.key,
      body: body as unknown as Json,
      revision: b.revision,
      possiblySent: true,
    };
  }
  if (p.confirmation !== null) {
    const c = obj(p.confirmation);
    keys(c, ['key', 'appliedRevision']);
    if (c.key !== b.key || !revision(c.appliedRevision) || b.frozenRaw === null || !b.review)
      fail();
    confirmation = { key: b.key, appliedRevision: c.appliedRevision };
  }
  return {
    baseline: b as unknown as Json,
    draft: d as unknown as Json,
    firstIntent: intent,
    confirmation: confirmation as unknown as Json,
  };
}
export function normalizedTerms(d: Raw): LabelDraft {
  const c = structuredClone(d.config);
  for (const [field, value] of Object.entries(d.fontSizes)) {
    if (!/^\d+(?:[.,]\d+)?$/.test(value.trim()))
      throw Error('Вкажіть розмір шрифту від 5 до 72 pt.');
    const size = Number(value.replace(',', '.'));
    if (!Number.isFinite(size) || size < 5 || size > 72)
      throw Error('Розмір шрифту має бути від 5 до 72 pt.');
    c.styles[field as LabelField] = { ...c.styles[field as LabelField], size };
  }
  return { config: c, settings: structuredClone(d.settings) };
}
function bodyFromRaw(b: Baseline, d: Raw): Request {
  return { ...normalizedTerms(d), key: b.key, revision: b.revision };
}
export function prepare(p: Payload): Payload {
  const b = baseline(p.baseline),
    d = raw(p.draft);
  if (p.firstIntent || p.confirmation || b.review) fail();
  const body = bodyFromRaw(b, d);
  return decodePayload({
    ...p,
    baseline: { ...b, frozenRaw: d },
    firstIntent: {
      method: 'POST',
      path: EXECUTE,
      key: b.key,
      body,
      revision: b.revision,
      possiblySent: true,
    },
  });
}
export function decodeContext(value: unknown, session: DraftSession): Context {
  const v = obj(value);
  keys(v, ['contract', 'resource', 'role', 'storeId', 'networkOwner', 'canWrite']);
  if (
    v.contract !== 'label-layout-context-v1' ||
    v.resource !== 'settings/main' ||
    v.role !== 'owner' ||
    session.role !== 'owner' ||
    v.storeId !== session.storeId ||
    v.networkOwner !== session.networkOwner ||
    v.canWrite !== true
  )
    fail();
  return v as Context;
}
export function decodeReceipt(value: unknown, key: string, ack = false): Receipt {
  const v = obj(value);
  keys(
    v,
    ack
      ? ['contract', 'key', 'appliedRevision', 'ok']
      : v.confirmed === true
        ? ['contract', 'key', 'confirmed', 'appliedRevision']
        : ['contract', 'key', 'confirmed'],
  );
  if (
    v.contract !== 'label-layout-save-v1' ||
    v.key !== key ||
    !uuid(v.key) ||
    (ack ? v.ok !== true : typeof v.confirmed !== 'boolean') ||
    ((ack || v.confirmed === true) && !revision(v.appliedRevision))
  )
    fail();
  return {
    contract: 'label-layout-save-v1',
    key,
    confirmed: ack || v.confirmed === true,
    ...(revision(v.appliedRevision) ? { appliedRevision: v.appliedRevision } : {}),
  };
}
export function confirm(p: Payload, value: unknown): Payload {
  const b = baseline(p.baseline);
  if (!p.firstIntent) fail();
  const result = decodeReceipt(value, b.key);
  if (!result.confirmed || !result.appliedRevision) fail();
  return decodePayload({
    ...p,
    baseline: { ...b, review: true },
    firstIntent: null,
    confirmation: { key: b.key, appliedRevision: result.appliedRevision },
  });
}

export function reject(p: Payload, value: unknown): Payload {
  const b = baseline(p.baseline),
    v = obj(value);
  keys(
    v,
    'code' in v ? ['error', 'code', 'write_rejected', 'key'] : ['error', 'write_rejected', 'key'],
  );
  if (
    !p.firstIntent ||
    v.key !== b.key ||
    v.write_rejected !== true ||
    !text(v.error) ||
    ('code' in v && v.code !== 'revision_conflict')
  )
    fail();
  return decodePayload({
    ...p,
    baseline: { ...b, review: true },
    firstIntent: null,
    confirmation: null,
  });
}

/** A typed point-size and its unfinished text are one merge unit. */
export const RAW_LABEL_MERGE_FIELDS: MergeField<Raw>[] = LABEL_MERGE_FIELDS.map((field) => {
  const match = /^style\.([a-zA-Z0-9]+)\.size$/.exec(field.id);
  const key = match?.[1] as LabelField | undefined;
  return {
    ...field,
    read: (draft) =>
      key && Object.hasOwn(draft.fontSizes, key) ? draft.fontSizes[key] : field.read(draft),
    write: (target, source) => {
      const merged = field.write(target, source);
      const sizes = { ...target.fontSizes };
      if (key) {
        if (source.fontSizes[key] !== undefined) sizes[key] = source.fontSizes[key];
        else delete sizes[key];
      }
      return { ...merged, fontSizes: sizes };
    },
  };
});
