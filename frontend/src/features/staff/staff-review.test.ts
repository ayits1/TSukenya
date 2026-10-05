import { it, expect, vi } from 'vitest';
import { StaffModel } from './state';
import { guardStaffDirectories } from './guard';
import { fixtureApi, fixture, options } from './fixtures';
import { ApiError } from '../../shared/api/client';
import type { DirectoryPage } from '../trading/api';

it('canceled directory read cannot revoke the current Staff workspace', async () => {
  const model = new StaffModel(fixtureApi());
  await model.activate(options);
  let reject!: (error: Error) => void;
  const delayed = new Promise<DirectoryPage>((_resolve, fail) => {
    reject = fail;
  });
  const api = guardStaffDirectories(model, {
    ...options.directoryApi,
    list: vi
      .fn()
      .mockReturnValueOnce(delayed)
      .mockRejectedValueOnce(new ApiError(403, 'Current denied')),
  });
  const request = new AbortController();
  const old = api.list('stores', { purpose: 'filter', q: 'old' }, request.signal);
  const outcome = old.catch((error: unknown) => error);
  request.abort();
  reject(new ApiError(401, 'Obsolete directory search'));
  await outcome;
  expect(model.state.denied).toBe(false);
  expect(model.state.data).not.toBeNull();
  await expect(
    api.list('stores', { purpose: 'filter' }, new AbortController().signal),
  ).rejects.toMatchObject({ status: 403 });
  expect(model.state.denied).toBe(true);
  expect(model.state.data).toBeNull();
});

it('a failed new store does not reuse old committed scope or submit newer draft filters', async () => {
  const api = fixtureApi(),
    model = new StaffModel(api);
  await model.activate({ ...options, store: 1 });
  const read = vi.spyOn(api, 'read').mockRejectedValueOnce(new ApiError(503, 'New store failed'));
  await model.store(2, { id: '2', name: 'Другий магазин' });
  model.edit({ q: 'not yet submitted' });
  const count = read.mock.calls.length;
  await model.refreshCommitted();
  expect(read).toHaveBeenCalledTimes(count);
  expect(model.state.store).toBe(2);
  expect(model.state.data).toBeNull();
  read.mockImplementation(async (resource, query, page) => fixture(resource, query, page, 0));
  await model.search();
  model.edit({ q: 'newer raw' });
  await model.refreshCommitted();
  expect(read.mock.calls.at(-1)?.[1]).toEqual({ store: 2, q: 'not yet submitted' });
  expect(model.state.filters.employees.q).toBe('newer raw');
});
