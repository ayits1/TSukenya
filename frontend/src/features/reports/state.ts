import { ApiError } from '../../shared/api/client';
import { ukraineToday } from '../../shared/ui/DatePicker';
import type { TradingApi, TradingBootstrap, DirectoryItem } from '../trading/api';
import { initialABC } from '../abc/ABCReport';
import type { ABCFilters, ABCApi } from '../abc/api';
import type { FinanceApi } from '../finance/api';
import {
  decodeSources,
  type ReportsApi,
  type Context,
  type Query,
  type Page,
  type Section,
  type SourceQuery,
  type Sources,
} from './api';
export type ActionContext = {
  revalidate: () => Promise<void>;
  isCurrent: () => boolean;
};
export type SourceContext = ActionContext & {
  onDenied: (error: unknown) => void;
  decode: (raw: unknown, page: number) => Sources;
};
export type Options = {
  bootstrap: TradingBootstrap;
  directoryApi: TradingApi;
  store: number | null;
  selectedStore: DirectoryItem | null;
  onStore: (value: number | null) => void;
  onSources: (
    query: SourceQuery,
    amount: string,
    context: SourceContext,
    opener?: Element,
  ) => void | Promise<void>;
  onPayDebt: (id: number, context: ActionContext) => void | Promise<void>;
  runNativeAction?: (action: () => void | Promise<void>, opener?: Element) => void | Promise<void>;
};
const current = (): Context => {
  const d = ukraineToday();
  return { mode: 'period', store: null, from: d.slice(0, 8) + '01', to: d, as_of: d };
};
const initial = () => ({
  view: 'period' as Context['mode'] | 'abc',
  draft: current(),
  selectedStore: null as DirectoryItem | null,
  section: 'products' as Section,
  q: '',
  data: null as Page | null,
  committed: null as Query | null,
  busy: false,
  actionBusy: false,
  denied: false,
  error: '',
  stale: false,
  epoch: 0,
  focus: 0,
  refresh: 0,
  abc: initialABC(),
});
const identity = (v: TradingBootstrap) => JSON.stringify([v.csrf, v.username, v.role, v.storeId]);
const status = (e: unknown) => (e && typeof e === 'object' && 'status' in e ? e.status : null);
export class ReportsModel {
  state = initial();
  options: Options | null = null;
  private listeners = new Set<() => void>();
  private active = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private intent: Query | null = null;
  private authority = '';
  public abc: ABCApi;
  constructor(
    public api: ReportsApi,
    public finance: FinanceApi,
    abc: ABCApi,
  ) {
    this.abc = {
      read: async (filters, page, signal) => {
        const token = this.accessToken(),
          live = () => !signal?.aborted && this.isCurrent(token);
        try {
          if (!live()) throw new DOMException('Скасовано', 'AbortError');
          await this.options!.directoryApi.bootstrap(signal);
          if (!live()) throw new DOMException('Скасовано', 'AbortError');
          const result = await abc.read(filters, page, signal);
          if (!live()) throw new DOMException('Скасовано', 'AbortError');
          await this.options!.directoryApi.bootstrap(signal);
          if (!live()) throw new DOMException('Скасовано', 'AbortError');
          return result;
        } catch (error) {
          if (live()) this.privacy(error);
          throw error;
        }
      },
    };
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.state;
  private emit(patch: Partial<typeof this.state>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  accessToken() {
    return this.state.epoch;
  }
  isCurrent(token: number) {
    return this.active && !this.state.denied && token === this.state.epoch;
  }
  privacy(error: unknown) {
    if (status(error) === 401 || status(error) === 403)
      this.deny(
        error instanceof Error ? error.message : 'Доступ до звітів змінився.',
        status(error) === 401,
      );
  }
  deny(error: string, expired = false) {
    this.generation++;
    this.controller?.abort();
    this.intent = null;
    this.emit({ ...initial(), epoch: this.state.epoch + 1, denied: true, error });
    if (expired && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tsukenya:session-invalidated'));
      location.assign('/');
    }
  }
  guard(api: TradingApi): TradingApi {
    return new Proxy(api, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const token = this.accessToken(),
            signal = args.find((x) => x instanceof AbortSignal) as AbortSignal | undefined;
          try {
            const result = await Reflect.apply(value, target, args);
            if (signal?.aborted || !this.isCurrent(token))
              throw new DOMException('Скасовано', 'AbortError');
            if (key === 'bootstrap' && identity(result as TradingBootstrap) !== this.authority)
              throw new ApiError(403, 'Права або сеанс змінилися. Відкрийте звіти заново.');
            return result;
          } catch (error) {
            if (!signal?.aborted && this.isCurrent(token)) this.privacy(error);
            throw error;
          }
        };
      },
    });
  }
  async activate(options: Options) {
    const changed = !this.active || this.authority !== identity(options.bootstrap),
      store = options.bootstrap.storeId ?? options.store;
    this.authority = identity(options.bootstrap);
    this.active = true;
    this.options = { ...options, directoryApi: this.guard(options.directoryApi) };
    if (changed || this.state.denied) {
      this.emit({
        ...initial(),
        draft: { ...current(), store },
        selectedStore: options.selectedStore?.id === String(store) ? options.selectedStore : null,
        epoch: this.state.epoch + 1,
      });
    }
    if (!['owner', 'manager', 'accountant'].includes(options.bootstrap.role)) {
      this.deny('Звіти недоступні за чинними правами.');
      return;
    }
    this.emit({ refresh: this.state.refresh + 1 });
    if (this.state.view !== 'abc') await this.read(this.state.committed ?? this.query());
  }
  leave() {
    this.active = false;
    this.generation++;
    this.controller?.abort();
    this.options = null;
    this.intent = null;
    this.emit({ ...initial(), epoch: this.state.epoch + 1 });
  }
  edit(patch: Partial<Context>) {
    this.emit({ draft: { ...this.state.draft, ...patch } });
  }
  store(item: DirectoryItem | null) {
    this.emit({ selectedStore: item });
    this.edit({ store: item ? Number(item.id) : null });
  }
  searchText(q: string) {
    this.emit({ q });
  }
  query(): Query {
    return {
      ...this.state.draft,
      mode: this.state.view === 'abc' ? 'period' : this.state.view,
      section: this.state.section,
      page: 1,
      q: this.state.q.trim(),
    };
  }
  async apply() {
    if (this.state.busy || this.state.denied) return;
    const query = { ...this.query(), q: '', page: 1 };
    this.emit({ q: '' });
    await this.read(query);
  }
  async search() {
    if (!this.state.committed || this.state.busy) return;
    await this.read({
      ...this.state.committed,
      section: this.state.section,
      page: 1,
      q: this.state.q.trim(),
    });
  }
  async page(page: number) {
    if (!this.state.committed || !this.ready()) return;
    await this.read({ ...this.state.committed, page }, true);
  }
  async section(section: Section) {
    if (!this.state.data || this.state.denied) return;
    this.emit({ section, q: '' });
    await this.read({ ...this.state.committed!, section, page: 1, q: '' });
  }
  async mode(view: typeof this.state.view) {
    if (this.state.denied || view === this.state.view) return;
    this.generation++;
    this.controller?.abort();
    const draft = { ...this.state.draft, mode: view === 'abc' ? ('period' as const) : view };
    this.emit({
      view,
      draft,
      section: view === 'balances' ? 'stock' : 'products',
      q: '',
      data: null,
      committed: null,
      error: '',
      busy: false,
      actionBusy: false,
      stale: false,
      epoch: this.state.epoch + 1,
    });
    if (view !== 'abc') await this.read(this.query());
  }
  abcFilters(value: ABCFilters) {
    this.edit({ store: value.store ? Number(value.store) : null, from: value.from, to: value.to });
    this.emit({ abc: value });
    this.options?.onStore(value.store ? Number(value.store) : null);
  }
  async retry() {
    if (this.intent && !this.state.busy && !this.state.denied) await this.read(this.intent, true);
  }
  async read(query: Query, focus = false) {
    if (!this.active || !this.options || this.state.denied) return;
    const token = ++this.generation,
      c = new AbortController(),
      epoch = this.accessToken();
    this.controller?.abort();
    this.controller = c;
    this.intent = { ...query };
    const previous =
      this.state.data && this.state.committed
        ? { data: this.state.data, query: this.state.committed }
        : null;
    const safe = previous?.query.mode === query.mode && previous.query.store === query.store;
    if (!safe) this.emit({ epoch: epoch + 1, data: null, committed: null });
    this.emit({ busy: true, error: '', stale: false });
    const live = () =>
      this.active && !c.signal.aborted && token === this.generation && !this.state.denied;
    try {
      const auth = await this.options.directoryApi.bootstrap(c.signal);
      if (!live()) return;
      const payroll = auth.role === 'owner' || auth.role === 'accountant';
      const data = await this.api.read(query, payroll, c.signal);
      if (!live()) return;
      let selected = this.state.selectedStore;
      if (query.store && selected?.id !== String(query.store)) {
        const result = await this.options.directoryApi.details(
          [{ type: 'stores', id: String(query.store) }],
          { purpose: 'filter' },
          c.signal,
        );
        if (!live()) return;
        selected = result.items[0] ?? null;
      }
      // A grant established before the report GET cannot authorize its late result.
      await this.options.directoryApi.bootstrap(c.signal);
      if (!live()) return;
      this.emit({
        data,
        committed: { ...query, page: data.page },
        section: query.section,
        selectedStore: selected,
        error: '',
        stale: false,
        focus: this.state.focus + (focus ? 1 : 0),
      });
      this.options.onStore(query.store);
    } catch (error) {
      if (!live() || (error instanceof Error && error.name === 'AbortError')) return;
      if (status(error) === 401 || status(error) === 403) {
        this.privacy(error);
        return;
      }
      const fallback =
        safe && previous && !(error instanceof ApiError && error.code === 'protocol');
      this.emit({
        data: fallback ? previous.data : null,
        committed: fallback ? previous.query : null,
        section: fallback ? previous.query.section : query.section,
        stale: !!fallback,
        error: error instanceof Error ? error.message : 'Не вдалося прочитати звіт.',
        focus: this.state.focus + (focus ? 1 : 0),
      });
    } finally {
      if (live()) this.emit({ busy: false });
    }
  }
  ready() {
    return (
      this.active &&
      !this.state.denied &&
      !this.state.busy &&
      !this.state.actionBusy &&
      !this.state.error &&
      !!this.state.data &&
      !!this.state.committed
    );
  }
  private async revalidate(token: number) {
    if (!this.isCurrent(token) || !this.options) throw new DOMException('Скасовано', 'AbortError');
    await this.options.directoryApi.bootstrap();
    if (!this.isCurrent(token)) throw new DOMException('Скасовано', 'AbortError');
  }
  async action(fn: () => void | Promise<void>, opener?: Element) {
    if (this.state.actionBusy || this.state.denied || !this.active) return;
    const token = this.accessToken();
    this.emit({ actionBusy: true });
    try {
      await this.revalidate(token);
      if (this.options?.runNativeAction) await this.options.runNativeAction(fn, opener);
      else await fn();
    } catch (error) {
      if (this.isCurrent(token)) {
        this.privacy(error);
        if (!this.state.denied)
          this.emit({
            error: error instanceof Error ? error.message : 'Не вдалося відкрити документ.',
          });
      }
    } finally {
      if (this.isCurrent(token)) this.emit({ actionBusy: false });
    }
  }
  async payDebt(id: number, opener?: Element) {
    const token = this.accessToken();
    await this.action(
      () =>
        this.options?.onPayDebt(id, {
          revalidate: () => this.revalidate(token),
          isCurrent: () => this.isCurrent(token),
        }),
      opener,
    );
  }
  async sources(metric: SourceQuery['metric'], amount: string, source?: number, opener?: Element) {
    if (!this.ready() || !this.options) return;
    const query: SourceQuery = { ...this.state.committed!, metric, ...(source ? { source } : {}) },
      token = this.accessToken(),
      auth = this.options.bootstrap;
    await this.action(
      () =>
        this.options?.onSources(
          query,
          amount,
          {
            revalidate: () => this.revalidate(token),
            isCurrent: () => this.isCurrent(token),
            onDenied: (error) => {
              if (this.isCurrent(token)) this.privacy(error);
            },
            decode: (raw, page) => decodeSources(raw, query, page, auth.role, auth.storeId),
          },
          opener,
        ),
      opener,
    );
  }
}
