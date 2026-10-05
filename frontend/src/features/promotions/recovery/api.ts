import type { components } from '../../../shared/api/campaignRecovery.generated';
import { ApiError } from '../../../shared/api/client';
import {
  decodeDraftSession,
  sameSession,
  type DraftSession,
} from '../../../shared/recovery/session';
import { decodeCampaign, type CampaignInput } from '../api';
export const operations = ['create', 'update', 'archive'] as const;
export type Operation = (typeof operations)[number];
export type Envelope = components['schemas']['CampaignRecoveryEnvelope'];
export type Acknowledgement = components['schemas']['CampaignRecoveryAcknowledgement'];
export type Context = {
  operation: Operation;
  target: string | null;
  exists: boolean | null;
  editing: { role: 'owner'; storeId: null; networkOwner: true; canWrite: boolean };
};
export class RecoveryError extends ApiError {
  constructor(
    status: number,
    message: string,
    code?: string,
    readonly refusal?: Record<string, unknown>,
  ) {
    super(status, message, code);
  }
}
export const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw Error('Формат відновлення акції не підтверджено.');
  return v as Record<string, unknown>;
};
export const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k)))
    throw Error('Поля відновлення акції не підтверджено.');
};
export const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
export function decodeInput(raw: unknown): CampaignInput {
  const v = object(raw);
  exact(v, ['name', 'startsOn', 'endsOn', 'active', 'scope', 'stores', 'prices', 'reason']);
  if (
    ['name', 'startsOn', 'endsOn', 'reason'].some(
      (k) => typeof v[k] !== 'string' || String(v[k]).length > 1000,
    ) ||
    typeof v.active !== 'boolean' ||
    typeof v.scope !== 'string' ||
    !['network', 'stores'].includes(v.scope) ||
    !Array.isArray(v.stores) ||
    v.stores.length > 100 ||
    v.stores.some((x) => !Number.isSafeInteger(x) || Number(x) <= 0) ||
    !Array.isArray(v.prices) ||
    v.prices.length > 1000
  )
    throw Error('Первісні умови акції не підтверджено.');
  const ids = new Set();
  for (const item of v.prices) {
    const row = object(item);
    exact(row, ['product', 'price']);
    if (
      typeof row.product !== 'string' ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(row.product) ||
      ids.has(row.product) ||
      typeof row.price !== 'string' ||
      row.price.length > 1000
    )
      throw Error('Рядок акції не підтверджено.');
    ids.add(row.product);
  }
  return structuredClone(v) as CampaignInput;
}
export function decodeEnvelope(raw: unknown): Envelope {
  const v = object(raw);
  exact(v, ['key', 'operation', 'target', 'request']);
  if (
    !uuid(v.key) ||
    !operations.includes(v.operation as Operation) ||
    (v.operation === 'create' ? v.target !== null : !uuid(v.target))
  )
    throw Error('Первісна дія акції не підтверджена.');
  const r = object(v.request);
  const revision = r.revision,
    idempotencyKey = r.idempotencyKey;
  if (v.operation === 'archive') {
    exact(r, ['revision', 'reason']);
    if (typeof r.reason !== 'string' || r.reason.length > 1000)
      throw Error('Причина не підтверджена.');
  } else {
    const input = { ...r };
    delete input.revision;
    delete input.idempotencyKey;
    decodeInput(input);
    exact(r, [...Object.keys(input), v.operation === 'create' ? 'idempotencyKey' : 'revision']);
  }
  if (
    v.operation === 'create'
      ? idempotencyKey !== v.key
      : !Number.isSafeInteger(revision) || Number(revision) <= 0
  )
    throw Error('UUID або версія первісної акції не підтверджені.');
  return structuredClone(v) as Envelope;
}
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
export async function requestHash(value: Envelope) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(decodeEnvelope(value))),
  );
  return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
}
export function decodeAcknowledgement(
  raw: unknown,
  request: Envelope,
  hash: string,
): Acknowledgement {
  const v = object(raw);
  exact(v, ['confirmed', 'key', 'operation', 'target', 'requestHash', 'outcome']);
  if (
    !/^[a-f0-9]{64}$/.test(hash) ||
    v.key !== request.key ||
    v.operation !== request.operation ||
    v.requestHash !== hash ||
    typeof v.confirmed !== 'boolean' ||
    (v.confirmed
      ? v.target !== (request.target || request.key) ||
        v.outcome !== { create: 'created', update: 'saved', archive: 'archived' }[request.operation]
      : v.target !== request.target || v.outcome !== 'unresolved')
  )
    throw Error('Не підтверджено саме первісний результат акції.');
  return v as Acknowledgement;
}
export function decodePolicy(raw: unknown, canWrite: boolean) {
  const p = object(raw);
  exact(p, ['role', 'storeId', 'networkOwner', 'canWrite']);
  if (
    p.role !== 'owner' ||
    p.storeId !== null ||
    p.networkOwner !== true ||
    p.canWrite !== canWrite
  )
    throw Error('Поточні права не підтверджені.');
  return p as Context['editing'];
}
export function decodeContext(
  raw: unknown,
  request: Pick<Envelope, 'operation' | 'target'>,
): Context {
  const v = object(raw);
  exact(v, ['operation', 'target', 'exists', 'editing']);
  if (
    v.operation !== request.operation ||
    v.target !== request.target ||
    (request.target === null ? v.exists !== null : typeof v.exists !== 'boolean')
  )
    throw Error('Контекст акції не підтверджено.');
  decodePolicy(v.editing, true);
  return v as Context;
}
export function createRecoveryApi(transport: typeof fetch = fetch) {
  async function read<T>(
    path: string,
    decode: (v: unknown) => T,
    signal: AbortSignal,
    live: () => boolean,
    body?: unknown,
    expectedSession?: DraftSession,
  ) {
    const guard = () => {
      if (signal.aborted || !live()) throw new DOMException('Скасовано', 'AbortError');
    };
    guard();
    let csrf: string | undefined;
    if (body !== undefined) {
      if (!expectedSession) throw Error('Не підтверджено власника первісного запиту.');
      const s = await transport('/api/v1/session', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      });
      guard();
      const v: unknown = await s.json().catch(() => null);
      guard();
      if (!s.ok) throw new RecoveryError(s.status, 'Не підтверджено поточний сеанс.');
      if (!sameSession(expectedSession, decodeDraftSession(v)))
        throw new RecoveryError(403, 'Сеанс або права змінилися. Перевірте доступ до чернетки.');
      const o = object(v);
      if (typeof o.csrf !== 'string' || !o.csrf) throw Error('Не підтверджено захист запиту.');
      csrf = o.csrf;
    }
    guard();
    let response: Response;
    try {
      response = await transport(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal,
        ...(body === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf! },
              body: JSON.stringify(body),
            }),
      });
    } catch (cause) {
      guard();
      if (cause instanceof Error && cause.name === 'AbortError') throw cause;
      throw new RecoveryError(0, 'Не вдалося підтвердити результат. Первісний запит збережено.');
    }
    guard();
    const value: unknown = await response.json().catch(() => null);
    guard();
    if (!response.ok) {
      const v =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      throw new RecoveryError(
        response.status,
        typeof v.error === 'string' ? v.error : `Помилка читання (${response.status}).`,
        typeof v.code === 'string' ? v.code : undefined,
        v,
      );
    }
    return decode(value);
  }
  return {
    current: (id: string, signal: AbortSignal, live: () => boolean) =>
      read(
        '/api/v1/promotions/recovery/current?id=' + encodeURIComponent(id),
        (raw) => {
          const v = object(raw);
          exact(v, ['campaign', 'editing']);
          const campaign = decodeCampaign(v.campaign);
          if (campaign.id !== id) throw Error('Не підтверджено ID поточної акції.');
          const editing = decodePolicy(v.editing, !campaign.archived);
          return { campaign, editing };
        },
        signal,
        live,
      ),
    context: (
      v: Pick<Envelope, 'operation' | 'target'>,
      signal: AbortSignal,
      live: () => boolean,
    ) => {
      const params = new URLSearchParams({
        operation: v.operation,
        ...(v.target ? { target: v.target } : {}),
      });
      return read(
        '/api/v1/promotions/recovery/context?' + params,
        (x) => decodeContext(x, v),
        signal,
        live,
      );
    },
    identity: (
      v: Envelope,
      hash: string,
      signal: AbortSignal,
      live: () => boolean,
      session: DraftSession,
    ) =>
      read(
        '/api/v1/promotions/recovery/identity',
        (x) => decodeAcknowledgement(x, v, hash),
        signal,
        live,
        v,
        session,
      ),
    execute: (
      v: Envelope,
      hash: string,
      signal: AbortSignal,
      live: () => boolean,
      session: DraftSession,
    ) =>
      read(
        '/api/v1/promotions/recovery/execute',
        (x) => {
          const ack = decodeAcknowledgement(x, v, hash);
          if (!ack.confirmed) throw Error('Не підтверджено запис.');
          return ack;
        },
        signal,
        live,
        v,
        session,
      ),
  };
}
