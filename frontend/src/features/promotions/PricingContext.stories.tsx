import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PricingContext } from './PricingContext';
import { ApiError } from '../../shared/api/client';
import { Button } from '../../shared/ui/Button';
import { Studio, initialStudioMemory } from '../labels/Studio';
import { adaptLabelProduct } from '../labels/domain';
import { studioConfig, studioSettings } from '../labels/fixtures';
import {
  catalogPage,
  catalogProducts,
  catalogReferences,
  fixturePricePreview,
} from '../catalog/fixtures';
import type { CatalogApi } from '../catalog/api';
import type { LabelApi } from '../labels/api';
import type { PromotionApi, PromotionContext } from './api';
const stores = [
  { id: 1, name: 'Обліковий магазин 1' },
  { id: 2, name: 'Обліковий магазин 2' },
];
const context = (id: number): PromotionContext => ({
  storeId: id,
  storeName: stores[id - 1]!.name,
  stores,
  canManage: true,
  canSelectNetwork: true,
  canViewHistory: true,
  csrf: 'synthetic',
  effectiveDay: '2026-10-04',
});
function ContextStudio({
  store,
  services,
}: {
  store: number | null;
  services: ReturnType<typeof makeServices>;
}) {
  const catalog = useMemo(() => services.catalog(store), [store, services]);
  return (
    <Studio
      api={services.labels}
      catalog={catalog}
      priceStore={store}
      priceContext={context(store || 1)}
      initialMemory={services.memory}
      onMemory={() => {}}
      onDirty={() => {}}
      onChanged={() => {}}
    />
  );
}
function makeServices(onContext: (store: number | undefined | null) => void) {
  let reject: (reason: unknown) => void = () => {};
  let resolve: (value: PromotionContext) => void = () => {};
  const product = catalogProducts[0]!;
  const workspace = {
    config: studioConfig,
    settings: studioSettings,
    revision: 'synthetic-layout',
    csrf: 'synthetic',
    canEdit: true,
    warnings: [],
  };
  const api = {
    context: async (store) => {
      onContext(store);
      if (store === undefined || store === 1) return context(1);
      return new Promise<PromotionContext>((yes, no) => {
        resolve = yes;
        reject = no;
      });
    },
  } as PromotionApi;
  return {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    api,
    fail: () => reject(new ApiError(503, 'Магазини тимчасово недоступні. Чернетку збережено.')),
    finish: () => resolve(context(2)),
    memory: {
      ...initialStudioMemory(),
      preview: adaptLabelProduct(product),
      selection: { [product.id]: 3 },
      records: { [product.id]: adaptLabelProduct(product) },
    },
    labels: {
      workspace: async () => workspace,
      save: async () => workspace,
      prepare: async () => {
        throw new Error('Друк не використовується в цьому сценарії.');
      },
    } satisfies LabelApi,
    catalog: (store: number | null): CatalogApi => ({
      session: async () => ({ role: 'owner', csrf: 'synthetic' }),
      list: async () => catalogPage,
      product: async () => ({
        ...product,
        priceContext: { storeId: store, storeName: store ? context(store).storeName : null },
      }),
      previewPrice: fixturePricePreview,
      save: async () => product,
      remove: async () => true,
      references: async () => catalogReferences,
      createReference: async () => {
        throw new Error('Not used');
      },
    }),
  };
}
function Harness({ onContext }: { onContext: (store: number | undefined | null) => void }) {
  const [services] = useState(() => makeServices(onContext));
  return (
    <QueryClientProvider client={services.client}>
      <div className="tk-promotion-actions">
        <Button onPress={services.fail}>Відповісти помилкою магазину</Button>
        <Button onPress={services.finish}>Підтвердити магазин 2</Button>
      </div>
      <PricingContext api={services.api}>
        {(_catalog, store, confirmed) => (
          <>
            <p role="status">Поточний контекст Studio: {confirmed.storeName}</p>
            <ContextStudio store={store} services={services} />
          </>
        )}
      </PricingContext>
    </QueryClientProvider>
  );
}
const meta = {
  title: 'Цінники/Підтверджений контекст магазину',
  component: Harness,
  args: { onContext: fn() },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FailedStoreRequestKeepsDraft: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const size = await c.findByLabelText('Розмір, pt');
    await userEvent.clear(size);
    await userEvent.type(size, '18');
    await userEvent.tab();
    await userEvent.click(c.getByRole('tab', { name: /Товари для друку/ }));
    const copies = c.getByLabelText(`Копій: ${catalogProducts[0]!.name}`);
    await userEvent.clear(copies);
    await userEvent.type(copies, '7');
    await userEvent.tab();
    await userEvent.click(c.getByRole('tab', { name: 'Макет' }));
    const retained = c.getByLabelText('Розмір, pt');
    const choose = c.getByRole('button', { name: /Ціни та друк для/ });
    choose.focus();
    await userEvent.keyboard('{Enter}{End}{Enter}');
    await waitFor(() => expect(args.onContext).toHaveBeenLastCalledWith(2));
    const workspace = canvasElement.querySelector('.tk-pricing-workspace')!;
    await expect(workspace).toHaveAttribute('inert');
    await expect(workspace).toHaveTextContent('Поточний контекст Studio: Обліковий магазин 1');
    await expect(retained).toHaveValue('18');
    await userEvent.click(c.getByRole('button', { name: 'Відповісти помилкою магазину' }));
    await expect(await c.findByRole('alert')).toHaveTextContent('Магазини тимчасово недоступні');
    await expect(workspace).toHaveAttribute('inert');
    await expect(retained).toBeInTheDocument();
    await expect(retained).toHaveValue('18');
    await userEvent.click(c.getByRole('button', { name: 'Повторити контекст ціни' }));
    await waitFor(() => expect(args.onContext).toHaveBeenCalledTimes(3));
    await expect(workspace).toHaveAttribute('inert');
    await userEvent.click(c.getByRole('button', { name: 'Підтвердити магазин 2' }));
    await waitFor(() => expect(workspace).not.toHaveAttribute('inert'));
    await expect(workspace).toHaveTextContent('Поточний контекст Studio: Обліковий магазин 2');
    await expect(retained).toBeInTheDocument();
    await expect(retained).toHaveValue('18');
    await userEvent.click(c.getByRole('tab', { name: /Товари для друку/ }));
    await expect(c.getByLabelText(`Копій: ${catalogProducts[0]!.name}`)).toHaveValue('7');
  },
};

/** Native browser QA drives pending/error/cancel states without the automatic play sequence. */
export const InteractiveStoreRecovery: Story = {};
