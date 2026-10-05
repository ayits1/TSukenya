import { takeCatalogRestore } from './recovery/session';
import type { CatalogPayload } from './recovery/codec';
import { createCatalogApi } from './api';
import { useCallback, useEffect, useState, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../shared/ui/Button';
import { ApiError } from '../../shared/api/client';
import { CatalogVisibility } from './CatalogVisibility';
import { CatalogView } from './CatalogView';
import { ReferenceManager } from './ReferenceManager';
import { ProductEditor } from './ProductEditor';
import { emptyFilters, type CatalogApi, type Product, type Filters } from './api';
import './catalog.css';
import { CampaignManager } from '../promotions/CampaignManager';
import type { PromotionApi, PromotionContext } from '../promotions/api';

export function Catalog({
  api,
  onChanged,
  onDirty,
  initialFilters = emptyFilters,
  onFiltersChanged,
  priceStore,
  promotions,
  priceContext,
}: {
  api: CatalogApi;
  priceStore?: number | null;
  promotions?: PromotionApi;
  priceContext?: PromotionContext;
  onChanged: () => void;
  onDirty: (dirty: boolean) => void;
  initialFilters?: Filters;
  onFiltersChanged: (filters: Filters) => void;
}) {
  const client = useQueryClient();
  const [productDirty, setProductDirty] = useState(false);
  const [campaignDirty, setCampaignDirty] = useState(false);
  useEffect(() => onDirty(productDirty || campaignDirty), [onDirty, productDirty, campaignDirty]);
  const [filters, setFilters] = useState(initialFilters);
  const [query, setQuery] = useState(initialFilters.q);
  const [editing, setEditing] = useState<{
    product?: Product;
    activatePromotion?: boolean;
    deactivatePromotion?: boolean;
    restoredPayload?: CatalogPayload;
    defaultMarkup: string;
  } | null>(null);
  const exportRequest = useRef<AbortController | null>(null),
    exportSequence = useRef(0);
  const exportIdentity = JSON.stringify([filters, priceStore]);
  const [exporting, setExporting] = useState<string | null>(null);
  const exportBusy = exporting === exportIdentity;
  useEffect(
    () => () => {
      exportRequest.current?.abort();
      exportSequence.current += 1;
    },
    [api, exportIdentity],
  );
  const download = async () => {
    if (!api.exportCsv || exportBusy || result.isFetching || query !== filters.q) return;
    const controller = new AbortController(),
      sequence = ++exportSequence.current;
    exportRequest.current = controller;
    setExporting(exportIdentity);
    setMessage('');
    try {
      const blob = await api.exportCsv(filters, controller.signal);
      if (sequence !== exportSequence.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'catalogue.csv';
      try {
        document.body.append(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        URL.revokeObjectURL(url);
      }
      setMessage('CSV містить усі товари за поточним фільтром.');
    } catch (cause) {
      if (sequence === exportSequence.current && !controller.signal.aborted)
        setMessage(cause instanceof Error ? cause.message : 'Експорт недоступний.');
    } finally {
      if (sequence === exportSequence.current && !controller.signal.aborted) setExporting(null);
    }
  };
  const [message, setMessage] = useState('');
  const [managingReferences, setManagingReferences] = useState(false);
  const [managerRestore, setManagerRestore] = useState<CatalogPayload | undefined>();
  const [restoredApi, setRestoredApi] = useState<CatalogApi | null>(null);
  useEffect(() => {
    const restore = () => {
      const payload = takeCatalogRestore();
      if (!payload) return;
      if (payload.baseline.kind === 'product') {
        const restoredClient = createCatalogApi(payload.baseline.store);
        setRestoredApi(restoredClient);
        void restoredClient.session().catch(() => {});
        setEditing({ defaultMarkup: payload.baseline.defaultMarkup, restoredPayload: payload });
      } else {
        setManagerRestore(payload);
        setManagingReferences(true);
      }
    };
    window.addEventListener('tsukenya:catalog-draft-restore', restore);
    restore();
    return () => window.removeEventListener('tsukenya:catalog-draft-restore', restore);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(filters.q), 250);
    return () => clearTimeout(timer);
  }, [filters.q]);
  const session = useQuery({
    queryKey: ['catalog-session'],
    queryFn: ({ signal }) => api.session(signal),
    staleTime: 60_000,
    retry: false,
  });
  const result = useQuery({
    queryKey: ['catalog', { ...filters, q: query }, priceStore],
    queryFn: ({ signal }) => api.list({ ...filters, q: query }, signal),
    enabled: !!session.data,
    placeholderData: (previous) =>
      previous?.visibility === (filters.visibility || 'active') ? previous : undefined,
    staleTime: 15_000,
    retry: false,
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
          ['products', 'references', 'settings/main'].includes(String(name)),
        )
      )
        return;
      void client.invalidateQueries({ queryKey: ['catalog'] });
      void client.invalidateQueries({ queryKey: ['catalog-references'] });
      void client.invalidateQueries({ queryKey: ['catalog-reference-details'] });
    };
    window.addEventListener('tsukenya:data-changed', refresh);
    return () => window.removeEventListener('tsukenya:data-changed', refresh);
  }, [client]);
  const saved = useCallback(
    (product: Product) => {
      setProductDirty(false);
      setEditing(null);
      setMessage(`Збережено: ${product.name}`);
      void client.invalidateQueries({ queryKey: ['catalog'] });
      onChanged();
    },
    [client, onChanged],
  );
  const promotion = useMutation({
    mutationFn: async (product: Product) => {
      setRestoredApi(null);
      setEditing({
        product,
        defaultMarkup: result.data?.defaultMarkup || '0',
        deactivatePromotion: true,
      });
    },
    retry: false,
  });
  const error = session.error || result.error || promotion.error;
  return (
    <>
      <div className="tk-catalog-mode tk-root">
        <CatalogVisibility
          filters={filters}
          onChange={(value) => {
            setMessage('');
            setFilters(value);
            onFiltersChanged(value);
          }}
        />
      </div>
      {!result.data ? (
        <section className="tk-catalog tk-root">
          {error ? (
            <div role="alert">
              <h2>Не вдалося відкрити каталог</h2>
              <p>{error.message}</p>
              {error instanceof ApiError && error.status === 401 ? (
                <a href="/">Увійти знову</a>
              ) : (
                <Button
                  onPress={() => {
                    void session.refetch();
                    void result.refetch();
                  }}
                >
                  Повторити
                </Button>
              )}
            </div>
          ) : (
            <p role="status">Завантажуємо каталог…</p>
          )}
        </section>
      ) : (
        <>
          {error ? (
            <div className="tk-catalog-error" role="alert">
              {error.message}{' '}
              <Button
                onPress={() => {
                  promotion.reset();
                  void result.refetch();
                }}
              >
                Оновити список
              </Button>
            </div>
          ) : null}
          <CatalogView
            {...(api.facets ? { facetApi: api.facets } : {})}
            showVisibility={false}
            data={result.data}
            {...(api.exportCsv ? { onExport: () => void download() } : {})}
            onReferences={() => {
              setManagerRestore(undefined);
              setManagingReferences(true);
            }}
            filters={filters}
            onFilters={(value) => {
              setMessage('');
              setFilters(value);
              onFiltersChanged(value);
            }}
            onEdit={(product) =>
              setEditing(
                product
                  ? { product, defaultMarkup: result.data.defaultMarkup }
                  : { defaultMarkup: result.data.defaultMarkup },
              )
            }
            onPromotion={(product) => {
              if (product.effectivePromotion?.source === 'campaign')
                setEditing({ product, defaultMarkup: result.data.defaultMarkup });
              else if (product.promotion) promotion.mutate(product);
              else
                setEditing({
                  product,
                  activatePromotion: true,
                  defaultMarkup: result.data.defaultMarkup,
                });
            }}
            busy={result.isFetching || promotion.isPending || exportBusy || query !== filters.q}
            message={message}
          />
        </>
      )}
      {managingReferences ? (
        <ReferenceManager
          key={managerRestore?.baseline.recordId || 'new_reference_manager'}
          {...(managerRestore ? { restoredPayload: managerRestore } : {})}
          store={managerRestore?.baseline.store ?? priceStore ?? null}
          onClose={() => setManagingReferences(false)}
          onChanged={onChanged}
        />
      ) : null}
      {promotions && priceContext && (priceContext.canManage || priceContext.canViewHistory) ? (
        <CampaignManager
          api={promotions}
          catalog={api}
          context={priceContext}
          onDirty={setCampaignDirty}
          onChanged={() => {
            void client.invalidateQueries({ queryKey: ['catalog'] });
            onChanged();
          }}
        />
      ) : null}
      {editing ? (
        <ProductEditor
          key={editing.restoredPayload?.baseline.recordId || editing.product?.id || 'new_product'}
          {...editing}
          api={editing.restoredPayload && restoredApi ? restoredApi : api}
          onClose={() => {
            setProductDirty(false);
            setEditing(null);
          }}
          onSaved={saved}
          onVisibilityChanged={(product) => {
            setMessage(
              product.hidden ? `Приховано: ${product.name}` : `Відновлено: ${product.name}`,
            );
            void client.invalidateQueries({ queryKey: ['catalog'] });
            onChanged();
          }}
          onDeleted={() => {
            setProductDirty(false);
            setEditing(null);
            setMessage('Товар видалено');
            void client.invalidateQueries({ queryKey: ['catalog'] });
            onChanged();
          }}
          onDirty={setProductDirty}
        />
      ) : null}
    </>
  );
}
