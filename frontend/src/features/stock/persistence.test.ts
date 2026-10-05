import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftStore, PREFIX } from '../../shared/recovery/storage';
import { RecoveryController } from '../../shared/recovery/controller';
import type { DraftSession } from '../../shared/recovery/session';
import { StockModel } from './state';
import type { AssortmentRow } from './api';
import { fixtureApi, options, assortmentRow } from './fixtures';
import { AssortmentRecovery } from './recovery';
import { AssortmentError, createAssortmentRecoveryApi } from './recoveryApi';
import * as codec from './persistence';
const actor: DraftSession = {
  draftOwner: 'a'.repeat(64),
  draftSession: 'b'.repeat(64),
  role: 'owner',
  storeId: null,
  networkOwner: true,
};
class Memory implements Storage {
  values = new Map<string, string>();
  denied = false;
  get length() {
    return this.values.size;
  }
  key(i: number) {
    return [...this.values.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.values.get(k) ?? null;
  }
  removeItem(k: string) {
    this.values.delete(k);
  }
  clear() {
    this.values.clear();
  }
  setItem(k: string, v: string) {
    if (this.denied) throw Error('quota');
    this.values.set(k, v);
  }
}
async function setup(storage = new Memory()) {
  vi.stubGlobal('location', { hash: '#trade/stock' });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  const store = new DraftStore(storage),
    controller = new RecoveryController(store, async () => actor);
  const model = new StockModel(fixtureApi());
  await model.activate(options);
  model.state.captions.set('warehouses:1', { id: '1', name: 'Склад', store_id: 1 });
  model.state.captions.set('warehouses:2', { id: '2', name: 'Другий склад', store_id: 2 });
  let row: AssortmentRow = { ...assortmentRow, revision: null };
  const receipts = new Map<string, unknown>();
  const context = (b: codec.Base): codec.Context => ({
    contract: 'assortment-context-v1',
    warehouse: b.warehouse,
    product: b.row.product,
    store: b.store,
    role: 'owner',
    storeId: null,
    exists: true,
    row: { ...row, product: b.row.product },
  });
  const api = {
    context: vi.fn(async (b: codec.Base) => context(b)),
    current: vi.fn(async (b: codec.Base) => context(b)),
    identity: vi.fn(async (r: codec.Request) => ({
      contract: 'assortment-action-v1',
      key: r.key,
      warehouse: r.warehouse,
      product: r.product,
      confirmed: receipts.has(r.key),
      ...(receipts.has(r.key) ? { original: receipts.get(r.key) } : {}),
    })),
    execute: vi.fn(async (r: codec.Request) => {
      row = {
        ...row,
        sold: r.terms.sold,
        min_stock: r.terms.min_stock === null ? null : Number(r.terms.min_stock).toFixed(3),
        minimum:
          r.terms.min_stock === null ? row.default_min : Number(r.terms.min_stock).toFixed(3),
        revision: 'e'.repeat(32),
      };
      const original = {
        warehouse: r.warehouse,
        product: r.product,
        revision: row.revision,
        sold: row.sold,
        min_stock: row.min_stock,
        unit: r.unit,
      };
      receipts.set(r.key, original);
      return {
        contract: 'assortment-action-v1',
        key: r.key,
        warehouse: r.warehouse,
        product: r.product,
        ok: true,
        original,
      };
    }),
  };
  const manager = new AssortmentRecovery(
    model,
    { store, controller, register: (c) => store.register(c), close: vi.fn(), open: vi.fn() },
    api,
  );
  model.persistence = manager;
  model.requireRecovery = true;
  await manager.indexRows(1, [row]);
  await manager.indexRows(2, [row]);
  await manager.activate();
  const id = await codec.recordId(1, row.product),
    id2 = await codec.recordId(2, row.product);
  const saved = () => JSON.parse(storage.getItem(PREFIX + id)!).payload;
  return { manager, model, store, controller, storage, api, receipts, row, id, id2, saved };
}
afterEach(() => vi.unstubAllGlobals());
describe('Assortment durable pairs', () => {
  it('captures invalid raw synchronously, two warehouses independently; cold entry is an explicit offer', async () => {
    const a = await setup();
    a.manager.edit(1, a.row, { minimum: '1,' });
    a.manager.edit(2, a.row, { minimum: 'invalid' });
    expect(codec.raw(a.saved().draft).minimum).toBe('1,');
    expect(a.storage.length).toBe(2);
    expect(a.api.execute).not.toHaveBeenCalled();
    a.manager.leave();
    const b = await setup(a.storage);
    expect(b.model.state.drafts.size).toBe(0);
    expect(b.model.state.recovery.offers).toHaveLength(2);
    b.manager.edit(1, b.row, { minimum: 'overwriting' });
    expect(codec.raw(b.saved().draft).minimum).toBe('1,');
    await b.manager.restore(b.id);
    expect(b.model.state.drafts.get('1:' + b.row.product)?.minimum).toBe('1,');
    expect(codec.baseline(b.saved().baseline).review).toBe(true);
    expect(b.api.execute).not.toHaveBeenCalled();
  });
  it('strict raw/intent/confirmation whitelist rejects mismatched target and coerced method', async () => {
    const a = await setup();
    a.manager.edit(1, a.row, { minimum: '2.5' });
    a.api.execute.mockRejectedValueOnce(Error('lost'));
    await a.manager.save(1, a.row.product);
    const p = a.saved();
    for (const broken of [
      { ...p, draft: { ...p.draft, products: [] } },
      { ...p, firstIntent: { ...p.firstIntent, method: ['POST'] } },
      { ...p, firstIntent: { ...p.firstIntent, body: { ...p.firstIntent.body, warehouse: 2 } } },
      { ...p, firstIntent: { ...p.firstIntent, body: { ...p.firstIntent.body, unit: 'шт' } } },
    ])
      expect(() => codec.decodePayload(broken)).toThrow();
    a.manager.edit(1, a.row, { minimum: '' });
    expect(a.saved().firstIntent).toEqual(p.firstIntent);
    a.manager.apply('1:' + a.row.product, { sold: false, min_stock: '7' });
    expect(a.saved().firstIntent).toEqual(p.firstIntent);
  });
  it('positive identity persists before current503; reload keeps newer invalid input and cannot repeat POST', async () => {
    const a = await setup();
    a.manager.edit(1, a.row, { minimum: '2.5' });
    const commit = a.api.execute.getMockImplementation()!;
    a.api.execute.mockImplementationOnce(async (r) => {
      await commit(r);
      throw Error('lost ACK');
    });
    await a.manager.save(1, a.row.product);
    const original = a.saved().firstIntent;
    a.manager.edit(1, a.row, { minimum: 'unfinished,' });
    a.manager.leave();
    const b = await setup(a.storage);
    b.api.identity.mockImplementation(a.api.identity.getMockImplementation()!);
    b.api.current.mockRejectedValueOnce(Error('current503'));
    await b.manager.restore(b.id);
    expect(b.saved().firstIntent).toBeNull();
    expect(b.saved().confirmation.key).toBe(original.key);
    expect(codec.raw(b.saved().draft).minimum).toBe('unfinished,');
    b.manager.leave();
    const c = await setup(a.storage);
    await c.manager.restore(c.id);
    expect(c.api.identity).not.toHaveBeenCalled();
    expect(c.api.execute).not.toHaveBeenCalled();
    expect(c.model.state.drafts.get('1:' + c.row.product)?.minimum).toBe('unfinished,');
  });
  it('first rollback409 retires durably; Apply is one write and Save uses a new UUID', async () => {
    const a = await setup();
    a.manager.edit(1, a.row, { minimum: '3' });
    a.api.execute.mockImplementationOnce(async (r) => {
      throw new AssortmentError(409, 'revision', 'revision_conflict', {
        error: 'revision',
        code: 'revision_conflict',
        contract: 'assortment-action-v1',
        key: r.key,
        warehouse: r.warehouse,
        product: r.product,
        write_rejected: true,
      });
    });
    await a.manager.save(1, a.row.product);
    const first = a.api.execute.mock.calls[0]![0].key;
    expect(a.saved().firstIntent).toBeNull();
    expect(codec.baseline(a.saved().baseline).review).toBe(true);
    await a.manager.compare(1, a.row.product);
    const before = a.storage.getItem(PREFIX + a.id);
    a.storage.denied = true;
    a.manager.apply('1:' + a.row.product, { sold: true, min_stock: '3' });
    expect(a.storage.getItem(PREFIX + a.id)).toBe(before);
    expect(codec.baseline(a.saved().baseline).review).toBe(true);
    a.storage.denied = false;
    const writes = vi.spyOn(a.storage, 'setItem');
    a.manager.apply('1:' + a.row.product, { sold: true, min_stock: '3' });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(a.api.execute).toHaveBeenCalledTimes(1);
    await a.manager.save(1, a.row.product);
    expect(a.api.execute.mock.calls[1]![0].key).not.toBe(first);
  });
  it('quota retains newly typed raw in memory and prevents transport until durable capture succeeds', async () => {
    const a = await setup();
    a.storage.denied = true;
    a.manager.edit(1, a.row, { minimum: '5,' });
    expect(a.model.state.drafts.get('1:' + a.row.product)?.minimum).toBe('5,');
    await a.manager.save(1, a.row.product);
    expect(a.api.execute).not.toHaveBeenCalled();
    a.storage.denied = false;
    a.manager.edit(1, a.row, { minimum: '5.25' });
    expect(codec.raw(a.saved().draft).minimum).toBe('5.25');
  });
  it('pending write allows newer raw; ACK confirms original without adopting or clearing newer values', async () => {
    const a = await setup();
    a.manager.edit(1, a.row, { minimum: '2' });
    let release!: () => void;
    const commit = a.api.execute.getMockImplementation()!;
    a.api.execute.mockImplementationOnce(async (r) => {
      await new Promise<void>((r) => (release = r));
      return commit(r);
    });
    const running = a.manager.save(1, a.row.product);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(a.model.state.recovery.ready).toBe(true);
    a.manager.edit(1, a.row, { minimum: 'later invalid' });
    release();
    await running;
    expect(codec.raw(a.saved().draft).minimum).toBe('later invalid');
    expect(a.saved().firstIntent).toBeNull();
    expect(codec.baseline(a.saved().baseline).review).toBe(true);
  });
  it('current read after ACK keeps raw typed during that last await', async () => {
    const a = await setup();
    a.manager.edit(1, a.row, { minimum: '2' });
    let release!: () => void;
    const current = a.api.current.getMockImplementation()!;
    a.api.current.mockImplementationOnce(async (b) => {
      await new Promise<void>((r) => (release = r));
      return current(b);
    });
    const running = a.manager.save(1, a.row.product);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(a.saved().firstIntent).toBeNull();
    a.manager.edit(1, a.row, { minimum: 'typed after ACK,' });
    release();
    await running;
    expect(codec.raw(a.saved().draft).minimum).toBe('typed after ACK,');
    expect(a.saved().confirmation).not.toBeNull();
  });
  it('a workspace denial during a held write prevents late ACK adoption', async () => {
    const a = await setup();
    a.manager.edit(1, a.row, { minimum: '2' });
    let release!: () => void;
    const commit = a.api.execute.getMockImplementation()!;
    a.api.execute.mockImplementationOnce(async (r) => {
      await new Promise<void>((r) => (release = r));
      return commit(r);
    });
    const running = a.manager.save(1, a.row.product);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const original = a.saved().firstIntent;
    a.model.deny('Fresh policy denied the workspace');
    release();
    await running;
    expect(a.saved().firstIntent).toEqual(original);
    expect(a.saved().confirmation).toBeNull();
    expect(a.api.current).not.toHaveBeenCalled();
  });
  it('off-page raw keeps its original warehouse store when captions are no longer on the current page', async () => {
    const a = await setup();
    a.manager.edit(1, a.row, { minimum: '2' });
    a.model.state.captions.clear();
    a.manager.edit(1, a.row, { minimum: 'off-page newer raw,' });
    expect(codec.raw(a.saved().draft).minimum).toBe('off-page newer raw,');
    expect(codec.baseline(a.saved().baseline).store).toBe(1);
  });
  it('API handles nonJSON current401/403 and allowed-actor changes; cancelled last session sends zero business POST', async () => {
    const controller = new AbortController(),
      f = { signal: controller.signal, current: () => true, session: actor };
    const session = () => new Response(JSON.stringify({ ...actor, csrf: 'local' }));
    const b: codec.Base = {
      recordId: 'assortment_' + 'a'.repeat(64),
      warehouse: 1,
      store: 1,
      row: assortmentRow,
      review: false,
    };
    for (const status of [401, 403]) {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(session())
        .mockResolvedValueOnce(new Response('html', { status }));
      await expect(createAssortmentRecoveryApi(transport).current(b, f)).rejects.toMatchObject({
        status,
      });
    }
    const changed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...actor, csrf: 'local', draftOwner: 'c'.repeat(64) })),
      );
    await expect(createAssortmentRecoveryApi(changed).current(b, f)).rejects.toMatchObject({
      status: 403,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    const late = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      return session();
    });
    await expect(createAssortmentRecoveryApi(late).current(b, f)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(late).toHaveBeenCalledTimes(1);
  });
  it('later bound409 cannot retire an earlier unknown request even with invalid newer raw', async () => {
    const a = await setup();
    a.manager.edit(1, a.row, { minimum: '2' });
    a.api.execute.mockRejectedValueOnce(Error('unknown before ACK'));
    await a.manager.save(1, a.row.product);
    const frozen = a.saved().firstIntent;
    a.manager.edit(1, a.row, { minimum: 'invalid' });
    a.api.execute.mockImplementationOnce(async (r) => {
      throw new AssortmentError(409, 'stale', 'revision_conflict', {
        error: 'stale',
        code: 'revision_conflict',
        write_rejected: true,
        contract: 'assortment-action-v1',
        key: r.key,
        warehouse: r.warehouse,
        product: r.product,
      });
    });
    await a.manager.save(1, a.row.product);
    expect(a.saved().firstIntent).toEqual(frozen);
    expect(codec.raw(a.saved().draft).minimum).toBe('invalid');
    expect(a.api.execute.mock.calls[1]![0]).toEqual(a.api.execute.mock.calls[0]![0]);
  });
});
