import { validateRequiredEffectivePricing } from './effectivePricing';
import type { components } from './generated';

export type ProductPricePreviewRequest = components['schemas']['ProductPricePreviewRequest'];
export type ProductPricePreview = components['schemas']['ProductPricePreview'];

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
  function mutate<T>(
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
  }
  return {
    get<T>(path: string, decode: Decoder<T>, signal?: AbortSignal) {
      return request(path, decode, { method: 'GET', ...(signal ? { signal } : {}) });
    },
    mutate,
    previewProductPrice(
      value: ProductPricePreviewRequest,
      signal?: AbortSignal,
      store?: number | null,
    ) {
      return mutate(
        'POST',
        '/api/v1/catalog/products/price-preview' + (store == null ? '' : `?store=${store}`),
        value,
        decodeProductPricePreview,
        signal,
      );
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

const nonnegativeDecimal = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(value) && Number.isFinite(Number(value));

export function decodeProductPricePreview(value: unknown): ProductPricePreview {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'regularPrice',
          'salePrice',
          'config',
          'pricingRevision',
          'warnings',
          'promotionValid',
          'effectivePromotion',
          'effectiveDay',
          'effectivePriceRevision',
          'priceContext',
        ].includes(key),
    ) ||
    !('regularPrice' in value) ||
    !nonnegativeDecimal(value.regularPrice) ||
    !('salePrice' in value) ||
    !nonnegativeDecimal(value.salePrice) ||
    !('pricingRevision' in value) ||
    typeof value.pricingRevision !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.pricingRevision) ||
    !('promotionValid' in value) ||
    typeof value.promotionValid !== 'boolean' ||
    !('warnings' in value) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((warning: unknown) => typeof warning === 'string') ||
    !('config' in value) ||
    !value.config ||
    typeof value.config !== 'object' ||
    Array.isArray(value.config) ||
    Object.keys(value.config).some((key) => !['markup', 'rounding'].includes(key)) ||
    !('markup' in value.config) ||
    !nonnegativeDecimal(value.config.markup) ||
    !('rounding' in value.config) ||
    !nonnegativeDecimal(value.config.rounding)
  )
    throw new Error('Invalid product price preview');
  const effective = value as Record<string, unknown>;
  validateRequiredEffectivePricing(effective);
  return {
    ...effective,
    regularPrice: value.regularPrice,
    salePrice: value.salePrice,
    pricingRevision: value.pricingRevision,
    promotionValid: value.promotionValid,
    warnings: value.warnings.map((warning) => String(warning)),
    config: { markup: value.config.markup, rounding: value.config.rounding },
  };
}
