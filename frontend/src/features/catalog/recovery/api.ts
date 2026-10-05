import type { components } from '../../../shared/api/catalogRecovery.generated';
import { ApiError } from '../../../shared/api/client';
import {
  decodeDraftSession,
  sameSession,
  type DraftSession,
} from '../../../shared/recovery/session';
export const operations = [
  'product_create',
  'product_update',
  'product_visibility',
  'product_delete',
  'reference_create',
  'reference_commit',
] as const;
export type Operation = (typeof operations)[number];
export type Envelope = components['schemas']['CatalogRecoveryEnvelope'];
export type Acknowledgement = components['schemas']['CatalogRecoveryAcknowledgement'];
export type Context = components['schemas']['CatalogRecoveryContext'];
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
    throw Error('Не підтверджено формат відновлення каталогу.');
  return v as Record<string, unknown>;
};
export const exact = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k)))
    throw Error('Не підтверджено поля відновлення каталогу.');
};
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v);
export function decodeEnvelope(value: unknown): Envelope {
  const v = object(value);
  exact(v, ['key', 'operation', 'target', 'store', 'request']);
  if (
    typeof v.key !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v.key) ||
    !operations.includes(v.operation as Operation) ||
    !(
      v.store === null ||
      (typeof v.store === 'number' && Number.isSafeInteger(v.store) && v.store > 0)
    )
  )
    throw Error('Не підтверджено первісну дію каталогу.');
  const create = v.operation === 'product_create' || v.operation === 'reference_create';
  if (create ? v.target !== null : !identifier(v.target))
    throw Error('Не підтверджено ID первісної дії.');
  const request = object(v.request),
    fields = [
      'name',
      'type',
      'category',
      'pack',
      'size',
      'unit',
      'barcode',
      'cost',
      'markup',
      'price',
      'manualPrice',
      'promotion',
      'promotionPrice',
      'priceAt',
      'priceReviewed',
      'minStock',
      'expiryAlertDays',
      'pricingRevision',
    ];
  const allowed =
    v.operation === 'product_create'
      ? fields
      : v.operation === 'product_update'
        ? [...fields, 'revision']
        : v.operation === 'product_visibility'
          ? ['revision', 'hidden']
          : v.operation === 'product_delete'
            ? ['revision']
            : v.operation === 'reference_create'
              ? ['field', 'value', 'parentType']
              : [
                  'sourceId',
                  'revision',
                  'operation',
                  'value',
                  'targetId',
                  'snapshot',
                  'idempotencyKey',
                ];
  if (
    Object.keys(request).some((k) => !allowed.includes(k)) ||
    Object.values(request).some(
      (x) =>
        !(
          x === null ||
          typeof x === 'boolean' ||
          (typeof x === 'string' && x.length <= 1000) ||
          (typeof x === 'number' && Number.isSafeInteger(x))
        ),
    )
  )
    throw Error('Не підтверджено умови первісної дії.');
  if (
    v.operation === 'reference_commit' &&
    (request.sourceId !== v.target || request.idempotencyKey !== v.key)
  )
    throw Error('UUID або довідник не відповідає первісній дії.');
  const required =
    v.operation === 'product_visibility'
      ? ['revision', 'hidden']
      : v.operation === 'reference_create'
        ? ['field', 'value']
        : v.operation === 'reference_commit'
          ? ['sourceId', 'revision', 'operation', 'snapshot', 'idempotencyKey']
          : create
            ? []
            : ['revision'];
  if (required.some((k) => !Object.hasOwn(request, k))) throw Error('Первісні умови відсутні.');
  if (String(v.operation).startsWith('product_')) {
    for (const k of [
      'name',
      'type',
      'category',
      'pack',
      'size',
      'unit',
      'barcode',
      'priceAt',
      'revision',
      'pricingRevision',
    ])
      if (Object.hasOwn(request, k) && typeof request[k] !== 'string')
        throw Error('Текстові умови не підтверджено.');
    for (const k of ['cost', 'markup', 'price', 'promotionPrice', 'minStock'])
      if (Object.hasOwn(request, k) && request[k] !== null && typeof request[k] !== 'string')
        throw Error('Десяткові умови не підтверджено.');
    for (const k of ['manualPrice', 'promotion', 'priceReviewed', 'hidden'])
      if (Object.hasOwn(request, k) && typeof request[k] !== 'boolean')
        throw Error('Логічні умови не підтверджено.');
    if (
      Object.hasOwn(request, 'expiryAlertDays') &&
      request.expiryAlertDays !== null &&
      !Number.isSafeInteger(request.expiryAlertDays)
    )
      throw Error('Поріг придатності не підтверджено.');
  } else {
    if (Object.values(request).some((x) => typeof x !== 'string'))
      throw Error('Умови довідника не підтверджено.');
    if (
      v.operation === 'reference_create' &&
      !['type', 'category', 'pack', 'size', 'unit'].includes(String(request.field))
    )
      throw Error('Довідник не підтверджено.');
    if (v.operation === 'reference_commit') {
      const op = request.operation;
      if (!['rename', 'merge', 'archive', 'restore'].includes(String(op)))
        throw Error('Дію довідника не підтверджено.');
      const expected = [
        ...required,
        ...(op === 'rename' ? ['value'] : op === 'merge' ? ['targetId'] : []),
      ];
      if (
        Object.keys(request).length !== expected.length ||
        expected.some((k) => !Object.hasOwn(request, k))
      )
        throw Error('Умови переглянутого впливу не підтверджено.');
      if (op === 'merge' && !identifier(request.targetId))
        throw Error('Ціль об’єднання не підтверджено.');
    }
  }
  if (!create && typeof request.revision !== 'string') throw Error('Первісна версія відсутня.');
  return structuredClone(v) as Envelope;
}
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
export async function requestHash(value: Envelope): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(decodeEnvelope(value))),
  );
  return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
}
export function decodeAcknowledgement(
  value: unknown,
  request: Envelope,
  hash: string,
): Acknowledgement {
  const v = object(value);
  exact(v, ['confirmed', 'key', 'operation', 'target', 'requestHash', 'outcome']);
  const outcome =
    request.operation === 'product_delete'
      ? 'deleted'
      : request.operation === 'reference_commit'
        ? 'committed'
        : request.operation === 'product_create' || request.operation === 'reference_create'
          ? 'created'
          : 'saved';
  if (
    v.key !== request.key ||
    v.operation !== request.operation ||
    v.requestHash !== hash ||
    typeof v.confirmed !== 'boolean' ||
    (v.confirmed
      ? !identifier(v.target) ||
        v.outcome !== outcome ||
        (request.target !== null && v.target !== request.target)
      : v.target !== request.target || v.outcome !== 'unresolved')
  )
    throw Error('Не підтверджено результат саме первісного запиту.');
  return v as Acknowledgement;
}
export function decodeContext(
  value: unknown,
  request: Pick<Envelope, 'operation' | 'target' | 'store'>,
): Context {
  const v = object(value);
  exact(v, ['operation', 'target', 'store', 'exists', 'editing']);
  const p = object(v.editing);
  exact(p, ['role', 'storeId', 'networkOwner', 'canWrite']);
  if (
    v.operation !== request.operation ||
    v.target !== request.target ||
    v.store !== request.store ||
    !(request.target === null ? v.exists === null : typeof v.exists === 'boolean') ||
    !['owner', 'manager', 'warehouse'].includes(String(p.role)) ||
    typeof p.role !== 'string' ||
    !(
      p.storeId === null ||
      (typeof p.storeId === 'number' && Number.isSafeInteger(p.storeId) && p.storeId > 0)
    ) ||
    p.networkOwner !== (p.role === 'owner' && p.storeId === null) ||
    p.canWrite !== true ||
    (request.store !== null && p.storeId !== null && p.storeId !== request.store)
  )
    throw Error('Поточні права або контекст каталогу не підтверджено.');
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
    context: (
      v: Pick<Envelope, 'operation' | 'target' | 'store'>,
      signal: AbortSignal,
      live: () => boolean,
    ) => {
      const params = new URLSearchParams({
        operation: v.operation,
        ...(v.target ? { target: v.target } : {}),
        ...(v.store === null ? {} : { store: String(v.store) }),
      });
      return read(
        '/api/v1/catalog/recovery/context?' + params,
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
        '/api/v1/catalog/recovery/identity',
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
        '/api/v1/catalog/recovery/execute',
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
