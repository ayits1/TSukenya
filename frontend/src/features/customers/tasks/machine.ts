import { flushSync } from 'react-dom';
import type { Payload } from '../../../shared/recovery/storage';
import {
  sameSession,
  decodeDraftSession,
  type DraftSession,
} from '../../../shared/recovery/session';
import * as api from './api';
export type View = {
  payload: Payload;
  visible: boolean;
  existing: boolean;
  busy: boolean;
  error: string;
  current: api.TaskRead | null;
  comparison: boolean;
};
let active: TaskMachine | null = null;
let mount: (machine: TaskMachine) => void = () => {};
export function installTaskRecovery(render: typeof mount) {
  mount = render;
  const recovery = window.NativeDraftRecovery;
  if (!recovery) return;
  let restoredSignal: AbortSignal | null = null;
  recovery.controller.subscribe(() => {
    if (recovery.controller.snapshot().state !== 'ready' || !restoredSignal) return;
    const signal = restoredSignal;
    restoredSignal = null;
    queueMicrotask(() => {
      if (!signal.aborted) {
        recovery.close();
        document
          .querySelector<HTMLDialogElement>('.contact-task-editor-dialog')
          ?.querySelector<HTMLInputElement>('input')
          ?.focus();
      }
    });
  });
  recovery.register({
    name: 'contact_task',
    version: 1,
    label: 'Задача контакту',
    decode: api.payload,
    confirm: api.confirm,
    authorize: async (p, session, signal) => {
      const s = api.state(p.baseline);
      const params = new URLSearchParams({
        customer: String(s.customer),
        store: String(s.store),
        id: s.id,
      });
      const x = api.obj(
        await api.request('/api/v1/crm/contact-task-context?' + params, {}, signal),
      );
      api.exact(x, ['resource', 'id', 'exists', 'customer', 'store', 'role', 'storeId', 'canEdit']);
      if (
        x.resource !== 'contact_task' ||
        x.id !== s.id ||
        typeof x.exists !== 'boolean' ||
        (s.confirmed && !x.exists) ||
        x.customer !== s.customer ||
        x.store !== s.store ||
        x.role !== session.role ||
        x.storeId !== session.storeId
      )
        throw Object.assign(Error('Доступ змінився.'), { status: 403 });
      return x.canEdit === true;
    },
    restore: (p, signal) => {
      if (signal.aborted) return;
      active?.dispose(false);
      if (signal.aborted) return;
      active = new TaskMachine(api.payload(p));
      mount(active);
      restoredSignal = signal;
    },
    suspend: () => {
      if (active) flushSync(() => active?.suspend());
    },
  });
}
export function openTask(customer: number, store: number, row?: api.Task) {
  const id = row?.id || crypto.randomUUID(),
    base = row
      ? api.project(row.terms)
      : { title: '', note: '', due_on: '', assignee: '', status: 'todo', archived: false };
  const s: api.State = {
    recordId: 'contact_' + id,
    id,
    customer,
    store,
    revision: row?.revision || null,
    base,
    needsReview: false,
    confirmed: !!row,
  };
  active?.dispose();
  active = new TaskMachine({
    baseline: api.json(s),
    draft: api.json(base),
    firstIntent: null,
    confirmation: null,
  });
  mount(active);
  void active.prepare();
}
export class TaskMachine {
  private disposed = false;
  private granted: DraftSession | null = null;
  private generation = 0;
  private request: AbortController | null = null;
  private listeners = new Set<() => void>();
  private firstLive = false;
  private verifying = false;
  private unsubscribe: (() => void) | null = null;
  view: View;
  constructor(p: Payload) {
    this.view = {
      payload: api.payload(p),
      visible: true,
      existing: false,
      busy: false,
      error: '',
      current: null,
      comparison: false,
    };
    const recovery = window.NativeDraftRecovery;
    if (recovery)
      this.unsubscribe = recovery.controller.subscribe(() => {
        if (
          recovery.controller.snapshot().state === 'ready' &&
          !this.view.visible &&
          !this.verifying
        )
          void this.verify();
      });
  }
  snapshot = () => this.view;
  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  };
  private set(next: Partial<View>) {
    this.view = { ...this.view, ...next };
    for (const f of this.listeners) f();
  }
  private recovery() {
    return window.NativeDraftRecovery || api.fail();
  }
  private persist(p: Payload) {
    this.recovery().store.save(api.state(p.baseline).recordId, 'contact_task', p);
    this.set({ payload: p });
  }
  raw(next: api.Raw) {
    if (this.view.existing || this.disposed) return;
    this.set({
      payload: { ...this.view.payload, draft: api.json(next) },
      current: null,
      comparison: false,
    });
    try {
      this.persist(this.view.payload);
      this.set({ error: '' });
    } catch (e) {
      this.set({ error: String(e) });
    }
  }
  async prepare() {
    if (this.disposed) return;
    this.set({ visible: false });
    try {
      await this.recovery().controller.check(false);
      if (this.disposed) return;
      const id = api.state(this.view.payload.baseline).recordId;
      if (
        this.recovery()
          .store.entries()
          .some((entry) => entry.id === id)
      ) {
        this.set({
          existing: true,
          visible: false,
          error:
            'Для цієї задачі є локальна чернетка. Відновіть або явно відкиньте її; поточний запис її не замінює.',
        });
        return;
      }
      this.persist(this.view.payload);
      await this.verify();
    } catch (e) {
      this.set({ visible: false, error: String(e) });
    }
  }
  suspend() {
    this.firstLive = false;
    this.granted = null;
    this.generation++;
    this.request?.abort();
    this.request = null;
    this.set({ visible: false, busy: false, current: null, comparison: false });
  }
  dispose(cancelRead = true) {
    if (this.disposed) return;
    this.disposed = true;
    if (cancelRead) this.recovery().controller.dismiss();
    this.suspend();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
    if (active === this) active = null;
  }
  async restoreExisting() {
    if (!this.view.existing || this.disposed) return;
    try {
      await this.recovery().controller.restore(api.state(this.view.payload.baseline).recordId);
    } catch (error) {
      if (!this.disposed) this.set({ error: String(error) });
    }
  }
  async verify() {
    if (this.view.existing) return false;
    if (this.verifying || this.disposed) return false;
    this.verifying = true;
    try {
      const s = api.state(this.view.payload.baseline);
      const result = await this.recovery().controller.verify(s.recordId);
      if (result && !this.disposed) {
        this.granted = result;
        this.set({ visible: true, error: '' });
        return true;
      }
      this.set({ error: 'Доступ не підтверджено. Повторіть перевірку.' });
      return false;
    } catch (e) {
      this.set({ error: String(e) });
      return false;
    } finally {
      this.verifying = false;
    }
  }
  private confirm(type: string, raw: unknown, draft = this.view.payload.draft) {
    const s = api.state(this.view.payload.baseline);
    const event = { type, raw, draft };
    const next = api.confirm(this.view.payload, event);
    this.recovery().store.confirmed(s.recordId, event);
    if (next) this.set({ payload: next, current: null, comparison: false });
    return next;
  }
  async current() {
    if (this.disposed) return;
    const s = api.state(this.view.payload.baseline);
    if (!s.confirmed) return;
    this.suspend();
    this.verifying = true;
    this.set({ busy: true, error: '' });
    try {
      const found = await this.recovery().controller.verifyRead(s.recordId, async (signal) =>
        api.read(await api.request('/api/v1/crm/contact-tasks/' + s.id, {}, signal), s.id),
      );
      if (found && !this.disposed) {
        if (found.value.record.store !== s.store || found.value.record.customer !== s.customer)
          api.fail();
        this.set({ visible: true, current: found.value });
      } else this.set({ error: 'Не вдалося перечитати задачу. Повторіть лише читання.' });
    } catch (e) {
      this.set({ error: String(e) });
    } finally {
      this.verifying = false;
      this.set({ busy: false });
    }
  }
  compare() {
    if (this.view.current && !this.view.payload.firstIntent) this.set({ comparison: true });
  }
  cancelCompare() {
    this.set({ comparison: false });
  }
  apply(raw: api.Raw) {
    if (!this.view.current || this.view.payload.firstIntent) return;
    try {
      this.confirm('apply', this.view.current, api.json(raw));
      this.set({
        comparison: false,
        current: null,
        error: 'Порівняння застосовано локально. Натисніть «Зберегти» окремо.',
      });
    } catch (error) {
      this.set({ error: String(error) });
    }
  }
  async identity() {
    if (this.disposed) return;
    const p = this.view.payload,
      f = p.firstIntent;
    if (!f) return;
    const s = api.state(p.baseline);
    this.suspend();
    this.verifying = true;
    this.set({ busy: true, error: '' });
    try {
      const found = await this.recovery().controller.verifyRead(
        s.recordId,
        async (signal, actor) => {
          const session = api.obj(await api.request('/api/v1/session', {}, signal));
          if (signal.aborted) throw new DOMException('Скасовано', 'AbortError');
          if (!sameSession(actor, decodeDraftSession(session))) {
            this.suspend();
            await this.recovery().controller.check(false);
            throw new DOMException('Сеанс змінився', 'AbortError');
          }
          const raw = await api.request(
            '/api/v1/crm/contact-tasks/identity',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': api.text(session.csrf),
              },
              body: JSON.stringify({
                id: s.id,
                action: f.method === 'POST' ? 'create' : 'update',
                request: f.body,
              }),
            },
            signal,
          );
          api.ack(raw, p, true);
          return raw;
        },
      );
      if (found && !this.disposed) {
        this.set({ visible: true });
        this.confirm('identity', found.value);
      }
    } catch (e) {
      this.set({ error: String(e) });
    } finally {
      this.verifying = false;
      this.set({ busy: false });
    }
    if (api.state(this.view.payload.baseline).confirmed && !this.view.payload.firstIntent)
      await this.current();
  }
  async denied(status: unknown) {
    flushSync(() => this.suspend());
    if (status === 401) {
      this.recovery().controller.revoke();
      window.dispatchEvent(new Event('tsukenya:session-invalidated'));
      location.assign('/');
      return;
    }
    const s = api.state(this.view.payload.baseline);
    await this.recovery().controller.verifyRead(s.recordId, async () => {
      throw Object.assign(Error('Доступ до задачі закрито.'), { status: 403 });
    });
  }
  async save() {
    if (this.view.busy) return;
    try {
      if (!(await this.verify())) return;
      let p = this.view.payload;
      const s = api.state(p.baseline);
      if (!p.firstIntent) {
        if (s.needsReview || (s.confirmed && s.revision === null))
          throw Error('Перечитайте поточну задачу й застосуйте порівняння.');
        const t = api.capture(api.raw(p.draft)),
          key = crypto.randomUUID(),
          creating = !s.confirmed;
        const body = creating
          ? { id: s.id, request_key: key, customer: s.customer, store: s.store, terms: t }
          : { request_key: key, revision: s.revision, terms: t };
        p = {
          ...p,
          firstIntent: {
            method: creating ? 'POST' : 'PATCH',
            path: '/api/v1/crm/contact-tasks' + (creating ? '' : '/' + s.id),
            key,
            body: api.json(body),
            revision: s.revision,
            possiblySent: true,
          },
        };
        this.persist(p);
        this.firstLive = true;
      }
      const f = this.recovery().store.beforeSend(s.recordId),
        frozen = JSON.stringify(f),
        granted = this.granted || api.fail();
      this.set({ busy: true, error: '' });
      const generation = ++this.generation,
        request = (this.request = new AbortController());
      const rawSession = await api.request('/api/v1/session', {}, request.signal),
        session = decodeDraftSession(rawSession);
      const live = () =>
        generation === this.generation &&
        !request.signal.aborted &&
        this.view.visible &&
        document.visibilityState !== 'hidden' &&
        JSON.stringify(this.view.payload.firstIntent) === frozen;
      if (!live()) return;
      if (!sameSession(granted, session)) {
        await this.recovery().controller.check(false);
        this.suspend();
        return;
      }
      const response = await fetch(f.path, {
        method: f.method,
        credentials: 'same-origin',
        signal: request.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': api.text(api.obj(rawSession).csrf),
        },
        body: JSON.stringify(f.body),
      });
      if (!live()) return;
      if (response.status === 401 || response.status === 403) {
        await this.denied(response.status);
        throw Error('Доступ до задачі відкликано.');
      }
      const raw: unknown = await response.json();
      if (!live()) return;
      if (!response.ok) {
        if (
          this.firstLive &&
          ((response.status === 400 && api.obj(raw).code === 'validation_error') ||
            (response.status === 409 && api.obj(raw).code === 'revision_conflict'))
        ) {
          try {
            this.confirm('rejected', raw);
            this.firstLive = false;
          } catch {
            /* no bound rollback proof: retain original */
          }
        }
        throw Error(
          typeof api.obj(raw).error === 'string'
            ? String(api.obj(raw).error)
            : 'Запит не підтверджено.',
        );
      }
      api.ack(raw, this.view.payload);
      this.confirm('ack', raw);
      this.firstLive = false;
      this.set({ error: 'Запис підтверджено. Перечитайте поточний стан.' });
      await this.current();
    } catch (e) {
      this.firstLive = false;
      if (
        !this.disposed &&
        this.request &&
        !this.request.signal.aborted &&
        this.view.visible &&
        document.visibilityState !== 'hidden' &&
        e &&
        typeof e === 'object' &&
        'status' in e &&
        (e.status === 401 || e.status === 403)
      )
        await this.denied(e.status);
      this.set({ error: String(e) });
    } finally {
      this.set({ busy: false });
    }
  }
  async discard() {
    if (this.disposed) return false;
    this.suspend();
    try {
      await this.recovery().controller.discard(api.state(this.view.payload.baseline).recordId);
      if (this.recovery().controller.snapshot().state === 'error') {
        this.set({ error: this.recovery().controller.snapshot().error });
        return false;
      }
      return true;
    } catch (e) {
      this.suspend();
      this.set({ error: String(e) });
      return false;
    }
  }
}
