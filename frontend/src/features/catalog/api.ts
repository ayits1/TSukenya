import { createApiClient } from '../../shared/api/client';
import type { components } from '../../shared/api/generated';

export type ProductPricePreviewRequest = components['schemas']['ProductPricePreviewRequest'];
export type {
  PriceContext,
  EffectivePromotion,
  EffectivePricing,
} from '../../shared/api/effectivePricing';
import { validateEffectivePricing, type EffectivePricing } from '../../shared/api/effectivePricing';
export type ProductPricePreview = components['schemas']['ProductPricePreview'] & EffectivePricing;
export type PricePreviewRequest = ProductPricePreviewRequest;
export type PricePreview = ProductPricePreview;
export type Product = components['schemas']['Product'] & EffectivePricing;
export function hasEffectivePromotion(product: Product): boolean {
  return (
    (product.effectivePromotion != null || product.promotion) &&
    (product.effectivePromotion != null || product.promotionPrice !== null) &&
    Number(product.salePrice) > 0 &&
    Number(product.salePrice) < Number(product.regularPrice)
  );
}
export type ProductPage = Omit<components['schemas']['ProductPage'], 'items'> & {
  items: Product[];
};
export type ProductCreate = components['schemas']['ProductCreate'];
export type ProductPatch = components['schemas']['ProductPatch'];
export type Session = components['schemas']['Session'];
export const referenceFields = ['type', 'category', 'pack', 'size', 'unit'] as const;
export type ReferenceField = (typeof referenceFields)[number];
export type ReferenceItem = components['schemas']['ReferenceItem'];
export type ReferenceData = components['schemas']['ReferenceData'];
export type ReferenceCreate = components['schemas']['ReferenceCreate'];
export const referenceKey = (value: string) =>
  value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA');
export type Filters = {
  q: string;
  type: string;
  category: string;
  pack: string;
  promotion: string;
  page: number;
  limit: number;
};
export const emptyFilters: Filters = {
  q: '',
  type: '',
  category: '',
  pack: '',
  promotion: '',
  page: 1,
  limit: 20,
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object');
  return value as Record<string, unknown>;
}
const decimal = (value: unknown) =>
  typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value));
export function decodeProduct(value: unknown): Product {
  const item = object(value);
  for (const key of [
    'id',
    'revision',
    'name',
    'type',
    'category',
    'pack',
    'size',
    'unit',
    'barcode',
    'priceAt',
  ]) {
    if (typeof item[key] !== 'string') throw new Error(`Invalid ${key}`);
  }
  for (const key of ['cost', 'markup', 'price', 'promotionPrice']) {
    if (item[key] !== null && !decimal(item[key])) throw new Error(`Invalid ${key}`);
  }
  if (
    !decimal(item.minStock) ||
    !decimal(item.salePrice) ||
    !decimal(item.regularPrice) ||
    typeof item.manualPrice !== 'boolean' ||
    typeof item.promotion !== 'boolean'
  )
    throw new Error('Invalid pricing');
  if (item.referenceIds !== undefined) {
    const ids = object(item.referenceIds);
    for (const [field, id] of Object.entries(ids)) {
      if (
        !referenceFields.some((allowed) => allowed === field) ||
        typeof id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(id)
      )
        throw new Error('Invalid referenceIds');
    }
  }
  validateEffectivePricing(item);
  return item as Product;
}
export function decodePage(value: unknown): ProductPage {
  const page = object(value);
  if (!Array.isArray(page.items)) throw new Error('Invalid products');
  page.items.forEach(decodeProduct);
  for (const key of ['total', 'page', 'pages', 'limit']) {
    if (!Number.isInteger(page[key]) || Number(page[key]) < (key === 'total' ? 0 : 1))
      throw new Error(`Invalid ${key}`);
  }
  if (
    ![10, 20, 50].includes(Number(page.limit)) ||
    typeof page.canEdit !== 'boolean' ||
    !decimal(page.defaultMarkup)
  )
    throw new Error('Invalid page');
  const facets = object(page.facets);
  for (const key of ['type', 'category', 'pack']) {
    if (
      !Array.isArray(facets[key]) ||
      !facets[key].every((item: unknown) => typeof item === 'string')
    )
      throw new Error('Invalid facets');
  }
  return page as ProductPage;
}
function decodeSession(value: unknown): Session {
  const session = object(value);
  if (
    !['owner', 'manager', 'warehouse', 'cashier', 'accountant'].includes(String(session.role)) ||
    typeof session.csrf !== 'string' ||
    !session.csrf
  )
    throw new Error('Invalid session');
  return session as Session;
}
export function decodeReference(value: unknown): ReferenceItem {
  const item = object(value);
  if (
    typeof item.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(item.id) ||
    !referenceFields.some((field) => field === item.field) ||
    typeof item.value !== 'string' ||
    !item.value.trim() ||
    typeof item.parentType !== 'string' ||
    (item.field !== 'category' && item.parentType !== '')
  )
    throw new Error('Invalid reference');
  return item as ReferenceItem;
}
export function decodeReferences(value: unknown): ReferenceData {
  const data = object(value);
  if (!Array.isArray(data.items) || typeof data.canEdit !== 'boolean')
    throw new Error('Invalid references');
  const items = data.items.map(decodeReference);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error('Duplicate reference ids');
  if (data.archivedItems !== undefined && !Array.isArray(data.archivedItems))
    throw new Error('Invalid archived references');
  const archivedItems = (data.archivedItems as unknown[] | undefined)?.map(decodeReference);
  const all = [...items, ...(archivedItems || [])];
  if (new Set(all.map((item) => item.id)).size !== all.length)
    throw new Error('Duplicate reference ids');
  return { items, canEdit: data.canEdit, ...(archivedItems ? { archivedItems } : {}) };
}
export function createCatalogApi(store?: number | null, csrfToken?: string) {
  const context = store == null ? '' : `store=${store}`;
  const contextual = (path: string) =>
    context ? `${path}${path.includes('?') ? '&' : '?'}${context}` : path;
  let csrf: string | undefined = csrfToken;
  const client = createApiClient({ getCsrf: () => csrf });
  return {
    async session(signal?: AbortSignal) {
      const result = await client.get('/api/v1/session', decodeSession, signal);
      csrf = result.csrf;
      return result;
    },
    list(filters: Filters, signal?: AbortSignal) {
      const params = new URLSearchParams(
        Object.entries(filters).map(([key, value]) => [key, String(value)]),
      );
      return client.get(contextual(`/api/v1/catalog/products?${params}`), decodePage, signal);
    },
    product(id: string) {
      return client.get(
        contextual(`/api/v1/catalog/products/${encodeURIComponent(id)}`),
        decodeProduct,
      );
    },
    references(signal?: AbortSignal) {
      return client.get('/api/v1/catalog/references', decodeReferences, signal);
    },
    createReference(reference: ReferenceCreate) {
      return client.mutate('POST', '/api/v1/catalog/references', reference, decodeReference);
    },
    remove(product: Product) {
      return client.mutate(
        'DELETE',
        `/api/v1/catalog/products/${encodeURIComponent(product.id)}`,
        { revision: product.revision },
        (value) => {
          if (object(value).ok !== true) throw new Error('Invalid deletion response');
          return true;
        },
      );
    },
    previewPrice(input: ProductPricePreviewRequest, signal?: AbortSignal) {
      return client.previewProductPrice(input, signal, store);
    },
    save(product: ProductCreate | ProductPatch, id?: string) {
      return client.mutate(
        id ? 'PATCH' : 'POST',
        contextual(`/api/v1/catalog/products${id ? '/' + encodeURIComponent(id) : ''}`),
        product,
        decodeProduct,
      );
    },
  };
}
export type CatalogApi = ReturnType<typeof createCatalogApi>;
