import { describe, expect, it } from 'vitest';
import { DraftStore, PREFIX, type Codec, type Payload } from './storage';
import { decodeDraftSession, type DraftSession } from './session';
import { RecoveryController } from './controller';
class Memory implements Storage {
  values = new Map<string, string>();
  denied = false;
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(k: string) {
    return this.values.get(k) ?? null;
  }
  key(i: number) {
    return [...this.values.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.values.delete(k);
  }
  setItem(k: string, v: string) {
    if (this.denied) throw Error('quota');
    this.values.set(k, v);
  }
}
const session: DraftSession = {
  draftOwner: 'a'.repeat(64),
  draftSession: 'b'.repeat(64),
  role: 'owner',
  storeId: null,
  networkOwner: true,
};
const draft: Payload = {
  baseline: { revision: 'a'.repeat(32) },
  draft: { amount: '-', title: '' },
  firstIntent: null,
  confirmation: null,
};
const intent: Payload = {
  ...draft,
  firstIntent: {
    method: 'POST',
    path: '/api/tasks',
    key: 'frozen-key',
    body: { title: 'Первісна задача' },
    revision: null,
    possiblySent: true,
  },
};
function setup() {
  const storage = new Memory(),
    restored: Payload[] = [];
  const codec: Codec = {
    name: 'synthetic',
    version: 1,
    label: 'Торгова чернетка',
    decode: (value) => value as Payload,
    authorize: async () => true,
    restore: (value) => restored.push(value),
    suspend: () => {},
    confirm: (value, ack) => {
      if (ack !== 'strict-confirmed') throw Error('ACK');
      return { ...value, firstIntent: null, confirmation: { id: 'confirmed' } };
    },
  };
  const store = new DraftStore(storage);
  store.register(codec);
  store.bind(session);
  return { store, storage, codec, restored };
}
describe('reload draft foundation', () => {
  it('strict binding strips credentials and refuses missing or invalid current context', () => {
    expect(decodeDraftSession({ ...session, csrf: 'never-store' })).toEqual(session);
    for (const bad of [
      { ...session, csrf: '' },
      { ...session, draftSession: undefined, csrf: 'x' },
      { ...session, role: 'cashier', csrf: 'x' },
      { ...session, storeId: 0, csrf: 'x' },
    ])
      expect(() => decodeDraftSession(bad)).toThrow();
  });
  it('hard storage reconstruction preserves invalid newer input and exact first intent; unknown4xx cannot rekey', async () => {
    const { store, storage, codec, restored } = setup();
    store.save('draft1', 'synthetic', intent);
    store.save('draft1', 'synthetic', { ...intent, draft: { amount: 'invalid', title: '' } });
    const reload = new DraftStore(storage);
    reload.register(codec);
    reload.bind(session);
    expect(reload.beforeSend('draft1')).toEqual(intent.firstIntent);
    expect(() => reload.save('draft1', 'synthetic', { ...intent, firstIntent: null })).toThrow();
    expect(() =>
      reload.save('draft1', 'synthetic', {
        ...intent,
        firstIntent: { ...intent.firstIntent!, key: 'new-key' },
      }),
    ).toThrow();
    await reload.restore('draft1', session, new AbortController().signal);
    expect(restored[0]?.draft).toEqual({ amount: 'invalid', title: '' });
    expect(JSON.stringify([...storage.values])).not.toContain('never-store');
  });
  it('quota before first send fails closed without overwriting previous valid snapshot', () => {
    const { store, storage } = setup();
    store.save('draft1', 'synthetic', draft);
    const old = storage.getItem(PREFIX + 'draft1');
    storage.denied = true;
    expect(() => store.save('draft1', 'synthetic', intent)).toThrow('Запит не надіслано');
    expect(storage.getItem(PREFIX + 'draft1')).toBe(old);
    expect(() => store.beforeSend('draft1')).toThrow();
  });
  it('malformed/unknown-version data is unreadable, cannot overwrite, and supports explicit discard', () => {
    const { store, storage } = setup();
    storage.setItem(PREFIX + 'draft1', '{"version":99}');
    expect(store.entries()[0]?.state).toBe('unreadable');
    expect(() => store.save('draft1', 'synthetic', draft)).toThrow();
    expect(() => store.beforeSend('draft1')).toThrow();
    store.discard('draft1');
    expect(storage.length).toBe(0);
    expect(() =>
      store.save('credentials', 'synthetic', { ...draft, draft: { password: 'bad' } }),
    ).toThrow();
  });
  it('confirmed ACK keeps newer draft and read barrier instead of permitting repeated POST', () => {
    const { store } = setup();
    store.save('draft1', 'synthetic', intent);
    expect(() => store.confirmed('draft1', {})).toThrow();
    expect(store.beforeSend('draft1')).toEqual(intent.firstIntent);
    store.confirmed('draft1', 'strict-confirmed');
    expect(() => store.beforeSend('draft1')).toThrow();
    expect(store.entries()[0]?.state).toBe('confirmed');
  });
  it('fresh permission/role/login gates clear private records and no onmount writes', async () => {
    const { store, storage, codec, restored } = setup();
    store.save('draft1', 'synthetic', intent);
    let reads = 0;
    const controller = new RecoveryController(store, async () => {
      reads++;
      return session;
    });
    await controller.check();
    expect(restored).toHaveLength(0);
    expect(reads).toBe(1);
    await controller.restore('draft1');
    expect(restored).toHaveLength(1);
    const other = { ...session, draftSession: 'c'.repeat(64) };
    store.bind(other);
    expect(storage.length).toBe(0);
    store.bind(session);
    store.save('draft1', 'synthetic', draft);
    const denied = new RecoveryController(store, async () => {
      throw Object.assign(Error('expired'), { status: 401 });
    });
    await expect(denied.check()).rejects.toThrow();
    expect(denied.snapshot().entries).toEqual([]);
    expect(storage.length).toBe(0);
    codec.authorize = async () => false;
  });
  it('late authorization cannot replace newer raw edits or restore after cancel', async () => {
    const { store, codec, restored } = setup();
    store.save('draft1', 'synthetic', draft);
    let release: ((v: boolean) => void) | undefined;
    codec.authorize = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const signal = new AbortController();
    const loading = store.restore('draft1', session, signal.signal);
    store.save('draft1', 'synthetic', { ...draft, draft: { amount: 'newer' } });
    release?.(true);
    await expect(loading).rejects.toThrow('скасовано');
    expect(restored).toHaveLength(0);
    const second = store.restore('draft1', session, signal.signal);
    signal.abort();
    release?.(true);
    await expect(second).rejects.toThrow('скасовано');
  });
});
