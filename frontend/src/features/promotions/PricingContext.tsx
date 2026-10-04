import { useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Select } from '../../shared/ui/Select';
import { Button } from '../../shared/ui/Button';
import { createCatalogApi, type CatalogApi } from '../catalog/api';
import { createPromotionApi, type PromotionApi, type PromotionContext } from './api';
import './promotions.css';
/** A live fence includes requested choices, even while the old context remains confirmed. */
export type PricingRequestGuard = { generation: number; isCurrent: () => boolean };
function createRequestFence() {
  let generation = 0,
    blocked = true;
  return {
    invalidate: () => {
      blocked = true;
      return ++generation;
    },
    confirm: (value: boolean) => {
      blocked = value;
    },
    guard: (expected: number): PricingRequestGuard => ({
      generation: expected,
      isCurrent: () => generation === expected && !blocked,
    }),
  };
}
export function PricingContext({
  children,
  api: supplied,
  onState,
  layout = 'panel',
}: {
  children: (
    catalog: CatalogApi,
    store: number | null,
    context: PromotionContext,
    promotions: PromotionApi,
    controls: { adopt: (context: PromotionContext) => void; guard: PricingRequestGuard },
  ) => ReactNode;
  api?: PromotionApi;
  onState?: (value: { context: PromotionContext | null; blocked: boolean }) => void;
  layout?: 'panel' | 'toolbar';
}) {
  const contextClass = `tk-root tk-pricing-context${layout === 'toolbar' ? ' tk-pricing-context--toolbar' : ''}`;
  const client = useQueryClient();
  const [api] = useState(() => supplied || createPromotionApi());
  const [selected, setSelected] = useState<number | null | undefined>(undefined);
  const [requestGeneration, setRequestGeneration] = useState(0);
  const [fence] = useState(createRequestFence);
  const invalidateRequest = () => {
    setRequestGeneration(fence.invalidate());
  };
  const requestStore = (store: number | null | undefined) => {
    invalidateRequest();
    setSelected(store);
  };
  const retry = () => {
    invalidateRequest();
    void query.refetch();
  };
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
  if (
    query.isSuccess &&
    !query.isFetching &&
    (confirmed?.context !== query.data || confirmed.requested !== selected)
  )
    setConfirmed({ context: query.data, requested: selected });
  const context = confirmed?.context;
  const catalog = useMemo(
    () => createCatalogApi(context?.storeId, context?.csrf),
    [context?.storeId, context?.csrf],
  );
  const blocked =
    !confirmed ||
    query.isFetching ||
    query.isPending ||
    query.isError ||
    selected !== confirmed.requested;
  useLayoutEffect(() => {
    fence.confirm(blocked);
    onState?.({ context: confirmed?.context ?? null, blocked });
  }, [onState, confirmed, blocked, fence, requestGeneration]);
  const guard = fence.guard(requestGeneration);
  const adopt = (context: PromotionContext) => {
    if (!guard.isCurrent()) throw Error('Вибір магазину змінився. Прочитайте перегляд повторно.');
    client.setQueryData(['promotion-context', context.storeId], context);
    setSelected(context.storeId);
    setConfirmed({ context, requested: context.storeId });
  };
  if (!confirmed)
    return (
      <section className={contextClass} aria-label="Контекст цін">
        {query.error ? (
          <>
            <p role="alert">{query.error.message}</p>
            <Button onPress={retry}>Повторити контекст ціни</Button>
          </>
        ) : (
          <p role="status">Завантажуємо магазини…</p>
        )}
      </section>
    );
  const current = confirmed.context;
  const selectedStore = selected === undefined ? current.storeId : selected;
  return (
    <>
      <section className={contextClass} aria-label="Контекст цін">
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
            if (key !== null) requestStore(key === 'network' ? null : Number(key));
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
            {query.error ? <Button onPress={retry}>Повторити контекст ціни</Button> : null}
            <Button onPress={() => requestStore(confirmed.requested)}>
              Скасувати зміну магазину
            </Button>
          </div>
        ) : null}
        <p className="tk-help tk-pricing-context-confirmed">
          Підтверджений контекст: {current.storeName || 'Мережа — загальні ціни'}. Чинність акцій:{' '}
          {current.effectiveDay}. Друк використовує назву підтвердженого магазину з обліку.
        </p>
      </section>
      <div className="tk-pricing-workspace" inert={blocked} aria-busy={blocked}>
        {children(catalog, current.storeId, current, api, { adopt, guard })}
      </div>
    </>
  );
}
