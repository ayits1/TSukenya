import { decodeBinding, sameSession, type DraftSession } from './session';
export const PREFIX = 'tsukenya:draft:v1:';
export const LIMITS = {
  recordBytes: 2 * 1024 * 1024,
  totalBytes: 3 * 1024 * 1024,
  records: 20,
  depth: 16,
  nodes: 30000,
};
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type FirstIntent = {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  key: string;
  body: Json;
  revision: string | number | null;
  possiblySent: true;
};
export type Payload = {
  baseline: Json;
  draft: Json;
  firstIntent: FirstIntent | null;
  confirmation: Json;
};
export type Codec = {
  name: string;
  version: number;
  label: string;
  decode: (value: unknown) => Payload;
  authorize: (payload: Payload, session: DraftSession, signal: AbortSignal) => Promise<boolean>;
  restore: (payload: Payload) => void;
  suspend: () => void;
  confirm?: (payload: Payload, acknowledgement: unknown) => Payload | null;
};
type RecordValue = {
  version: 1;
  id: string;
  codec: string;
  codecVersion: number;
  session: DraftSession;
  updatedAt: string;
  payload: Payload;
};
export type Entry = {
  id: string;
  label: string;
  state: 'draft' | 'unknown' | 'confirmed' | 'unreadable';
  updatedAt: string | null;
};
function fail(): never {
  throw Error('Чернетка пошкоджена або має непідтримувану версію.');
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(v);
function json(value: unknown): void {
  let nodes = 0;
  function visit(v: unknown, depth: number): void {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) fail();
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (Array.isArray(v)) {
      v.forEach((x) => visit(x, depth + 1));
      return;
    }
    if (!object(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail();
    for (const [key, item] of Object.entries(v)) {
      if (
        /^(?:__proto__|prototype|constructor|password|csrf|authorization|cookie|token|token_hash|secret|apiKey|api_key|permissions)$/i.test(
          key,
        )
      )
        fail();
      visit(item, depth + 1);
    }
  }
  visit(value, 0);
}
function payload(value: unknown): Payload {
  if (!object(value) || !exact(value, ['baseline', 'draft', 'firstIntent', 'confirmation'])) fail();
  json(value);
  const intent = value.firstIntent;
  if (intent !== null) {
    if (
      !object(intent) ||
      !exact(intent, ['method', 'path', 'key', 'body', 'revision', 'possiblySent']) ||
      !['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(intent.method)) ||
      typeof intent.path !== 'string' ||
      !/^\/api\/(?:v1\/)?[A-Za-z0-9_/-]+$/.test(intent.path) ||
      !identifier(intent.key) ||
      intent.possiblySent !== true ||
      !(
        intent.revision === null ||
        typeof intent.revision === 'string' ||
        Number.isSafeInteger(intent.revision)
      )
    )
      fail();
  }
  return value as Payload; // Structure and bounded JSON checked; domain codec must validate semantics.
}
const bytes = (text: string) => new TextEncoder().encode(text).length;
export class DraftStore {
  private codecs = new Map<string, Codec>();
  private session: DraftSession | null = null;
  constructor(private storage: Storage) {}
  register(codec: Codec) {
    if (
      !identifier(codec.name) ||
      !Number.isSafeInteger(codec.version) ||
      codec.version < 1 ||
      !codec.label ||
      codec.label.length > 250 ||
      this.codecs.has(codec.name) ||
      ![codec.decode, codec.authorize, codec.restore, codec.suspend].every(
        (fn) => typeof fn === 'function',
      )
    )
      throw Error('Некоректний codec чернетки.');
    this.codecs.set(codec.name, codec);
  }
  bind(session: DraftSession) {
    session = decodeBinding(session);
    if (this.session && !sameSession(this.session, session)) this.erase();
    this.session = structuredClone(session);
    // Different login/actor/scope records must never become visible in this session.
    for (const key of this.keys()) {
      try {
        const v: unknown = JSON.parse(this.storage.getItem(key) || '');
        if (object(v) && object(v.session) && !sameSession(decodeBinding(v.session), session))
          this.storage.removeItem(key);
      } catch {
        /* Keep unreadable records blocked for explicit discard, never restore them. */
      }
    }
  }
  suspend() {
    this.session = null;
    for (const codec of this.codecs.values()) {
      try {
        codec.suspend();
      } catch {
        /* Other editors must still be suspended. */
      }
    }
  }
  erase() {
    this.suspend();
    for (const key of this.keys()) this.storage.removeItem(key);
  }
  private keys(): string[] {
    const keys = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    return keys;
  }
  private read(id: string): RecordValue {
    if (!this.session || !identifier(id)) throw Error('Спочатку підтвердьте чинний сеанс.');
    const text = this.storage.getItem(PREFIX + id);
    if (text === null) throw Error('Чернетка більше не доступна.');
    if (bytes(text) > LIMITS.recordBytes) fail();
    const v: unknown = JSON.parse(text);
    if (
      !object(v) ||
      !exact(v, ['version', 'id', 'codec', 'codecVersion', 'session', 'updatedAt', 'payload']) ||
      v.version !== 1 ||
      v.id !== id ||
      !identifier(v.codec) ||
      !object(v.session) ||
      !sameSession(decodeBinding(v.session), this.session) ||
      typeof v.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(v.updatedAt))
    )
      fail();
    const codec = this.codecs.get(v.codec);
    if (!codec || v.codecVersion !== codec.version) fail();
    const decoded = payload(codec.decode(payload(v.payload)));
    return {
      version: 1,
      id,
      codec: v.codec,
      codecVersion: codec.version,
      session: structuredClone(this.session),
      updatedAt: v.updatedAt,
      payload: structuredClone(decoded),
    };
  }
  entries(): Entry[] {
    if (!this.session) return [];
    return this.keys().map((key) => {
      const id = key.slice(PREFIX.length);
      try {
        const v = this.read(id);
        return {
          id,
          label: this.codecs.get(v.codec)!.label,
          state: v.payload.firstIntent
            ? 'unknown'
            : v.payload.confirmation !== null
              ? 'confirmed'
              : 'draft',
          updatedAt: v.updatedAt,
        } as Entry;
      } catch {
        return {
          id,
          label: 'Недоступна локальна чернетка',
          state: 'unreadable',
          updatedAt: null,
        } as Entry;
      }
    });
  }
  save(id: string, codecName: string, input: Payload) {
    if (!this.session || !identifier(id)) throw Error('Спочатку підтвердьте чинний сеанс.');
    const codec = this.codecs.get(codecName);
    if (!codec) fail();
    const next = payload(codec.decode(payload(input)));
    const existing = this.storage.getItem(PREFIX + id);
    if (existing !== null) {
      const old = this.read(id);
      if (
        old.codec !== codecName ||
        (old.payload.firstIntent !== null &&
          JSON.stringify(old.payload.firstIntent) !== JSON.stringify(next.firstIntent))
      )
        throw Error('Первісний запит незмінний до авторитетного підтвердження.');
    }
    this.write(id, codecName, next);
  }
  private write(id: string, codecName: string, value: Payload) {
    const codec = this.codecs.get(codecName)!;
    const text = JSON.stringify({
      version: 1,
      id,
      codec: codecName,
      codecVersion: codec.version,
      session: this.session,
      updatedAt: new Date().toISOString(),
      payload: value,
    });
    const keys = this.keys();
    let total = bytes(text);
    for (const key of keys)
      if (key !== PREFIX + id) total += bytes(this.storage.getItem(key) || '');
    if (
      bytes(text) > LIMITS.recordBytes ||
      total > LIMITS.totalBytes ||
      (!keys.includes(PREFIX + id) && keys.length >= LIMITS.records)
    )
      throw Error('Ліміт локальних чернеток перевищено. Запит не надіслано.');
    try {
      this.storage.setItem(PREFIX + id, text);
    } catch {
      throw Error('Не вдалося зберегти чернетку у вкладці. Запит не надіслано.');
    }
  }
  beforeSend(id: string): FirstIntent {
    const intent = this.read(id).payload.firstIntent;
    if (!intent) throw Error('Первісний запит ще не збережено.');
    return structuredClone(intent);
  }
  confirmed(id: string, acknowledgement: unknown) {
    const old = this.read(id),
      codec = this.codecs.get(old.codec)!;
    if (!codec.confirm) throw Error('Codec не підтримує підтвердження запиту.');
    const next = codec.confirm(structuredClone(old.payload), acknowledgement);
    if (next === null) this.discard(id);
    else this.write(id, old.codec, payload(codec.decode(payload(next))));
  }
  async restore(id: string, session: DraftSession, signal: AbortSignal) {
    if (!this.session || !sameSession(this.session, session))
      throw Error('Сеанс чернетки змінився.');
    const row = this.read(id),
      original = this.storage.getItem(PREFIX + id),
      codec = this.codecs.get(row.codec)!;
    if (!(await codec.authorize(structuredClone(row.payload), session, signal)))
      throw Object.assign(Error('Ця чернетка більше не доступна.'), { status: 403 });
    if (
      signal.aborted ||
      !this.session ||
      !sameSession(this.session, session) ||
      this.storage.getItem(PREFIX + id) !== original
    )
      throw Error('Відновлення скасовано.');
    codec.restore(structuredClone(row.payload));
  }
  discard(id: string) {
    if (!this.session || typeof id !== 'string' || id.length > 2048)
      throw Error('Спочатку підтвердьте чинний сеанс.');
    this.storage.removeItem(PREFIX + id);
  }
}
