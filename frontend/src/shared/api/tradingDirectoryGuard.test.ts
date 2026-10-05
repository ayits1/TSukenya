import { describe, it, expect, vi } from 'vitest';
import { guardTradingDirectories } from './tradingDirectoryGuard';
import { ApiError } from './client';
import { StockModel } from '../../features/stock/state';
import { FinanceModel } from '../../features/finance/state';
import { SalesModel } from '../../features/sales/state';
import { PurchasesModel } from '../../features/purchases/state';
import { fixtureApi as stockApi, options as stockOptions } from '../../features/stock/fixtures';
import {
  fixtureApi as financeApi,
  options as financeOptions,
} from '../../features/finance/fixtures';
import { fixtureApi as salesApi, options as salesOptions } from '../../features/sales/fixtures';
import {
  fixtureApi as purchasesApi,
  options as purchasesOptions,
} from '../../features/purchases/fixtures';

const cases = [
  {
    name: 'Stock',
    activate: async () => {
      const model = new StockModel(stockApi());
      await model.activate(stockOptions);
      return model;
    },
  },
  {
    name: 'Finance',
    activate: async () => {
      const model = new FinanceModel(financeApi());
      await model.activate(financeOptions);
      return model;
    },
  },
  {
    name: 'Sales',
    activate: async () => {
      const model = new SalesModel(salesApi());
      await model.activate(salesOptions);
      return model;
    },
  },
  {
    name: 'Purchases',
    activate: async () => {
      const model = new PurchasesModel(purchasesApi());
      await model.activate(purchasesOptions);
      return model;
    },
  },
];
describe.each(cases)('$name directory authorization guard', ({ activate }) => {
  it('ignored-abort old bootstrap401 preserves current workspace, current403 still hides it', async () => {
    const model = await activate();
    const confirmed = model.state;
    let reject!: (error: Error) => void;
    const delayed = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const api = guardTradingDirectories(model, {
      ...stockOptions.directoryApi,
      bootstrap: vi
        .fn()
        .mockReturnValueOnce(delayed)
        .mockRejectedValueOnce(new ApiError(403, 'Current denied')),
    });
    const controller = new AbortController();
    const old = api.bootstrap(controller.signal).catch((error: unknown) => error);
    controller.abort();
    reject(new ApiError(401, 'Obsolete issued401'));
    await old;
    expect(model.state.denied).toBe(false);
    expect(model.state).toBe(confirmed);
    await expect(api.bootstrap(new AbortController().signal)).rejects.toMatchObject({
      status: 403,
    });
    expect(model.state.denied).toBe(true);
  });
  it('current401 hides, but late directory details403 after leave does not deny a new lifecycle', async () => {
    const model = await activate();
    let reject!: (error: Error) => void;
    const delayed = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const api = guardTradingDirectories(model, {
      ...stockOptions.directoryApi,
      details: vi.fn().mockReturnValueOnce(delayed),
      bootstrap: vi.fn().mockRejectedValueOnce(new ApiError(401, 'Current401')),
    });
    const deny = vi.spyOn(model, 'deny');
    const old = api.details([], {}, new AbortController().signal).catch((error: unknown) => error);
    model.leave();
    reject(new ApiError(403, 'Old lifecycle403'));
    await old;
    expect(deny).not.toHaveBeenCalled();
    const current = await activate();
    const live = guardTradingDirectories(current, {
      ...stockOptions.directoryApi,
      bootstrap: api.bootstrap,
    });
    await expect(live.bootstrap(new AbortController().signal)).rejects.toMatchObject({
      status: 401,
    });
    expect(current.state.denied).toBe(true);
  });
});
