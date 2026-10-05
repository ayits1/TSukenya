import { ApiError } from '../../shared/api/client';
import { decodeDraftSession, sameSession } from '../../shared/recovery/session';
import type { DraftSession } from '../../shared/recovery/session';
import { decodeWorkspace } from './api';
import { decodeContext, decodeReceipt, EXECUTE } from './persistence';
import type { Request } from './persistence';
export type Fence = { signal: AbortSignal; current: () => boolean; session: DraftSession };
export const cancelled = () => new DOMException('Скасовано.', 'AbortError');
export function gate(f: Fence) {
  if (f.signal.aborted || !f.current()) throw cancelled();
}
export class LabelSaveError extends ApiError {
  constructor(
    status: number,
    message: string,
    code: string | undefined,
    readonly rejection: unknown,
  ) {
    super(status, message, code);
  }
}
export function createLabelRecoveryApi(transport: typeof fetch = fetch) {
  async function json(response: Response, f: Fence): Promise<unknown> {
    try {
      const value: unknown = await response.json();
      gate(f);
      return value;
    } catch (error) {
      gate(f);
      if (!response.ok) return null;
      throw error;
    }
  }
  async function session(f: Fence) {
    gate(f);
    const response = await transport('/api/v1/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: f.signal,
      redirect: 'error',
    });
    gate(f);
    const value = await json(response, f);
    gate(f);
    if (!response.ok) throw new ApiError(response.status, 'Не вдалося підтвердити сеанс.');
    const next = decodeDraftSession(value);
    if (!sameSession(next, f.session))
      throw new ApiError(403, 'Сеанс або доступ до чернетки змінився.');
    return (value as { csrf: string }).csrf;
  }
  async function request<T>(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    decode: (v: unknown) => T,
    f: Fence,
  ) {
    const csrf = await session(f);
    gate(f);
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
    const value = await json(response, f);
    gate(f);
    if (!response.ok) {
      const v =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      throw new LabelSaveError(
        response.status,
        typeof v.error === 'string' ? v.error : 'Не вдалося виконати запит макета.',
        typeof v.code === 'string' ? v.code : undefined,
        value,
      );
    }
    return decode(value);
  }
  return {
    context: (f: Fence) =>
      request(
        '/api/v1/labels/recovery-context',
        'GET',
        null,
        (v) => decodeContext(v, f.session),
        f,
      ),
    workspace: (f: Fence) => request('/api/v1/labels/workspace', 'GET', null, decodeWorkspace, f),
    identity: (body: Request, f: Fence) =>
      request(
        '/api/v1/labels/workspace/identity',
        'POST',
        { request: body },
        (v) => decodeReceipt(v, body.key),
        f,
      ),
    execute: (body: Request, f: Fence) =>
      request(EXECUTE, 'POST', body, (v) => decodeReceipt(v, body.key, true), f),
  };
}
export type LabelRecoveryApi = ReturnType<typeof createLabelRecoveryApi>;
