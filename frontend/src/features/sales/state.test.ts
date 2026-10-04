import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../../shared/api/client';
import { SalesModel } from './state';
import { fixtureApi, options, shifts } from './fixtures';
import type { Documents } from './api';
const delayed = <T>() => {
  let resolve!: (v: T) => void, reject!: (v: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
describe('sales scope, reads and native actions', () => {
  it('list failure blocks actions and a fresh denied policy removes all private data', async () => {
    const api = fixtureApi(),
      model = new SalesModel(api),
      write = vi.fn();
    await model.activate(options);
    api.documents = async () => {
      throw new ApiError(503, 'Збій читання');
    };
    await model.refresh();
    await model.action(write);
    expect(write).not.toHaveBeenCalled();
    expect(model.state.documents).toBeNull();
    api.documents = async (...args) => ({
      ...(await fixtureApi().documents(...args)),
      policy: { ...shifts.policy, role: 'cashier', store: 1 },
    });
    await model.refresh();
    expect(model.state.denied).toBe(true);
    expect(model.state.policy).toBeNull();
    expect(model.state.selectedStore).toBeNull();
  });
  it('ignored abort read cannot repaint left route or clear a newer successful mount', async () => {
    const api = fixtureApi(),
      model = new SalesModel(api),
      late = delayed<Documents>();
    api.documents = () => late.promise;
    const pending = model.activate(options);
    model.leave();
    api.documents = fixtureApi().documents;
    await model.activate(options);
    late.reject(new ApiError(403, 'old denied'));
    await pending;
    expect(model.state.denied).toBe(false);
    expect(model.state.documents?.items.length).toBe(30);
    const late2 = delayed<Documents>();
    api.documents = () => late2.promise;
    const pending2 = model.refresh();
    model.leave();
    late2.resolve(
      await fixtureApi().documents({ q: '', store: null, kind: '', status: '', from: '', to: '' }),
    );
    await pending2;
    expect(model.state.documents).toBeNull();
    expect(model.options).toBeNull();
  });
  it('native close only uses displayed own open shift and does not calculate or post cash', async () => {
    const api = fixtureApi(),
      model = new SalesModel(api),
      close = vi.fn();
    api.documents = async (...args) => ({
      ...(await fixtureApi().documents(...args)),
      policy: { ...shifts.policy, role: 'cashier' },
    });
    api.shifts = async (query) => ({
      ...shifts,
      query,
      policy: { ...shifts.policy, role: 'cashier' },
    });
    await model.activate({
      ...options,
      bootstrap: { ...options.bootstrap, role: 'cashier', username: 'owner' },
      onCloseShift: close,
    });
    await model.change({ view: 'shifts' });
    const row = model.state.shifts!.items[0]!;
    await model.closeShift({ ...row });
    expect(close).not.toHaveBeenCalled();
    await model.closeShift(row);
    expect(close).toHaveBeenCalledExactlyOnceWith(row.id);
    row.openedBy = 'other cashier';
    await model.closeShift(row);
    expect(close).toHaveBeenCalledTimes(1);
    model.leave();
    await model.closeShift(row);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
