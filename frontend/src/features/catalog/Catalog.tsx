import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Button } from '../../shared/ui/Button';
import { ApiError } from '../../shared/api/client';
import { CatalogView } from './CatalogView';
import { ProductEditor } from './ProductEditor';
import { emptyFilters, type CatalogApi, type Product, type Filters } from './api';
import './catalog.css';

export function Catalog({
  api,
  onChanged,
  onDirty,
  initialFilters = emptyFilters,
  onFiltersChanged,
}: {
  api: CatalogApi;
  onChanged: () => void;
  onDirty: (dirty: boolean) => void;
  initialFilters?: Filters;
  onFiltersChanged: (filters: Filters) => void;
}) {
  const client = useQueryClient();
  const [filters, setFilters] = useState(initialFilters);
  const [query, setQuery] = useState(initialFilters.q);
  const [editing, setEditing] = useState<{ product?: Product } | null>(null);
  const [message, setMessage] = useState('');
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
    queryKey: ['catalog', { ...filters, q: query }],
    queryFn: ({ signal }) => api.list({ ...filters, q: query }, signal),
    enabled: !!session.data,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: false,
  });
  useEffect(() => {
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ['catalog'] });
    };
    window.addEventListener('tsukenya:data-changed', refresh);
    return () => window.removeEventListener('tsukenya:data-changed', refresh);
  }, [client]);
  const saved = useCallback(
    (product: Product) => {
      onDirty(false);
      setEditing(null);
      setMessage(`Збережено: ${product.name}`);
      void client.invalidateQueries({ queryKey: ['catalog'] });
      onChanged();
    },
    [client, onChanged, onDirty],
  );
  const promotion = useMutation({
    mutationFn: (product: Product) =>
      api.save({ revision: product.revision, promotion: !product.promotion }, product.id),
    retry: false,
    onSuccess: saved,
  });
  const error = session.error || result.error || promotion.error;
  if (!result.data)
    return (
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
    );
  return (
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
        data={result.data}
        filters={filters}
        onFilters={(value) => {
          setMessage('');
          setFilters(value);
          onFiltersChanged(value);
        }}
        onEdit={(product) => setEditing(product ? { product } : {})}
        onPromotion={(product) => promotion.mutate(product)}
        busy={result.isFetching || promotion.isPending}
        message={message}
      />
      {editing ? (
        <ProductEditor
          {...editing}
          defaultMarkup={result.data.defaultMarkup}
          api={api}
          onClose={() => {
            onDirty(false);
            setEditing(null);
          }}
          onSaved={saved}
          onDeleted={() => {
            onDirty(false);
            setEditing(null);
            setMessage('Товар видалено');
            void client.invalidateQueries({ queryKey: ['catalog'] });
            onChanged();
          }}
          onDirty={onDirty}
        />
      ) : null}
    </>
  );
}
