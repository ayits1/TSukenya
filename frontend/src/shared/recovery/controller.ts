import { readDraftSession, type DraftSession } from './session';
import { DraftStore, type Entry } from './storage';
export type RecoveryView = {
  state: 'checking' | 'ready' | 'error';
  entries: Entry[];
  error: string;
};
export class RecoveryController {
  private generation = 0;
  private request: AbortController | null = null;
  private session: DraftSession | null = null;
  private listeners = new Set<() => void>();
  private view: RecoveryView = { state: 'checking', entries: [], error: '' };
  constructor(
    readonly store: DraftStore,
    private readSession = readDraftSession,
    private revoked: () => void = () => {},
  ) {}
  snapshot = () => this.view;
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };
  private show(view: RecoveryView) {
    this.view = view;
    for (const notify of this.listeners) notify();
  }
  refreshEntries() {
    this.show({ state: 'ready', entries: this.store.entries(), error: '' });
  }
  dismiss() {
    ++this.generation;
    this.request?.abort();
    this.request = null;
    this.show({ state: 'checking', entries: [], error: '' });
  }
  suspend() {
    this.dismiss();
    this.session = null;
    this.store.suspend();
  }
  revoke() {
    this.suspend();
    try {
      this.store.erase();
    } catch {
      /* Private UI stays hidden even if storage removal is denied. */
    }
    this.revoked();
  }
  async check(revealEntries = true): Promise<DraftSession> {
    this.suspend();
    const generation = this.generation,
      request = (this.request = new AbortController());
    try {
      const session = await this.readSession(request.signal);
      if (request.signal.aborted || generation !== this.generation)
        throw Error('Перевірку скасовано.');
      this.store.bind(session);
      this.session = session;
      if (revealEntries) this.refreshEntries();
      return session;
    } catch (error) {
      if (request.signal.aborted || generation !== this.generation) throw error;
      const status = error instanceof Error && 'status' in error ? error.status : null;
      if (status === 401 || status === 403) this.revoke();
      this.show({
        state: 'error',
        entries: [],
        error:
          'Не вдалося підтвердити доступ до локальних чернеток. Повторіть лише перевірку сеансу.',
      });
      throw error;
    } finally {
      if (generation === this.generation) this.request = null;
    }
  }
  restore(id: string) {
    return this.authorizeRecord(id, true);
  }
  verify(id: string) {
    return this.authorizeRecord(id, false);
  }
  async verifyRead<T>(
    id: string,
    read: (signal: AbortSignal, session: DraftSession) => Promise<T>,
  ) {
    const values: T[] = [];
    const session = await this.authorizeRecord(id, false, async (signal, actor) => {
      values.push(await read(signal, actor));
    });
    return session ? { session, value: values[0]! } : null;
  }
  private async authorizeRecord(
    id: string,
    render: boolean,
    read?: (signal: AbortSignal, session: DraftSession) => Promise<void>,
  ): Promise<DraftSession | null> {
    let session: DraftSession;
    try {
      session = await this.check(false);
    } catch {
      return null;
    }
    const generation = this.generation,
      request = (this.request = new AbortController());
    try {
      if (render) await this.store.restore(id, session, request.signal);
      else await this.store.verify(id, session, request.signal);
      if (request.signal.aborted || generation !== this.generation) return null;
      if (read) await read(request.signal, session);
      if (request.signal.aborted || generation !== this.generation) return null;
      this.refreshEntries();
      return session;
    } catch (error) {
      if (request.signal.aborted || generation !== this.generation) return null;
      const status = error instanceof Error && 'status' in error ? error.status : null;
      if (status === 401) this.revoke();
      if (status === 403) {
        // A resource denial is not a session-wide revocation. Recheck actor/scope before
        // showing other records, and delete only the denied resource's local record.
        const denialGeneration = this.generation + 1;
        try {
          await this.check(false);
        } catch {
          return null; // Session failure already hides records; 401/403 revokes globally.
        }
        if (denialGeneration !== this.generation || !this.session) return null;
        try {
          this.store.discard(id);
        } catch {
          this.show({
            state: 'error',
            entries: [],
            error:
              'Доступ до цієї чернетки закрито. Не вдалося прибрати її локальний запис. Інші чернетки збережені.',
          });
          return null;
        }
      }
      this.show({
        state: 'error',
        entries: [],
        error:
          status === 403
            ? 'Доступ до цієї чернетки закрито. Інші локальні чернетки збережені. Повторіть перевірку, щоб їх відкрити.'
            : 'Не вдалося відновити чернетку. Повторіть перевірку доступу.',
      });
      return null;
    } finally {
      if (generation === this.generation) this.request = null;
    }
  }
  async discard(id: string) {
    await this.check(false);
    if (!this.session) return;
    try {
      this.store.discard(id);
      this.refreshEntries();
    } catch {
      this.show({
        state: 'error',
        entries: [],
        error:
          'Не вдалося відкинути локальну чернетку. Запис збережено; повторіть перевірку і спробуйте ще раз.',
      });
    }
  }
  install(target: Window) {
    const refresh = () => {
        void this.check().catch(() => {});
      },
      hide = () => this.suspend(),
      revoke = () => this.revoke();
    target.addEventListener('focus', refresh);
    target.addEventListener('pageshow', refresh);
    target.addEventListener('pagehide', hide);
    target.addEventListener('tsukenya:session-invalidated', revoke);
    const visibility = () => {
      if (target.document.visibilityState === 'hidden') hide();
      else refresh();
    };
    target.document.addEventListener('visibilitychange', visibility);
    return () => {
      this.suspend();
      target.removeEventListener('focus', refresh);
      target.removeEventListener('pageshow', refresh);
      target.removeEventListener('pagehide', hide);
      target.removeEventListener('tsukenya:session-invalidated', revoke);
      target.document.removeEventListener('visibilitychange', visibility);
    };
  }
}
