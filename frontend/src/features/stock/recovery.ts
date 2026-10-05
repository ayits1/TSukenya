import type { createDraftRecovery } from '../../shared/recovery/bridge';
import type { Payload } from '../../shared/recovery/storage';
import { sameSession, type DraftSession } from '../../shared/recovery/session';
import { ApiError } from '../../shared/api/client';
import type { AssortmentRow } from './api';
import { captureTerms, draftKey, type Draft, type StockModel, type Terms } from './state';
import * as codec from './persistence';
import { createAssortmentRecoveryApi, AssortmentError, gate, type Fence } from './recoveryApi';
type P0 = Pick<
  ReturnType<typeof createDraftRecovery>,
  'store' | 'controller' | 'register' | 'close' | 'open'
>;
type RecordState = {
  payload: Payload;
  current: codec.Context | null;
  error: string;
  busy: boolean;
};
export type RecoveryView = {
  ready: boolean;
  busy: boolean;
  error: string;
  offers: { recordId: string; warehouse: number; product: string; name: string }[];
};
const visible = () => document.visibilityState !== 'hidden';
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Не вдалося відновити асортимент.';
export class AssortmentRecovery {
  private records = new Map<string, RecordState>();
  private unsaved = new Set<string>();
  private ids = new Map<string, string>();
  private verified = new Map<string, { payload: Payload; context: codec.Context }>();
  private shown = new Set<string>();
  private entries: string[] = [];
  private actor: DraftSession | null = null;
  private active = false;
  private serial = 0;
  private busy = false;
  private ready = false;
  private error = '';
  constructor(
    private model: StockModel,
    private p0: P0,
    private api = createAssortmentRecoveryApi(),
  ) {
    p0.register({
      name: codec.CODEC,
      version: 1,
      label: 'Асортимент товару на складі',
      decode: codec.decodePayload,
      confirm: codec.confirm,
      suspend: () => this.hide(),
      authorize: async (value, session, signal) => {
        const payload = codec.decodePayload(value),
          b = codec.baseline(payload.baseline);
        const f = { signal, session, current: () => !signal.aborted };
        if ((await codec.recordId(b.warehouse, b.row.product)) !== b.recordId) codec.fail();
        gate(f);
        let context: codec.Context;
        try {
          context = await api.context(b, f);
          gate(f);
        } catch (error) {
          this.denied(error, f);
          throw error;
        }
        if (context.store !== b.store) throw new ApiError(403, 'Магазин складу змінився.');
        this.verified.set(b.recordId, { payload, context });
        this.actor = session;
        return true;
      },
      restore: async (value, signal) => {
        const p = codec.decodePayload(value),
          b = codec.baseline(p.baseline);
        if (location.hash !== '#trade/stock') location.hash = '#trade/stock';
        const until = Date.now() + 30000;
        while (!this.active) {
          if (signal.aborted || Date.now() > until)
            throw new DOMException('Скасовано.', 'AbortError');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (signal.aborted || !this.actor) return;
        this.records.set(b.recordId, { payload: p, current: null, error: '', busy: false });
        this.ids.set(draftKey(b.warehouse, b.row.product), b.recordId);
        const serial = this.serial;
        const f = {
          signal,
          session: this.actor,
          current: () =>
            this.active && serial === this.serial && !this.model.state.denied && visible(),
        };
        try {
          await this.resolve(b.recordId, f);
          gate(f);
        } catch (error) {
          this.denied(error, f);
          throw error;
        }
        this.shown.add(b.recordId);
        this.ready = true;
        this.publish();
        setTimeout(() => {
          if (!signal.aborted && this.active && serial === this.serial) this.p0.close();
        }, 0);
      },
    });
  }
  private publish() {
    const drafts = new Map<string, Draft>();
    if (this.ready)
      for (const id of this.shown) {
        const entry = this.records.get(id);
        if (!entry) continue;
        const b = codec.baseline(entry.payload.baseline),
          d = codec.raw(entry.payload.draft),
          current = entry.current;
        const blocked =
          current && (!current.row || current.row.unit !== b.row.unit)
            ? 'Товар або одиницю змінено. Старе введення збережено; відкиньте чернетку перед новим введенням.'
            : '';
        drafts.set(draftKey(b.warehouse, b.row.product), {
          store: b.store,
          base: b.row,
          ...d,
          busy: entry.busy,
          error: entry.error || blocked,
          uncertain: !!entry.payload.firstIntent,
          server: entry.payload.firstIntent || blocked ? null : (current?.row ?? null),
          reading: entry.busy,
          review: b.review,
          blocked,
        });
      }
    const offers = this.entries
      .filter((id) => !this.shown.has(id) || !this.ready)
      .map((id) => {
        const v = this.verified.get(id);
        if (!v)
          return { recordId: id, warehouse: 0, product: '', name: 'Недоступна локальна чернетка' };
        const b = codec.baseline(v.payload.baseline);
        return {
          recordId: id,
          warehouse: b.warehouse,
          product: b.row.product,
          name: v.context.row?.name ?? b.row.name,
        };
      });
    this.model.recoveryChanged(drafts, {
      ready: this.ready,
      busy: this.busy,
      error: this.error,
      offers,
    });
  }
  private hide() {
    this.ready = false;
    this.shown.clear();
    // Do not erase/capture or recursively start P0 from a suspend callback.
    this.publish();
  }
  private denied(error: unknown, f: Fence) {
    gate(f);
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      if (this.active) this.model.deny(error.message);
      if (error.status === 401) {
        this.p0.controller.revoke();
        window.dispatchEvent(new Event('tsukenya:session-invalidated'));
      }
    }
  }
  private store(id: string, payload: Payload) {
    const next = codec.decodePayload(payload);
    this.p0.store.save(id, codec.CODEC, next);
    this.unsaved.delete(id);
    const previous = this.records.get(id);
    this.records.set(id, {
      payload: next,
      current: previous?.current ?? null,
      error: '',
      busy: previous?.busy ?? false,
    });
    if (!this.entries.includes(id)) this.entries.push(id);
  }
  async indexRows(warehouse: number, rows: AssortmentRow[]) {
    for (const row of rows)
      this.ids.set(draftKey(warehouse, row.product), await codec.recordId(warehouse, row.product));
  }
  async activate() {
    this.active = true;
    await this.start();
  }
  leave() {
    this.active = false;
    this.serial++;
    this.p0.controller.dismiss();
    this.busy = false;
    this.hide();
  }
  hasDrafts() {
    return this.entries.length > 0 || this.records.size > 0;
  }
  offer(warehouse: number, product: string) {
    const id = this.ids.get(draftKey(warehouse, product));
    return id && this.entries.includes(id) && !this.shown.has(id) ? id : null;
  }
  async start() {
    if (this.busy || !this.active) return;
    const serial = ++this.serial,
      previousActor = this.actor;
    this.busy = true;
    this.error = '';
    this.publish();
    try {
      const session = await this.p0.controller.check(false);
      if (!this.active || serial !== this.serial || !visible()) return;
      if (previousActor && !sameSession(previousActor, session)) {
        this.records.clear();
        this.verified.clear();
        this.unsaved.clear();
      }
      this.actor = session;
      const bootstrap = this.model.options?.bootstrap;
      if (!bootstrap || session.role !== bootstrap.role || session.storeId !== bootstrap.storeId)
        throw new ApiError(403, 'Доступ змінився. Перечитайте розділ.');
      for (const id of [...this.unsaved]) {
        const record = this.records.get(id);
        if (record) this.store(id, record.payload);
      }
      this.entries = this.p0.store
        .entries()
        .filter((e) => e.id.startsWith('assortment_'))
        .map((e) => e.id);
      for (const id of [...this.records.keys()])
        if (!this.entries.includes(id)) this.records.delete(id);
      this.verified.clear();
      const warm = new Set(this.records.keys());
      for (const id of this.entries) {
        const actor = await this.p0.controller.verify(id);
        if (!this.active || serial !== this.serial || !visible()) return;
        if (!actor || !sameSession(session, actor))
          throw Error('Не вдалося підтвердити доступ до всіх чернеток.');
      }
      for (const id of warm) {
        const entry = this.records.get(id),
          grant = this.verified.get(id);
        if (entry && grant) {
          entry.current = grant.context;
          this.shown.add(id);
        }
      }
      this.ready = true;
    } catch (error) {
      if (this.active && serial === this.serial) {
        this.error = message(error);
        if (
          error &&
          typeof error === 'object' &&
          'status' in error &&
          (error.status === 401 || error.status === 403)
        )
          this.model.deny(this.error);
      }
    } finally {
      if (serial === this.serial) {
        this.busy = false;
        this.publish();
      }
    }
  }
  edit(warehouse: number, row: AssortmentRow, patch: Partial<codec.Raw>) {
    if (!this.ready || !this.active || !this.actor) return;
    const id = this.ids.get(draftKey(warehouse, row.product));
    let pending: Payload | null = null;
    try {
      if (!id || this.offer(warehouse, row.product))
        throw Error('Спершу відновіть або відкиньте наявну чернетку.');
      const old = this.records.get(id),
        store = old
          ? codec.baseline(old.payload.baseline).store
          : (this.model.state.captions.get('warehouses:' + warehouse)?.store_id ??
            this.model.policy()?.store);
      if (!store) throw Error('Не підтверджено магазин складу.');
      const p =
        old?.payload ??
        codec.decodePayload({
          baseline: { recordId: id, warehouse, store, row, review: false },
          draft: { sold: row.sold, minimum: row.min_stock ?? '' },
          firstIntent: null,
          confirmation: null,
        });
      const next = { ...p, draft: codec.json({ ...codec.raw(p.draft), ...patch }) };
      pending = codec.decodePayload(next);
      this.store(id, next);
      this.shown.add(id);
      this.error = '';
    } catch (error) {
      this.error = message(error);
      if (pending && id) {
        const old = this.records.get(id);
        this.records.set(id, {
          payload: pending,
          current: old?.current ?? null,
          error: this.error,
          busy: false,
        });
        this.unsaved.add(id);
        this.shown.add(id);
      }
    }
    this.publish();
  }
  private accept(id: string, type: 'ack' | 'identity' | 'rejected', value: unknown) {
    let entry = this.records.get(id);
    if (!entry) codec.fail();
    if (this.unsaved.has(id)) {
      this.store(id, entry.payload);
      entry = this.records.get(id)!;
    }
    const event = { type, value },
      next = codec.confirm(entry.payload, event);
    this.p0.store.confirmed(id, event); // One durable write BEFORE in-memory adoption/current GET.
    entry.payload = next;
  }
  private async resolve(id: string, f: Fence) {
    let entry = this.records.get(id);
    if (!entry) codec.fail();
    if (entry.payload.firstIntent) {
      const found = await this.api.identity(codec.request(entry.payload.firstIntent.body), f);
      gate(f);
      this.accept(id, 'identity', found);
      entry = this.records.get(id);
      if (!entry) codec.fail();
    }
    const b = codec.baseline(entry.payload.baseline),
      current = await this.api.current(b, f);
    gate(f);
    if (current.store !== b.store) throw new ApiError(403, 'Магазин складу змінився.');
    // A user may type after ACK while this current GET is pending. Adopt only
    // the latest durable raw, never the object captured before that await.
    entry = this.records.get(id);
    if (!entry) codec.fail();
    entry.current = current;
    if (entry.payload.confirmation !== null) {
      let clean = false;
      try {
        const original = codec.raw(codec.object(entry.payload.confirmation).raw);
        clean =
          JSON.stringify(captureTerms(original)) ===
          JSON.stringify(captureTerms(codec.raw(entry.payload.draft)));
      } catch {
        /* New invalid input remains available for review; it is not discarded. */
      }
      if (clean) {
        this.p0.store.discard(id);
        this.records.delete(id);
        this.shown.delete(id);
        this.entries = this.entries.filter((v) => v !== id);
        this.verified.delete(id);
        return;
      }
    }
    // Cold restore always needs explicit local review; it does not adopt revision.
    if (!entry.payload.firstIntent && !b.review)
      this.store(id, { ...entry.payload, baseline: codec.json({ ...b, review: true }) });
  }
  private async run(id: string, work: (f: Fence) => Promise<void>) {
    if (this.busy || !this.active) return;
    const serial = ++this.serial;
    this.busy = true;
    this.error = '';
    this.publish();
    try {
      const result = await this.p0.controller.verifyRead(id, async (signal, session) => {
        const f = {
          signal,
          session,
          current: () =>
            this.active && serial === this.serial && !this.model.state.denied && visible(),
        };
        try {
          gate(f);
          const authorized = this.verified.get(id);
          if (!authorized) codec.fail();
          const b = codec.baseline(authorized.payload.baseline);
          // The fresh warehouse grant covers its other already-open rows. Keep
          // their input editable while the immutable write is pending.
          for (const [other, record] of this.records) {
            const base = codec.baseline(record.payload.baseline);
            if (base.warehouse === b.warehouse && base.store === b.store) this.shown.add(other);
          }
          this.records.get(id)!.busy = true;
          this.ready = true;
          this.publish();
          await work(f);
          gate(f);
        } catch (error) {
          this.denied(error, f);
          this.error = message(error);
          throw error;
        }
      });
      if (!this.active || serial !== this.serial) return;
      if (!result && !this.ready)
        this.model.deny('Доступ до чернетки не підтверджено. Перечитайте розділ.');
      if (!result)
        throw Error(this.error || 'Доступ або результат не підтверджено. Чернетку збережено.');
      if (this.records.has(id)) this.shown.add(id);
      this.ready = true;
      if (!this.records.has(id)) {
        this.error = 'Асортимент збережено.';
        await this.model.refresh();
      }
    } catch (error) {
      if (this.active && serial === this.serial) this.error = message(error);
    } finally {
      if (serial === this.serial) {
        this.busy = false;
        for (const entry of this.records.values()) entry.busy = false;
        this.publish();
        if (
          this.active &&
          this.ready &&
          !this.model.state.denied &&
          [...this.records.keys()].some((key) => !this.shown.has(key))
        ) {
          const notice = this.error;
          await this.start();
          if (this.ready && notice) {
            this.error = notice;
            this.publish();
          }
        }
      }
    }
  }
  async restore(id: string) {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.publish();
    try {
      const session = await this.p0.controller.restore(id);
      if (!session && this.active) this.error = 'Не вдалося відновити чернетку. Повторіть читання.';
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  async save(warehouse: number, product: string) {
    const id = this.ids.get(draftKey(warehouse, product)),
      entry = id && this.records.get(id);
    if (!id || !entry || !this.ready || this.busy) return;
    const firstLive = !entry.payload.firstIntent;
    try {
      const b = codec.baseline(entry.payload.baseline);
      if (this.unsaved.has(id)) this.store(id, entry.payload);
      if (firstLive) {
        if (b.review) throw Error('Перечитайте поточний стан і застосуйте порівняння.');
        const request: codec.Request = {
          key: crypto.randomUUID(),
          warehouse,
          product,
          revision: b.row.revision,
          unit: b.row.unit,
          terms: captureTerms(codec.raw(entry.payload.draft)),
        };
        this.store(id, {
          ...entry.payload,
          confirmation: null,
          firstIntent: {
            method: 'POST',
            path: codec.PATH + 'execute',
            key: request.key,
            body: codec.json(request),
            revision: request.revision,
            possiblySent: true,
          },
        });
      }
    } catch (error) {
      this.error = message(error);
      this.publish();
      return;
    }
    await this.run(id, async (f) => {
      const request = codec.request(this.p0.store.beforeSend(id).body);
      if (!firstLive) {
        const found = await this.api.identity(request, f);
        gate(f);
        this.accept(id, 'identity', found);
        if (!this.records.get(id)!.payload.firstIntent) {
          await this.resolve(id, f);
          return;
        }
      }
      try {
        const ack = await this.api.execute(request, f);
        gate(f);
        this.accept(id, 'ack', ack);
      } catch (error) {
        gate(f);
        if (
          firstLive &&
          error instanceof AssortmentError &&
          (error.status === 400 || (error.status === 409 && error.code === 'revision_conflict'))
        ) {
          this.accept(id, 'rejected', error.rejection);
        }
        throw error;
      }
      await this.resolve(id, f);
    });
  }
  async compare(warehouse: number, product: string) {
    const id = this.ids.get(draftKey(warehouse, product));
    if (!id || !this.records.has(id)) return;
    await this.run(id, (f) => this.resolve(id, f));
  }
  apply(key: string, value: Terms) {
    const id = this.ids.get(key),
      entry = id && this.records.get(id);
    if (!id || !entry || !this.ready || this.busy) return;
    try {
      const b = codec.baseline(entry.payload.baseline),
        current = entry.current;
      if (
        entry.payload.firstIntent ||
        !current?.row ||
        current.row.unit !== b.row.unit ||
        current.store !== b.store
      )
        throw Error('Спершу підтвердьте первісний запит і чинну одиницю.');
      const draft = { sold: value.sold, minimum: value.min_stock ?? '' };
      captureTerms(draft);
      this.store(id, {
        baseline: codec.json({ ...b, row: current.row, review: false }),
        draft: codec.json(draft),
        firstIntent: null,
        confirmation: null,
      });
      this.records.get(id)!.current = null;
      this.error = 'Узгоджено лише чернетку. Натисніть «Зберегти» окремо.';
    } catch (error) {
      this.error = message(error);
    }
    this.publish();
  }
  async discard(id: string) {
    if (this.busy) return;
    const serial = ++this.serial;
    this.busy = true;
    try {
      await this.p0.controller.discard(id);
      if (!this.active || serial !== this.serial) return;
      if (this.p0.controller.snapshot().state === 'error')
        throw Error(this.p0.controller.snapshot().error);
      this.records.delete(id);
      this.verified.delete(id);
      this.entries = this.entries.filter((x) => x !== id);
    } catch (error) {
      this.error = message(error);
    } finally {
      if (serial === this.serial) {
        this.busy = false;
        this.publish();
      }
    }
    if (this.active && serial === this.serial) {
      await this.start();
      await this.model.refresh();
    }
  }
  async reset(key: string) {
    const id = this.ids.get(key);
    if (id) await this.discard(id);
  }
  cancel() {
    this.serial++;
    this.p0.controller.dismiss();
    this.busy = false;
    this.ready = false;
    this.error = 'Читання скасовано. Первісний запит і введення збережено.';
    this.publish();
  }
  openRecovery() {
    this.p0.open();
  }
}
