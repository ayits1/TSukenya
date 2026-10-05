import type { createDraftRecovery } from '../../shared/recovery/bridge';
import type { Payload, Json } from '../../shared/recovery/storage';
import type { DraftSession } from '../../shared/recovery/session';
import { ApiError } from '../../shared/api/client';
import { createLabelRecoveryApi, LabelSaveError, cancelled, gate } from './recoveryApi';
import type { LabelRecoveryApi, Fence } from './recoveryApi';
import type { Workspace } from './api';
import {
  baseline,
  raw,
  request,
  decodePayload,
  prepare,
  confirm,
  reject,
  LABEL_DRAFT,
  RECORD_ID,
} from './persistence';
import type { Raw, Receipt } from './persistence';

type P0 = Pick<
  ReturnType<typeof createDraftRecovery>,
  'store' | 'controller' | 'register' | 'close'
>;
export type LabelRecoveryView = {
  phase: 'checking' | 'offer' | 'ready' | 'error';
  error: string;
  workspace: Workspace | null;
  generation: number;
};
const message = (e: unknown) => (e instanceof Error ? e.message : 'Не вдалося підтвердити макет.');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export class LabelRecovery {
  private listeners = new Set<() => void>();
  private view: LabelRecoveryView = {
    phase: 'checking',
    error: '',
    workspace: null,
    generation: 0,
  };
  private actor: DraftSession | null = null;
  private p: Payload | null = null;
  private active = false;
  private busy = false;
  private serial = 0;
  private local: AbortController | null = null;
  private host: HTMLElement | null = null;
  private unsubscribe: () => void;
  constructor(
    private p0: P0,
    private api: LabelRecoveryApi = createLabelRecoveryApi(),
  ) {
    p0.register({
      name: LABEL_DRAFT,
      version: 1,
      label: 'Макет і реквізити цінників',
      decode: decodePayload,
      suspend: () => this.hide(),
      authorize: async (_payload, session, signal) => {
        const f = { signal, session, current: () => !signal.aborted };
        await this.api.context(f);
        gate(f);
        this.actor = session;
        return true;
      },
      restore: async (payload, signal) => {
        this.busy = true;
        try {
          this.p = decodePayload(payload);
          if (location.hash !== '#operations/tags') location.hash = '#operations/tags';
          const end = Date.now() + 30000;
          while (!this.active) {
            if (signal.aborted || Date.now() > end) throw cancelled();
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (!this.actor || signal.aborted) throw cancelled();
          const serial = this.serial;
          await this.resolve({
            signal,
            session: this.actor,
            current: () => this.active && this.serial === serial,
          });
          // P0 performs its final signal fence before this deferred panel close.
          setTimeout(() => {
            if (
              this.active &&
              this.serial === serial &&
              this.view.phase === 'ready' &&
              !signal.aborted
            )
              this.p0.close();
          }, 0);
        } catch (error) {
          if (this.active && this.view.phase === 'checking') this.show('error', message(error));
          throw error;
        } finally {
          this.busy = false;
        }
      },
      confirm: (payload, value) =>
        value && typeof value === 'object' && 'write_rejected' in value
          ? reject(payload, value)
          : confirm(payload, value),
    });
    this.unsubscribe = p0.controller.subscribe(() => {
      if (
        this.active &&
        !this.busy &&
        this.p &&
        this.view.phase === 'checking' &&
        p0.controller.snapshot().state === 'ready'
      )
        void this.warm();
    });
  }
  snapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  payload = () => (this.p ? decodePayload(this.p) : null);
  private show(
    phase: LabelRecoveryView['phase'],
    error = '',
    workspace = this.view.workspace,
    remount = false,
  ) {
    this.view = { phase, error, workspace, generation: this.view.generation + Number(remount) };
    if (this.host) this.host.hidden = phase !== 'ready';
    for (const listener of this.listeners) listener();
  }
  private hide() {
    this.local?.abort();
    this.local = null;
    if (this.host) this.host.hidden = true;
    this.show('checking');
  }
  private store(p: Payload) {
    const value = decodePayload(p);
    this.p0.store.save(RECORD_ID, LABEL_DRAFT, value);
    this.p = value;
  }
  private fresh(workspace: Workspace): Payload {
    return decodePayload({
      baseline: {
        original: { config: workspace.config, settings: workspace.settings },
        revision: workspace.revision,
        key: crypto.randomUUID(),
        review: false,
        frozenRaw: null,
      },
      draft: { config: workspace.config, settings: workspace.settings, fontSizes: {} },
      firstIntent: null,
      confirmation: null,
    });
  }
  async mount(host: HTMLElement) {
    this.active = true;
    this.host = host;
    // A cold Restore has already passed P0 authorization and owns its signal.
    if (this.p && this.view.phase === 'checking' && this.busy) return;
    await this.start();
  }
  leave() {
    if (this.busy) this.p0.controller.dismiss();
    this.active = false;
    this.serial++;
    this.local?.abort();
    this.local = null;
    this.host = null;
    this.p = null;
    this.show('checking', '', null);
  }
  private async failed(error: unknown, serial: number) {
    if (
      !this.active ||
      serial !== this.serial ||
      (error instanceof Error && error.name === 'AbortError')
    )
      return;
    this.show('error', message(error));
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      if (error.status === 401) this.p0.controller.revoke();
      else await this.p0.controller.check(false).catch(() => {});
      if (this.active && serial === this.serial)
        this.show('error', 'Доступ до чернетки не підтверджено. Повторіть перевірку.');
    }
  }
  async start() {
    const serial = ++this.serial;
    this.busy = true;
    this.show('checking');
    try {
      const actor = await this.p0.controller.check(false);
      if (!this.active || serial !== this.serial) return;
      this.actor = actor;
      const local = (this.local = new AbortController()),
        f = {
          signal: local.signal,
          session: actor,
          current: () => this.active && serial === this.serial,
        };
      await this.api.context(f);
      gate(f);
      if (this.p0.store.entries().some((entry) => entry.id === RECORD_ID)) {
        this.show('offer');
        return;
      }
      const current = await this.api.workspace(f);
      gate(f);
      await this.api.context(f);
      gate(f);
      this.p = this.fresh(current);
      this.show('ready', '', current, true);
    } catch (error) {
      await this.failed(error, serial);
    } finally {
      if (serial === this.serial) this.busy = false;
    }
  }
  async restore() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.p0.controller.restore(RECORD_ID);
    } finally {
      this.busy = false;
      if (this.active && this.view.phase === 'checking')
        this.show('error', 'Не вдалося відновити чернетку. Повторіть перевірку доступу.');
    }
  }
  async discard() {
    if (this.busy) return;
    const serial = ++this.serial;
    this.busy = true;
    try {
      await this.p0.controller.discard(RECORD_ID);
      if (!this.active || serial !== this.serial) return;
      this.p = null;
    } catch (error) {
      await this.failed(error, serial);
      return;
    } finally {
      this.busy = false;
    }
    if (this.active && serial === this.serial) await this.start();
  }
  capture(draft: Raw) {
    if (!this.p || this.view.phase !== 'ready') throw Error('Спершу підтвердьте доступ до макета.');
    this.store({ ...this.p, draft: raw(draft) as unknown as Json });
  }
  private accepted(result: Receipt) {
    this.p0.store.confirmed(RECORD_ID, result);
    if (!this.p) throw cancelled();
    this.p = confirm(this.p, result);
  }
  private async resolve(f: Fence, remount = true) {
    if (!this.p) throw cancelled();
    if (this.p.firstIntent) {
      const result = await this.api.identity(request(this.p.firstIntent.body), f);
      gate(f);
      if (result.confirmed) this.accepted(result); // Durable BEFORE independent current read.
    }
    const current = await this.api.workspace(f);
    gate(f);
    await this.api.context(f);
    gate(f);
    if (!this.p) throw cancelled();
    const b = baseline(this.p.baseline);
    if (this.p.confirmation && b.frozenRaw && same(this.p.draft, b.frozenRaw)) {
      this.p0.store.discard(RECORD_ID);
      this.p = this.fresh(current);
    } else if (!this.p.firstIntent) {
      this.store({ ...this.p, baseline: { ...b, review: true } as unknown as Json });
    }
    this.show('ready', '', current, remount);
    return current;
  }
  async read(remount = true) {
    if (this.busy || !this.p) return null;
    if (!this.p0.store.entries().some((entry) => entry.id === RECORD_ID)) {
      this.p = null;
      await this.start();
      return this.view.phase === 'ready' ? this.view.workspace : null;
    }
    const serial = ++this.serial;
    this.busy = true;
    try {
      const result = await this.p0.controller.verifyRead(RECORD_ID, async (signal, session) => {
        const f = { signal, session, current: () => this.active && serial === this.serial };
        return this.resolve(f, remount);
      });
      if (!result && this.active && serial === this.serial)
        this.show('error', 'Не вдалося підтвердити доступ до чернетки.');
      return result?.value ?? null;
    } catch (error) {
      await this.failed(error, serial);
      return null;
    } finally {
      if (serial === this.serial) this.busy = false;
    }
  }
  private async warm() {
    if (!this.p) return;
    if (this.p.firstIntent || this.p.confirmation) {
      await this.read();
      return;
    }
    const serial = ++this.serial;
    this.busy = true;
    try {
      // Clean open workspace has no disk record until its first local edit.
      if (!this.p0.store.entries().some((entry) => entry.id === RECORD_ID)) {
        this.busy = false;
        await this.start();
        return;
      }
      const actor = await this.p0.controller.verify(RECORD_ID);
      if (actor && this.active && serial === this.serial) this.show('ready');
      else if (this.active && serial === this.serial)
        this.show('error', 'Не вдалося підтвердити доступ до чернетки.');
    } finally {
      if (serial === this.serial) this.busy = false;
    }
  }
  apply(draft: Raw, current: Workspace) {
    if (!this.p || this.p.firstIntent || this.view.phase !== 'ready')
      throw Error('Спершу звірте первісний запит.');
    this.store({ ...this.fresh(current), draft: raw(draft) as unknown as Json });
  }
  async save(draft: Raw, retry = false) {
    if (this.busy || !this.p) return null;
    this.capture(draft);
    const firstLive = !this.p.firstIntent;
    if (retry !== !firstLive) throw Error('Спершу звірте стан первісного запиту.');
    if (firstLive) this.store(prepare(this.p));
    const serial = ++this.serial;
    this.busy = true;
    try {
      const result = await this.p0.controller.verifyRead(RECORD_ID, async (signal, session) => {
        const f = { signal, session, current: () => this.active && serial === this.serial };
        // The actual immutable body is re-read from durable storage after the last check.
        const body = request(this.p0.store.beforeSend(RECORD_ID).body);
        if (!firstLive) {
          const identity = await this.api.identity(body, f);
          gate(f);
          if (identity.confirmed) {
            this.accepted(identity);
            return this.resolve(f);
          }
        }
        try {
          const ack = await this.api.execute(body, f);
          gate(f);
          this.accepted(ack);
        } catch (error) {
          gate(f);
          if (
            firstLive &&
            error instanceof LabelSaveError &&
            (error.status === 400 || (error.status === 409 && error.code === 'revision_conflict'))
          ) {
            const next = reject(this.p!, error.rejection);
            this.p0.store.confirmed(RECORD_ID, error.rejection);
            this.p = next;
          }
          throw error;
        }
        return this.resolve(f, retry);
      });
      if (!result && this.active && serial === this.serial)
        this.show('error', 'Збереження потребує перевірки. Первісний запит і чернетку збережено.');
      return result?.value ?? null;
    } catch (error) {
      await this.failed(error, serial);
      return null;
    } finally {
      if (serial === this.serial) this.busy = false;
    }
  }
  cancel() {
    this.serial++;
    this.local?.abort();
    this.local = null;
    this.p0.controller.dismiss();
    this.busy = false;
    if (this.active)
      this.show(
        this.p ? 'offer' : 'error',
        this.p ? '' : 'Перевірку скасовано. Чернетка не змінена.',
      );
  }
  dispose() {
    this.leave();
    this.unsubscribe();
  }
}
