import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../../shared/api/client';
import { decode, createDocumentApi, decimalText, type Query, type Page } from './api';
import { fixture, fixturePage, api } from './fixtures';
import { DocumentModel } from './state';
const grant = { role: 'owner' as const, scopeStore: null },
  q: Query = { id: 1, section: 'lines', page: 2, limit: 30 };
describe('bounded document contract', () => {
  it('binds exact header/section/fullcounts and rejects mask/header substitution', () => {
    const page = fixturePage(q);
    expect(decode(page, 1, grant, q)).toEqual(page);
    for (const mutate of [
      (p: Page) => {
        p.document.store.id = 2;
      },
      (p: Page) => {
        p.page.total = 5;
      },
      (p: Page) => {
        p.page.section = 'cash_movements';
      },
      (p: Page) => {
        p.document.actions.push('edit');
        p.document.actions.push('edit');
      },
      (p: Page) => {
        Object.assign(p.context, { role: ['owner'] });
      },
      (p: Page) => {
        Object.assign(p.document, { payload: {} });
      },
    ]) {
      const invalid = structuredClone(page);
      mutate(invalid);
      expect(() => decode(invalid, 1, grant, q)).toThrow();
    }
  });
  it('preserves current grant denial from a readable 200 outside the generic client decoder', async () => {
    for (const context of [
      { role: 'cashier' as const, scopeStore: null },
      { role: 'owner' as const, scopeStore: 2 },
    ]) {
      const response = structuredClone(fixture);
      Object.assign(response.context, context);
      const transport = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
      await expect(createDocumentApi(transport).header(1, grant)).rejects.toMatchObject({
        status: 403,
      });
    }
  });
  it('keeps decimal display exact for unit price and money above Number precision', () => {
    expect(decimalText('12.3456')).toBe('12,3456');
    expect(decimalText('999999999999999.99')).toBe('999 999 999 999 999,99');
  });
  it('clears current rows/actions on 503 and retries only chosen page', async () => {
    const header = vi.fn(),
      read = vi
        .fn()
        .mockRejectedValueOnce(new ApiError(503, 'retry'))
        .mockImplementation(fixturePage),
      model = new DocumentModel({
        initial: fixture,
        api: { ...api, page: read },
        grant: async () => grant,
        isCurrent: () => true,
        onHeader: header,
        onDenied: vi.fn(),
      });
    await model.read(q);
    expect(model.snapshot().data).toBeNull();
    expect(header).toHaveBeenCalledWith(null);
    await model.read();
    expect(read.mock.calls.map((c) => c[0])).toEqual([q, q]);
    expect(model.snapshot().data?.page.page).toBe(2);
  });
  it('ignores closed late401 and fences final fresh identity before reveal', async () => {
    let reject!: (e: unknown) => void;
    const denied = vi.fn(),
      header = vi.fn(),
      model = new DocumentModel({
        initial: fixture,
        api: {
          ...api,
          page: () =>
            new Promise((_, r) => {
              reject = r;
            }),
        },
        grant: async () => grant,
        isCurrent: () => true,
        onHeader: header,
        onDenied: denied,
      });
    const pending = model.read(q);
    await Promise.resolve();
    model.cancel();
    reject(new ApiError(401, 'late'));
    await pending;
    expect(denied).not.toHaveBeenCalled();
    const fresh = vi
        .fn()
        .mockResolvedValueOnce(grant)
        .mockRejectedValueOnce(new ApiError(403, 'changed')),
      current = new DocumentModel({
        initial: fixture,
        api,
        grant: fresh,
        isCurrent: () => true,
        onHeader: header,
        onDenied: denied,
      });
    await current.read(q);
    expect(current.snapshot().data).toBeNull();
    expect(denied).toHaveBeenCalledOnce();
  });
  it('completion barrier calls independent full reader and final current grant, never page DTO', async () => {
    const fresh = vi.fn(async () => grant),
      m = new DocumentModel({
        initial: fixture,
        api,
        grant: fresh,
        isCurrent: () => true,
        onHeader: vi.fn(),
        onDenied: vi.fn(),
      });
    await m.read(q);
    const raw = { lines: [1, 2], payload: { exact: 'source' } },
      reader = vi.fn(async () => raw);
    expect(await m.confirmedRead(reader)).toBe(raw);
    expect(fresh).toHaveBeenCalledTimes(4);
    await expect(
      m.confirmedRead(async () => {
        throw new ApiError(503, 'read failed');
      }),
    ).rejects.toThrow('read failed');
    expect(m.snapshot().data).not.toBeNull();
  });
  it('dispatches native actions only for a ready, live current document', async () => {
    const callback = vi.fn(),
      target = {} as Element;
    const model = new DocumentModel({
      initial: fixture,
      api,
      grant: async () => grant,
      isCurrent: () => true,
      onHeader: () => {},
      onDenied: () => {},
      onNativeAction: callback,
    });
    model.nativeAction(target);
    expect(callback).not.toHaveBeenCalled();
    await model.read();
    model.nativeAction(target);
    expect(callback).toHaveBeenCalledExactlyOnceWith(target);
    model.cancel();
    model.nativeAction(target);
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it('allows another child selection from the live ready host after a child invalidates old reads', async () => {
    let readCurrent = true,
      hostCurrent = true;
    const callback = vi.fn(),
      target = {} as Element;
    const model = new DocumentModel({
      initial: fixture,
      api,
      grant: async () => grant,
      isCurrent: () => readCurrent,
      isActionCurrent: () => hostCurrent,
      onHeader: () => {},
      onDenied: () => {},
      onNativeAction: callback,
    });
    await model.read();
    readCurrent = false;
    model.nativeAction(target);
    expect(callback).toHaveBeenCalledExactlyOnceWith(target);
    hostCurrent = false;
    model.nativeAction(target);
    expect(callback).toHaveBeenCalledTimes(1);
    hostCurrent = true;
    model.cancel();
    model.nativeAction(target);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
