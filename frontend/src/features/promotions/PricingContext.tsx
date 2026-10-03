import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Select } from '../../shared/ui/Select';
import { Button } from '../../shared/ui/Button';
import { createCatalogApi, type CatalogApi } from '../catalog/api';
import { createPromotionApi, type PromotionApi, type PromotionContext } from './api';
import './promotions.css';
export function PricingContext({
  children,
  api: supplied,
}: {
  children: (
    catalog: CatalogApi,
    store: number | null,
    context: PromotionContext,
    promotions: PromotionApi,
  ) => ReactNode;
  api?: PromotionApi;
}) {
  const [api] = useState(() => supplied || createPromotionApi());
  const [selected, setSelected] = useState<number | null | undefined>(undefined);
  const query = useQuery({
    queryKey: ['promotion-context', selected],
    queryFn: ({ signal }) => api.context(selected, signal),
    retry: false,
    placeholderData: keepPreviousData,
  });
  const store = selected === undefined ? query.data?.storeId : selected;
  const catalog = useMemo(
    () => createCatalogApi(store, query.data?.csrf),
    [store, query.data?.csrf],
  );
  if (!query.data || store === undefined)
    return (
      <section className="tk-root tk-pricing-context">
        {query.error ? (
          <>
            <p role="alert">{query.error.message}</p>
            <Button onPress={() => void query.refetch()}>Повторити контекст ціни</Button>
          </>
        ) : (
          <p role="status">Завантажуємо магазини…</p>
        )}
      </section>
    );
  return (
    <>
      <section className="tk-root tk-pricing-context">
        <Select
          label="Ціни та друк для"
          value={store === null ? 'network' : String(store)}
          options={[
            ...(query.data.canSelectNetwork
              ? [{ id: 'network', label: 'Мережа — загальні ціни' }]
              : []),
            ...query.data.stores.map((s) => ({ id: String(s.id), label: s.name })),
          ]}
          onChange={(key) => {
            if (key !== null) setSelected(key === 'network' ? null : Number(key));
          }}
        />
        {query.error ? (
          <>
            <p role="alert">{query.error.message}</p>
            <Button onPress={() => void query.refetch()}>Повторити контекст ціни</Button>
          </>
        ) : null}
        <p className="tk-help">
          Чинність акцій: {query.data.effectiveDay}. Друк використовує назву обраного магазину з
          обліку.
        </p>
      </section>
      {children(
        catalog,
        store,
        {
          ...query.data,
          storeId: store,
          storeName:
            store === null
              ? null
              : query.data.stores.find((s) => s.id === store)?.name || query.data.storeName,
        },
        api,
      )}
    </>
  );
}
