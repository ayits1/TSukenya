import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  // Keep the last authoritative context independently of a pending/failed query.
  // The mounted editor and its draft stay attached to that context until success.
  const [confirmed, setConfirmed] = useState<{
    context: PromotionContext;
    requested: number | null | undefined;
  } | null>(null);
  const query = useQuery({
    queryKey: ['promotion-context', selected],
    queryFn: async ({ signal }) => {
      const context = await api.context(selected, signal);
      if (selected !== undefined && context.storeId !== selected)
        throw new Error('Сервер повернув інший магазин ціни. Повторіть вибір.');
      return context;
    },
    retry: false,
  });
  if (query.isSuccess && (confirmed?.context !== query.data || confirmed.requested !== selected))
    setConfirmed({ context: query.data, requested: selected });
  const context = confirmed?.context;
  const catalog = useMemo(
    () => createCatalogApi(context?.storeId, context?.csrf),
    [context?.storeId, context?.csrf],
  );
  if (!confirmed)
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
  const current = confirmed.context;
  const blocked = query.isPending || query.isError || selected !== confirmed.requested;
  const selectedStore = selected === undefined ? current.storeId : selected;
  return (
    <>
      <section className="tk-root tk-pricing-context">
        <Select
          label="Ціни та друк для"
          value={selectedStore === null ? 'network' : String(selectedStore)}
          options={[
            ...(current.canSelectNetwork
              ? [{ id: 'network', label: 'Мережа — загальні ціни' }]
              : []),
            ...current.stores.map((s) => ({ id: String(s.id), label: s.name })),
          ]}
          onChange={(key) => {
            if (key !== null) setSelected(key === 'network' ? null : Number(key));
          }}
        />
        {query.error ? (
          <>
            <p role="alert">{query.error.message}</p>
          </>
        ) : blocked ? (
          <p role="status">Перевіряємо вибраний магазин. Редагування та друк призупинені.</p>
        ) : null}
        {blocked ? (
          <div className="tk-promotion-actions">
            {query.error ? (
              <Button onPress={() => void query.refetch()}>Повторити контекст ціни</Button>
            ) : null}
            <Button onPress={() => setSelected(confirmed.requested)}>
              Скасувати зміну магазину
            </Button>
          </div>
        ) : null}
        <p className="tk-help">
          Підтверджений контекст: {current.storeName || 'Мережа — загальні ціни'}. Чинність акцій:{' '}
          {current.effectiveDay}. Друк використовує назву підтвердженого магазину з обліку.
        </p>
      </section>
      <div className="tk-pricing-workspace" inert={blocked} aria-busy={blocked}>
        {children(catalog, current.storeId, current, api)}
      </div>
    </>
  );
}
