import { ApiError } from '../../shared/api/client';
import type { TradingApi, TradingBootstrap, DirectoryItem } from '../trading/api';
import type { Policy, DocumentQuery, ShiftQuery, Documents, Shifts, SalesApi, Shift } from './api';
export type Options = {
  bootstrap: TradingBootstrap;
  directoryApi: TradingApi;
  store: number | null;
  selectedStore: DirectoryItem | null;
  onStore: (id: number | null) => void;
  onCreateDocument: (kind: string) => void | Promise<void>;
  onViewDocument: (id: number) => void | Promise<void>;
  onOpenShift: () => void | Promise<void>;
  onCloseShift: (id: number) => void | Promise<void>;
  onRefresh: () => Promise<void>;
};
export type State = {
  view: 'documents' | 'shifts';
  store: number | null;
  selectedStore: DirectoryItem | null;
  employee: number | null;
  selectedEmployee: DirectoryItem | null;
  q: string;
  kind: DocumentQuery['kind'];
  status: DocumentQuery['status'];
  shiftStatus: ShiftQuery['status'];
  from: string;
  to: string;
  page: number;
  busy: boolean;
  actionBusy: boolean;
  error: string;
  denied: boolean;
  policy: Policy | null;
  documents: Documents | null;
  shifts: Shifts | null;
  focus: 'next' | 'previous' | null;
};
const initial = (): State => ({
  view: 'documents',
  store: null,
  selectedStore: null,
  employee: null,
  selectedEmployee: null,
  q: '',
  kind: '',
  status: '',
  shiftStatus: '',
  from: '',
  to: '',
  page: 1,
  busy: true,
  actionBusy: false,
  error: '',
  denied: false,
  policy: null,
  documents: null,
  shifts: null,
  focus: null,
});
export class SalesModel {
  state = initial();
  options: Options | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private active = false;
  private controller: AbortController | null = null;
  constructor(public api: SalesApi) {}
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
  deny(message: string) {
    this.generation++;
    this.controller?.abort();
    this.emit({ ...initial(), busy: false, denied: true, error: message });
  }
  private error(error: unknown) {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
    if (status === 401 || status === 403) {
      this.deny(error instanceof Error ? error.message : 'Доступ відкликано.');
      return;
    }
    this.emit({ error: error instanceof Error ? error.message : 'Не вдалося прочитати продажі.' });
  }
  private policy(policy: Policy) {
    const bootstrap = this.options?.bootstrap;
    if (
      !bootstrap ||
      policy.role !== bootstrap.role ||
      policy.store !== bootstrap.storeId ||
      (this.state.policy && JSON.stringify(this.state.policy) !== JSON.stringify(policy))
    )
      throw new ApiError(403, 'Права доступу змінилися. Оновіть розділ.');
  }
  async activate(options: Options) {
    this.options = options;
    this.active = true;
    const store = options.bootstrap.storeId ?? options.store;
    this.emit({
      policy: null,
      store,
      selectedStore: options.selectedStore?.id === String(store) ? options.selectedStore : null,
      ...(store !== this.state.store ? { employee: null, selectedEmployee: null } : {}),
      denied: false,
    });
    await this.refresh();
  }
  leave() {
    this.active = false;
    this.generation++;
    this.controller?.abort();
    this.options = null;
    this.emit({ ...initial(), busy: false });
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
  shiftQuery(): ShiftQuery {
    return {
      store: this.state.store,
      employee: this.state.employee,
      status: this.state.shiftStatus,
      from: this.state.from,
      to: this.state.to,
    };
  }
  edit(patch: Partial<Pick<State, 'q' | 'kind' | 'status' | 'shiftStatus' | 'from' | 'to'>>) {
    this.emit(patch);
  }
  async change(
    patch: Partial<
      Pick<State, 'view' | 'store' | 'selectedStore' | 'employee' | 'selectedEmployee'>
    >,
  ) {
    if (this.state.denied) return;
    this.emit({
      ...patch,
      page: 1,
      focus: null,
      error: '',
      ...('store' in patch ? { employee: null, selectedEmployee: null } : {}),
    });
    if ('store' in patch) this.options?.onStore(this.state.store);
    await this.refresh();
  }
  async search() {
    this.emit({ page: 1, focus: null });
    await this.refresh();
  }
  async page(page: number) {
    this.emit({ page, focus: page > this.state.page ? 'next' : 'previous' });
    await this.refresh();
  }
  async refresh() {
    if (!this.active || !this.options) return;
    const token = ++this.generation;
    this.controller?.abort();
    const c = new AbortController();
    this.controller = c;
    this.emit({ busy: true, error: '', documents: null, shifts: null });
    try {
      if (this.state.from && this.state.to && this.state.from > this.state.to)
        throw Error('Початок періоду має бути не пізніше завершення.');
      const data =
        this.state.view === 'documents'
          ? await this.api.documents(this.documentQuery(), this.state.page, c.signal)
          : await this.api.shifts(this.shiftQuery(), this.state.page, c.signal);
      if (!this.isCurrent(token)) return;
      this.policy(data.policy);
      let selectedStore = this.state.selectedStore;
      if (this.state.store && !selectedStore) {
        const details = await this.options.directoryApi.details(
          [{ type: 'stores', id: String(this.state.store) }],
          { purpose: 'filter' },
          c.signal,
        );
        if (!this.isCurrent(token)) return;
        selectedStore = details.items.find((item) => item.id === String(this.state.store)) ?? null;
      }
      this.emit({
        policy: data.policy,
        selectedStore,
        page: data.page,
        ...('fiscalRequired' in data ? { documents: data } : { shifts: data }),
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
      this.state.policy !== null
    );
  }
  canClose(shift: Shift) {
    return (
      this.ready() &&
      shift.canClose &&
      shift.closedAt === null &&
      (this.state.policy?.role !== 'cashier' || shift.openedBy === this.options?.bootstrap.username)
    );
  }
  async closeShift(shift: Shift) {
    if (!this.canClose(shift) || !this.state.shifts?.items.some((row) => row === shift)) return;
    await this.action(() => this.options?.onCloseShift(shift.id));
  }
  async action(fn: () => void | Promise<void>) {
    if (!this.ready()) return;
    const token = this.generation;
    this.emit({ actionBusy: true, error: '' });
    try {
      await fn();
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
