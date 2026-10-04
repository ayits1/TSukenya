/** Explicit raw whitelist for both real recipe editors; no catalog caches or permissions. */
import type { Json, Payload } from '../recovery/storage';
import type { DraftSession } from '../recovery/session';
import {
  productId,
  decodeLegacy,
  decodeList,
  projection,
  validateDraft,
  confirmVersion,
  type LegacyRecipe,
  type RecipeList,
  quantity,
  policies,
} from './recipe';
import type { NativeDraft } from './fields';
const fail = (): never => {
  throw Error('Чернетка рецептури не підтверджена. Введення не підмінено.');
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail();
};
const text = (v: unknown, max = 8000) => (typeof v === 'string' && v.length <= max ? v : fail());
const bool = (v: unknown) => (typeof v === 'boolean' ? v : fail());
const uuid = (v: unknown) =>
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(text(v, 36)) ? String(v) : fail();
const revision = (v: unknown) => (/^[a-f0-9]{64}$/.test(text(v, 64)) ? String(v) : fail());
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
export type Mode = 'legacy' | 'version';
export type RawRecipe = {
  product: string;
  components: { rowKey: string; product: string; quantity: string }[];
  outputQuantity: string;
  expiryPolicy: string;
  shelfLifeDays: string;
  reason: string;
};
export type Original = {
  product: { id: string; name: string; unit: string };
  revision: string;
  latestVersion: string | null;
  projection: NativeDraft;
};
export type State = {
  recordId: string;
  key: string;
  mode: Mode;
  original: Original | null;
  needsReview: boolean;
};
export function decodeRawRecipe(value: unknown): RawRecipe {
  const v = object(value);
  exact(v, ['product', 'components', 'outputQuantity', 'expiryPolicy', 'shelfLifeDays', 'reason']);
  if (!Array.isArray(v.components) || v.components.length > 100) return fail();
  const rows = v.components.map((value) => {
    const r = object(value);
    exact(r, ['rowKey', 'product', 'quantity']);
    return {
      rowKey: uuid(r.rowKey),
      product: r.product === '' ? '' : productId(r.product),
      quantity: text(r.quantity),
    };
  });
  if (new Set(rows.map((r) => r.rowKey)).size !== rows.length) fail();
  return {
    product: v.product === '' ? '' : productId(v.product),
    components: rows,
    outputQuantity: text(v.outputQuantity),
    expiryPolicy: text(v.expiryPolicy, 100),
    shelfLifeDays: text(v.shelfLifeDays),
    reason: text(v.reason),
  };
}
export function original(record: LegacyRecipe | RecipeList): Original {
  return {
    product: record.product,
    revision: 'recipe' in record ? record.revision : record.catalogRevision,
    latestVersion: 'recipe' in record ? null : record.latestVersion,
    projection: projection(record),
  };
}
export function decodeState(value: unknown): State {
  const v = object(value);
  exact(v, ['recordId', 'key', 'mode', 'original', 'needsReview']);
  if (v.mode !== 'legacy' && v.mode !== 'version') return fail();
  const recordId = text(v.recordId, 80);
  if (!recordId.startsWith('recipe_')) fail();
  uuid(recordId.slice(7));
  let old: Original | null = null;
  if (v.original !== null) {
    const o = object(v.original),
      p = object(o.product);
    exact(o, ['product', 'revision', 'latestVersion', 'projection']);
    exact(p, ['id', 'name', 'unit']);
    const product = { id: productId(p.id), name: text(p.name, 250), unit: text(p.unit, 30) },
      draft = object(o.projection);
    exact(
      draft,
      v.mode === 'legacy'
        ? ['components']
        : ['components', 'outputQuantity', 'expiryPolicy', 'shelfLifeDays', 'reason'],
    );
    // A baseline has no approval reason; validate terms with a temporary reason only.
    const valid = validateDraft({ components: draft.components } as NativeDraft, product.id, true);
    if (v.mode === 'version') {
      const policy = text(draft.expiryPolicy, 100),
        shelf = draft.shelfLifeDays;
      if (
        !Object.hasOwn(policies, policy) ||
        (policy === 'minimum_with_shelf_life'
          ? typeof shelf !== 'number' || !Number.isSafeInteger(shelf) || shelf < 1 || shelf > 3650
          : shelf !== null)
      )
        fail();
      Object.assign(valid, {
        outputQuantity: quantity(draft.outputQuantity),
        expiryPolicy: policy,
        shelfLifeDays: shelf,
        reason: text(draft.reason, 500),
      });
    }
    old = {
      product,
      revision: revision(o.revision),
      latestVersion: o.latestVersion === null ? null : uuid(o.latestVersion),
      projection: valid,
    };
    if (v.mode === 'legacy' && old.latestVersion !== null) fail();
  }
  return {
    recordId,
    key: uuid(v.key),
    mode: v.mode,
    original: old,
    needsReview: bool(v.needsReview),
  };
}
export function draftProjection(raw: RawRecipe, legacy: boolean): NativeDraft {
  return {
    components: JSON.stringify(
      raw.components.map(({ product, quantity }) => ({ product, quantity })),
    ),
    ...(legacy
      ? {}
      : {
          outputQuantity: raw.outputQuantity,
          expiryPolicy: raw.expiryPolicy,
          shelfLifeDays:
            raw.expiryPolicy === 'minimum_with_shelf_life' ? Number(raw.shelfLifeDays) : null,
          reason: raw.reason,
        }),
  };
}
function body(value: unknown, s: State): Record<string, Json> {
  const v = object(value),
    o = s.original || fail();
  exact(
    v,
    s.mode === 'legacy'
      ? ['product', 'recipe', 'revision']
      : [
          'idempotencyKey',
          'product',
          'expectedVersion',
          'catalogRevision',
          'outputQuantity',
          'components',
          'expiryPolicy',
          'shelfLifeDays',
          'reason',
        ],
  );
  if (v.product !== o.product.id) fail();
  if (s.mode === 'legacy') {
    if (v.revision !== o.revision) fail();
    validateDraft({ components: JSON.stringify(v.recipe) }, o.product.id, true);
  } else {
    if (
      v.idempotencyKey !== s.key ||
      v.catalogRevision !== o.revision ||
      v.expectedVersion !== o.latestVersion
    )
      fail();
    validateDraft(
      {
        components: JSON.stringify(v.components),
        outputQuantity: v.outputQuantity,
        expiryPolicy: v.expiryPolicy,
        shelfLifeDays: v.shelfLifeDays,
        reason: v.reason,
      } as NativeDraft,
      o.product.id,
    );
  }
  // Nested component metadata, credentials, or stable UI keys never belong to the request.
  const rows = s.mode === 'legacy' ? v.recipe : v.components;
  if (!Array.isArray(rows)) return fail();
  rows.forEach((r) => exact(object(r), ['product', 'quantity']));
  return json(v) as Record<string, Json>;
}
export function decodePayload(value: unknown): Payload {
  const v = object(value);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const s = decodeState(v.baseline),
    raw = decodeRawRecipe(v.draft);
  if (s.original && raw.product !== s.original.product.id) fail();
  let first: Payload['firstIntent'] = null;
  if (v.firstIntent !== null) {
    const f = object(v.firstIntent);
    exact(f, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const path = s.mode === 'legacy' ? '/api/erp/recipes' : '/api/erp/recipes/versions';
    if (
      f.method !== 'POST' ||
      f.path !== path ||
      f.key !== s.key ||
      f.revision !== s.original?.revision ||
      f.possiblySent !== true
    )
      fail();
    first = {
      method: 'POST',
      path,
      key: s.key,
      body: body(f.body, s),
      revision: (s.original || fail()).revision,
      possiblySent: true,
    };
  }
  let confirmation: Json = null;
  if (v.confirmation !== null) {
    const c = object(v.confirmation);
    exact(c, ['mode', 'id', 'revision', 'body']);
    if (c.mode !== s.mode || !s.original) fail();
    if (c.id !== (s.mode === 'legacy' ? (s.original || fail()).product.id : s.key)) fail();
    if (s.mode === 'legacy') revision(c.revision);
    else if (c.revision !== null) fail();
    confirmation = {
      mode: s.mode,
      id: text(c.id, 120),
      revision: c.revision as string | null,
      body: body(c.body, s),
    };
    if (first || !s.needsReview) fail();
  }
  return { baseline: json(s), draft: json(raw), firstIntent: first, confirmation };
}
export function decodeContext(value: unknown, mode: Mode, product: string, session: DraftSession) {
  const v = object(value);
  exact(v, ['mode', 'product', 'role', 'storeId', 'networkOwner', 'canWrite', 'exists']);
  if (
    v.role !== session.role ||
    v.storeId !== session.storeId ||
    v.networkOwner !== session.networkOwner
  )
    throw Object.assign(Error('Доступ до чернетки змінився.'), { status: 403 });
  if (
    v.mode !== mode ||
    v.product !== product ||
    (product ? typeof v.exists !== 'boolean' : v.exists !== null)
  )
    fail();
  bool(v.canWrite);
  return v;
}
export function decodeIdentity(value: unknown, request: Record<string, Json>) {
  const v = object(value);
  if (typeof v.confirmed !== 'boolean') fail();
  exact(
    v,
    v.confirmed ? ['confirmed', 'key', 'product', 'original'] : ['confirmed', 'key', 'product'],
  );
  if (v.key !== request.idempotencyKey || v.product !== request.product) fail();
  return v.confirmed
    ? confirmVersion(v.original, request as Parameters<typeof confirmVersion>[1])
    : null;
}
export function confirmPayload(value: unknown, event: unknown): Payload | null {
  const p = decodePayload(value),
    s = decodeState(p.baseline),
    e = object(event);
  exact(e, ['type', 'raw', 'draft']);
  p.draft = json(decodeRawRecipe(e.draft));
  if (e.type === 'ack' || e.type === 'identity') {
    const request = p.firstIntent ? object(p.firstIntent.body) : fail();
    let ackRevision: string | null = null;
    if (s.mode === 'legacy') {
      if (e.type !== 'ack') fail();
      const r = object(e.raw);
      exact(r, ['ok', 'product', 'revision']);
      if (r.ok !== true || r.product !== s.original?.product.id) fail();
      ackRevision = revision(r.revision);
    } else if (e.type === 'identity') {
      if (!decodeIdentity(e.raw, request as Record<string, Json>)) return p;
    } else confirmVersion(e.raw, request as Parameters<typeof confirmVersion>[1]);
    p.confirmation = {
      mode: s.mode,
      id: s.mode === 'legacy' ? s.original!.product.id : s.key,
      revision: ackRevision,
      body: json(request),
    };
    p.firstIntent = null;
    s.needsReview = true;
  } else if (e.type === 'rejected') {
    const r = object(e.raw);
    exact(r, ['write_rejected', 'request_key', 'product', 'mode']);
    if (
      s.mode !== 'version' ||
      !p.firstIntent ||
      r.write_rejected !== true ||
      r.request_key !== s.key ||
      r.product !== s.original?.product.id ||
      r.mode !== 'version'
    )
      fail();
    p.firstIntent = null;
    s.needsReview = true;
  } else if (e.type === 'apply') {
    // Current GET explicitly applied locally. Unknown legacy UPDATE is never replayed.
    if (s.mode === 'version' && p.firstIntent) fail();
    const apply = object(e.raw);
    exact(apply, ['current', 'key']);
    const latest =
      s.mode === 'legacy'
        ? decodeLegacy(apply.current, s.original!.product.id)
        : decodeList(apply.current, s.original!.product.id);
    const next = original(latest);
    if (next.product.unit !== s.original?.product.unit) fail();
    s.original = next;
    s.needsReview = false;
    s.key = uuid(apply.key);
    p.firstIntent = null;
    p.confirmation = null;
  } else if (e.type === 'complete') {
    if (!p.confirmation || p.firstIntent) fail();
    const c = object(p.confirmation),
      request = object(c.body),
      raw = decodeRawRecipe(p.draft);
    const normalized = validateDraft(
      draftProjection(raw, s.mode === 'legacy'),
      raw.product,
      s.mode === 'legacy',
    );
    if (s.mode === 'legacy') {
      const latest = decodeLegacy(e.raw, raw.product);
      if (JSON.stringify(normalized) !== JSON.stringify(projection(latest))) return p;
    } else {
      if (!decodeIdentity(e.raw, request as Record<string, Json>)) return p;
      const sent = validateDraft(
        {
          components: JSON.stringify(request.components),
          outputQuantity: request.outputQuantity,
          expiryPolicy: request.expiryPolicy,
          shelfLifeDays: request.shelfLifeDays,
          reason: request.reason,
        } as NativeDraft,
        raw.product,
      );
      if (JSON.stringify(normalized) !== JSON.stringify(sent)) return p;
    }
    return null;
  } else fail();
  p.baseline = json(s);
  return decodePayload(p);
}
