export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Stable server error code, for example `revision_conflict` or `duplicate_name`. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Decoder<T> = (value: unknown) => T;
type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Cookie sessions stay on the same origin. Decoders validate network data at runtime.
export function createApiClient({
  transport = fetch,
  getCsrf = () => undefined,
}: {
  transport?: typeof fetch;
  getCsrf?: () => string | undefined;
} = {}) {
  async function request<T>(path: string, decode: Decoder<T>, init: RequestInit): Promise<T> {
    if (!/^\/(?:api\/|health$)/.test(path) || path.includes('\\')) {
      throw new Error('API path must be a local /api/ route or /health');
    }
    let response: Response;
    try {
      response = await transport(path, {
        ...init,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw cause;
      throw new ApiError(
        0,
        'Не вдалося з’єднатися із сервером. Перевірте підключення та спробуйте ще раз.',
      );
    }
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
          ? value.error
          : `Помилка запиту (${response.status}).`;
      const code =
        value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
          ? value.code
          : undefined;
      throw new ApiError(response.status, message, code);
    }
    try {
      return decode(value);
    } catch {
      throw new ApiError(response.status, 'Сервер повернув дані невідомого формату.');
    }
  }
  return {
    get<T>(path: string, decode: Decoder<T>, signal?: AbortSignal) {
      return request(path, decode, { method: 'GET', ...(signal ? { signal } : {}) });
    },
    mutate<T>(
      method: MutationMethod,
      path: string,
      value: unknown,
      decode: Decoder<T>,
      signal?: AbortSignal,
    ) {
      const csrf = getCsrf();
      if (!csrf) throw new ApiError(403, 'Потрібно оновити сесію перед збереженням.');
      return request(path, decode, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
        ...(signal ? { signal } : {}),
      });
    },
  };
}

export type Health = { status: 'ok'; storage: string; version: string };
export function decodeHealth(value: unknown): Health {
  if (
    !value ||
    typeof value !== 'object' ||
    !('status' in value) ||
    value.status !== 'ok' ||
    !('storage' in value) ||
    typeof value.storage !== 'string' ||
    !('version' in value) ||
    typeof value.version !== 'string'
  )
    throw new Error('Invalid health response');
  return { status: 'ok', storage: value.storage, version: value.version };
}
