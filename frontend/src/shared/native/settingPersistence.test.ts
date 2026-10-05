import { describe, it, expect } from 'vitest';
import * as c from './settingPersistence';
const key = '11111111-1111-4111-8111-111111111111',
  revision = 'a'.repeat(32),
  next = 'b'.repeat(32);
const editing = { role: 'owner', storeId: null, networkOwner: true, canWrite: true };
const raw = { date: '2026-10-03', reason: 'Точна причина ', mode: 'optional', percent: '7,50' };
function payload(setting: c.Kind): unknown {
  const value =
    setting === 'period'
      ? { date: null, reason: 'Історична причина' }
      : setting === 'fiscal'
        ? { required: false }
        : { percent: '10' };
  return {
    baseline: {
      recordId: 'settings_' + key,
      key,
      setting,
      original: { type: 'setting', setting, value, revision, editing },
      needsReview: false,
    },
    draft: raw,
    firstIntent: null,
    confirmation: null,
  };
}
function sent(setting: c.Kind) {
  const p = c.decodePayload(payload(setting)),
    body = { ...c.capture(setting, raw), revision, idempotency_key: key };
  p.firstIntent = {
    method: 'POST',
    path: '/api/erp/' + setting,
    key,
    body,
    revision,
    possiblySent: true,
  };
  return {
    p,
    body,
    ack: {
      type: 'setting',
      setting,
      request_key: key,
      original: c.normalizeBody(setting, body),
      value: c.capture(setting, raw),
      revision: next,
    },
  };
}
describe('setting persistence', () => {
  it('all3 raw exact/frozen bodies reject credentials and wrong terms ACK', () => {
    for (const setting of ['period', 'fiscal', 'discount-limit'] as const) {
      const { p, body, ack } = sent(setting);
      expect(c.decodePayload(p).firstIntent?.body).toEqual(body);
      expect(c.decodeReceipt(ack, setting, key, body).revision).toBe(next);
      expect(() =>
        c.decodeReceipt(
          {
            ...ack,
            value:
              setting === 'period'
                ? { date: '2026-10-02', reason: 'other' }
                : setting === 'fiscal'
                  ? { required: true }
                  : { percent: '99' },
          },
          setting,
          key,
          body,
        ),
      ).toThrow();
      expect(() => c.decodePayload({ ...p, draft: { ...raw, password: 'secret' } })).toThrow();
    }
  });
  it('invalid raw remains distinct from semantic input limits', () => {
    const bad = { ...raw, date: '2026-02-30', reason: '', percent: '1e-' };
    expect(c.decodeRaw(bad)).toEqual(bad);
    expect(() => c.capture('period', bad)).toThrow();
    expect(() => c.capture('discount-limit', bad)).toThrow();
    expect(c.capture('discount-limit', { ...raw, percent: '0' })).toEqual({ percent: '0' });
    expect(() => c.capture('discount-limit', { ...raw, percent: '100.001' })).toThrow();
    expect(() =>
      c.normalizeBody('fiscal', { required: 'false', revision, idempotency_key: key }),
    ).toThrow();
  });
  it('identity confirmation durable before current, original baseline unchanged; Apply rotates only explicitly', () => {
    const { p, ack } = sent('period');
    const invalid = { ...raw, reason: '' };
    const confirmed = c.confirmPayload(p, {
      type: 'identity',
      raw: { confirmed: true, ...ack },
      draft: invalid,
    });
    expect(confirmed.firstIntent).toBeNull();
    expect(confirmed.confirmation).toEqual(ack);
    expect(confirmed.draft).toEqual(invalid);
    expect(c.decodeState(confirmed.baseline).original.revision).toBe(revision);
    expect(c.decodePayload(confirmed).confirmation).toEqual(ack);
    const current = {
      type: 'setting',
      setting: 'period',
      value: { date: '2026-10-02', reason: 'Інший редактор' },
      revision: next,
      editing,
    };
    expect(() =>
      c.confirmPayload(confirmed, {
        type: 'apply',
        raw: { current, merged: invalid, key },
        draft: invalid,
      }),
    ).toThrow();
    const applied = c.confirmPayload(confirmed, {
      type: 'apply',
      raw: { current, merged: raw, key: '22222222-2222-4222-8222-222222222222' },
      draft: invalid,
    });
    expect(c.decodeState(applied.baseline).original.revision).toBe(next);
    expect(applied.confirmation).toBeNull();
    expect(applied.draft).toEqual(raw);
  });
  it('missing identity does not retire unknown; strict resource/policy and original receipt UUID', () => {
    const { p, body, ack } = sent('fiscal');
    const missing = { confirmed: false, type: 'setting', setting: 'fiscal', request_key: key };
    expect(
      c.confirmPayload(p, { type: 'identity', raw: missing, draft: raw }).firstIntent?.body,
    ).toEqual(body);
    expect(() => c.decodeReceipt({ ...ack, setting: 'period' }, 'fiscal', key, body)).toThrow();
    expect(() =>
      c.decodeCurrent(
        { type: 'setting', setting: 'fiscal', value: { required: 1 }, revision, editing },
        'fiscal',
      ),
    ).toThrow();
    expect(() =>
      c.decodeCurrent(
        {
          type: 'setting',
          setting: 'fiscal',
          value: { required: false },
          revision,
          editing: { ...editing, role: 'manager' },
        },
        'fiscal',
      ),
    ).toThrow();
  });
});
