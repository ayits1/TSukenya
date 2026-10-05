import { ApiError } from '../../shared/api/client';
import { decodeDraftSession, sameSession, type DraftSession } from '../../shared/recovery/session';
import { PATH, acknowledgement, context, type Base, type Request } from './persistence';
export type Fence = { signal: AbortSignal; current: () => boolean; session: DraftSession };
export const gate = (f: Fence) => {
  if (f.signal.aborted || !f.current()) throw new DOMException('Скасовано.', 'AbortError');
};
export class AssortmentError extends ApiError {
  constructor(
    status: number,
    message: string,
    code: string | undefined,
    readonly rejection: unknown,
  ) {
    super(status, message, code);
  }
}
export function createAssortmentRecoveryApi(transport: typeof fetch = fetch) {
  async function read(response: Response, f: Fence) {
    gate(f);
    if (response.status === 401 || response.status === 403)
      throw new ApiError(response.status, 'Доступ до асортименту відкликано.');
    try {
      const v: unknown = await response.json();
      gate(f);
      return v;
    } catch (e) {
      gate(f);
      if (!response.ok) return null;
      throw e;
    }
  }
  async function request<T>(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    decode: (v: unknown) => T,
    f: Fence,
  ) {
    gate(f);
    const sessionResponse = await transport('/api/v1/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: f.signal,
    });
    gate(f);
    const sessionValue = await read(sessionResponse, f);
    gate(f);
    if (!sessionResponse.ok)
      throw new ApiError(sessionResponse.status, 'Не вдалося перевірити сеанс.');
    if (!sameSession(decodeDraftSession(sessionValue), f.session))
      throw new ApiError(403, 'Актор або контекст змінився.');
    const csrf = (sessionValue as { csrf: string }).csrf;
    const response = await transport(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: f.signal,
      ...(method === 'POST'
        ? {
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify(body),
          }
        : {}),
    });
    gate(f);
    const v = await read(response, f);
    gate(f);
    if (!response.ok) {
      const error =
        v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      throw new AssortmentError(
        response.status,
        typeof error.error === 'string' ? error.error : 'Запит асортименту не підтверджено.',
        typeof error.code === 'string' ? error.code : undefined,
        v,
      );
    }
    return decode(v);
  }
  return {
    current: (b: Base, f: Fence) =>
      request(
        PATH +
          'current?' +
          new URLSearchParams({ warehouse: String(b.warehouse), product: b.row.product }),
        'GET',
        null,
        (v) => context(v, b, f.session),
        f,
      ),
    context: (b: Base, f: Fence) =>
      request(
        PATH +
          'recovery-context?' +
          new URLSearchParams({ warehouse: String(b.warehouse), product: b.row.product }),
        'GET',
        null,
        (v) => context(v, b, f.session),
        f,
      ),
    identity: (r: Request, f: Fence) =>
      request(
        PATH + 'identity',
        'POST',
        { request: r },
        (v) => {
          acknowledgement(v, r, true);
          return v;
        },
        f,
      ),
    execute: (r: Request, f: Fence) =>
      request(
        PATH + 'execute',
        'POST',
        r,
        (v) => {
          acknowledgement(v, r);
          return v;
        },
        f,
      ),
  };
}
