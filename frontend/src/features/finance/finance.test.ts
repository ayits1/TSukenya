import { describe, it, expect, vi } from 'vitest';
import { FinanceModel } from './state';
import { decodePage, createFinanceApi, moneyText } from './api';
import { fixture, fixtureApi, options, policy } from './fixtures';
import { ApiError } from '../../shared/api/client';
const query = { q: '', store: null };
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { resolve, reject, promise };
};
describe('Finance authoritative read boundary', () => {
  it('preserves very large cents and refuses malformed counts/private policies/resources', () => {
    const valid = fixture('accounts', query);
    expect(decodePage(valid, 'accounts', query).items[0]?.balance).toBe('99999999999999.99');
    expect(moneyText('99999999999999.99')).toBe('99 999 999 999 999,99');
    expect(moneyText('-19999999999998.98')).toBe('-19 999 999 999 998,98');
    for (const patch of [
      { pages: 2 },
      { total: 2 },
      { items: [{ ...valid.items[0], revision: null }] },
      { items: [{ ...valid.items[0], store: 2 }], policy: { ...policy, store: 1 } },
      { items: [{ ...valid.items[0], balance: 1 }] },
      { query: { q: 'foreign', store: null } },
    ])
      expect(() => decodePage({ ...valid, ...patch }, 'accounts', query)).toThrow(ApiError);
    const ledger = fixture('ledger', { q: '', store: null, account: null, from: '', to: '' });
    expect(() =>
      decodePage(
        { ...ledger, items: [{ ...ledger.items[0], note: 'x'.repeat(4001) }] },
        'ledger',
        ledger.query,
      ),
    ).toThrow(ApiError);
  });
  it('late read401 after a newer response cannot deny or replace current data', async () => {
    const api = fixtureApi(),
      model = new FinanceModel(api);
    await model.activate(options);
    const old = deferred<ReturnType<typeof fixture<'accounts'>>>();
    api.read = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => Promise.resolve(fixture('accounts', query)));
    const first = model.refresh();
    await model.refresh();
    old.reject(new ApiError(401, 'Old session'));
    await first;
    expect(model.state.denied).toBe(false);
    expect(model.state.data?.items).toHaveLength(1);
  });
  it('current role mismatch and callback403 remove all private data, captions and actions', async () => {
    const api = fixtureApi(),
      model = new FinanceModel(api);
    await model.activate({
      ...options,
      onViewDocument: async () => {
        throw new ApiError(403, 'Revoked');
      },
    });
    await model.action(() => model.options!.onViewDocument(1));
    expect(model.state.denied).toBe(true);
    expect(model.state.data).toBeNull();
    expect(model.state.policy).toBeNull();
    expect(model.state.filters.accounts.q).toBe('');
    await model.activate(options);
    api.read = vi.fn().mockResolvedValue({
      ...fixture('accounts', query),
      policy: { ...policy, role: 'manager', canManageAccounts: false },
    });
    await model.refresh();
    expect(model.state.denied).toBe(true);
  });
  it('new context503 clears previous result and retries only GET with exact query', async () => {
    const api = fixtureApi(),
      model = new FinanceModel(api);
    await model.activate(options);
    model.edit({ q: 'local input' });
    api.read = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'Unavailable'))
      .mockImplementationOnce((r, q, p) => fixture(r, q, p));
    await model.search();
    expect(model.state.data).toBeNull();
    expect(model.state.filters.accounts.q).toBe('local input');
    expect(model.ready()).toBe(false);
    await model.refresh();
    expect(model.state.data?.query).toEqual({ q: 'local input', store: null });
    expect(api.read).toHaveBeenCalledTimes(2);
  });
  it('callback late401 and scoped reload cannot clear new workspace', async () => {
    const api = fixtureApi(),
      model = new FinanceModel(api),
      gate = deferred<void>();
    await model.activate({ ...options, onViewDocument: () => gate.promise });
    const action = model.action(() => model.options!.onViewDocument(1));
    model.leave();
    await model.activate(options);
    gate.reject(new ApiError(401, 'Old callback'));
    await action;
    expect(model.state.denied).toBe(false);
    expect(model.state.actionBusy).toBe(false);
    expect(model.state.data).not.toBeNull();
  });
  it('JSON200 protocol and error codes stay distinct, transport is readonly/no-store', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('{broken', { status: 200 }));
    const api = createFinanceApi(transport);
    await expect(api.read('accounts', query)).rejects.toMatchObject({
      code: 'protocol',
      status: 200,
    });
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
    });
    transport.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Blocked', code: 'closed_period' }), { status: 403 }),
    );
    await expect(api.read('accounts', query)).rejects.toMatchObject({
      code: 'closed_period',
      status: 403,
    });
  });
  it('native action bridge receives the captured opener while duplicate action stays blocked', async () => {
    const model = new FinanceModel(fixtureApi()),
      gate = deferred<void>();
    const opener = {} as Element;
    const call = vi.fn(async () => {
      await gate.promise;
    });
    const bridge = vi.fn(async (action: () => void | Promise<void>, target?: Element) => {
      expect(target).toBe(opener);
      expect(model.state.actionBusy).toBe(true);
      await action();
    });
    await model.activate({ ...options, runNativeAction: bridge });
    const first = model.action(call, opener);
    await model.action(call, opener);
    expect(call).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
    expect(model.state.actionBusy).toBe(false);
  });
});
