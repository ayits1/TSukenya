import { useCallback, useEffect, useState } from 'react';
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
    defaultMarkup: string;
  } | null>(null);
  const [message, setMessage] = useState('');
  const [managingReferences, setManagingReferences] = useState(false);
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
    mutationFn: (product: Product) =>
      api.save({ revision: product.revision, promotion: false }, product.id),
    retry: false,
    onSuccess: saved,
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
            onReferences={() => setManagingReferences(true)}
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
            busy={result.isFetching || promotion.isPending}
            message={message}
          />
        </>
      )}
      {managingReferences ? (
        <ReferenceManager onClose={() => setManagingReferences(false)} onChanged={onChanged} />
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
          {...editing}
          api={api}
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
