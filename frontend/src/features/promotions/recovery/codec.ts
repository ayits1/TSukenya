import type { Payload, FirstIntent } from '../../../shared/recovery/storage';
import {
  object,
  exact,
  uuid,
  decodeInput,
  decodeEnvelope,
  decodeAcknowledgement,
  type Envelope,
  type Acknowledgement,
} from './api';
import type { CampaignInput } from '../api';
export const codecName = 'campaign_editor';
export type Raw = { input: CampaignInput; names: Record<string, string>; search: string };
export type Baseline = {
  recordId: string;
  target: string | null;
  revision: number | null;
  archived: boolean;
  original: Raw;
  intentHash: string | null;
};
export type CampaignPayload = {
  baseline: Baseline;
  draft: Raw;
  firstIntent: FirstIntent | null;
  confirmation: { ack: Acknowledgement; envelope: Envelope } | null;
};
export const encodePayload = (v: CampaignPayload): Payload =>
  JSON.parse(JSON.stringify(v)) as Payload;
export function decodeRaw(raw: unknown): Raw {
  const v = object(raw);
  exact(v, ['input', 'names', 'search']);
  decodeInput(v.input);
  const names = object(v.names);
  if (
    Object.entries(names).some(
      ([k, x]) => !/^[A-Za-z0-9_-]{1,120}$/.test(k) || typeof x !== 'string' || x.length > 1000,
    ) ||
    typeof v.search !== 'string' ||
    v.search.length > 1000
  )
    throw Error('Поля чернетки акції не підтверджені.');
  return structuredClone(v) as Raw;
}
export function decodePayload(raw: unknown): CampaignPayload {
  const v = object(raw);
  exact(v, ['baseline', 'draft', 'firstIntent', 'confirmation']);
  const b = object(v.baseline);
  exact(b, ['recordId', 'target', 'revision', 'archived', 'original', 'intentHash']);
  if (
    typeof b.recordId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(b.recordId) ||
    (b.target === null
      ? b.revision !== null
      : !uuid(b.target) || !Number.isSafeInteger(b.revision) || Number(b.revision) <= 0) ||
    typeof b.archived !== 'boolean' ||
    (b.intentHash !== null &&
      (typeof b.intentHash !== 'string' || !/^[a-f0-9]{64}$/.test(b.intentHash)))
  )
    throw Error('Первісна версія акції не підтверджена.');
  decodeRaw(b.original);
  decodeRaw(v.draft);
  const bound = (e: Envelope) => {
    if (
      e.operation === 'create'
        ? b.target !== null
        : e.target !== b.target || e.request.revision !== b.revision
    )
      throw Error('Первісний запит не відповідає версії чернетки.');
  };
  if (v.firstIntent !== null) {
    const i = object(v.firstIntent);
    exact(i, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']);
    const e = decodeEnvelope(i.body);
    bound(e);
    if (
      i.method !== 'POST' ||
      i.path !== '/api/v1/promotions/recovery/execute' ||
      i.key !== e.key ||
      i.revision !== null ||
      i.possiblySent !== true
    )
      throw Error('Первісний запит акції не підтверджений.');
  }
  if (v.confirmation !== null) {
    const c = object(v.confirmation);
    exact(c, ['ack', 'envelope']);
    const e = decodeEnvelope(c.envelope);
    bound(e);
    if (
      typeof b.intentHash !== 'string' ||
      v.firstIntent !== null ||
      !decodeAcknowledgement(c.ack, e, b.intentHash).confirmed
    )
      throw Error('Підтвердження акції не відповідає первісному запиту.');
  }
  return structuredClone(v) as unknown as CampaignPayload;
}
export function confirmed(raw: Payload, answer: unknown): Payload {
  const v = decodePayload(raw);
  if (!v.firstIntent || !v.baseline.intentHash) throw Error('Первісний запит відсутній.');
  const e = decodeEnvelope(v.firstIntent.body),
    r = object(answer);
  if (r.write_rejected === true) {
    exact(r, ['write_rejected', 'key', 'operation', 'requestHash']);
    if (r.key !== e.key || r.operation !== e.operation || r.requestHash !== v.baseline.intentHash)
      throw Error('Відмову не підтверджено.');
    return encodePayload({
      ...v,
      baseline: { ...v.baseline, intentHash: null },
      firstIntent: null,
      confirmation: null,
    });
  }
  const ack = decodeAcknowledgement(answer, e, v.baseline.intentHash);
  if (!ack.confirmed) throw Error('Первісний результат не підтверджено.');
  return encodePayload({ ...v, firstIntent: null, confirmation: { ack, envelope: e } });
}
