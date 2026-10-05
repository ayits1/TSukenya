import contract from '../../../../contracts/trading-document-details.openapi.json';
import type { components } from '../../shared/api/documentDetails.generated';
import { ApiError, createApiClient } from '../../shared/api/client';
export type Header = components['schemas']['Header'];
export type Page = components['schemas']['Page'];
export type Document = Header['document'];
export type Section = components['schemas']['Section'];
export type Action = components['schemas']['Action'];
export type Row = Page['page']['items'][number];
export type Grant = Pick<Header['context'], 'role' | 'scopeStore'>;
export type Query = { id: number; section: Section; page: number; limit: 10 | 30 };
export const titles: Record<Section, string> = {
  lines: 'Рядки документа',
  stock_movements: 'Складські рухи',
  cash_movements: 'Рух коштів',
  allocations: 'Розподіли платежу',
  payroll_calculation: 'Розрахунок зарплати',
  production_components: 'Сировина',
  order_lines: 'Виконання замовлення',
  reservations: 'Історія резервів',
};
// The small, closed subset below validates this checked-in contract directly: generated TS
// is used by consumers, while every network field is checked before becoming visible.
type Schema = {
  $ref?: string;
  anyOf?: Schema[];
  type?: string;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
};
const schemas = contract.components.schemas as Record<string, Schema>;
const fail = (): never => {
  throw new ApiError(200, 'Некоректні дані документа. Повторіть читання.', 'protocol');
};
function check(ok: unknown): asserts ok {
  if (!ok) fail();
}
function valid(value: unknown, schema: Schema): boolean {
  if (schema.anyOf) return schema.anyOf.some((s) => valid(value, s));
  if (value === null) return schema.type === 'null';
  if (schema.$ref) return valid(value, schemas[schema.$ref.split('/').at(-1)!]!);
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf) return schema.oneOf.filter((s) => valid(value, s)).length === 1;
  if (schema.type === 'string')
    return typeof value === 'string' && (!schema.pattern || new RegExp(schema.pattern).test(value));
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer')
    return (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= (schema.minimum ?? 0)
    );
  if (schema.type === 'array')
    return Array.isArray(value) && value.every((v) => valid(v, schema.items!));
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>,
      props = schema.properties!;
    return (
      (schema.required ?? []).every((k) => Object.hasOwn(v, k)) &&
      Object.keys(v).every((k) => Object.hasOwn(props, k) && valid(v[k], props[k]!))
    );
  }
  return false;
}
const rowSchemas: Record<Section, string> = {
  lines: 'Line',
  stock_movements: 'StockMovement',
  cash_movements: 'CashMovement',
  allocations: 'Allocation',
  payroll_calculation: 'PayrollCalculation',
  production_components: 'ProductionComponent',
  order_lines: 'OrderLine',
  reservations: 'Reservation',
};
export function decode(value: unknown, id: number, grant: Grant, query?: Query): Header | Page {
  check(valid(value, schemas[query ? 'Page' : 'Header']!));
  const result = value as Header | Page,
    d = result.document,
    c = result.context;
  if (c.role !== grant.role || c.scopeStore !== grant.scopeStore)
    throw new ApiError(403, 'Права або магазин змінилися. Відкрийте розділ заново.');
  check(c.document === id && d.id === id && c.store === d.store.id);
  check(grant.scopeStore === null || grant.scopeStore === d.store.id);
  check(
    new Set(result.sections.map((s) => s.key)).size === result.sections.length &&
      new Set(d.actions).size === d.actions.length,
  );
  const expected: Section[] = ['lines', 'stock_movements', 'cash_movements'];
  if (['payment', 'advance_allocation'].includes(d.kind)) expected.push('allocations');
  if (d.kind === 'payroll') {
    check(['owner', 'accountant'].includes(c.role));
    expected.push('payroll_calculation');
  }
  if (d.kind === 'production') expected.push('production_components');
  if (['purchase_order', 'customer_order'].includes(d.kind)) expected.push('order_lines');
  if (d.kind === 'customer_order') expected.push('reservations');
  check(
    result.sections.length === expected.length &&
      expected.every((k) => result.sections.some((s) => s.key === k)),
  );
  check((d.order !== null) === expected.includes('order_lines'));
  if (c.role === 'cashier') check(d.cost === null);
  if (d.kind === 'expense' && d.expenseScope === 'network')
    check(['owner', 'accountant'].includes(c.role));
  if (query) {
    check('page' in result);
    const p = result.page,
      count = result.sections.find((s) => s.key === query.section)?.total;
    check(
      p.section === query.section &&
        p.limit === query.limit &&
        p.total === count &&
        p.pages === Math.max(1, Math.ceil(p.total / p.limit)) &&
        p.page === Math.min(query.page, p.pages),
    );
    check(
      p.items.length === Math.min(p.limit, Math.max(0, p.total - (p.page - 1) * p.limit)) &&
        new Set(p.items.map((r) => r.id)).size === p.items.length,
    );
    check(p.items.every((r) => valid(r, schemas[rowSchemas[query.section]]!)));
    if (c.role === 'cashier')
      check(
        p.items.every((r) => !('cost' in r) || r.cost === null) &&
          p.items.every((r) => !('value' in r) || r.value === null),
      );
  }
  return result;
}
export function createDocumentApi(transport: typeof fetch = fetch) {
  const client = createApiClient({ transport });
  return {
    async header(id: number, grant: Grant, signal?: AbortSignal) {
      const value = await client.get(`/api/v1/trading/documents/${id}`, (v) => v, signal);
      return decode(value, id, grant) as Header;
    },
    async page(q: Query, grant: Grant, signal?: AbortSignal) {
      const value = await client.get(
        `/api/v1/trading/documents/${q.id}/rows?${new URLSearchParams({ section: q.section, page: String(q.page), limit: String(q.limit) })}`,
        (v) => v,
        signal,
      );
      return decode(value, q.id, grant, q) as Page;
    },
  };
}
export type DocumentApi = ReturnType<typeof createDocumentApi>;
export const decimalText = (value: string) => {
  const [whole = '', fraction] = value.split('.');
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (fraction === undefined ? '' : ',' + fraction)
  );
};
export const positive = (value: string) =>
  /^[0-9]+(?:\.[0-9]+)?$/.test(value) && /[1-9]/.test(value);
