import { ApiError } from '../../shared/api/client';
import type { TradingApi, TradingBootstrap, DirectoryItem } from '../trading/api';
import type { StaffApi, Resource, Pages, Page, Policy, Queries } from './api';
export type Options = {
  bootstrap: TradingBootstrap;
  directoryApi: TradingApi;
  store: number | null;
  selectedStore: DirectoryItem | null;
  onStore: (id: number | null) => void;
  onCreateDocument: (kind: 'payroll' | 'payroll_payment') => void | Promise<void>;
  onViewDocument: (id: number) => void | Promise<void>;
  onEditEmployee: (id: number | null) => void | Promise<void>;
  onWorkShift: (id: number | null) => void | Promise<void>;
  runNativeAction?: (action: () => void | Promise<void>, opener?: Element) => void | Promise<void>;
  onDrafts: () => void;
  onRefresh: () => Promise<void>;
};
export type Filters = {
  q: string;
  employee: number | null;
  selectedEmployee: DirectoryItem | null;
  from: string;
  to: string;
  status: string;
  page: number;
};
const filters = (): Filters => ({
  q: '',
  employee: null,
  selectedEmployee: null,
  from: '',
  to: '',
  status: '',
  page: 1,
});
const initial = () => ({
  view: 'employees' as Resource,
  store: null as number | null,
  selectedStore: null as DirectoryItem | null,
  filters: { employees: filters(), 'work-shifts': filters(), documents: filters() },
  data: null as Page | null,
  policy: null as Policy | null,
  busy: false,
  actionBusy: false,
  denied: false,
  error: '',
  focus: null as 'next' | 'previous' | null,
});

export class StaffModel {
  state = initial();
  options: Options | null = null;
  private active = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private listeners = new Set<() => void>();
  private committed = new Map<Resource, { query: Queries[Resource]; page: number }>();
  constructor(public api: StaffApi) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  accessToken() {
    return this.generation;
  }
  isCurrent(token: number) {
    return this.active && token === this.generation;
  }
  private emit(patch: Partial<typeof this.state>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  deny(message: string) {
    this.committed.clear();
    this.generation++;
    this.controller?.abort();
    this.emit({ ...initial(), denied: true, error: message });
  }
  private error(error: unknown) {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
    if (status === 401 || status === 403)
      this.deny(error instanceof Error ? error.message : 'Доступ відкликано.');
    else
      this.emit({
        error: error instanceof Error ? error.message : 'Не вдалося прочитати команду.',
      });
  }
  async activate(options: Options) {
    const store = options.bootstrap.storeId ?? options.store;
    if (
      store !== this.state.store ||
      this.options?.bootstrap.role !== options.bootstrap.role ||
      this.options?.bootstrap.storeId !== options.bootstrap.storeId
    )
      this.committed.clear();
    this.options = options;
    this.active = true;
    this.emit({
      policy: null,
      store,
      selectedStore: options.selectedStore?.id === String(store) ? options.selectedStore : null,
      denied: false,
      ...(store !== this.state.store ? { filters: initial().filters } : {}),
    });
    await this.refresh();
  }
  leave() {
    this.active = false;
    this.generation++;
    this.controller?.abort();
    this.options = null;
    this.committed.clear();
    this.emit(initial());
  }
  result<R extends Resource>(resource: R): Pages[R] | null {
    return this.state.view === resource ? (this.state.data as Pages[R] | null) : null;
  }
  query<R extends Resource>(resource: R): Queries[R] {
    const f = this.state.filters[resource],
      store = this.state.store;
    return (
      resource === 'employees'
        ? { q: f.q.trim(), store }
        : resource === 'work-shifts'
          ? { store, employee: f.employee, from: f.from, to: f.to }
          : { store, status: f.status }
    ) as Queries[R];
  }
  edit(patch: Partial<Filters>) {
    const view = this.state.view;
    this.emit({
      filters: { ...this.state.filters, [view]: { ...this.state.filters[view], ...patch } },
    });
  }
  async search() {
    this.edit({ page: 1 });
    this.emit({ focus: null });
    await this.refresh();
  }
  async reset() {
    this.emit({ filters: { ...this.state.filters, [this.state.view]: filters() }, focus: null });
    await this.refresh();
  }
  async change(view: Resource) {
    if (this.state.denied) return;
    this.emit({ view, focus: null });
    await this.refresh();
  }
  async store(id: number | null, item: DirectoryItem | null) {
    if (this.state.denied) return;
    if (id !== this.state.store) this.committed.clear();
    this.emit({ store: id, selectedStore: item, filters: initial().filters, focus: null });
    this.options?.onStore(id);
    await this.refresh();
  }
  async page(page: number) {
    this.emit({ focus: page > this.state.filters[this.state.view].page ? 'next' : 'previous' });
    this.edit({ page });
    await this.refresh();
  }
  hasFilterDraft() {
    const confirmed = this.committed.get(this.state.view);
    return (
      !!confirmed &&
      JSON.stringify(Object.entries(confirmed.query).sort()) !==
        JSON.stringify(Object.entries(this.query(this.state.view)).sort())
    );
  }
  allowPolicyRefresh() {
    this.emit({ policy: null });
  }
  async refreshCommitted() {
    const confirmed = this.committed.get(this.state.view);
    // No successful read in this scope yet: an optional background refresh must
    // neither revive another store nor submit the user's unconfirmed filters.
    if (confirmed) await this.refresh(confirmed);
  }
  async refresh(confirmed?: { query: Queries[Resource]; page: number }) {
    if (!this.active || !this.options) return;
    const token = ++this.generation,
      controller = new AbortController();
    this.controller?.abort();
    this.controller = controller;
    this.emit({ busy: true, error: '', data: null });
    try {
      const view = this.state.view,
        query = confirmed?.query ?? this.query(view),
        data = await this.api.read(
          view,
          query,
          confirmed?.page ?? this.state.filters[view].page,
          controller.signal,
        );
      if (!this.isCurrent(token)) return;
      const bootstrap = this.options.bootstrap;
      if (
        data.policy.role !== bootstrap.role ||
        data.policy.store !== bootstrap.storeId ||
        (this.state.policy && JSON.stringify(this.state.policy) !== JSON.stringify(data.policy))
      )
        throw new ApiError(403, 'Права або обліковий період змінилися. Оновіть розділ.');
      const f = this.state.filters[view];
      const refs = [
        ...(this.state.store ? [{ type: 'stores' as const, id: String(this.state.store) }] : []),
        ...(f.employee ? [{ type: 'employees' as const, id: String(f.employee) }] : []),
      ];
      const details = refs.length
        ? await this.options.directoryApi.details(refs, { purpose: 'label' }, controller.signal)
        : null;
      if (!this.isCurrent(token)) return;
      const selectedStore =
        details?.items.find((x) => x.type === 'stores' && x.id === String(this.state.store)) ??
        null;
      const selectedEmployee =
        details?.items.find((x) => x.type === 'employees' && x.id === String(f.employee)) ?? null;
      this.committed.set(view, { query: data.query, page: data.page });
      this.emit({
        policy: data.policy,
        data,
        selectedStore,
        filters: {
          ...this.state.filters,
          [view]: { ...this.state.filters[view], selectedEmployee },
        },
      });
    } catch (error) {
      if (this.isCurrent(token) && !(error instanceof Error && error.name === 'AbortError'))
        this.error(error);
    } finally {
      if (this.isCurrent(token)) this.emit({ busy: false });
    }
  }
  ready() {
    return (
      this.active &&
      !this.state.busy &&
      !this.state.actionBusy &&
      !this.state.denied &&
      !this.state.error &&
      this.state.data !== null &&
      this.state.policy !== null
    );
  }
  async action(fn: () => void | Promise<void>, opener?: Element) {
    if (!this.ready()) return;
    const token = this.generation;
    this.emit({ actionBusy: true, error: '' });
    try {
      if (this.options?.runNativeAction) await this.options.runNativeAction(fn, opener);
      else await fn();
    } catch (error) {
      if (this.isCurrent(token)) this.error(error);
    } finally {
      if (this.isCurrent(token)) this.emit({ actionBusy: false });
    }
  }
  async reload() {
    const token = this.generation;
    try {
      await this.options?.onRefresh();
    } catch (error) {
      if (this.isCurrent(token)) this.error(error);
    }
  }
}
