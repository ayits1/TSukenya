import { describe, expect, it } from 'vitest';
import {
  createCustomerApi,
  decodeCustomerPage,
  decodeCustomerProfile,
  emptyCustomerFilters,
} from './api';
import { customerPage, customerProfile } from './fixtures';
import { moneyText } from './CustomerProfile';

describe('customer contracts', () => {
  it('decodes current scope, decimal strings and nullable cashier debt', () => {
    expect(decodeCustomerProfile(customerProfile)).toEqual(customerProfile);
    expect(
      decodeCustomerProfile({ ...customerProfile, debt: null, canEdit: false }).debt,
    ).toBeNull();
    expect(decodeCustomerPage(customerPage).items[0]?.name).toBe('Олена Коваленко');
    expect(moneyText('9999999999999999.99').replace(/\s/g, '')).toBe('9999999999999999,99грн');
  });
  it('rejects numeric money, wrong dates, negative counts and invalid paging', () => {
    for (const purchases of [
      { ...customerProfile.purchases, gross: 50 },
      { ...customerProfile.purchases, first: '2026-02-31' },
      { ...customerProfile.purchases, checks: -1 },
      { ...customerProfile.purchases, averageCheck: null },
      { ...customerProfile.purchases, segment: { toString: () => 'repeat' } },
    ])
      expect(() => decodeCustomerProfile({ ...customerProfile, purchases })).toThrow();
    expect(() =>
      decodeCustomerProfile({
        ...customerProfile,
        debt: { ...customerProfile.debt, outstanding: 62 },
      }),
    ).toThrow();
    expect(() => decodeCustomerPage({ ...customerPage, page: 2 })).toThrow();
    expect(() =>
      decodeCustomerPage({ ...customerPage, items: [{ ...customerPage.items[0], id: '1' }] }),
    ).toThrow();
  });
  it('sends encoded search, exact store and abort signal through the shared client', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const transport: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify(String(input).includes('/customers?') ? customerPage : customerProfile),
      );
    };
    const controller = new AbortController(),
      api = createCustomerApi({ transport });
    await api.list(
      { ...emptyCustomerFilters, q: 'Олена & кави', active: 'yes', store: 1 },
      controller.signal,
    );
    await api.profile(1, 1, controller.signal);
    expect(new URL('http://localhost' + calls[0]?.url).searchParams.get('q')).toBe('Олена & кави');
    expect(calls[1]?.url).toBe('/api/v1/crm/customers/1?store=1');
    expect(calls[0]?.init?.signal).toBe(controller.signal);
    expect(calls[0]?.init?.credentials).toBe('same-origin');
  });
});
