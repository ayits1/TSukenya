import {
  type DocumentApi,
  type Header,
  type Page,
  type Query,
  type Grant,
  type Section,
} from './api';
export type Options = {
  initial: Header;
  api: DocumentApi;
  grant: (signal: AbortSignal) => Promise<Grant>;
  isCurrent: () => boolean;
  onHeader: (value: Header | null) => void;
  onDenied: (error: unknown) => void;
  onNativeAction?: (target: Element) => void;
};
export class DocumentModel {
  private state: {
    data: Page | null;
    busy: boolean;
    error: string;
    section: Section;
    limit: 10 | 30;
    denied: boolean;
  };
  private listeners = new Set<() => void>();
  private active = true;
  private controller: AbortController | null = null;
  private epoch = 0;
  private query: Query;
  constructor(private options: Options) {
    const section = options.initial.document.order ? 'order_lines' : 'lines';
    this.query = { id: options.initial.document.id, section, page: 1, limit: 30 };
    this.state = { data: null, busy: false, error: '', section, limit: 30, denied: false };
  }
  snapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit(patch: Partial<typeof this.state>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  isCurrent = () => this.active && this.options.isCurrent() && !this.state.denied;
  async read(query = this.query) {
    if (!this.isCurrent()) return null;
    this.controller?.abort();
    const controller = new AbortController(),
      epoch = ++this.epoch;
    this.controller = controller;
    this.query = query;
    const live = () => this.isCurrent() && this.epoch === epoch && !controller.signal.aborted;
    this.options.onHeader(null);
    this.emit({ data: null, busy: true, error: '', section: query.section, limit: query.limit });
    try {
      const grant = await this.options.grant(controller.signal);
      if (!live()) return null;
      const data = await this.options.api.page(query, grant, controller.signal);
      if (!live()) return null;
      await this.options.grant(controller.signal);
      if (!live()) return null;
      this.emit({ data, busy: false });
      this.options.onHeader(data);
      return data;
    } catch (error) {
      if (!live()) return null;
      const status = error && typeof error === 'object' && 'status' in error ? error.status : 0;
      this.emit({
        data: null,
        busy: false,
        error: error instanceof Error ? error.message : 'Не вдалося прочитати документ.',
        denied: status === 401 || status === 403,
      });
      if (this.state.denied) this.options.onDenied(error);
      return null;
    }
  }
  nativeAction = (target: Element) => {
    if (this.isCurrent() && !this.state.busy && this.state.data)
      this.options.onNativeAction?.(target);
  };
  select(section: Section) {
    return this.read({ ...this.query, section, page: 1 });
  }
  page(page: number) {
    return this.read({ ...this.query, page });
  }
  size(limit: 10 | 30) {
    return this.read({ ...this.query, limit, page: 1 });
  }
  async confirmedRead<T>(reader: (signal: AbortSignal, live: () => boolean) => Promise<T>) {
    // Separate full recovery serializer; no page/header can complete a B06 draft.
    if (!this.isCurrent() || !this.state.data) return;
    const epoch = this.epoch,
      c = new AbortController(),
      live = () => this.isCurrent() && epoch === this.epoch;
    try {
      await this.options.grant(c.signal);
      if (!live()) return;
      const result = await reader(c.signal, live);
      if (!live()) return;
      await this.options.grant(c.signal);
      if (live()) return result;
    } catch (error) {
      if (
        live() &&
        error &&
        typeof error === 'object' &&
        'status' in error &&
        (error.status === 401 || error.status === 403)
      ) {
        this.emit({ data: null, denied: true });
        this.options.onHeader(null);
        this.options.onDenied(error);
      }
      throw error;
    }
  }
  cancel() {
    this.active = false;
    this.epoch++;
    this.controller?.abort();
    this.state = { ...this.state, data: null };
  }
}
