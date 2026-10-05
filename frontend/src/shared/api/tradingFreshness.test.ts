import { describe, it, expect, vi } from 'vitest';
import { SalesModel } from '../../features/sales/state';
import { PurchasesModel } from '../../features/purchases/state';
import { FinanceModel } from '../../features/finance/state';
import { StaffModel } from '../../features/staff/state';
import { fixtureApi as salesApi, options as salesOptions } from '../../features/sales/fixtures';
import {
  fixtureApi as purchasesApi,
  options as purchasesOptions,
} from '../../features/purchases/fixtures';
import {
  fixtureApi as financeApi,
  options as financeOptions,
} from '../../features/finance/fixtures';
import { fixtureApi as staffApi, options as staffOptions } from '../../features/staff/fixtures';
import { ApiError } from './client';

describe('Remote refresh uses confirmed filters without discarding newer raw input', () => {
  it('purchases distinguishes an unchanged committed query from an unsubmitted filter', async () => {
    const api = purchasesApi(),
      model = new PurchasesModel(api);
    await model.activate(purchasesOptions);
    expect(model.hasFilterDraft()).toBe(false);
    model.edit({ q: 'new unsubmitted supplier' });
    expect(model.hasFilterDraft()).toBe(true);
    await model.search();
    expect(model.hasFilterDraft()).toBe(false);
    model.leave();
  });

  it('sales/purchases preserve committed query even after read failure and retry', async () => {
    const sale = salesApi(),
      sales = new SalesModel(sale);
    await sales.activate(salesOptions);
    sales.edit({ q: 'committed' });
    await sales.search();
    const salesRead = vi.spyOn(sale, 'documents');
    sales.edit({ q: 'newer invalid raw', from: 'unparsed' });
    salesRead.mockRejectedValueOnce(new ApiError(503, 'read failed'));
    await sales.refreshCommitted();
    expect(sales.state.q).toBe('newer invalid raw');
    await sales.refreshCommitted();
    expect(salesRead.mock.calls.at(-1)?.[0].q).toBe('committed');
    expect(salesRead.mock.calls.at(-1)?.[0].from).toBe('');
    expect(sales.state.from).toBe('unparsed');
    const purchase = purchasesApi(),
      purchases = new PurchasesModel(purchase);
    await purchases.activate(purchasesOptions);
    purchases.edit({ q: 'supplier submitted' });
    await purchases.search();
    const purchaseRead = vi.spyOn(purchase, 'documents');
    purchases.edit({ q: 'newer filter' });
    purchaseRead.mockRejectedValueOnce(new ApiError(503, 'read failed'));
    await purchases.refreshCommitted();
    await purchases.refreshCommitted();
    expect(purchaseRead.mock.calls.at(-1)?.[0].q).toBe('supplier submitted');
    expect(purchases.state.q).toBe('newer filter');
  });
  it('finance/staff keep lastconfirmed context; denied and leaving erase private committed maps', async () => {
    const finance = financeApi(),
      model = new FinanceModel(finance);
    await model.activate(financeOptions);
    model.edit({ q: 'confirmed account' });
    await model.search();
    const read = vi.spyOn(finance, 'read');
    model.edit({ q: 'draft account' });
    read.mockRejectedValueOnce(new ApiError(503, 'read failed'));
    await model.refreshCommitted();
    await model.refreshCommitted();
    expect(read.mock.calls.at(-1)?.[1]).toEqual({ q: 'confirmed account', store: null });
    expect(model.state.filters.accounts.q).toBe('draft account');
    model.deny('revoked');
    expect(model.state.data).toBeNull();
    await model.activate(financeOptions);
    expect(read.mock.calls.at(-1)?.[1]).toEqual({ q: '', store: null });
    const staff = staffApi(),
      team = new StaffModel(staff);
    await team.activate(staffOptions);
    team.edit({ q: 'confirmed person' });
    await team.search();
    const staffRead = vi.spyOn(staff, 'read');
    team.edit({ q: 'newer raw person' });
    team.allowPolicyRefresh();
    await team.refreshCommitted();
    expect(staffRead.mock.calls.at(-1)?.[1]).toEqual({ q: 'confirmed person', store: null });
    expect(team.state.filters.employees.q).toBe('newer raw person');
    team.leave();
    expect(team.state.data).toBeNull();
  });
  it('store change + GET503 never reuses rows or confirmed queries from the old store', async () => {
    const api = financeApi(),
      model = new FinanceModel(api);
    await model.activate(financeOptions);
    model.edit({ q: 'private old-store filter' });
    await model.search();
    const read = vi.spyOn(api, 'read');
    read.mockRejectedValueOnce(new ApiError(503, 'new-store unavailable'));
    await model.store(2, null);
    expect(model.state.store).toBe(2);
    expect(model.state.data).toBeNull();
    const calls = read.mock.calls.length;
    await model.refreshCommitted();
    expect(read.mock.calls.length).toBe(calls);
    const staff = staffApi(),
      team = new StaffModel(staff);
    await team.activate(staffOptions);
    team.edit({ q: 'private previous person' });
    await team.search();
    team.edit({ q: 'newer invalid raw' });
    expect(team.hasFilterDraft()).toBe(true);
    const staffRead = vi.spyOn(staff, 'read');
    staffRead.mockRejectedValueOnce(new ApiError(503, 'new-store unavailable'));
    await team.store(2, null);
    expect(team.state.data).toBeNull();
    const staffCalls = staffRead.mock.calls.length;
    await team.refreshCommitted();
    expect(staffRead.mock.calls.length).toBe(staffCalls);
    expect(team.state.filters.employees.q).toBe('');
  });
  it('server JSON member order does not invent a dirty filter on cash shifts', async () => {
    const api = salesApi(),
      original = api.shifts;
    api.shifts = async (...args) => {
      const result = await original(...args);
      return {
        ...result,
        query: {
          to: result.query.to,
          from: result.query.from,
          status: result.query.status,
          employee: result.query.employee,
          store: result.query.store,
        },
      };
    };
    const model = new SalesModel(api);
    await model.activate(salesOptions);
    await model.change({ view: 'shifts' });
    expect(model.hasFilterDraft()).toBe(false);
    const read = vi.spyOn(api, 'shifts');
    await model.refreshCommitted();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
