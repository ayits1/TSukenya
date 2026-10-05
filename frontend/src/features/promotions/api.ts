import { createApiClient } from '../../shared/api/client';
import type { components } from '../../shared/api/generated';
export type PromotionContext = components['schemas']['PromotionContext'];
export type CampaignInput = components['schemas']['CampaignInput'];
export type Campaign = components['schemas']['Campaign'];
export type PriceHistory = components['schemas']['PriceHistoryItem'];
export type PageOptions = { page?: number; limit?: number };
export type CampaignFilters = PageOptions & { scope?: '' | 'network' | 'stores' };
export type HistoryFilters = PageOptions & { product?: string };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid promotion object');
  return value as Record<string, unknown>;
};
const amount = (v: unknown) => typeof v === 'string' && /^\d+\.\d{2}$/.test(v);
const day = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
const positiveId = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
export function decodeContext(raw: unknown): PromotionContext {
  const v = object(raw);
  if (
    !(v.storeId === null || positiveId(v.storeId)) ||
    !(v.storeName === null || (typeof v.storeName === 'string' && !!v.storeName)) ||
    (v.storeId === null) !== (v.storeName === null) ||
    typeof v.canViewHistory !== 'boolean' ||
    typeof v.canSelectNetwork !== 'boolean' ||
    typeof v.canManage !== 'boolean' ||
    !day(v.effectiveDay) ||
    typeof v.csrf !== 'string' ||
    !v.csrf ||
    !Array.isArray(v.stores) ||
    !v.stores.every((x) => {
      const s = object(x);
      return positiveId(s.id) && typeof s.name === 'string';
    })
  )
    throw new Error('Invalid price context');
  return v as PromotionContext;
}
export function decodeCampaign(raw: unknown): Campaign {
  const v = object(raw);
  if (
    typeof v.id !== 'string' ||
    !v.id ||
    typeof v.name !== 'string' ||
    typeof v.reason !== 'string' ||
    typeof v.author !== 'string' ||
    !day(v.startsOn) ||
    !day(v.endsOn) ||
    v.startsOn > v.endsOn ||
    typeof v.active !== 'boolean' ||
    typeof v.archived !== 'boolean' ||
    !positiveId(v.revision) ||
    typeof v.scope !== 'string' ||
    !['network', 'stores'].includes(v.scope) ||
    typeof v.status !== 'string' ||
    !['active', 'scheduled', 'expired', 'disabled', 'archived'].includes(v.status) ||
    !Array.isArray(v.stores) ||
    !v.stores.every((s) => positiveId(s)) ||
    !Array.isArray(v.prices) ||
    !v.prices.every((x) => {
      const p = object(x);
      return typeof p.product === 'string' && typeof p.name === 'string' && amount(p.price);
    })
  )
    throw new Error('Invalid campaign');
  return v as Campaign;
}
function pageMeta(v: Record<string, unknown>) {
  for (const key of ['page', 'pages', 'limit', 'total'])
    if (!Number.isSafeInteger(v[key]) || Number(v[key]) < (key === 'total' ? 0 : 1))
      throw new Error('Invalid promotion page');
  if (![10, 20, 50].includes(Number(v.limit)) || Number(v.page) > Number(v.pages))
    throw new Error('Invalid promotion page');
  return {
    page: Number(v.page),
    pages: Number(v.pages),
    limit: Number(v.limit),
    total: Number(v.total),
  };
}
const decodeCampaigns = (raw: unknown) => {
  const v = object(raw);
  if (!Array.isArray(v.items)) throw new Error('Invalid campaigns');
  return { ...pageMeta(v), items: v.items.map(decodeCampaign) };
};
export function decodeHistory(raw: unknown) {
  const v = object(raw);
  if (!Array.isArray(v.items)) throw new Error('Invalid history');
  return {
    ...pageMeta(v),
    items: v.items.map((raw) => {
      const h = object(raw),
        b = object(h.before),
        a = object(h.after);
      if (
        !positiveId(h.id) ||
        typeof h.name !== 'string' ||
        typeof h.product !== 'string' ||
        !(h.storeId === null || positiveId(h.storeId)) ||
        !amount(b.regularPrice) ||
        !amount(b.salePrice) ||
        !amount(a.regularPrice) ||
        !amount(a.salePrice) ||
        typeof h.author !== 'string' ||
        typeof h.source !== 'string' ||
        typeof h.reason !== 'string' ||
        typeof h.at !== 'string' ||
        !Number.isFinite(Date.parse(h.at))
      )
        throw new Error('Invalid price history');
      return h as PriceHistory;
    }),
  };
}
export function createPromotionApi() {
  let csrf: string | undefined;
  const client = createApiClient({ getCsrf: () => csrf });
  return {
    durableRecovery: true as boolean,
    async context(store?: number | null, signal?: AbortSignal) {
      const v = await client.get(
        '/api/v1/promotions/context' + (store == null ? '' : `?store=${store}`),
        decodeContext,
        signal,
      );
      csrf = v.csrf;
      return v;
    },
    campaigns(signal?: AbortSignal, filters: CampaignFilters = {}) {
      const params = new URLSearchParams(Object.entries(filters).map(([k, v]) => [k, String(v)]));
      return client.get('/api/v1/promotions/campaigns?' + params, decodeCampaigns, signal);
    },
    campaign(id: string, signal?: AbortSignal) {
      return client.get('/api/v1/promotions/campaigns/' + id, decodeCampaign, signal);
    },
    save(
      input: CampaignInput,
      identity: { id: string; revision: number } | { idempotencyKey: string },
    ) {
      return 'id' in identity
        ? client.mutate(
            'PATCH',
            '/api/v1/promotions/campaigns/' + identity.id,
            { ...input, revision: identity.revision },
            decodeCampaign,
          )
        : client.mutate(
            'POST',
            '/api/v1/promotions/campaigns',
            { ...input, idempotencyKey: identity.idempotencyKey },
            decodeCampaign,
          );
    },
    archive(campaign: Campaign, reason: string) {
      return client.mutate(
        'DELETE',
        '/api/v1/promotions/campaigns/' + campaign.id,
        { revision: campaign.revision, reason },
        decodeCampaign,
      );
    },
    history(store?: number | null, signal?: AbortSignal, filters: HistoryFilters = {}) {
      const params = new URLSearchParams(Object.entries(filters).map(([k, v]) => [k, String(v)]));
      if (store != null) params.set('store', String(store));
      return client.get('/api/v1/promotions/history?' + params, decodeHistory, signal);
    },
  };
}
export type PromotionApi = Omit<ReturnType<typeof createPromotionApi>, 'durableRecovery'> & {
  durableRecovery?: boolean;
};
