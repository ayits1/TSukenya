import { ApiError } from '../../shared/api/client';
import type { TradingApi, TradingBootstrap, DirectoryItem } from '../trading/api';
import type {
  Policy,
  DocumentQuery,
  ReplenishmentQuery,
  PurchasesApi,
  Documents,
  Groups,
  Group,
  Lines,
  Draft,
} from './api';
export type Options = {
  initialView?: 'replenishment';
  bootstrap: TradingBootstrap;
  directoryApi: TradingApi;
  store: number | null;
  selectedStore: DirectoryItem | null;
  onStore: (id: number | null) => void;
  onCreateDocument: (kind: string) => void | Promise<void>;
  onViewDocument: (id: number, opener?: Element) => void | Promise<void>;
  onReplenishment: (draft: Draft) => void | Promise<void>;
  onRefresh: () => Promise<void>;
};
export type State = {
  focus: { label: string; direction: 'next' | 'previous' } | null;
  view: 'documents' | 'replenishment';
  store: number | null;
  selectedStore: DirectoryItem | null;
  warehouse: number | null;
  selectedWarehouse: DirectoryItem | null;
  q: string;
  status: DocumentQuery['status'];
  kind: DocumentQuery['kind'];
  from: string;
  to: string;
  page: number;
  busy: boolean;
  actionBusy: boolean;
  error: string;
  notice: string;
  denied: boolean;
  policy: Policy | null;
  documents: Documents | null;
  groups: Groups | null;
  chosen: Group | null;
  lines: Lines | null;
  linesPage: number;
  linesBusy: boolean;
  linesError: string;
  prepared: Set<string>;
};
const initial = (): State => ({
  focus: null,
  view: 'documents',
  store: null,
  selectedStore: null,
  warehouse: null,
  selectedWarehouse: null,
  q: '',
  status: '',
  kind: '',
  from: '',
  to: '',
  page: 1,
  busy: true,
  actionBusy: false,
  error: '',
  notice: '',
  denied: false,
  policy: null,
  documents: null,
  groups: null,
  chosen: null,
  lines: null,
  linesPage: 1,
  linesBusy: false,
  linesError: '',
  prepared: new Set(),
});
export class PurchasesModel {
  state = initial();
  options: Options | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private committed = new Map<
    string,
    { query: DocumentQuery | ReplenishmentQuery; page: number }
  >();
  private active = false;
  private controller: AbortController | null = null;
  private detailController: AbortController | null = null;
  private detailSequence = 0;
  constructor(public api: PurchasesApi) {}
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
  private emit(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private cancelDetail() {
    this.detailSequence++;
    this.detailController?.abort();
    this.detailController = null;
  }
  deny(message: string) {
    this.committed.clear();
    this.generation++;
    this.controller?.abort();
    this.cancelDetail();
    this.emit({
      denied: true,
      busy: false,
      actionBusy: false,
      error: message,
      policy: null,
      documents: null,
      groups: null,
      chosen: null,
      lines: null,
      linesBusy: false,
      linesError: '',
      selectedStore: null,
      selectedWarehouse: null,
      prepared: new Set(),
      q: '',
      store: null,
      warehouse: null,
    });
  }
  private error(error: unknown) {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
    if (status === 401 || status === 403) {
      this.deny(error instanceof Error ? error.message : 'Доступ відкликано.');
      return;
    }
    this.emit({
      error: error instanceof Error ? error.message : 'Не вдалося прочитати закупівлі.',
    });
  }
  private policy(policy: Policy) {
    const bootstrap = this.options?.bootstrap;
    if (!bootstrap || policy.role !== bootstrap.role || policy.store !== bootstrap.storeId) {
      throw new ApiError(403, 'Права доступу змінилися. Оновіть розділ.');
    }
    if (this.state.policy && JSON.stringify(this.state.policy) !== JSON.stringify(policy))
      throw new ApiError(403, 'Права доступу змінилися. Оновіть розділ.');
  }
  async activate(options: Options) {
    this.options = options;
    this.active = true;
    const store = options.bootstrap.storeId ?? options.store;
    this.emit({
      policy: null,
      ...(options.initialView ? { view: options.initialView, q: '', page: 1 } : {}),
      ...(store !== this.state.store ? { warehouse: null, selectedWarehouse: null } : {}),
      store,
      selectedStore: options.selectedStore?.id === String(store) ? options.selectedStore : null,
      denied: false,
    });
    await this.refresh();
  }
  leave() {
    this.committed.clear();
    this.active = false;
    this.generation++;
    this.controller?.abort();
    this.cancelDetail();
    this.emit({
      documents: null,
      groups: null,
      lines: null,
      chosen: null,
      policy: null,
      busy: false,
      actionBusy: false,
      selectedStore: null,
      selectedWarehouse: null,
      prepared: new Set(),
    });
  }
  documentQuery(): DocumentQuery {
    return {
      q: this.state.q.trim(),
      store: this.state.store,
      status: this.state.status,
      kind: this.state.kind,
      from: this.state.from,
      to: this.state.to,
    };
  }
  replenishmentQuery(): ReplenishmentQuery {
    return { q: this.state.q.trim(), store: this.state.store, warehouse: this.state.warehouse };
  }
  edit(patch: Partial<Pick<State, 'q' | 'kind' | 'status' | 'from' | 'to'>>) {
    this.emit(patch);
  }
  async change(
    patch: Partial<
      Pick<State, 'view' | 'store' | 'selectedStore' | 'warehouse' | 'selectedWarehouse'>
    >,
  ) {
    if (this.state.denied) return;
    this.emit({
      ...patch,
      page: 1,
      chosen: null,
      lines: null,
      error: '',
      notice: '',
      ...(patch.view ? { q: '' } : {}),
    });
    if ('store' in patch) {
      this.emit({ warehouse: null, selectedWarehouse: null });
      this.options?.onStore(this.state.store);
    }
    await this.refresh();
  }
  async page(page: number) {
    this.emit({
      page,
      focus: {
        label: this.state.view === 'documents' ? 'Сторінки документів' : 'Сторінки груп поповнення',
        direction: page > this.state.page ? 'next' : 'previous',
      },
    });
    await this.refresh();
  }
  async search() {
    this.emit({ page: 1 });
    await this.refresh();
  }
  hasFilterDraft() {
    const confirmed = this.committed.get(JSON.stringify([this.state.view, this.state.store]));
    return (
      !!confirmed &&
      JSON.stringify(Object.entries(confirmed.query).sort()) !==
        JSON.stringify(
          Object.entries(
            this.state.view === 'documents' ? this.documentQuery() : this.replenishmentQuery(),
          ).sort(),
        )
    );
  }
  async refreshCommitted() {
    const confirmed = this.committed.get(JSON.stringify([this.state.view, this.state.store]));
    if (!confirmed) return;
    return this.refresh(confirmed);
  }
  allowPolicyRefresh() {
    this.emit({ policy: null });
  }
  async refresh(confirmed?: { query: DocumentQuery | ReplenishmentQuery; page: number }) {
    if (!this.active || !this.options) return;
    const token = ++this.generation;
    this.controller?.abort();
    this.cancelDetail();
    const c = new AbortController();
    this.controller = c;
    const selectedQuery =
        confirmed?.query ??
        (this.state.view === 'documents' ? this.documentQuery() : this.replenishmentQuery()),
      page = confirmed?.page ?? this.state.page;
    this.emit({
      busy: true,
      error: '',
      notice: '',
      documents: null,
      groups: null,
      chosen: null,
      lines: null,
      linesBusy: false,
      linesError: '',
    });
    try {
      const query = selectedQuery;
      if ('from' in query && query.from && query.to && query.from > query.to)
        throw Error('Початок періоду має бути не пізніше завершення.');
      const data =
        this.state.view === 'documents'
          ? await this.api.documents(query as DocumentQuery, page, c.signal)
          : await this.api.groups(query as ReplenishmentQuery, page, c.signal);
      if (!this.isCurrent(token)) return;
      this.policy(data.policy);
      const refs = [
        ...(this.state.store ? [{ type: 'stores' as const, id: String(this.state.store) }] : []),
        ...(this.state.warehouse
          ? [{ type: 'warehouses' as const, id: String(this.state.warehouse) }]
          : []),
      ];
      const details = refs.length
        ? await this.options.directoryApi.details(refs, { purpose: 'label' }, c.signal)
        : null;
      if (!this.isCurrent(token)) return;
      const selectedStore =
        details?.items.find((x) => x.type === 'stores' && x.id === String(this.state.store)) ??
        null;
      const selectedWarehouse =
        details?.items.find(
          (x) => x.type === 'warehouses' && x.id === String(this.state.warehouse),
        ) ?? null;
      this.committed.set(JSON.stringify([this.state.view, this.state.store]), {
        query: data.query,
        page: data.page,
      });
      this.emit({
        policy: data.policy,
        denied: false,
        selectedStore,
        selectedWarehouse,
        page: data.page,
        ...('summary' in data ? { groups: data } : { documents: data }),
      });
    } catch (error) {
      if (this.isCurrent(token) && !(error instanceof Error && error.name === 'AbortError'))
        this.error(error);
    } finally {
      if (this.isCurrent(token)) this.emit({ busy: false });
    }
  }
  async openLines(group: Group, page = 1) {
    if (!this.state.policy || this.state.busy || this.state.denied) return;
    this.cancelDetail();
    const token = this.generation,
      n = this.detailSequence,
      c = new AbortController();
    this.detailController = c;
    this.emit({
      focus:
        this.state.chosen?.key === group.key
          ? {
              label: 'Сторінки товарів групи',
              direction: page > this.state.linesPage ? 'next' : 'previous',
            }
          : null,
      chosen: group,
      lines: null,
      linesPage: page,
      linesBusy: true,
      linesError: '',
    });
    try {
      const result = await this.api.lines(
        this.state.groups?.query ?? this.replenishmentQuery(),
        group,
        page,
        c.signal,
      );
      if (!this.isCurrent(token) || n !== this.detailSequence) return;
      this.policy(result.policy);
      this.emit({ lines: result, linesPage: result.page });
    } catch (error) {
      if (!this.isCurrent(token) || n !== this.detailSequence) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403))
        this.deny(error.message);
      else if (!(error instanceof Error && error.name === 'AbortError'))
        this.emit({
          linesError: error instanceof Error ? error.message : 'Не вдалося прочитати товари.',
        });
    } finally {
      if (this.isCurrent(token) && n === this.detailSequence) this.emit({ linesBusy: false });
    }
  }
  closeLines() {
    this.cancelDetail();
    this.emit({ chosen: null, lines: null, linesBusy: false, linesError: '' });
  }
  async action(fn: () => void | Promise<void>) {
    if (
      !this.active ||
      this.state.actionBusy ||
      this.state.busy ||
      this.state.denied ||
      !this.state.policy
    )
      return;
    const token = this.generation;
    this.emit({ actionBusy: true, error: '', notice: '' });
    try {
      await fn();
    } catch (error) {
      if (this.isCurrent(token)) this.error(error);
    } finally {
      if (this.isCurrent(token)) this.emit({ actionBusy: false });
    }
  }
  async prepare(group: Group, part: number) {
    await this.action(async () => {
      const token = this.generation;
      const draft = await this.api.draft(
        this.state.groups?.query ?? this.replenishmentQuery(),
        group,
        part,
        this.controller?.signal,
      );
      if (!this.isCurrent(token)) return;
      this.policy(draft.policy);
      await this.options?.onReplenishment(draft);
      if (this.isCurrent(token)) {
        const prepared = new Set(this.state.prepared);
        prepared.add(group.binding + ':' + part);
        this.emit({
          prepared,
          notice: 'Товари відкрито у редакторі. Перевірте чернетку перед збереженням.',
        });
      }
    });
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
