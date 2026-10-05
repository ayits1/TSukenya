import { describe, it, expect, vi } from 'vitest';
import {
  decodeEnvelope,
  requestHash,
  createRecoveryApi,
  RecoveryError,
  decodeAcknowledgement,
} from './api';
import { decodePayload, confirmed, encodePayload, type CampaignPayload } from './codec';
const key = '00000000-0000-4000-8000-000000000001';
const request = {
  name: 'Акція',
  startsOn: '2026-10-01',
  endsOn: '2026-10-05',
  active: true,
  scope: 'network',
  stores: [],
  prices: [{ product: 'coffee', price: '25.00' }],
  reason: 'Причина',
  idempotencyKey: key,
};
const envelope = decodeEnvelope({ key, operation: 'create', target: null, request });
const session = {
  draftOwner: 'a'.repeat(64),
  draftSession: 'b'.repeat(64),
  role: 'owner' as const,
  storeId: null,
  networkOwner: true,
};
const raw = {
  input: Object.fromEntries(Object.entries(request).filter(([k]) => k !== 'idempotencyKey')),
  names: { coffee: 'Кава' },
  search: '',
};
function payload(hash: string): CampaignPayload {
  return decodePayload({
    baseline: {
      recordId: 'campaign_test',
      target: null,
      revision: null,
      archived: false,
      original: raw,
      intentHash: hash,
    },
    draft: { ...raw, input: { ...raw.input, name: '' } },
    firstIntent: {
      method: 'POST',
      path: '/api/v1/promotions/recovery/execute',
      key,
      body: envelope,
      revision: null,
      possiblySent: true,
    },
    confirmation: null,
  });
}
describe('campaign compact recovery', () => {
  it('retains invalid newer raw and frozen intent; confirmation is scalar, never a baseline', async () => {
    const hash = await requestHash(envelope),
      p = payload(hash);
    expect(p.draft.input.name).toBe('');
    const ack = {
      confirmed: true,
      key,
      operation: 'create',
      target: key,
      requestHash: hash,
      outcome: 'created',
    };
    const next = decodePayload(confirmed(encodePayload(p), ack));
    expect(next.baseline.target).toBeNull();
    expect(next.draft.input.name).toBe('');
    expect(next.firstIntent).toBeNull();
    expect(next.confirmation?.envelope).toEqual(envelope);
    expect(() => confirmed(encodePayload(p), { ...ack, target: 'other' })).toThrow();
  });
  it('rejects DTO/private storage additions, invalid revision, wrong original body and receipt', async () => {
    const hash = await requestHash(envelope),
      p = payload(hash);
    expect(() => decodePayload({ ...p, privateCost: '20' })).toThrow();
    expect(() =>
      decodePayload({ ...p, baseline: { ...p.baseline, target: key, revision: 0 } }),
    ).toThrow();
    expect(() =>
      decodeEnvelope({ ...envelope, request: { ...request, author: 'secret' } }),
    ).toThrow();
    expect(() =>
      decodeAcknowledgement(
        {
          confirmed: true,
          key,
          operation: 'create',
          target: key,
          requestHash: 'c'.repeat(64),
          outcome: 'created',
        },
        envelope,
        hash,
      ),
    ).toThrow();
  });
  it('releases only a proof bound to exact original action/hash', async () => {
    const hash = await requestHash(envelope),
      p = payload(hash);
    const proof = { write_rejected: true, key, operation: 'create', requestHash: hash };
    expect(decodePayload(confirmed(encodePayload(p), proof)).firstIntent).toBeNull();
    expect(() => confirmed(encodePayload(p), { ...proof, key: 'wrong' })).toThrow();
  });
  it('nonJSON current last-session401/403 retain actual status and never reach POST', async () => {
    for (const status of [401, 403]) {
      const transport = vi.fn(async () => new Response('denied', { status }));
      const api = createRecoveryApi(transport as typeof fetch);
      await expect(
        api.identity(
          envelope,
          await requestHash(envelope),
          new AbortController().signal,
          () => true,
          session,
        ),
      ).rejects.toMatchObject({ status });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it('ignored aborted late401 cannot authorize, decode or execute', async () => {
    const signal = new AbortController();
    const transport = vi.fn(async () => {
      signal.abort();
      return new Response('denied', { status: 401 });
    });
    await expect(
      createRecoveryApi(transport as typeof fetch).identity(
        envelope,
        await requestHash(envelope),
        signal.signal,
        () => true,
        session,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('last-awaited session change blocks exact frozen execute; same-session delayed cancel also blocks', async () => {
    const changed = vi.fn(async () =>
      Response.json({ ...session, draftSession: 'c'.repeat(64), csrf: 'test' }),
    );
    await expect(
      createRecoveryApi(changed as typeof fetch).execute(
        envelope,
        await requestHash(envelope),
        new AbortController().signal,
        () => true,
        session,
      ),
    ).rejects.toBeInstanceOf(RecoveryError);
    expect(changed).toHaveBeenCalledTimes(1);
    let live = true;
    const cancelled = vi.fn(async () => {
      live = false;
      return Response.json({ ...session, csrf: 'test' });
    });
    await expect(
      createRecoveryApi(cancelled as typeof fetch).execute(
        envelope,
        await requestHash(envelope),
        new AbortController().signal,
        () => live,
        session,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
