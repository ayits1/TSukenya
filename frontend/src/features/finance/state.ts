import { ApiError } from '../../shared/api/client';
import type { TradingApi, TradingBootstrap, DirectoryItem } from '../trading/api';
import type { FinanceApi, Resource, Pages, Page, Policy, Queries } from './api';
export type Options = {
  bootstrap: TradingBootstrap;
  directoryApi: TradingApi;
  store: number | null;
  selectedStore: DirectoryItem | null;
  onStore: (id: number | null) => void;
  onCreateDocument: (kind: string) => void | Promise<void>;
  onViewDocument: (id: number) => void | Promise<void>;
  onEditAccount: (id: number | null) => void | Promise<void>;
  onPayDebt: (id: number) => void | Promise<void>;
  onAdvance: (
    kind: 'advance_allocation' | 'payment_refund',
    row: Pages['advances']['items'][number],
    opener?: Element,
  ) => void | Promise<void>;
  onStatement: (
    party: number,
    store: number | null,
    context: { isCurrent: () => boolean; onDenied: (error: unknown) => void },
  ) => void | Promise<void>;
  runNativeAction?: (action: () => void | Promise<void>, opener?: Element) => void | Promise<void>;
  onDrafts: () => void;
  onRefresh: () => Promise<void>;
};
export type Filters = {
  q: string;
  party: number | null;
  selectedParty: DirectoryItem | null;
  account: number | null;
  selectedAccount: DirectoryItem | null;
  from: string;
  to: string;
  due_from: string;
  due_to: string;
  status: string;
  page: number;
};
const filters = (): Filters => ({
  q: '',
  party: null,
  selectedParty: null,
  account: null,
  selectedAccount: null,
  from: '',
  to: '',
  due_from: '',
  due_to: '',
  status: '',
  page: 1,
});
const initial = () => ({
  view: 'accounts' as Resource,
  store: null as number | null,
  selectedStore: null as DirectoryItem | null,
  filters: {
    accounts: filters(),
    debts: filters(),
    advances: filters(),
    ledger: filters(),
    documents: filters(),
  },
  data: null as Page | null,
  policy: null as Policy | null,
  busy: false,
  actionBusy: false,
  denied: false,
  error: '',
  focus: null as 'next' | 'previous' | null,
});
export class FinanceModel {
  state = initial();
  options: Options | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private committed = new Map<string, { query: Queries[Resource]; page: number }>();
  private active = false;
  private controller: AbortController | null = null;
  constructor(public api: FinanceApi) {}
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
  private error(e: unknown) {
    const status = e && typeof e === 'object' && 'status' in e ? e.status : null;
    if (status === 401 || status === 403)
      this.deny(e instanceof Error ? e.message : 'Доступ відкликано.');
    else this.emit({ error: e instanceof Error ? e.message : 'Не вдалося прочитати фінанси.' });
  }
  async activate(options: Options) {
    this.options = options;
    this.active = true;
    const store = options.bootstrap.storeId ?? options.store;
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
    this.committed.clear();
    this.active = false;
    this.generation++;
    this.controller?.abort();
    this.options = null;
    this.emit(initial());
  }
  result<R extends Resource>(resource: R): Pages[R] | null {
    return this.state.view === resource ? (this.state.data as Pages[R] | null) : null;
  }
  query<R extends Resource>(resource: R): Queries[R] {
    const f = this.state.filters[resource],
      store = this.state.store;
    return (
      resource === 'accounts'
        ? { q: f.q.trim(), store }
        : resource === 'debts'
          ? {
              q: f.q.trim(),
              store,
              party: f.party,
              from: f.from,
              to: f.to,
              due_from: f.due_from,
              due_to: f.due_to,
              status: f.status,
            }
          : resource === 'advances'
            ? { q: f.q.trim(), store, party: f.party }
            : resource === 'ledger'
              ? { q: f.q.trim(), store, account: f.account, from: f.from, to: f.to }
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
    this.emit({ store: id, selectedStore: item, filters: initial().filters, focus: null });
    this.options?.onStore(id);
    await this.refresh();
  }
  async page(page: number) {
    this.emit({ focus: page > this.state.filters[this.state.view].page ? 'next' : 'previous' });
    this.edit({ page });
    await this.refresh();
  }
  allowPolicyRefresh() {
    this.emit({ policy: null });
  }
  hasFilterDraft() {
    const confirmed = this.committed.get(JSON.stringify([this.state.view, this.state.store]));
    return (
      !!confirmed &&
      JSON.stringify(Object.entries(confirmed.query).sort()) !==
        JSON.stringify(Object.entries(this.query(this.state.view)).sort())
    );
  }
  async refreshCommitted() {
    const confirmed = this.committed.get(JSON.stringify([this.state.view, this.state.store]));
    if (confirmed) await this.refresh(confirmed);
  }
  async refresh(confirmed?: { query: Queries[Resource]; page: number }) {
    if (!this.active || !this.options) return;
    const token = ++this.generation,
      c = new AbortController();
    this.controller?.abort();
    this.controller = c;
    this.emit({ busy: true, error: '', data: null });
    try {
      const view = this.state.view,
        data = await this.api.read(
          view,
          confirmed?.query ?? this.query(view),
          confirmed?.page ?? this.state.filters[view].page,
          c.signal,
        );
      if (!this.isCurrent(token)) return;
      const bootstrap = this.options.bootstrap;
      if (
        data.policy.role !== bootstrap.role ||
        data.policy.store !== bootstrap.storeId ||
        (this.state.policy && JSON.stringify(this.state.policy) !== JSON.stringify(data.policy))
      )
        throw new ApiError(403, 'Права змінилися. Оновіть розділ.');
      const f = this.state.filters[view];
      const refs = [
        ...(this.state.store ? [{ type: 'stores' as const, id: String(this.state.store) }] : []),
        ...(f.party ? [{ type: 'parties' as const, id: String(f.party) }] : []),
        ...(f.account ? [{ type: 'accounts' as const, id: String(f.account) }] : []),
      ];
      const details = refs.length
        ? await this.options.directoryApi.details(refs, { purpose: 'label' }, c.signal)
        : null;
      if (!this.isCurrent(token)) return;
      const selectedStore =
        details?.items.find((x) => x.type === 'stores' && x.id === String(this.state.store)) ??
        null;
      const selectedParty =
        details?.items.find((x) => x.type === 'parties' && x.id === String(f.party)) ?? null;
      const selectedAccount =
        details?.items.find((x) => x.type === 'accounts' && x.id === String(f.account)) ?? null;
      this.committed.set(JSON.stringify([this.state.view, this.state.store]), {
        query: data.query,
        page: data.page,
      });
      this.edit({ page: data.page, selectedParty, selectedAccount });
      this.emit({ policy: data.policy, data, selectedStore });
    } catch (e) {
      if (this.isCurrent(token) && !(e instanceof Error && e.name === 'AbortError')) this.error(e);
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
    } catch (e) {
      if (this.isCurrent(token)) this.error(e);
    } finally {
      if (this.isCurrent(token)) this.emit({ actionBusy: false });
    }
  }
  async payDebt(row: Pages['debts']['items'][number], opener?: Element) {
    if (!this.result('debts')?.items.some((x) => x === row)) return;
    await this.action(() => this.options?.onPayDebt(row.id), opener);
  }
  async advance(
    kind: 'advance_allocation' | 'payment_refund',
    row: Pages['advances']['items'][number],
    opener?: Element,
  ) {
    if (!this.result('advances')?.items.some((x) => x === row)) return;
    await this.action(() => this.options?.onAdvance(kind, row), opener);
  }
  async statement(opener?: Element) {
    const party = this.state.filters.advances.party;
    if (!party) {
      this.emit({ error: 'Виберіть контрагента для звірки.' });
      return;
    }
    const token = this.generation;
    await this.action(
      () =>
        this.options?.onStatement(party, this.state.store, {
          isCurrent: () => this.isCurrent(token),
          onDenied: (error) => {
            if (this.isCurrent(token)) this.error(error);
          },
        }),
      opener,
    );
  }
  async reload() {
    const token = this.generation;
    try {
      await this.options?.onRefresh();
    } catch (e) {
      if (this.isCurrent(token)) this.error(e);
    }
  }
}
