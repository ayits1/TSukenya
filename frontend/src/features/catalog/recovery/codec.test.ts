import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { DraftStore } from '../../../shared/recovery/storage';
import {
  decodeCatalogPayload,
  encodePayload,
  confirmed,
  codecName,
  type CatalogPayload,
} from './codec';
import {
  decodeEnvelope,
  decodeAcknowledgement,
  requestHash,
  createRecoveryApi,
  type Envelope,
} from './api';
const key = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const raw = {
  values: {
    name: '',
    type: 'Кава',
    category: '',
    pack: '',
    size: '',
    unit: 'шт',
    barcode: '',
    cost: '1e-',
    markup: '0.',
    price: null,
    manualPrice: false,
    promotion: false,
    promotionPrice: null,
    priceAt: '',
    priceReviewed: false,
    minStock: 'invalid',
    expiryAlertDays: 'new invalid',
  },
  manualAmount: '19.',
  creation: { field: 'type' as const, value: '' },
};
const envelope: Envelope = {
  key,
  operation: 'product_create',
  target: null,
  store: null,
  request: { name: 'Первісна кава', cost: '0.5', unit: 'шт', pricingRevision: 'c'.repeat(64) },
};
const payload = (): CatalogPayload => ({
  baseline: {
    recordId: 'catalog_' + key,
    kind: 'product',
    store: null,
    target: null,
    revision: null,
    hidden: false,
    referenceIds: { type: 'unknown_stable_id' },
    defaultMarkup: '30',
    original: raw,
    intentHash: null,
  },
  draft: raw,
  firstIntent: null,
  confirmation: null,
});
const session = {
  draftOwner: 'a'.repeat(64),
  draftSession: 'b'.repeat(64),
  role: 'owner' as const,
  storeId: null,
  networkOwner: true,
};
class Memory implements Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(k: string) {
    return this.values.get(k) ?? null;
  }
  key(n: number) {
    return [...this.values.keys()][n] ?? null;
  }
  removeItem(k: string) {
    this.values.delete(k);
  }
  setItem(k: string, v: string) {
    this.values.set(k, v);
  }
}
const ack = (hash: string) => ({
  confirmed: true,
  key,
  operation: 'product_create' as const,
  target: 'created_product',
  requestHash: hash,
  outcome: 'created' as const,
});
describe('Catalogue durable frozen protocol', () => {
  it('keeps invalid newer raw + unknown stable IDs and refuses DTO/unknown JSON in storage', () => {
    const p = payload();
    expect(decodeCatalogPayload(p).draft).toEqual(raw);
    expect(decodeCatalogPayload(p).baseline.referenceIds).toEqual({ type: 'unknown_stable_id' });
    for (const addition of [
      { recipe: [] },
      { regularPrice: '20' },
      { permissions: { canEdit: true } },
    ])
      expect(() => decodeCatalogPayload({ ...p, draft: { ...raw, ...addition } })).toThrow();
    expect(() =>
      decodeCatalogPayload({ ...p, baseline: { ...p.baseline, referenceIds: { unit: 123 } } }),
    ).toThrow();
  });
  it('binds compact receipt exactly; durably confirms before current read without adopting baseline', async () => {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    const hash = await requestHash(envelope);
    const p = payload();
    p.baseline.intentHash = hash;
    p.firstIntent = {
      method: 'POST',
      path: '/api/v1/catalog/recovery/execute',
      key,
      body: envelope,
      revision: null,
      possiblySent: true,
    };
    const store = new DraftStore(new Memory());
    store.register({
      name: codecName,
      version: 1,
      label: 'Каталог',
      decode: (v) => encodePayload(decodeCatalogPayload(v)),
      authorize: async () => true,
      restore: () => {},
      suspend: () => {},
      confirm: confirmed,
    });
    store.bind(session);
    store.save(p.baseline.recordId, codecName, encodePayload(p));
    const frozen = store.beforeSend(p.baseline.recordId);
    expect(frozen.body).toEqual(envelope);
    expect(() =>
      store.save(
        p.baseline.recordId,
        codecName,
        encodePayload({
          ...p,
          firstIntent: { ...p.firstIntent!, body: { ...envelope, request: { name: 'Новіші' } } },
        }),
      ),
    ).toThrow();
    for (const change of [
      { key: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      { requestHash: 'f'.repeat(64) },
      { operation: 'reference_create' },
      { outcome: 'deleted' },
    ])
      expect(() => store.confirmed(p.baseline.recordId, { ...ack(hash), ...change })).toThrow();
    store.confirmed(p.baseline.recordId, ack(hash));
    expect(store.entries()[0]?.state).toBe('confirmed');
    const next = confirmed(encodePayload(p), ack(hash));
    expect(decodeCatalogPayload(next).firstIntent).toBeNull();
    expect(decodeCatalogPayload(next).baseline.target).toBeNull();
    expect(decodeCatalogPayload(next).baseline.referenceIds.type).toBe('unknown_stable_id');
    expect(decodeCatalogPayload(next).draft).toEqual(raw);
    expect(() =>
      decodeCatalogPayload({
        ...decodeCatalogPayload(next),
        baseline: { ...p.baseline, store: 1 },
      }),
    ).toThrow();
  });
  it('rejects reference body/key mismatch and confirms only whole reviewed signed request', async () => {
    const body = {
      sourceId: 'ref_a',
      revision: 'a'.repeat(64),
      operation: 'rename',
      value: 'Нова назва',
      snapshot: 'b'.repeat(64),
      idempotencyKey: key,
    };
    const e = {
      ...envelope,
      operation: 'reference_commit' as const,
      target: 'ref_a',
      request: body,
    };
    expect(decodeEnvelope(e).request).toEqual(body);
    expect(() => decodeEnvelope({ ...e, request: { ...body, idempotencyKey: 'other' } })).toThrow();
    expect(() => decodeEnvelope({ ...e, request: { ...body, page: 1 } })).toThrow();
    const hash = await requestHash(e);
    expect(() =>
      decodeAcknowledgement(
        { ...ack(hash), operation: 'reference_commit', target: 'ref_other', outcome: 'committed' },
        e,
        hash,
      ),
    ).toThrow();
  });
  it('refuses malformed frozen request primitives and incomplete reviewed B30 bodies', () => {
    for (const request of [
      { name: 1 },
      { cost: 1 },
      { manualPrice: 'false' },
      { expiryAlertDays: '2' },
    ])
      expect(() => decodeEnvelope({ ...envelope, request })).toThrow();
    for (const request of [{ hidden: true }, { revision: 'r' }, { revision: 'r', hidden: 'true' }])
      expect(() =>
        decodeEnvelope({ ...envelope, operation: 'product_visibility', target: 'one', request }),
      ).toThrow();
    expect(() =>
      decodeEnvelope({
        ...envelope,
        operation: 'reference_create',
        request: { field: 'recipe', value: 'x' },
      }),
    ).toThrow();
    expect(() =>
      decodeEnvelope({
        ...envelope,
        operation: 'reference_commit',
        target: 'ref_a',
        request: {
          sourceId: 'ref_a',
          revision: 'r',
          operation: 'rename',
          snapshot: 's',
          idempotencyKey: key,
        },
      }),
    ).toThrow();
  });
  it('does not process old ignored-abort401 or decode after response-live context changes', async () => {
    let resolve!: (v: Response) => void;
    let live = true;
    const client = createRecoveryApi(
      (() =>
        new Promise<Response>((r) => {
          resolve = r;
        })) as typeof fetch,
    );
    const abort = new AbortController();
    const read = client.context(
      { operation: 'product_create', target: null, store: null },
      abort.signal,
      () => live,
    );
    live = false;
    resolve(new Response(JSON.stringify({ error: 'old unauthorized' }), { status: 401 }));
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('revalidates the exact session before every identity and execute POST', async () => {
    let changed = false;
    const paths: string[] = [];
    const hash = await requestHash(envelope);
    const client = createRecoveryApi((async (path) => {
      paths.push(String(path));
      return new Response(
        JSON.stringify(
          String(path) === '/api/v1/session'
            ? {
                ...session,
                csrf: 'ephemeral',
                ...(changed ? { draftSession: 'c'.repeat(64) } : {}),
              }
            : { ...ack(hash), confirmed: false, target: null, outcome: 'unresolved' },
        ),
      );
    }) as typeof fetch);
    const signal = new AbortController().signal;
    await client.identity(envelope, hash, signal, () => true, session);
    changed = true;
    await expect(client.execute(envelope, hash, signal, () => true, session)).rejects.toMatchObject(
      { status: 403 },
    );
    expect(paths).toEqual([
      '/api/v1/session',
      '/api/v1/catalog/recovery/identity',
      '/api/v1/session',
    ]);
  });
  it('refuses an ignored-abort session response before processing auth or sending POST', async () => {
    let resolve!: (v: Response) => void;
    let live = true;
    let requests = 0;
    const client = createRecoveryApi((() => {
      requests++;
      return new Promise<Response>((r) => {
        resolve = r;
      });
    }) as typeof fetch);
    const read = client.identity(
      envelope,
      'a'.repeat(64),
      new AbortController().signal,
      () => live,
      session,
    );
    live = false;
    resolve(new Response('{}', { status: 401 }));
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(1);
  });
});
