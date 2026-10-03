import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../shared/ui/Button';
import { ApiError } from '../../shared/api/client';
import { emptyFilters } from '../catalog/api';
import type { CatalogApi, Filters, Product } from '../catalog/api';
import { StudioView } from './StudioView';
import type { StudioOutputState, StudioTab, StudioViewProps } from './StudioView';
import type { LabelOutputProgress } from './output';
import { PrintPages } from './Label';
import {
  adaptLabelProduct,
  clippedLabel,
  defaultConfig,
  LABEL_PRESETS,
  labelCopies,
  printIssues,
} from './domain';
import type { LabelConfig, LabelField, LabelProduct, LabelSettings } from './domain';
import type { LabelApi, Proof, Workspace } from './api';

type Draft = { config: LabelConfig; settings: LabelSettings };
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

function ReviewPages({
  proof,
  copies,
  onMeasured,
}: {
  proof: Proof;
  copies: LabelProduct[];
  onMeasured: (snapshot: string, clipped: string[]) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    viewport = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setZoom(Math.min(1, entry.contentRect.width / ((210 * 96) / 25.4)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    const measure = () => {
      if (active && host.current)
        onMeasured(proof.snapshot, [
          ...new Set(
            [...host.current.querySelectorAll<HTMLElement>('.tk-label.tag')]
              .filter(clippedLabel)
              .map((element) => element.dataset.product || ''),
          ),
        ]);
    };
    void document.fonts.ready.then(measure);
    const timer = requestAnimationFrame(measure);
    return () => {
      active = false;
      cancelAnimationFrame(timer);
    };
  }, [proof, copies, onMeasured, zoom]);
  return (
    <div className="tk-studio-proof-viewport" ref={viewport}>
      <div className="tk-studio-proof-pages" ref={host} style={{ zoom }}>
        <PrintPages
          products={copies}
          config={proof.config}
          settings={proof.settings}
          date={proofDate(proof)}
        />
      </div>
    </div>
  );
}

export function Studio({
  api,
  catalog,
  onDirty,
  onChanged,
  initialMemory,
  onMemory,
}: {
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
  catalog,
  initial,
  onDirty,
  onChanged,
  initialMemory,
  onMemory,
}: {
  api: LabelApi;
  catalog: CatalogApi;
  initial: Workspace;
  onDirty: (value: boolean) => void;
  onChanged: () => void;
  initialMemory: StudioMemory;
  onMemory: (value: StudioMemory) => void;
}) {
  const client = useQueryClient();
  const [saved, setSaved] = useState(initial),
    [draft, setDraft] = useState<Draft>({ config: initial.config, settings: initial.settings });
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
    [saveState, setSaveState] = useState<'idle' | 'saving' | 'error' | 'conflict'>('idle');
  const [proof, setProof] = useState<Proof | null>(null),
    [preparing, setPreparing] = useState(false),
    [outputBusy, setOutputBusy] = useState(false),
    [outputState, setOutputState] = useState<StudioOutputState | null>(null),
    [outputStatus, setOutputStatus] = useState(''),
    [acknowledged, setAcknowledged] = useState(false);
  const [measurement, setMeasurement] = useState<{ snapshot: string; clipped: string[] }>({
      snapshot: '',
      clipped: [],
    }),
    [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const sequence = useRef(0),
    busy = useRef(false),
    alive = useRef(true),
    outputController = useRef<AbortController | null>(null);
  const dirty = !equal({ config: saved.config, settings: saved.settings }, draft);
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
      controller = outputController;
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
      controller.current?.abort();
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
    queryKey: ['label-products', { ...memory.filters, q: query }],
    queryFn: ({ signal }) => catalog.list({ ...memory.filters, q: query }, signal),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 15_000,
  });
  const suggestions = useQuery({
    queryKey: ['label-preview', previewSearch],
    queryFn: ({ signal }) => catalog.list({ ...emptyFilters, q: previewSearch, limit: 50 }, signal),
    retry: false,
    staleTime: 15_000,
  });
  const committedPreview = useQuery({
    queryKey: ['label-preview-detail', memory.preview?.id],
    queryFn: async () => toLabel(await catalog.product(memory.preview!.id)),
    enabled: !!memory.preview,
    retry: false,
    staleTime: 15_000,
  });
  useEffect(() => {
    const refresh = () => {
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
  const change = (next: Draft) => {
    if (!canEdit || busy.current || saveState === 'saving') return;
    setHistory((current) => ({ past: [...current.past, draft].slice(-40), future: [] }));
    setDraft(next);
    setError('');
    if (saveState !== 'conflict') setSaveState('idle');
    invalidate();
  };
  const undo = (redo = false) => {
    if (!canEdit || busy.current || saveState === 'saving') return;
    const next = redo ? history.future[0] : history.past.at(-1);
    if (!next) return;
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
    if (!canEdit || !dirty || busy.current || saveState === 'saving' || saveState === 'conflict')
      return;
    setSaveState('saving');
    setError('');
    try {
      const result = await api.save(saved.revision, draft.config, draft.settings);
      if (!alive.current) return;
      setSaved(result);
      setDraft({ config: result.config, settings: result.settings });
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
    setPreparing(true);
    try {
      const current = await api.workspace();
      if (!alive.current) return;
      setSaved(current);
      setDraft({ config: current.config, settings: current.settings });
      setHistory({ past: [], future: [] });
      setSaveState('idle');
      setError('');
      invalidate();
    } catch (cause) {
      if (alive.current) {
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
      const current = await api.prepare(selection);
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
        api.prepare(proof.selection, controller.signal),
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
      : committedPreview.data || memory.preview
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
      config={draft.config}
      settings={draft.settings}
      selectedField={field}
      onSelectField={setField}
      onConfigChange={(config) => change({ ...draft, config })}
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
        change({ ...draft, config: { ...draft.config, styles } });
      }}
      onResetTemplate={() => {
        if (confirm('Скинути оформлення всіх елементів?'))
          change({ ...draft, config: defaultConfig() });
      }}
      onApplyPreset={(preset) => {
        if (confirm('Застосувати готове оформлення до всіх цінників?')) {
          const chosen = LABEL_PRESETS.find(
            (item) => item.id === (preset === 'standard' ? 'classic' : preset),
          );
          if (chosen)
            change({
              ...draft,
              config: {
                ...chosen.config,
                size: draft.config.size,
                storeIdx: draft.config.storeIdx,
              },
            });
        }
      }}
      saveStatus={saveStatus}
      onSave={() => void save()}
      onReload={() => void reload()}
      canEdit={canEdit}
      selectedTab={tab}
      onTabChange={(next) => {
        if (!busy.current) setTab(next);
      }}
      previewProduct={previewProduct}
      previewProducts={suggestions.data?.items.map(toLabel) || []}
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
          <ReviewPages proof={proof} copies={copies} onMeasured={measured} />
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
