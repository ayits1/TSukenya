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
  suspend() {
    ++this.generation;
    this.request?.abort();
    this.request = null;
    this.session = null;
    this.store.suspend();
    this.show({ state: 'checking', entries: [], error: '' });
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
  async check(): Promise<DraftSession> {
    this.suspend();
    const generation = this.generation,
      request = (this.request = new AbortController());
    try {
      const session = await this.readSession(request.signal);
      if (request.signal.aborted || generation !== this.generation)
        throw Error('Перевірку скасовано.');
      this.store.bind(session);
      this.session = session;
      this.refreshEntries();
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
  async restore(id: string) {
    const session = await this.check();
    const generation = this.generation,
      request = (this.request = new AbortController());
    try {
      await this.store.restore(id, session, request.signal);
      if (request.signal.aborted || generation !== this.generation) return;
      this.refreshEntries();
    } catch (error) {
      if (request.signal.aborted || generation !== this.generation) return;
      const status = error instanceof Error && 'status' in error ? error.status : null;
      if (status === 401 || status === 403) this.revoke();
      this.show({
        state: 'error',
        entries: [],
        error: error instanceof Error ? error.message : 'Чернетку не відновлено.',
      });
    } finally {
      if (generation === this.generation) this.request = null;
    }
  }
  async discard(id: string) {
    await this.check();
    if (!this.session) return;
    this.store.discard(id);
    this.refreshEntries();
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
