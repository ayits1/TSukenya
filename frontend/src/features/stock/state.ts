import { ApiError } from '../../shared/api/client';
import { decimalKey, mergeEqual, type MergeField } from '../../shared/merge/threeWay';
import type { TradingBootstrap, TradingApi, DirectoryItem } from '../trading/api';
import type {
  StockApi,
  StockPage,
  StockDocuments,
  StockPolicy,
  AssortmentPage,
  AssortmentRow,
  AssortmentRequest,
  StockQuery,
} from './api';
export type Terms = { sold: boolean; min_stock: string | null };
export type Draft = {
  store: number | null;
  base: AssortmentRow;
  sold: boolean;
  minimum: string;
  busy: boolean;
  error: string;
  uncertain: boolean;
  server: AssortmentRow | null;
  reading: boolean;
};
export const draftKey = (warehouse: number, product: string) => warehouse + ':' + product;
export const terms = (row: AssortmentRow): Terms => ({ sold: row.sold, min_stock: row.min_stock });
export const assortmentFields: MergeField<Terms>[] = [
  {
    id: 'assortment',
    label: 'Продаж та мінімальний залишок на складі',
    read: (v) => [v.sold, decimalKey(v.min_stock)],
    write: (_, v) => ({ ...v }),
    equal: mergeEqual,
    format: (v) => {
      const a = v as [boolean, string | null];
      return `${a[0] ? 'Продається' : 'Не продається'} · ${a[1] === null ? 'мінімум із каталогу' : a[1]}`;
    },
  },
];
export function captureTerms(d: Pick<Draft, 'sold' | 'minimum'>): Terms {
  const raw = d.minimum.trim().replace(',', '.');
  if (
    raw !== '' &&
    (!/^\d{1,12}(?:\.\d{1,3})?$/.test(raw) || BigInt(raw.split('.')[0]!) > 999999999999n)
  )
    throw Error('Мінімум: невід’ємне число, до 3 знаків після коми.');
  return { sold: d.sold, min_stock: raw === '' ? null : raw };
}
export type StockOptions = {
  bootstrap: TradingBootstrap;
  directoryApi: TradingApi;
  store: number | null;
  selectedStore: DirectoryItem | null;
  onStore: (id: number | null) => void;
  onCreateDocument: (kind: string) => void | Promise<void>;
  onViewDocument: (id: number, opener?: Element) => void | Promise<void>;
  onLegacyRecipes: () => void | Promise<void>;
  onRecipeVersions: () => void | Promise<void>;
  onControl: () => Promise<void>;
  onReplenishment: () => void;
};
export type StockState = {
  q: string;
  store: number | null;
  warehouse: number | null;
  assortmentWarehouse: number | null;
  assortmentProduct: string;
  page: number;
  lotsPage: number;
  assortmentPage: number;
  documentsPage: number;
  status: string;
  lotsOpen: boolean;
  assortmentOpen: boolean;
  busy: boolean;
  error: string;
  denied: boolean;
  totals: StockPage | null;
  lots: StockPage | null;
  assortment: AssortmentPage | null;
  documents: StockDocuments | null;
  drafts: Map<string, Draft>;
  captions: Map<string, DirectoryItem>;
  csvBusy: boolean;
  notice: string;
  focus: { section: string; direction: 'next' | 'previous' } | null;
};
const initial = (): StockState => ({
  q: '',
  store: null,
  warehouse: null,
  assortmentWarehouse: null,
  assortmentProduct: '',
  page: 1,
  lotsPage: 1,
  assortmentPage: 1,
  documentsPage: 1,
  status: '',
  lotsOpen: false,
  assortmentOpen: false,
  busy: true,
  error: '',
  denied: false,
  totals: null,
  lots: null,
  assortment: null,
  documents: null,
  drafts: new Map(),
  captions: new Map(),
  csvBusy: false,
  notice: '',
  focus: null,
});
export class StockModel {
  state = initial();
  options: StockOptions | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private controller: AbortController | null = null;
  private active = false;
  private comparisons = new Map<string, number>();
  private comparisonSequence = 0;
  private comparisonControllers = new Map<string, AbortController>();
  private downloads = new Set<string>();
  // Render payloads are cleared during refresh; that is not a policy revocation.
  private confirmedPolicy: StockPolicy | null = null;
  constructor(public api: StockApi) {}
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
    return this.active && this.generation === token;
  }
  private emit(patch: Partial<StockState> = {}) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private draft(key: string, patch: Partial<Draft>) {
    const value = this.state.drafts.get(key);
    if (!value) return;
    const drafts = new Map(this.state.drafts);
    drafts.set(key, { ...value, ...patch });
    this.emit({ drafts });
  }
  private urls() {
    this.downloads.forEach((url) => URL.revokeObjectURL(url));
    this.downloads.clear();
  }
  private cancelReads() {
    this.comparisonControllers.forEach((controller) => controller.abort());
    this.comparisonControllers.clear();
    this.comparisons.clear();
    const drafts = new Map(this.state.drafts);
    for (const [key, d] of drafts)
      if (d.reading || d.server) drafts.set(key, { ...d, reading: false, server: null });
    this.emit({ drafts });
  }
  deny(message: string) {
    this.confirmedPolicy = null;
    this.cancelReads();
    this.generation++;
    this.controller?.abort();
    this.urls();
    this.emit({
      denied: true,
      error: message,
      busy: false,
      csvBusy: false,
      totals: null,
      lots: null,
      assortment: null,
      documents: null,
      captions: new Map(),
    });
  }
  private fail(error: unknown) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      this.deny(error.message);
      return;
    }
    this.emit({
      busy: false,
      error: error instanceof Error ? error.message : 'Не вдалося прочитати залишки.',
    });
  }
  async activate(options: StockOptions) {
    this.options = options;
    this.active = true;
    this.emit({ store: options.bootstrap.storeId ?? options.store, denied: false });
    await this.refresh();
  }
  leave() {
    this.confirmedPolicy = null;
    this.cancelReads();
    this.active = false;
    this.generation++;
    this.controller?.abort();
    this.urls();
    this.emit({
      totals: null,
      lots: null,
      assortment: null,
      documents: null,
      captions: new Map(),
      busy: false,
      csvBusy: false,
    });
  }
  canLeave() {
    if ([...this.state.drafts.values()].some((d) => d.busy)) {
      this.emit({ notice: 'Зачекайте на завершення збереження асортименту перед переходом.' });
      return false;
    }
    return true;
  }
  hasDrafts() {
    return this.state.drafts.size > 0;
  }
  query(view: 'totals' | 'lots' = 'totals'): StockQuery {
    return {
      q: this.state.q.trim(),
      store: this.state.store,
      warehouse: this.state.warehouse,
      view,
    };
  }
  async change(patch: Partial<StockState>) {
    if (this.state.denied) return;
    this.emit({
      ...patch,
      focus: null,
      page: 1,
      lotsPage: 1,
      assortmentPage: 1,
      documentsPage: 1,
      assortmentProduct: patch.assortmentProduct ?? '',
    });
    if ('store' in patch) this.options?.onStore(this.state.store);
    await this.refresh();
  }
  async page(section: 'page' | 'lotsPage' | 'assortmentPage' | 'documentsPage', value: number) {
    this.emit({
      [section]: value,
      focus: { section, direction: value > this.state[section] ? 'next' : 'previous' },
    });
    await this.refresh();
  }
  policy(): StockPolicy | null {
    return this.state.totals?.policy ?? null;
  }
  async refresh() {
    if (!this.active || !this.options) return;
    this.cancelReads();
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal,
      s = { ...this.state },
      query = this.query();
    this.urls();
    this.emit({
      busy: true,
      error: '',
      totals: null,
      lots: null,
      assortment: null,
      documents: null,
      csvBusy: false,
    });
    try {
      const totals = await this.api.stock(query, s.page, signal);
      if (!this.active || generation !== this.generation) return;
      const [lots, assortment, documents] = await Promise.all([
        s.lotsOpen ? this.api.stock({ ...query, view: 'lots' }, s.lotsPage, signal) : null,
        s.assortmentOpen && s.assortmentWarehouse && totals.policy.canEditAssortment
          ? this.api.assortment(
              s.assortmentWarehouse,
              s.assortmentProduct ? '' : query.q,
              s.assortmentPage,
              s.assortmentProduct,
              signal,
            )
          : null,
        this.api.documents(s.store, s.status, s.documentsPage, signal),
      ]);
      if (!this.active || generation !== this.generation) return;
      if (
        [lots, assortment, documents].some(
          (row) => row && JSON.stringify(row.policy) !== JSON.stringify(totals.policy),
        )
      )
        throw new ApiError(403, 'Права змінилися. Оновіть розділ.');
      const refs = new Map<
        string,
        { type: 'warehouses' | 'stores' | 'parties' | 'employees'; id: string }
      >();
      for (const row of [...totals.items, ...(lots?.items ?? [])])
        refs.set('warehouses:' + row.warehouse, { type: 'warehouses', id: String(row.warehouse) });
      for (const row of documents.items) {
        refs.set('stores:' + row.store, { type: 'stores', id: String(row.store) });
        if (row.party) refs.set('parties:' + row.party, { type: 'parties', id: String(row.party) });
        if (row.employee)
          refs.set('employees:' + row.employee, { type: 'employees', id: String(row.employee) });
      }
      if (s.store) refs.set('stores:' + s.store, { type: 'stores', id: String(s.store) });
      for (const wh of [s.warehouse, s.assortmentWarehouse])
        if (wh) refs.set('warehouses:' + wh, { type: 'warehouses', id: String(wh) });
      const details = refs.size
        ? await this.options.directoryApi.details([...refs.values()], { purpose: 'label' }, signal)
        : null;
      if (!this.active || generation !== this.generation) return;
      const captions = new Map<string, DirectoryItem>();
      details?.items.forEach((row) => captions.set(row.type + ':' + row.id, row));
      this.confirmedPolicy = totals.policy;
      this.emit({
        totals,
        lots,
        assortment,
        documents,
        captions,
        busy: false,
        page: totals.page,
        lotsPage: lots?.page ?? s.lotsPage,
        assortmentPage: assortment?.page ?? s.assortmentPage,
        documentsPage: documents.page,
      });
    } catch (error) {
      if (!this.active || generation !== this.generation) return;
      if (error instanceof Error && error.name === 'AbortError') return;
      this.fail(error);
    }
  }
  edit(warehouse: number, row: AssortmentRow, patch: Pick<Partial<Draft>, 'sold' | 'minimum'>) {
    if (this.state.denied) return;
    const key = draftKey(warehouse, row.product),
      drafts = new Map(this.state.drafts),
      old = drafts.get(key);
    drafts.set(key, {
      store:
        this.state.captions.get('warehouses:' + warehouse)?.store_id ??
        this.policy()?.store ??
        null,
      base: row,
      sold: row.sold,
      minimum: row.min_stock ?? '',
      busy: false,
      error: '',
      uncertain: false,
      server: null,
      reading: false,
      ...old,
      ...patch,
    });
    this.emit({ drafts, notice: '' });
  }
  reset(key: string) {
    const old = this.state.drafts.get(key);
    if (old?.busy || old?.uncertain) return;
    this.comparisons.delete(key);
    const drafts = new Map(this.state.drafts);
    drafts.delete(key);
    this.emit({ drafts });
  }
  async save(warehouse: number, product: string) {
    const key = draftKey(warehouse, product),
      old = this.state.drafts.get(key);
    if (!old || old.busy || old.uncertain || this.state.denied || !this.policy()?.canEditAssortment)
      return;
    let intent: AssortmentRequest;
    try {
      intent = { warehouse, product, ...captureTerms(old), revision: old.base.revision };
    } catch (error) {
      this.draft(key, { error: (error as Error).message });
      return;
    }
    this.draft(key, { busy: true, error: '', server: null });
    try {
      const ack = await this.api.save(intent);
      if (this.state.denied) return;
      const latest = this.state.drafts.get(key);
      if (!latest) return;
      if (JSON.stringify(ack.policy) !== JSON.stringify(this.confirmedPolicy) && this.active) {
        this.deny('Права змінилися. Оновіть розділ.');
        return;
      }
      if (latest.sold === old.sold && latest.minimum === old.minimum) {
        const drafts = new Map(this.state.drafts);
        drafts.delete(key);
        this.emit({ drafts, notice: 'Асортимент збережено.' });
      } else
        this.draft(key, {
          base: ack.row,
          busy: false,
          error: 'Попередні умови збережено. Нові зміни залишилися у чернетці.',
        });
      if (this.active) await this.refresh();
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 401 || status === 403) {
        this.draft(key, { busy: false, uncertain: true, error: (error as Error).message });
        this.deny((error as Error).message);
        return;
      }
      this.draft(key, {
        busy: false,
        uncertain:
          status === 0 ||
          status >= 500 ||
          status === 409 ||
          (error instanceof ApiError && error.code === 'protocol'),
        error:
          status === 409
            ? 'Запис змінився. Порівняйте зміни перед збереженням.'
            : (error as Error).message,
      });
    }
  }
  async compare(warehouse: number, product: string) {
    const key = draftKey(warehouse, product),
      old = this.state.drafts.get(key);
    const policy = this.policy();
    if (
      !old ||
      old.busy ||
      old.reading ||
      this.state.denied ||
      !policy?.canEditAssortment ||
      (policy.store !== null && old.store !== policy.store)
    )
      return;
    const generation = this.generation,
      request = ++this.comparisonSequence;
    this.comparisonControllers.get(key)?.abort();
    const controller = new AbortController();
    this.comparisonControllers.set(key, controller);
    this.comparisons.set(key, request);
    const live = () =>
      this.active &&
      generation === this.generation &&
      this.comparisons.get(key) === request &&
      this.state.drafts.has(key);
    this.draft(key, { reading: true, error: '' });
    try {
      const page = await this.api.assortment(warehouse, '', 1, product, controller.signal);
      if (!live() || this.state.denied) return;
      if (JSON.stringify(page.policy) !== JSON.stringify(this.confirmedPolicy))
        throw new ApiError(403, 'Права змінилися. Оновіть розділ.');
      if (page.rows[0]!.unit !== old.base.unit)
        throw Error(
          'Одиницю товару змінено. Введення збережено; автоматичне узгодження недоступне.',
        );
      if (!page.policy.canEditAssortment)
        throw new ApiError(403, 'Недостатньо прав для редагування.');
      this.draft(key, {
        server: page.rows[0]!,
        error: 'Поточний стан прочитано. Це не підтверджує авторство попереднього запиту.',
      });
    } catch (error) {
      if (live()) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403))
          this.deny(error.message);
        else this.draft(key, { error: (error as Error).message });
      }
    } finally {
      if (live()) {
        this.comparisons.delete(key);
        this.comparisonControllers.delete(key);
        this.draft(key, { reading: false });
      }
    }
  }
  apply(key: string, value: Terms) {
    const old = this.state.drafts.get(key);
    const policy = this.policy();
    if (
      !old?.server ||
      this.state.denied ||
      old.busy ||
      !policy?.canEditAssortment ||
      (policy.store !== null && old.store !== policy.store)
    )
      return;
    captureTerms({ sold: value.sold, minimum: value.min_stock ?? '' });
    this.draft(key, {
      base: old.server,
      sold: value.sold,
      minimum: value.min_stock ?? '',
      server: null,
      uncertain: false,
      error: 'Узгоджено лише чернетку. Натисніть «Зберегти» окремо.',
    });
  }
  cancelComparison(key: string) {
    this.comparisonControllers.get(key)?.abort();
    this.comparisonControllers.delete(key);
    this.comparisons.delete(key);
    this.draft(key, { server: null, reading: false });
  }
  async action(fn: () => void | Promise<void>) {
    const generation = this.generation;
    try {
      await fn();
    } catch (error) {
      if (!this.active || generation !== this.generation) return;
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        (error.status === 401 || error.status === 403)
      )
        this.deny(error instanceof Error ? error.message : 'Доступ відкликано.');
      else
        this.emit({ error: error instanceof Error ? error.message : 'Не вдалося відкрити дію.' });
    }
  }
  async csv() {
    if (this.state.denied || this.state.busy) return;
    const generation = this.generation;
    this.emit({ csvBusy: true, error: '' });
    try {
      const blob = await this.api.csv(this.query(), this.controller?.signal);
      if (!this.active || generation !== this.generation || this.state.denied) return;
      const url = URL.createObjectURL(blob);
      this.downloads.add(url);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'stock.csv';
      a.click();
      URL.revokeObjectURL(url);
      this.downloads.delete(url);
    } catch (error) {
      if (this.active && generation === this.generation) this.fail(error);
    } finally {
      if (this.active && generation === this.generation) this.emit({ csvBusy: false });
    }
  }
}
