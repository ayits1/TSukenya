import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../../shared/api/client';
import { PurchasesModel } from './state';
import { fixtureApi, options, group } from './fixtures';
import type { Documents } from './api';
const delayed = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
describe('purchases lifetime and callbacks', () => {
  it('propagates required refresh failure and clears private results on fresh policy drift', async () => {
    const api = fixtureApi(),
      model = new PurchasesModel(api);
    await model.activate(options);
    expect(model.state.documents?.total).toBe(67);
    api.documents = async () => {
      throw new ApiError(503, 'unavailable');
    };
    await model.refresh();
    expect(model.state.documents).toBeNull();
    expect(model.state.error).toBe('unavailable');
    api.documents = async (...args) => ({
      ...(await fixtureApi().documents(...args)),
      policy: {
        role: 'warehouse',
        store: 1,
        documentKinds: ['purchase_order', 'receipt', 'supplier_return'],
      },
    });
    await model.refresh();
    expect(model.state.denied).toBe(true);
    expect(model.state.policy).toBeNull();
    expect(model.state.selectedStore).toBeNull();
  });
  it('ignored abort old403 cannot erase a newer successful mount', async () => {
    const api = fixtureApi(),
      model = new PurchasesModel(api),
      slow = delayed<Documents>();
    api.documents = () => slow.promise;
    const old = model.activate(options);
    api.documents = fixtureApi().documents;
    await model.activate(options);
    slow.reject(new ApiError(403, 'old forbidden'));
    await old;
    expect(model.state.denied).toBe(false);
    expect(model.state.documents?.items).toHaveLength(30);
  });
  it('changed group never opens partial draft; route leave fences delayed preparation', async () => {
    const api = fixtureApi(),
      onReplenishment = vi.fn(),
      model = new PurchasesModel(api);
    await model.activate({ ...options, onReplenishment });
    await model.change({ view: 'replenishment' });
    api.draft = async () => {
      throw new ApiError(409, 'Група змінилася', 'replenishment_changed');
    };
    await model.prepare(group, 2);
    expect(onReplenishment).not.toHaveBeenCalled();
    expect(model.state.error).toContain('змінилася');
    const pending = delayed<Awaited<ReturnType<typeof api.draft>>>();
    api.draft = () => pending.promise;
    const start = model.prepare(group, 1);
    model.leave();
    pending.resolve(await fixtureApi().draft({ q: '', store: null, warehouse: null }, group, 1));
    await start;
    expect(onReplenishment).not.toHaveBeenCalled();
    expect(model.state.groups).toBeNull();
  });
  it('prepares explicit second part from the displayed query, preserving native callback and no local write', async () => {
    const api = fixtureApi(),
      prepare = vi.spyOn(api, 'draft'),
      onReplenishment = vi.fn(),
      model = new PurchasesModel(api);
    await model.activate({ ...options, onReplenishment });
    await model.change({ view: 'replenishment' });
    model.edit({ q: 'new unsubmitted query' });
    await model.prepare(group, 2);
    expect(prepare.mock.calls[0]?.[0].q).toBe('');
    expect(onReplenishment.mock.calls[0]?.[0].lines).toHaveLength(5);
    expect(model.state.prepared.has(group.binding + ':2')).toBe(true);
    expect(model.state.groups?.summary.lines).toBe(205);
  });
});
