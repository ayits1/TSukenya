import { normalizedTerms } from './persistence';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../shared/ui/Button';
import { ConflictComparison } from '../../shared/ui/ConflictComparison';
import { compareThreeWay, resolveThreeWay } from '../../shared/merge/threeWay';
import type { MergeChoice } from '../../shared/merge/threeWay';
import { ApiError } from '../../shared/api/client';
import { emptyFilters } from '../catalog/api';
import type { CatalogApi, Filters, Product } from '../catalog/api';
import { StudioView } from './StudioView';
import type { StudioOutputState, StudioTab, StudioViewProps } from './StudioView';
import type { LabelOutputProgress } from './output';
import { ReviewPages } from './ReviewPages';
import {
  adaptLabelProduct,
  clippedLabel,
  defaultConfig,
  LABEL_PRESETS,
  labelCopies,
  printIssues,
} from './domain';
import type { LabelField, LabelProduct } from './domain';
import type { LabelApi, Proof, Workspace } from './api';
import { RAW_LABEL_MERGE_FIELDS, baseline, raw, type Raw } from './persistence';
import type { LabelRecovery } from './recovery';
import type { PricingRequestGuard } from '../promotions/PricingContext';
import { OperationSelectionReview } from './OperationSelectionReview';
import type { PriceOperation } from './operationSelection';
import type { PromotionApi, PromotionContext } from '../promotions/api';

type Draft = Raw;
export type StudioMemory = {
  selection: Record<string, number>;
  records: Record<string, LabelProduct>;
  preview: LabelProduct | null;
  filters: Filters;
};
export const initialStudioMemory = (): StudioMemory => ({
  selection: {},
  records: {},
  preview: null,
  filters: emptyFilters,
});
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Не вдалося виконати дію. Спробуйте ще раз.';
const proofDate = (proof: Proof) => new Date(proof.date + 'T12:00:00');
const toLabel = (product: Product) => adaptLabelProduct(product, Number(product.salePrice));
// Dynamic module loading and injected read services may not themselves honor AbortSignal.
function outputWait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const detach = () => signal.removeEventListener('abort', cancel);
    const cancel = () => {
      detach();
      reject(new DOMException('Підготовку скасовано.', 'AbortError'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    work.then(
      (value) => {
        detach();
        resolve(value);
      },
      (cause) => {
        detach();
        reject(cause);
      },
    );
  });
}

export function Studio(props: StudioProps) {
  return props.recovery || props.requireRecovery ? (
    <StudioAccess {...props} />
  ) : (
    <OrdinaryStudio {...props} />
  );
}
function StudioAccess(props: StudioProps) {
  const readOnlyApi = useMemo(
    () => ({
      ...props.api,
      workspace: async (signal?: AbortSignal) => ({
        ...(await props.api.workspace(signal)),
        canEdit: false,
      }),
      save: async () => {
        throw Error('Локальне сховище чернеток недоступне.');
      },
    }),
    [props.api],
  );
  const [instance] = useState(() => crypto.randomUUID());
  const access = useQuery({
    queryKey: ['label-access', instance],
    queryFn: ({ signal }) => props.api.workspace(signal),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  if (!access.data)
    return (
      <section className="tk-root tk-studio">
        <p role="status">{access.error ? access.error.message : 'Завантажуємо студію…'}</p>
        {access.error ? <Button onPress={() => void access.refetch()}>Повторити</Button> : null}
      </section>
    );
  if (!access.data.canEdit) return <OrdinaryStudio {...props} />;
  if (props.recovery) return <PersistentStudio {...props} recovery={props.recovery} />;
  return (
    <>
      <p role="status">
        Локальне сховище чернеток недоступне. Перегляд і друк працюють; для редагування відновіть
        доступ до сховища та перезавантажте сторінку.
      </p>
      <OrdinaryStudio {...props} api={readOnlyApi} />
    </>
  );
}
type StudioProps = Parameters<typeof OrdinaryStudio>[0] & {
  recovery?: LabelRecovery;
  requireRecovery?: boolean;
};
function PersistentStudio(props: StudioProps & { recovery: LabelRecovery }) {
  const manager = props.recovery;
  const view = useSyncExternalStore(manager.subscribe, manager.snapshot);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (host.current) void manager.mount(host.current);
    return () => manager.leave();
  }, [manager]);
  return (
    <>
      {view.phase !== 'ready' ? (
        <section className="tk-root tk-studio" aria-label="Відновлення макета">
          <h2>Макет і реквізити цінників</h2>
          <p role={view.phase === 'error' ? 'alert' : 'status'}>
            {view.error ||
              (view.phase === 'offer'
                ? 'У цій вкладці є незавершена чернетка макета.'
                : 'Перевіряємо доступ до макета…')}
          </p>
          {view.phase === 'checking' ? (
            <Button onPress={() => manager.cancel()}>Скасувати перевірку макета</Button>
          ) : null}
          {view.phase === 'offer' ? (
            <>
              <Button onPress={() => void manager.restore()}>Відновити чернетку макета</Button>
              <Button onPress={() => void manager.discard()}>Відкинути чернетку макета</Button>
            </>
          ) : null}
          {view.phase === 'error' ? (
            <Button onPress={() => void (manager.payload() ? manager.read() : manager.start())}>
              Повторити перевірку макета
            </Button>
          ) : null}
        </section>
      ) : null}
      <div className="tk-label-recovery-workspace" ref={host} hidden={view.phase !== 'ready'}>
        {view.workspace ? (
          <StudioWorkspace
            {...props}
            key={view.generation}
            initial={view.workspace}
            recovery={manager}
          />
        ) : null}
      </div>
    </>
  );
}

function OrdinaryStudio({
  api,
  catalog,
  onDirty,
  onChanged,
  initialMemory,
  onMemory,
  priceStore,
  priceContext,
  operation,
  operationContext,
  operationContextGuard,
  promotions,
  onOperationApply,
  onOperationCancel,
}: {
  priceContext?: { storeId: number | null; storeName: string | null } | undefined;
  priceStore?: number | null | undefined;
  operation?: PriceOperation | null | undefined;
  operationContext?: PromotionContext | undefined;
  operationContextGuard?: PricingRequestGuard | undefined;
  promotions?: PromotionApi | undefined;
  onOperationApply?: ((context: PromotionContext) => void) | undefined;
  onOperationCancel?: (() => void) | undefined;
  api: LabelApi;
  catalog: CatalogApi;
  onDirty: (value: boolean) => void;
  onChanged: () => void;
  initialMemory: StudioMemory;
  onMemory: (value: StudioMemory) => void;
}) {
  const [instance] = useState(() => crypto.randomUUID());
  const workspace = useQuery({
    queryKey: ['label-workspace', instance],
    queryFn: ({ signal }) => api.workspace(signal),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  if (!workspace.data)
    return (
      <section className="tk-root tk-studio">
        <h2>Студія цінників</h2>
        {workspace.error ? (
          <div role="alert">
            <p>{workspace.error.message}</p>
            <Button onPress={() => void workspace.refetch()}>Повторити</Button>
          </div>
        ) : (
          <p role="status">Завантажуємо макет…</p>
        )}
      </section>
    );
  return (
    <StudioWorkspace
      api={api}
      priceStore={priceStore}
      priceContext={priceContext}
      operation={operation}
      operationContext={operationContext}
      operationContextGuard={operationContextGuard}
      promotions={promotions}
      onOperationApply={onOperationApply}
      onOperationCancel={onOperationCancel}
      catalog={catalog}
      initial={workspace.data}
      onDirty={onDirty}
      onChanged={onChanged}
      initialMemory={initialMemory}
      onMemory={onMemory}
    />
  );
}

function StudioWorkspace({
  api,
  recovery,
  catalog,
  initial,
  onDirty,
  onChanged,
  initialMemory,
  onMemory,
  priceStore,
  priceContext,
  operation,
  operationContext,
  operationContextGuard,
  promotions,
  onOperationApply,
  onOperationCancel,
}: {
  priceContext?: { storeId: number | null; storeName: string | null } | undefined;
  priceStore?: number | null | undefined;
  operation?: PriceOperation | null | undefined;
  operationContext?: PromotionContext | undefined;
  operationContextGuard?: PricingRequestGuard | undefined;
  promotions?: PromotionApi | undefined;
  onOperationApply?: ((context: PromotionContext) => void) | undefined;
  onOperationCancel?: (() => void) | undefined;
  recovery?: LabelRecovery;
  api: LabelApi;
  catalog: CatalogApi;
  initial: Workspace;
  onDirty: (value: boolean) => void;
  onChanged: () => void;
  initialMemory: StudioMemory;
  onMemory: (value: StudioMemory) => void;
}) {
  const client = useQueryClient();
  const recovered = recovery?.payload(),
    original = recovered ? baseline(recovered.baseline) : null;
  const [saved, setSaved] = useState(
      original ? { ...initial, ...original.original, revision: original.revision } : initial,
    ),
    [draft, setDraft] = useState<Draft>(
      recovered
        ? raw(recovered.draft)
        : { config: initial.config, settings: initial.settings, fontSizes: {} },
    );
  const [history, setHistory] = useState<{ past: Draft[]; future: Draft[] }>({
    past: [],
    future: [],
  });
  const [field, setField] = useState<LabelField>('name'),
    [tab, setTab] = useState<StudioTab>('design');
  const [memory, setMemory] = useState(initialMemory),
    [query, setQuery] = useState(initialMemory.filters.q),
    [previewQuery, setPreviewQuery] = useState(''),
    [previewSearch, setPreviewSearch] = useState('');
  const [error, setError] = useState(''),
    [saveState, setSaveState] = useState<'idle' | 'saving' | 'error' | 'conflict'>(
      original?.review ? 'conflict' : 'idle',
    );
  const [comparison, setComparison] = useState<{
      base: Draft;
      mine: Draft;
      server: Workspace;
      edit: number;
      baseline: string;
    } | null>(null),
    [comparisonBusy, setComparisonBusy] = useState(false),
    [comparisonNotice, setComparisonNotice] = useState(''),
    [comparisonChoices, setComparisonChoices] = useState<Record<string, MergeChoice>>({});
  const comparisonRequests = useRef(0),
    comparisonController = useRef<AbortController | null>(null),
    comparisonTrigger = useRef<HTMLButtonElement>(null);
  const [proof, setProof] = useState<Proof | null>(null),
    [preparing, setPreparing] = useState(false),
    [outputBusy, setOutputBusy] = useState(false),
    [outputState, setOutputState] = useState<StudioOutputState | null>(null),
    [outputStatus, setOutputStatus] = useState(''),
    [acknowledged, setAcknowledged] = useState(false);
  const storeRef = useRef(priceStore);
  const [measurement, setMeasurement] = useState<{ snapshot: string; clipped: string[] }>({
      snapshot: '',
      clipped: [],
    }),
    [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const sequence = useRef(0),
    busy = useRef(false),
    alive = useRef(true),
    outputController = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    if (storeRef.current !== priceStore) {
      storeRef.current = priceStore;
      sequence.current += 1;
      outputController.current?.abort();
      busy.current = false;
      setPreparing(false);
      setOutputBusy(false);
      setProof(null);
      setAcknowledged(false);
      setOutputState(null);
      setOutputStatus('Магазин ціни змінено. Підготуйте новий перегляд друку.');
    }
  }, [priceStore]);
  // Every draft replacement increments `edits`; a reload answers only for the draft it replaced.
  const edits = useRef(0),
    reloads = useRef(0),
    lastEdit = useRef<{ key: string; at: number } | null>(null);
  const dirty = !equal({ config: saved.config, settings: saved.settings, fontSizes: {} }, draft);
  const unknown = !!recovery?.payload()?.firstIntent;
  const canEdit = saved.canEdit && !saved.warnings.length;
  useEffect(() => {
    onDirty(dirty);
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, onDirty]);
  useEffect(() => {
    onMemory(memory);
  }, [memory, onMemory]);
  useEffect(() => {
    const active = alive,
      generation = sequence,
      controller = outputController,
      compareController = comparisonController,
      compareRequests = comparisonRequests;
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
      controller.current?.abort();
      compareController.current?.abort();
      compareRequests.current++;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(memory.filters.q), 200);
    return () => clearTimeout(timer);
  }, [memory.filters.q]);
  useEffect(() => {
    const timer = setTimeout(() => setPreviewSearch(previewQuery), 200);
    return () => clearTimeout(timer);
  }, [previewQuery]);
  const page = useQuery({
    queryKey: ['label-products', { ...memory.filters, q: query }, priceStore],
    queryFn: ({ signal }) => catalog.list({ ...memory.filters, q: query }, signal),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 15_000,
  });
  const suggestions = useQuery({
    queryKey: ['label-preview', previewSearch, priceStore],
    queryFn: ({ signal }) => catalog.list({ ...emptyFilters, q: previewSearch, limit: 50 }, signal),
    retry: false,
    staleTime: 15_000,
  });
  const committedPreview = useQuery({
    queryKey: ['label-preview-detail', memory.preview?.id, priceStore],
    queryFn: async () => toLabel(await catalog.product(memory.preview!.id)),
    enabled: !!memory.preview,
    retry: false,
    staleTime: 15_000,
  });
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      if (
        detail &&
        typeof detail === 'object' &&
        'domains' in detail &&
        Array.isArray(detail.domains) &&
        detail.domains.every((name: unknown) => typeof name === 'string') &&
        !detail.domains.some((name: unknown) =>
          ['products', 'settings/main'].includes(String(name)),
        )
      )
        return;
      void client.invalidateQueries({ queryKey: ['label-products'] });
      void client.invalidateQueries({ queryKey: ['label-preview'] });
      void client.invalidateQueries({ queryKey: ['label-preview-detail'] });
    };
    window.addEventListener('tsukenya:data-changed', refresh);
    return () => window.removeEventListener('tsukenya:data-changed', refresh);
  }, [client]);
  const invalidate = () => {
    sequence.current++;
    setProof(null);
    setMeasurement({ snapshot: '', clipped: [] });
    setAcknowledged(false);
    setPreparing(false);
  };
  const closeComparison = (notice = '') => {
    comparisonRequests.current++;
    comparisonController.current?.abort();
    comparisonController.current = null;
    setComparison(null);
    setComparisonBusy(false);
    setComparisonChoices({});
    setComparisonNotice(notice);
  };
  const compare = async () => {
    if (!canEdit || unknown || busy.current || saveState !== 'conflict' || comparisonBusy) return;
    const token = ++comparisonRequests.current,
      controller = new AbortController(),
      edit = edits.current,
      baseline = saved.revision;
    comparisonController.current?.abort();
    comparisonController.current = controller;
    setComparison(null);
    setComparisonChoices({});
    setComparisonNotice('');
    setComparisonBusy(true);
    setError('');
    const current = () =>
      alive.current && token === comparisonRequests.current && !controller.signal.aborted;
    try {
      const server = recovery ? await recovery.read(false) : await api.workspace(controller.signal);
      if (!server) return;
      if (!current() || edit !== edits.current) return;
      setComparison({
        base: { config: saved.config, settings: saved.settings, fontSizes: {} },
        mine: draft,
        server,
        edit,
        baseline,
      });
    } catch (cause) {
      if (current())
        setError(
          `Не вдалося завантажити порівняння. ${message(cause)} Чернетку збережено; повторіть спробу.`,
        );
    } finally {
      if (current()) {
        comparisonController.current = null;
        setComparisonBusy(false);
      }
    }
  };
  const applyComparison = () => {
    if (
      !comparison ||
      busy.current ||
      !canEdit ||
      !comparison.server.canEdit ||
      comparison.server.warnings.length
    )
      return;
    if (comparison.edit !== edits.current || comparison.baseline !== saved.revision) {
      closeComparison('Чернетку змінено. Порівняйте зміни повторно.');
      return;
    }
    const merged = resolveThreeWay(
      comparison.base,
      comparison.mine,
      { config: comparison.server.config, settings: comparison.server.settings, fontSizes: {} },
      RAW_LABEL_MERGE_FIELDS,
      comparisonChoices,
    );
    if (!merged) return;
    // Only accept a fresh baseline and a local merged draft. Saving is a separate user action.
    try {
      recovery?.apply(merged, comparison.server);
    } catch (cause) {
      setError(message(cause));
      return;
    }
    setSaved(comparison.server);
    edits.current++;
    lastEdit.current = null;
    setDraft(merged);
    setHistory({ past: [], future: [] });
    setSaveState('idle');
    setError('');
    closeComparison(
      'Зміни узгоджено в чернетці. Натисніть «Зберегти макет», щоб зберегти їх на сервері.',
    );
    invalidate();
  };
  const change = (next: Draft, mergeKey?: string) => {
    if (!canEdit || busy.current || saveState === 'saving') return;
    closeComparison(
      comparison || comparisonBusy ? 'Чернетку змінено. Порівняйте зміни повторно.' : '',
    );
    // A colour drag reports every intermediate value. Consecutive changes of the same property
    // without a pause form one undo step instead of filling the 40-step history.
    let persistenceError = '';
    try {
      recovery?.capture(next);
    } catch (cause) {
      persistenceError = message(cause);
    }
    const now = Date.now(),
      previous = lastEdit.current;
    const merge = !!mergeKey && previous?.key === mergeKey && now - previous.at < 1500;
    lastEdit.current = mergeKey ? { key: mergeKey, at: now } : null;
    if (!merge)
      setHistory((current) => ({ past: [...current.past, draft].slice(-40), future: [] }));
    edits.current++;
    setDraft(next);
    setError(persistenceError);
    if (saveState !== 'conflict') setSaveState('idle');
    invalidate();
  };
  const undo = (redo = false) => {
    if (!canEdit || busy.current || saveState === 'saving') return;
    const next = redo ? history.future[0] : history.past.at(-1);
    if (!next) return;
    try {
      recovery?.capture(next);
    } catch (cause) {
      setError(message(cause));
      return;
    }
    closeComparison();
    lastEdit.current = null;
    edits.current++;
    setHistory(
      redo
        ? { past: [...history.past, draft], future: history.future.slice(1) }
        : { past: history.past.slice(0, -1), future: [draft, ...history.future] },
    );
    setDraft(next);
    invalidate();
  };
  const changeQuantity = (id: string, quantity: number) => {
    if (busy.current) return;
    const next = Math.max(0, Math.min(500, Math.round(quantity)));
    if (!Number.isFinite(next)) return;
    const product = page.data?.items.find((product) => product.id === id);
    setMemory((current) => ({
      ...current,
      selection: { ...current.selection, [id]: next },
      records: { ...current.records, ...(product ? { [id]: toLabel(product) } : {}) },
    }));
    setError('');
    invalidate();
  };
  const save = async () => {
    if (
      !canEdit ||
      !dirty ||
      unknown ||
      busy.current ||
      saveState === 'saving' ||
      saveState === 'conflict'
    )
      return;
    setSaveState('saving');
    setError('');
    try {
      const normalized = recovery ? null : normalizedTerms(draft);
      const result = recovery
        ? await recovery.save(draft)
        : await api.save(saved.revision, normalized!.config, normalized!.settings);
      if (!result) {
        if (alive.current) setSaveState('idle');
        return;
      }
      if (!alive.current) return;
      setSaved(result);
      lastEdit.current = null;
      edits.current++;
      setDraft({ config: result.config, settings: result.settings, fontSizes: {} });
      setHistory({ past: [], future: [] });
      setSaveState('idle');
      onChanged();
    } catch (cause) {
      if (!alive.current) return;
      setSaveState(cause instanceof ApiError && cause.status === 409 ? 'conflict' : 'error');
      setError(message(cause));
    }
  };
  const reload = async () => {
    if (busy.current || saveState === 'saving') return;
    if (dirty && !confirm('Замінити чернетку збереженим макетом?')) return;
    if (recovery) {
      await recovery.discard();
      return;
    }
    closeComparison();
    // An edit, undo or newer reload while waiting wins: a late response must not replace
    // that draft or clear its undo history.
    const token = ++reloads.current,
      draftAtRequest = edits.current;
    const current = () =>
      alive.current && token === reloads.current && draftAtRequest === edits.current;
    setPreparing(true);
    try {
      const workspace = await api.workspace();
      if (!current()) return;
      setSaved(workspace);
      lastEdit.current = null;
      edits.current++;
      setDraft({ config: workspace.config, settings: workspace.settings, fontSizes: {} });
      setHistory({ past: [], future: [] });
      setSaveState('idle');
      setError('');
      invalidate();
    } catch (cause) {
      if (current()) {
        setError(message(cause));
        setPreparing(false);
      }
    }
  };
  const selection = Object.entries(memory.selection)
    .filter(([, quantity]) => quantity > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, quantity]) => ({ id, quantity }));
  const review = async () => {
    if (busy.current || preparing) return;
    setTab('review');
    setAcknowledged(false);
    setError('');
    if (dirty) {
      setProof(null);
      setError('Збережіть макет перед перевіркою друку.');
      return;
    }
    if (saved.warnings.length) {
      setError(saved.warnings.join(' '));
      return;
    }
    const token = ++sequence.current;
    setPreparing(true);
    setProof(null);
    setMeasurement({ snapshot: '', clipped: [] });
    try {
      const requestedStore = priceStore;
      const current = await api.prepare(selection, undefined, requestedStore);
      if (storeRef.current !== requestedStore) return;
      if (!alive.current || token !== sequence.current) return;
      if (current.revision !== saved.revision) {
        setSaveState('conflict');
        setError('Збережений макет змінився. Завантажте актуальний макет і повторіть перевірку.');
        return;
      }
      if (current.warnings.length) {
        setError(current.warnings.join(' '));
        return;
      }
      setProof(current);
      setOutputStatus('');
      setMemory((previous) => ({
        ...previous,
        records: {
          ...previous.records,
          ...Object.fromEntries(current.products.map((product) => [product.id, toLabel(product)])),
        },
      }));
    } catch (cause) {
      if (alive.current && token === sequence.current) setError(message(cause));
    } finally {
      if (alive.current && token === sequence.current) setPreparing(false);
    }
  };
  const copies = useMemo(
    () =>
      proof
        ? labelCopies(
            proof.products.map(toLabel),
            Object.fromEntries(proof.selection.map((row) => [row.id, row.quantity])),
          )
        : [],
    [proof],
  );
  const issues = proof
    ? printIssues(copies, proof.settings, proofDate(proof))
    : { noPrice: [], stale: [], incompletePromotion: [], overLimit: false };
  const validationErrors = [
    ...(!selection.length ? ['Оберіть товари для друку.'] : []),
    ...(selection.reduce((sum, row) => sum + row.quantity, 0) > 1000
      ? ['За один раз можна підготувати до 1000 цінників.']
      : []),
    ...(dirty ? ['Збережіть макет перед перевіркою друку.'] : []),
    ...(!draft.config.name || !draft.config.price
      ? ['Для друку цінника увімкніть назву товару та ціну.']
      : []),
    ...(issues.noPrice.length
      ? [`Немає ціни: ${issues.noPrice.slice(0, 5).join(', ')}. Друк заблоковано.`]
      : []),
    ...(issues.incompletePromotion.length
      ? [
          `Акція без окремої акційної ціни: ${issues.incompletePromotion.slice(0, 5).join(', ')}. Задайте звичайну й акційну ціну або вимкніть акцію.`,
        ]
      : []),
    ...(measurement.clipped.length
      ? [
          `Текст не вміщується: ${measurement.clipped
            .slice(0, 3)
            .map((id) => proof?.products.find((product) => product.id === id)?.name || id)
            .join(', ')}. Зменште шрифт або приховайте додаткові елементи.`,
        ]
      : []),
  ];
  const canOutput =
    !!proof &&
    !dirty &&
    !preparing &&
    !outputBusy &&
    measurement.snapshot === proof.snapshot &&
    !validationErrors.length &&
    (!issues.stale.length || acknowledged);
  const measured = useCallback((snapshot: string, clipped: string[]) => {
    setMeasurement((current) =>
      current.snapshot === snapshot && equal(current.clipped, clipped)
        ? current
        : { snapshot, clipped },
    );
  }, []);
  const cancelOutput = () => {
    const controller = outputController.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setOutputState((current) => (current ? { ...current, cancelling: true } : current));
  };
  const output = async (kind: 'print' | 'pdf' | 'csv') => {
    if (!proof || !canOutput || busy.current) return;
    const controller = new AbortController();
    outputController.current = controller;
    busy.current = true;
    setOutputBusy(true);
    setOutputState({ kind, stage: 'verify', completed: 0, total: 1, cancelling: false });
    setOutputStatus('');
    setError('');
    const token = ++sequence.current;
    const live = () =>
      alive.current && token === sequence.current && outputController.current === controller;
    const progress = (value: LabelOutputProgress) => {
      if (live() && !controller.signal.aborted)
        setOutputState({ ...value, kind, cancelling: false });
    };
    try {
      const current = await outputWait(
        api.prepare(proof.selection, controller.signal, proof.priceContext?.storeId ?? priceStore),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (!live()) return;
      if (current.snapshot !== proof.snapshot) {
        setProof(null);
        setAcknowledged(false);
        setError(
          'Ціни або макет змінилися після перегляду. Натисніть «Оновити перевірку» та перевірте цінники знову.',
        );
        return;
      }
      setOutputState({ kind, stage: 'module', completed: 0, total: 1, cancelling: false });
      const module = await outputWait(import('./output'), controller.signal);
      controller.signal.throwIfAborted();
      if (!live()) return;
      const snapshot = {
        products: copies,
        config: proof.config,
        settings: proof.settings,
        date: proofDate(proof),
      };
      const options = { signal: controller.signal, onProgress: progress };
      if (kind === 'pdf') await module.exportPdf(snapshot, options);
      else if (kind === 'print') await module.printLabels(snapshot, options);
      else module.downloadCsv(proof.products.map(toLabel));
      if (live())
        setOutputStatus(
          kind === 'print'
            ? 'Цінники передано системному діалогу друку.'
            : `${kind === 'pdf' ? 'PDF' : 'CSV'} сформовано. Перевірте завантаження браузера.`,
        );
    } catch (cause) {
      if (live()) {
        if (controller.signal.aborted)
          setOutputStatus('Підготовку скасовано. Товари й кількість копій збережені.');
        else setError(message(cause));
      }
    } finally {
      if (outputController.current === controller) {
        outputController.current = null;
        busy.current = false;
        if (alive.current) {
          setOutputBusy(false);
          setOutputState(null);
        }
      }
    }
  };
  // Preview is deliberately separate from committed selection and always has explicit clear.
  const previewProduct = memory.preview
    ? committedPreview.error
      ? null
      : committedPreview.data || (priceStore === undefined ? memory.preview : null)
    : null;
  useEffect(() => {
    let active = true;
    const check = () => {
      const label = document.querySelector<HTMLElement>(
        '#react-labels .tk-studio-canvas .tk-label.tag',
      );
      const warnings =
        label && clippedLabel(label)
          ? ['Текст не вміщується. Зменште шрифт або приховайте додаткові елементи.']
          : [];
      if (
        previewProduct?.promotion &&
        printIssues([previewProduct], draft.settings).incompletePromotion.length
      )
        warnings.push(
          'Акційна ціна не задана. Відкрийте товар і задайте звичайну й акційну ціну або вимкніть акцію.',
        );
      if (active)
        setPreviewWarnings((previous) => (equal(previous, warnings) ? previous : warnings));
    };
    void document.fonts.ready.then(check);
    const frame = requestAnimationFrame(check);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [draft, previewProduct, tab]);
  const saveStatus: StudioViewProps['saveStatus'] =
    saveState === 'idle' ? (dirty ? 'dirty' : 'saved') : saveState;
  const combinedError = [
    error,
    page.error?.message,
    suggestions.error?.message,
    committedPreview.error?.message,
    ...saved.warnings,
  ]
    .filter(Boolean)
    .join(' ');
  const selectedProducts = Object.keys(memory.selection)
    .filter((id) => (memory.selection[id] ?? 0) > 0)
    .map((id) => memory.records[id])
    .filter((product): product is LabelProduct => !!product);
  return (
    <StudioView
      operationReview={
        operation && operationContext && promotions ? (
          <OperationSelectionReview
            key={operation.token}
            operation={operation}
            context={operationContext}
            contextGuard={operationContextGuard}
            promotions={promotions}
            selection={memory.selection}
            isDisabled={outputBusy || preparing || comparisonBusy}
            onCancel={() => onOperationCancel?.()}
            onApply={(next, products, context) => {
              if (busy.current || preparing || outputBusy)
                throw Error('Дочекайтеся завершення поточної перевірки або друку.');
              if (operationContextGuard && !operationContextGuard.isCurrent())
                throw Error('Вибір магазину змінився. Прочитайте перегляд повторно.');
              onOperationApply?.(context);
              invalidate();
              setMemory((previous) => ({
                ...previous,
                selection: next,
                records: {
                  ...previous.records,
                  ...Object.fromEntries(products.map((product) => [product.id, toLabel(product)])),
                },
              }));
              void client.invalidateQueries({ queryKey: ['label-products'] });
              void client.invalidateQueries({ queryKey: ['label-preview'] });
              setOutputStatus(
                'Вибір за результатом операції застосовано. Перевірте актуальний друк окремою дією.',
              );
              onOperationCancel?.();
            }}
          />
        ) : null
      }
      config={draft.config}
      settings={draft.settings}
      previewSettings={
        priceContext
          ? {
              ...draft.settings,
              storeNames: priceContext.storeName ? [priceContext.storeName] : [],
            }
          : draft.settings
      }
      previewConfig={
        priceContext
          ? {
              ...draft.config,
              storeIdx: 0,
              ...(priceContext.storeId === null ? { store: false } : {}),
            }
          : draft.config
      }
      selectedField={field}
      onSelectField={setField}
      rawFontSize={draft.fontSizes[field]}
      onRawFontSize={(value) => {
        const number = Number(value.replace(',', '.'));
        change({
          ...draft,
          fontSizes: { ...draft.fontSizes, [field]: value },
          config:
            /^\d+(?:[.,]\d+)?$/.test(value.trim()) && number >= 5 && number <= 72
              ? {
                  ...draft.config,
                  styles: {
                    ...draft.config.styles,
                    [field]: { ...draft.config.styles[field], size: number },
                  },
                }
              : draft.config,
        });
      }}
      onConfigChange={(config, mergeKey) => change({ ...draft, config }, mergeKey)}
      onSettingsChange={(settings, storeIdx) =>
        change({
          ...draft,
          settings,
          config: storeIdx === undefined ? draft.config : { ...draft.config, storeIdx },
        })
      }
      onResetField={() => {
        const styles = { ...draft.config.styles };
        delete styles[field];
        const fontSizes = { ...draft.fontSizes };
        delete fontSizes[field];
        change({ ...draft, fontSizes, config: { ...draft.config, styles } });
      }}
      onResetTemplate={() => {
        if (confirm('Скинути оформлення всіх елементів?'))
          change({ ...draft, fontSizes: {}, config: defaultConfig() });
      }}
      onApplyPreset={(preset) => {
        if (confirm('Застосувати готове оформлення до всіх цінників?')) {
          const chosen = LABEL_PRESETS.find(
            (item) => item.id === (preset === 'standard' ? 'classic' : preset),
          );
          if (chosen)
            change({
              ...draft,
              fontSizes: {},
              config: {
                ...chosen.config,
                size: draft.config.size,
                storeIdx: draft.config.storeIdx,
              },
            });
        }
      }}
      saveStatus={saveStatus}
      saveBlocked={unknown}
      onSave={() => void save()}
      onReload={() => void reload()}
      onCompare={(trigger) => {
        comparisonTrigger.current = trigger;
        void compare();
      }}
      comparisonBusy={comparisonBusy}
      comparison={
        <div className="tk-studio-comparison">
          {unknown ? (
            <div role="status">
              <p>
                Результат первісного збереження ще не підтверджено. Нові правки не замінюють цей
                запит.
              </p>
              <Button onPress={() => void recovery?.read()}>Звірити збереження макета</Button>
              <Button
                onPress={() =>
                  void recovery?.save(draft, true).catch((cause) => setError(message(cause)))
                }
              >
                Повторити первісний запит макета
              </Button>
            </div>
          ) : null}
          {comparisonBusy ? (
            <div>
              <p role="status">
                Завантажуємо актуальний макет для порівняння. Чернетка залишається без змін…
              </p>
              <Button
                onPress={() => {
                  closeComparison('Порівняння скасовано. Чернетку збережено.');
                  requestAnimationFrame(() => {
                    if (alive.current) comparisonTrigger.current?.focus();
                  });
                }}
              >
                Скасувати порівняння
              </Button>
            </div>
          ) : comparison ? (
            <>
              {!comparison.server.canEdit || comparison.server.warnings.length ? (
                <p role="alert">
                  {comparison.server.warnings.join(' ') ||
                    'Редагування актуального макета недоступне.'}
                </p>
              ) : null}
              <ConflictComparison
                title="Порівняння макетів цінника"
                rows={compareThreeWay(
                  comparison.base,
                  comparison.mine,
                  {
                    config: comparison.server.config,
                    settings: comparison.server.settings,
                    fontSizes: {},
                  },
                  RAW_LABEL_MERGE_FIELDS,
                )}
                choices={comparisonChoices}
                onChoice={(id, choice) =>
                  setComparisonChoices((current) => ({ ...current, [id]: choice }))
                }
                onApply={applyComparison}
                onCancel={() => {
                  closeComparison('Порівняння скасовано. Чернетку збережено.');
                  requestAnimationFrame(() => {
                    if (alive.current) comparisonTrigger.current?.focus();
                  });
                }}
                isDisabled={
                  !comparison.server.canEdit || !!comparison.server.warnings.length || outputBusy
                }
              />
            </>
          ) : comparisonNotice ? (
            <p role="status">{comparisonNotice}</p>
          ) : null}
        </div>
      }
      canEdit={canEdit}
      selectedTab={tab}
      onTabChange={(next) => {
        if (!busy.current) setTab(next);
      }}
      previewProduct={previewProduct}
      previewProducts={suggestions.data?.items.map(toLabel) || []}
      previewLoading={suggestions.isFetching || previewQuery !== previewSearch}
      onPreviewProductChange={(id) => {
        const product =
          suggestions.data?.items.find((product) => product.id === id) ||
          page.data?.items.find((product) => product.id === id);
        setMemory((current) => ({
          ...current,
          preview:
            id && product ? toLabel(product) : id === current.preview?.id ? current.preview : null,
        }));
        setPreviewQuery('');
      }}
      onPreviewQueryChange={(value) => setPreviewQuery(value === previewProduct?.name ? '' : value)}
      products={page.data?.items.map(toLabel) || []}
      selectedProducts={selectedProducts}
      selection={memory.selection}
      onQuantityChange={changeQuantity}
      onSelectShown={(ids) => {
        if (busy.current) return;
        setMemory((current) => ({
          ...current,
          selection: {
            ...current.selection,
            ...Object.fromEntries(ids.map((id) => [id, current.selection[id] || 1])),
          },
          records: {
            ...current.records,
            ...Object.fromEntries(
              (page.data?.items || []).map((product) => [product.id, toLabel(product)]),
            ),
          },
        }));
        invalidate();
      }}
      onClearSelection={() => {
        if (!busy.current) {
          setMemory((current) => ({ ...current, selection: {}, records: {} }));
          invalidate();
        }
      }}
      filters={memory.filters}
      facets={page.data?.facets || { type: [], category: [], pack: [] }}
      {...(catalog.facets ? { facetApi: catalog.facets } : {})}
      onFiltersChange={(filters) =>
        setMemory((current) => ({ ...current, filters: { ...filters, page: 1, limit: 20 } }))
      }
      page={page.data?.page || 1}
      pages={page.data?.pages || 1}
      total={page.data?.total || 0}
      onPageChange={(next) =>
        setMemory((current) => ({ ...current, filters: { ...current.filters, page: next } }))
      }
      loading={page.isFetching}
      error={combinedError}
      {...(page.error || suggestions.error || committedPreview.error
        ? {
            onRetryProducts: () => {
              if (page.error) void page.refetch();
              if (suggestions.error) void suggestions.refetch();
              if (committedPreview.error) void committedPreview.refetch();
            },
            retryingProducts:
              page.isFetching || suggestions.isFetching || committedPreview.isFetching,
          }
        : {})}
      onReview={() => void review()}
      preparing={preparing}
      outputBusy={outputBusy}
      outputState={outputState}
      outputStatus={outputStatus}
      onCancelOutput={cancelOutput}
      canOutput={canOutput}
      onPrint={() => void output('print')}
      onExport={() => void output('pdf')}
      onCsv={() => void output('csv')}
      review={
        proof ? (
          <ReviewPages
            key={proof.snapshot}
            snapshot={proof.snapshot}
            products={copies}
            config={proof.config}
            settings={proof.settings}
            date={proofDate(proof)}
            onMeasured={measured}
            isDisabled={outputBusy}
          />
        ) : (
          <p role="status">
            {preparing
              ? 'Звіряємо ціни й готуємо аркуші…'
              : 'Підготуйте перегляд, щоб перевірити розкладку.'}
          </p>
        )
      }
      validationErrors={validationErrors}
      staleProducts={issues.stale}
      staleAcknowledged={acknowledged}
      onStaleAcknowledged={setAcknowledged}
      canUndo={!!history.past.length && saveState !== 'saving'}
      onUndo={() => undo()}
      canRedo={!!history.future.length && saveState !== 'saving'}
      onRedo={() => undo(true)}
      previewWarnings={previewWarnings}
    />
  );
}
