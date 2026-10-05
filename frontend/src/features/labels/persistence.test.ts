import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from './domain';
import {
  decodePayload,
  prepare,
  raw,
  baseline,
  RECORD_ID,
  EXECUTE,
  RAW_LABEL_MERGE_FIELDS,
} from './persistence';
import type { Request } from './persistence';
import { LabelRecovery } from './recovery';
import { createLabelRecoveryApi, LabelSaveError } from './recoveryApi';
import type { LabelRecoveryApi } from './recoveryApi';
import { DraftStore, PREFIX } from '../../shared/recovery/storage';
import { RecoveryController } from '../../shared/recovery/controller';
import type { DraftSession } from '../../shared/recovery/session';
import type { Workspace } from './api';
import { compareThreeWay, resolveThreeWay } from '../../shared/merge/threeWay';
const session: DraftSession = {
  draftOwner: 'a'.repeat(64),
  draftSession: 'b'.repeat(64),
  role: 'owner',
  storeId: null,
  networkOwner: true,
};
const revision = 'c'.repeat(64),
  nextRevision = 'd'.repeat(64);
const current = (): Workspace => ({
  config: defaultConfig(),
  settings: { chainName: 'Цукерня', storeNames: ['Київ'], staleDays: 30 },
  revision,
  canEdit: true,
  csrf: 'never-store',
  warnings: [],
});
function payload() {
  const w = current();
  return decodePayload({
    baseline: {
      original: { config: w.config, settings: w.settings },
      revision,
      key: crypto.randomUUID(),
      review: false,
      frozenRaw: null,
    },
    draft: { config: w.config, settings: w.settings, fontSizes: {} },
    firstIntent: null,
    confirmation: null,
  });
}
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
function setup(storage = new Memory()) {
  vi.stubGlobal('location', { hash: '#operations/tags' });
  const store = new DraftStore(storage),
    controller = new RecoveryController(store, async () => session);
  const api: LabelRecoveryApi = {
    context: vi.fn(async () => ({
      contract: 'label-layout-context-v1' as const,
      resource: 'settings/main' as const,
      role: 'owner' as const,
      storeId: null,
      networkOwner: true,
      canWrite: true as const,
    })),
    workspace: vi.fn(async () => current()),
    identity: vi.fn(async (body: Request) => ({
      contract: 'label-layout-save-v1' as const,
      key: body.key,
      confirmed: false,
    })),
    execute: vi.fn(async (body: Request) => ({
      contract: 'label-layout-save-v1' as const,
      key: body.key,
      confirmed: true,
      appliedRevision: nextRevision,
    })),
  };
  const close = vi.fn(),
    manager = new LabelRecovery(
      { store, controller, register: (c) => store.register(c), close },
      api,
    ),
    host = { hidden: false } as HTMLElement;
  return { manager, api, store, controller, host, storage, close };
}
afterEach(() => vi.unstubAllGlobals());
describe('Label durable workspace', () => {
  it('strict raw whitelist, exact frozen body and unfinished newer input survive reconstruction', () => {
    const p = payload(),
      d = raw(p.draft);
    d.fontSizes.price = '22,50';
    p.draft = JSON.parse(JSON.stringify(d));
    const frozen = prepare(p),
      newer = structuredClone(frozen);
    (newer.draft as Record<string, unknown>).fontSizes = { price: '' };
    expect(raw(decodePayload(newer).draft).fontSizes.price).toBe('');
    expect((frozen.firstIntent!.body as unknown as Request).config.styles.price!.size).toBe(22.5);
    for (const corrupt of [
      { ...newer, draft: { ...d, products: [] } },
      {
        ...frozen,
        firstIntent: {
          ...frozen.firstIntent!,
          body: { ...(frozen.firstIntent!.body as object), config: { ...d.config, size: 'l' } },
        },
      },
      { ...newer, baseline: { ...baseline(newer.baseline), key: crypto.randomUUID() } },
    ])
      expect(() => decodePayload(corrupt)).toThrow();
    expect(() =>
      prepare({ ...p, draft: JSON.parse(JSON.stringify({ ...d, fontSizes: { price: '' } })) }),
    ).toThrow(/розмір/);
  });
  it('keeps stores/index atomic and raw size in the reviewed merge unit', () => {
    const base = raw(payload().draft),
      mine = structuredClone(base),
      server = structuredClone(base);
    mine.settings.storeNames = ['Львів', 'Київ'];
    mine.config.storeIdx = 1;
    mine.fontSizes.price = '';
    server.settings.storeNames = ['Одеса'];
    const rows = compareThreeWay(base, mine, server, RAW_LABEL_MERGE_FIELDS);
    expect(rows.filter((r) => r.id === 'settings.stores')).toHaveLength(1);
    const merged = resolveThreeWay(base, mine, server, RAW_LABEL_MERGE_FIELDS, {
      'settings.stores': 'mine',
    });
    expect(merged!.settings.storeNames).toEqual(['Львів', 'Київ']);
    expect(merged!.config.storeIdx).toBe(1);
    expect(merged!.fontSizes.price).toBe('');
  });
  it('captures synchronously and quota blocks first POST without replacing durable prior raw', async () => {
    const s = setup();
    await s.manager.mount(s.host);
    const d = raw(s.manager.payload()!.draft);
    d.config.custom = 'raw';
    s.manager.capture(d);
    const before = s.storage.getItem(PREFIX + RECORD_ID);
    expect(before).toContain('raw');
    expect(before).not.toContain('never-store');
    s.storage.denied = true;
    await expect(s.manager.save(d)).rejects.toThrow(/не надіслано/);
    expect(s.api.execute).not.toHaveBeenCalled();
    expect(s.storage.getItem(PREFIX + RECORD_ID)).toBe(before);
    s.manager.dispose();
  });
  it('positive identity is durable before current503; reload reads only and preserves newer invalid text', async () => {
    const s = setup();
    await s.manager.mount(s.host);
    const d = raw(s.manager.payload()!.draft);
    d.config.custom = 'first';
    vi.mocked(s.api.execute).mockRejectedValueOnce(Error('lost ACK'));
    await s.manager.save(d);
    expect(s.store.entries()[0]?.state).toBe('unknown');
    await s.manager.read();
    const newer = raw(s.manager.payload()!.draft);
    newer.fontSizes.price = '';
    s.manager.capture(newer);
    vi.mocked(s.api.identity).mockImplementationOnce(async (b) => ({
      contract: 'label-layout-save-v1',
      key: b.key,
      confirmed: true,
      appliedRevision: nextRevision,
    }));
    vi.mocked(s.api.workspace).mockRejectedValueOnce(Error('current503'));
    await s.manager.read();
    expect(s.store.entries()[0]?.state).toBe('confirmed');
    expect(s.manager.payload()!.firstIntent).toBeNull();
    s.manager.dispose();
    const reload = setup(s.storage);
    await reload.manager.mount(reload.host);
    expect(reload.manager.snapshot().phase).toBe('offer');
    await reload.manager.restore();
    expect(reload.manager.snapshot().phase).toBe('ready');
    expect(raw(reload.manager.payload()!.draft).fontSizes.price).toBe('');
    expect(reload.api.identity).not.toHaveBeenCalled();
    expect(reload.api.execute).not.toHaveBeenCalled();
    reload.manager.dispose();
  });
  it('first bound rejection can review/apply; rejection after unknown preserves exact frozen intent', async () => {
    const s = setup();
    await s.manager.mount(s.host);
    const d = raw(s.manager.payload()!.draft);
    d.config.custom = 'first';
    vi.mocked(s.api.execute).mockImplementationOnce(async (b) => {
      throw new LabelSaveError(409, 'changed', 'revision_conflict', {
        error: 'changed',
        code: 'revision_conflict',
        write_rejected: true,
        key: b.key,
      });
    });
    await s.manager.save(d);
    expect(s.manager.payload()!.firstIntent).toBeNull();
    expect(baseline(s.manager.payload()!.baseline).review).toBe(true);
    await s.manager.read();
    s.manager.apply(d, current());
    vi.mocked(s.api.execute).mockRejectedValueOnce(Error('lost'));
    await s.manager.save(d);
    const frozen = s.store.beforeSend(RECORD_ID);
    await s.manager.read();
    vi.mocked(s.api.execute).mockImplementationOnce(async (b) => {
      throw new LabelSaveError(409, 'changed', 'revision_conflict', {
        error: 'changed',
        code: 'revision_conflict',
        write_rejected: true,
        key: b.key,
      });
    });
    await s.manager.save(raw(s.manager.payload()!.draft), true);
    expect(s.store.beforeSend(RECORD_ID)).toEqual(frozen);
    s.manager.dispose();
  });
  it('route cancellation after ignored-abort ACK never confirms or renders private data', async () => {
    const s = setup();
    await s.manager.mount(s.host);
    let done!: (value: Awaited<ReturnType<LabelRecoveryApi['execute']>>) => void;
    vi.mocked(s.api.execute).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const d = raw(s.manager.payload()!.draft);
    d.config.custom = 'pending';
    const saving = s.manager.save(d);
    await vi.waitFor(() => expect(done).toBeTypeOf('function'));
    const frozen = s.store.beforeSend(RECORD_ID);
    s.manager.leave();
    done({
      contract: 'label-layout-save-v1',
      key: frozen.key,
      confirmed: true,
      appliedRevision: nextRevision,
    });
    await saving;
    expect(s.store.entries()[0]?.state).toBe('unknown');
    expect(s.manager.snapshot().workspace).toBeNull();
    s.manager.dispose();
  });
  it('current non-JSON401 keeps its status; stale non-JSON401 cannot revoke the current grant', async () => {
    const f = { session, signal: new AbortController().signal, current: () => true };
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }));
    await expect(createLabelRecoveryApi(transport).context(f)).rejects.toMatchObject({
      status: 401,
    });
    let live = true,
      done!: () => void;
    const held = vi.fn<typeof fetch>().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () =>
        new Promise((_resolve, reject) => {
          done = () => reject(Error('invalid JSON'));
        }),
    } as Response);
    const pending = createLabelRecoveryApi(held).context({ ...f, current: () => live });
    await vi.waitFor(() => expect(done).toBeTypeOf('function'));
    live = false;
    done();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('transport fences last session and JSON await before execute/ACK', async () => {
    const f = { session, signal: new AbortController().signal, current: () => true },
      body = prepare(payload()).firstIntent!.body as unknown as Request;
    const changed = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ ...session, csrf: 'x', role: 'manager', networkOwner: false }),
      );
    await expect(createLabelRecoveryApi(changed).execute(body, f)).rejects.toMatchObject({
      status: 403,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    let done!: (v: unknown) => void,
      live = true;
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...session, csrf: 'x' }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          new Promise((resolve) => {
            done = resolve;
          }),
      } as Response);
    const work = createLabelRecoveryApi(transport).execute(body, { ...f, current: () => live });
    await vi.waitFor(() => expect(done).toBeTypeOf('function'));
    live = false;
    done({
      contract: 'label-layout-save-v1',
      key: body.key,
      ok: true,
      appliedRevision: nextRevision,
    });
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.mock.calls[1]?.[0]).toBe(EXECUTE);
  });
});
