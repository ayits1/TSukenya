import { createApiClient } from '../../shared/api/client';
import type { components } from '../../shared/api/crm.generated';

export type Customer = components['schemas']['Customer'];
export type CustomerPage = components['schemas']['CustomerPage'];
export type CustomerProfile = components['schemas']['CustomerProfile'];
export type CustomerFilters = {
  q: string;
  active: '' | 'yes' | 'no';
  page: number;
  store: number | null;
};
export const emptyCustomerFilters: CustomerFilters = { q: '', active: '', page: 1, store: null };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid customer object');
  return value as Record<string, unknown>;
};
const integer = (v: unknown, minimum = 0) => Number.isSafeInteger(v) && Number(v) >= minimum;
const amount = (v: unknown) => typeof v === 'string' && /^\d+\.\d{2}$/.test(v);
const day = (v: unknown) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
export function decodeCustomer(raw: unknown): Customer {
  const v = object(raw);
  if (
    !integer(v.id, 1) ||
    !['name', 'phone', 'email', 'notes'].every((k) => typeof v[k] === 'string') ||
    typeof v.active !== 'boolean'
  )
    throw new Error('Invalid customer');
  return v as Customer;
}
export function decodeCustomerPage(raw: unknown): CustomerPage {
  const v = object(raw);
  if (
    !Array.isArray(v.items) ||
    v.items.length > 30 ||
    !integer(v.total) ||
    !integer(v.page, 1) ||
    !integer(v.pages, 1) ||
    Number(v.page) > Number(v.pages) ||
    typeof v.canEdit !== 'boolean'
  )
    throw new Error('Invalid customer page');
  return {
    items: v.items.map(decodeCustomer),
    total: Number(v.total),
    page: Number(v.page),
    pages: Number(v.pages),
    canEdit: v.canEdit,
  };
}
export function decodeCustomerProfile(raw: unknown): CustomerProfile {
  const v = object(raw),
    scope = object(v.scope),
    purchases = object(v.purchases);
  decodeCustomer(v.customer);
  if (
    !(scope.store === null || integer(scope.store, 1)) ||
    !day(scope.today) ||
    scope.basis !== 'current' ||
    typeof v.canEdit !== 'boolean'
  )
    throw new Error('Invalid customer scope');
  if (
    !integer(purchases.checks) ||
    !amount(purchases.gross) ||
    !amount(purchases.returned) ||
    typeof purchases.net !== 'string' ||
    !/^-?\d+\.\d{2}$/.test(purchases.net) ||
    !(purchases.averageCheck === null || amount(purchases.averageCheck)) ||
    ![purchases.first, purchases.last].every((d) => d === null || day(d)) ||
    typeof purchases.segment !== 'string' ||
    !['none', 'single', 'repeat'].includes(purchases.segment)
  )
    throw new Error('Invalid purchase facts');
  if (
    (purchases.checks === 0) !== (purchases.averageCheck === null) ||
    (purchases.checks === 0) !== (purchases.first === null) ||
    (purchases.first === null) !== (purchases.last === null)
  )
    throw new Error('Invalid empty purchase facts');
  if (v.debt !== null) {
    const debt = object(v.debt);
    if (
      !amount(debt.outstanding) ||
      !amount(debt.overdue) ||
      !['documents', 'overdueDocuments', 'unknownDueDocuments'].every((k) => integer(debt[k]))
    )
      throw new Error('Invalid customer debt');
  }
  return v as CustomerProfile;
}
export function createCustomerApi({ transport }: { transport?: typeof fetch } = {}) {
  const client = createApiClient(transport ? { transport } : {});
  return {
    list(filters: CustomerFilters, signal?: AbortSignal) {
      const params = new URLSearchParams({
        q: filters.q,
        active: filters.active,
        page: String(filters.page),
      });
      if (filters.store !== null) params.set('store', String(filters.store));
      return client.get('/api/v1/crm/customers?' + params, decodeCustomerPage, signal);
    },
    profile(id: number, store: number | null, signal?: AbortSignal) {
      return client.get(
        `/api/v1/crm/customers/${id}` + (store === null ? '' : `?store=${store}`),
        decodeCustomerProfile,
        signal,
      );
    },
  };
}
export type CustomerApi = ReturnType<typeof createCustomerApi>;
