import { afterEach, expect, test, vi } from 'vitest';
import { createCatalogApi, emptyFilters } from './api';

afterEach(() => vi.unstubAllGlobals());
test('CSV uses full committed filter and rejects malformed transport without a Blob result', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response('a\n', { headers: { 'Content-Type': 'text/csv', 'Content-Length': '2' } }),
    );
  vi.stubGlobal('fetch', fetchMock);
  const api = createCatalogApi(7);
  expect((await api.exportCsv({ ...emptyFilters, q: 'Кава', page: 4 })).size).toBe(2);
  const url = new URL(fetchMock.mock.calls[0]?.[0] as string, 'http://isolated');
  expect(url.searchParams.get('q')).toBe('Кава');
  expect(url.searchParams.get('store')).toBe('7');
  expect(url.searchParams.has('page')).toBe(false);
  expect(url.searchParams.has('limit')).toBe(false);
  for (const headers of [
    { 'Content-Type': 'application/json', 'Content-Length': '2' },
    { 'Content-Type': 'text/csv', 'Content-Length': '3' },
    { 'Content-Type': 'text/csv', 'Content-Length': '268435457' },
  ]) {
    fetchMock.mockResolvedValueOnce(new Response('a\n', { headers }));
    await expect(api.exportCsv(emptyFilters)).rejects.toThrow();
  }
});
test('ignored-abort CSV transport is refused before producing a usable file', async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      controller.abort();
      return new Response('a\n', {
        headers: { 'Content-Type': 'text/csv', 'Content-Length': '2' },
      });
    }),
  );
  await expect(createCatalogApi().exportCsv(emptyFilters, controller.signal)).rejects.toMatchObject(
    { name: 'AbortError' },
  );
});
