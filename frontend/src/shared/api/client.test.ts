import { describe, expect, it, vi } from 'vitest';
import { createApiClient, decodeHealth, decodeProductPricePreview } from './client';

describe('API boundary', () => {
  it('validates the existing health response and preserves cancellation', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: 'ok', storage: 'relational', version: 'crm-2' }));
    const controller = new AbortController();
    const client = createApiClient({ transport });
    await expect(client.get('/health', decodeHealth, controller.signal)).resolves.toEqual({
      status: 'ok',
      storage: 'relational',
      version: 'crm-2',
    });
    expect(transport).toHaveBeenCalledWith(
      '/health',
      expect.objectContaining({
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
      }),
    );
  });
  it('rejects malformed success payloads instead of trusting a TypeScript cast', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: 'ok', version: 2 }));
    await expect(createApiClient({ transport }).get('/health', decodeHealth)).rejects.toThrow(
      'невідомого формату',
    );
  });
  it.each([401, 403, 409, 500])('preserves HTTP status %i for the UI', async (status) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: 'Недоступно' }, { status }));
    await expect(createApiClient({ transport }).get('/health', decodeHealth)).rejects.toMatchObject(
      { status, message: 'Недоступно' },
    );
  });
  it('keeps the server error code so a duplicate name is not shown as a version conflict', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: 'Товар із такою назвою вже є.', code: 'duplicate_name' },
          { status: 409 },
        ),
      );
    await expect(createApiClient({ transport }).get('/health', decodeHealth)).rejects.toMatchObject(
      { status: 409, code: 'duplicate_name', message: 'Товар із такою назвою вже є.' },
    );
    transport.mockResolvedValue(Response.json({ error: 'Недоступно', code: 7 }, { status: 409 }));
    await expect(createApiClient({ transport }).get('/health', decodeHealth)).rejects.toMatchObject(
      { status: 409, code: undefined },
    );
  });
  it('blocks mutations without CSRF before making a request', () => {
    const transport = vi.fn<typeof fetch>();
    expect(() =>
      createApiClient({ transport }).mutate('POST', '/api/example', {}, decodeHealth),
    ).toThrow('оновити сесію');
    expect(transport).not.toHaveBeenCalled();
  });
  it('sends mutations with the session CSRF token', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: 'ok', storage: 'relational', version: 'crm-2' }));
    await createApiClient({ transport, getCsrf: () => 'test-csrf' }).mutate(
      'PATCH',
      '/api/example',
      { value: 1 },
      decodeHealth,
    );
    expect(transport).toHaveBeenCalledWith(
      '/api/example',
      expect.objectContaining({
        method: 'PATCH',
        body: '{"value":1}',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' },
      }),
    );
  });
  it.each(['https://example.com/api/x', '//example.com/api/x', '/api\\example'])(
    'rejects an external or ambiguous URL %s',
    async (path) => {
      const transport = vi.fn<typeof fetch>();
      await expect(createApiClient({ transport }).get(path, decodeHealth)).rejects.toThrow('local');
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it('keeps AbortError available to callers without turning it into a server error', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    await expect(createApiClient({ transport }).get('/health', decodeHealth)).rejects.toMatchObject(
      { name: 'AbortError' },
    );
  });
  it('provides a Ukrainian recovery message for a network failure', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createApiClient({ transport }).get('/health', decodeHealth)).rejects.toMatchObject(
      {
        name: 'ApiError',
        status: 0,
        message: 'Не вдалося з’єднатися із сервером. Перевірте підключення та спробуйте ще раз.',
      },
    );
  });
});

const pricePreview = {
  regularPrice: '21.99',
  salePrice: '17.50',
  config: { markup: '30', rounding: '0.5' },
  pricingRevision: 'a'.repeat(64),
  warnings: [],
  promotionValid: true,
  effectivePromotion: null,
  effectiveDay: '2026-10-04',
  effectivePriceRevision: 'f'.repeat(64),
  priceContext: { storeId: null, storeName: null },
};

describe('Product price preview contract', () => {
  it.each(['effectivePromotion', 'effectiveDay', 'effectivePriceRevision', 'priceContext'])(
    'rejects missing mandatory context field %s',
    (key) => {
      const incomplete: Record<string, unknown> = { ...pricePreview };
      delete incomplete[key];
      expect(() => decodeProductPricePreview(incomplete)).toThrow();
    },
  );
  it('sends read-only POST with CSRF and cancellation, retaining exact decimal strings', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(pricePreview));
    const controller = new AbortController();
    const client = createApiClient({ transport, getCsrf: () => 'preview-csrf' });
    const input = {
      id: 'one',
      revision: 'old',
      cost: '10.29',
      markup: '12.3456',
      manualPrice: true,
      price: '21.99',
      promotion: true,
      promotionPrice: '17.50',
      priceReviewed: true,
    };
    await expect(client.previewProductPrice(input, controller.signal)).resolves.toEqual(
      pricePreview,
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      '/api/v1/catalog/products/price-preview',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(input),
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'preview-csrf' },
      }),
    );
  });
  it('keeps grandfather warnings and never substitutes browser-computed prices', () => {
    expect(
      decodeProductPricePreview({
        ...pricePreview,
        regularPrice: '99999999999999.99',
        salePrice: '99999999999999.99',
        promotionValid: false,
        warnings: ['Стара акція'],
      }),
    ).toMatchObject({
      regularPrice: '99999999999999.99',
      warnings: ['Стара акція'],
      promotionValid: false,
    });
  });
  it.each([
    { regularPrice: 21.99 },
    { salePrice: 'NaN' },
    { salePrice: '-1' },
    { config: { markup: 30, rounding: '0.5' } },
    { config: { markup: '30', rounding: '0.5', secret: 'no' } },
    { pricingRevision: 'stale' },
    { promotionValid: 'yes' },
    { warnings: [1] },
    { warnings: null },
    { secret: 'private' },
  ])('rejects malformed server preview %j', async (replacement) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...pricePreview, ...replacement }));
    await expect(
      createApiClient({ transport, getCsrf: () => 'csrf' }).previewProductPrice({ cost: '10' }),
    ).rejects.toThrow('невідомого формату');
  });
  it('does not make a preview request without CSRF', () => {
    const transport = vi.fn<typeof fetch>();
    expect(() => createApiClient({ transport }).previewProductPrice({ cost: '10' })).toThrow(
      'оновити сесію',
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it('preserves pricing conflicts and never retries a POST automatically', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: 'Оновіть розрахунок', code: 'pricing_revision_conflict' },
          { status: 409 },
        ),
      );
    await expect(
      createApiClient({ transport, getCsrf: () => 'csrf' }).previewProductPrice({ cost: '10' }),
    ).rejects.toMatchObject({ status: 409, code: 'pricing_revision_conflict' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('preserves abort errors so superseded editor requests can be discarded', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    await expect(
      createApiClient({ transport, getCsrf: () => 'csrf' }).previewProductPrice(
        { cost: '10' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
