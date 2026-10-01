import { createApiClient } from '../../shared/api/client';
import type { components } from '../../shared/api/generated';

export type Product = components['schemas']['Product'];
export type ProductPage = components['schemas']['ProductPage'];
export type ProductCreate = components['schemas']['ProductCreate'];
export type ProductPatch = components['schemas']['ProductPatch'];
export type Session = components['schemas']['Session'];
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
  for (const key of ['cost', 'markup', 'price']) {
    if (item[key] !== null && !decimal(item[key])) throw new Error(`Invalid ${key}`);
  }
  if (
    !decimal(item.minStock) ||
    !decimal(item.salePrice) ||
    typeof item.manualPrice !== 'boolean' ||
    typeof item.promotion !== 'boolean'
  )
    throw new Error('Invalid pricing');
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
export function createCatalogApi() {
  let csrf: string | undefined;
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
      return client.get(`/api/v1/catalog/products?${params}`, decodePage, signal);
    },
    product(id: string) {
      return client.get(`/api/v1/catalog/products/${encodeURIComponent(id)}`, decodeProduct);
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
    save(product: ProductCreate | ProductPatch, id?: string) {
      return client.mutate(
        id ? 'PATCH' : 'POST',
        `/api/v1/catalog/products${id ? '/' + encodeURIComponent(id) : ''}`,
        product,
        decodeProduct,
      );
    },
  };
}
export type CatalogApi = ReturnType<typeof createCatalogApi>;
