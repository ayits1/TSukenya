import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Button } from '../../shared/ui/Button';
import { Studio, initialStudioMemory } from './Studio';
import { adaptLabelProduct } from './domain';
import { studioConfig, studioSettings } from './fixtures';
import {
  catalogPage,
  catalogProducts,
  catalogReferences,
  fixturePricePreview,
} from '../catalog/fixtures';
import type { CatalogApi, Product } from '../catalog/api';
import type { LabelApi, Proof } from './api';
function Harness({ onPrepare }: { onPrepare: (store: number | undefined | null) => void }) {
  const [store, setStore] = useState(1);
  const [services] = useState(() => {
    let liveStore = 1;
    let late: ((proof: Proof) => void) | null = null;
    const workspace = {
      config: { ...studioConfig, store: true },
      settings: studioSettings,
      revision: 'synthetic-layout',
      canEdit: true,
      csrf: 'synthetic-csrf',
      warnings: [],
    };
    const product = (id: number): Product => ({
      ...catalogProducts[0]!,
      price: '35.00',
      promotion: false,
      promotionPrice: null,
      salePrice: id === 1 ? '20.00' : '25.00',
      effectiveDay: '2026-10-04',
      effectivePriceRevision: 'a'.repeat(64),
      priceContext: { storeId: id, storeName: `Обліковий магазин ${id}` },
      effectivePromotion: {
        source: 'campaign',
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Кава на вихідні',
        price: id === 1 ? '20.00' : '25.00',
        startsOn: '2026-10-04',
        endsOn: '2026-10-05',
        revision: 1,
      },
    });
    const proof = (id: number): Proof => ({
      ...workspace,
      config: { ...workspace.config, storeIdx: 0 },
      settings: { ...workspace.settings, storeNames: [`Обліковий магазин ${id}`] },
      products: [product(id)],
      selection: [{ id: catalogProducts[0]!.id, quantity: 3 }],
      date: '2026-10-04',
      snapshot: `synthetic-store-${id}`,
      priceContext: { storeId: id, storeName: `Обліковий магазин ${id}` },
    });
    const labels: LabelApi = {
      workspace: async () => workspace,
      save: async () => workspace,
      prepare: async (_selection, _signal, context) => {
        onPrepare(context);
        if (context === 1)
          return new Promise((resolve) => {
            late = resolve;
          });
        return proof(context || 2);
      },
    };
    const catalog: CatalogApi = {
      session: async () => ({ role: 'owner', csrf: 'synthetic' }),
      list: async () => ({ ...catalogPage, items: [product(liveStore)] }),
      product: async () => product(liveStore),
      visibility: async (product, hidden) => ({ ...product, hidden }),
      previewPrice: fixturePricePreview,
      save: async () => product(liveStore),
      remove: async () => true,
      references: async () => catalogReferences,
      createReference: async () => {
        throw new Error('Unused');
      },
    };
    return {
      client: new QueryClient(),
      labels,
      catalog,
      change: (id: number) => {
        liveStore = id;
      },
      finish: () => {
        late?.(proof(1));
        late = null;
      },
      memory: {
        ...initialStudioMemory(),
        selection: { [catalogProducts[0]!.id]: 3 },
        records: { [catalogProducts[0]!.id]: adaptLabelProduct(product(1)) },
      },
    };
  });
  return (
    <QueryClientProvider client={services.client}>
      <div className="tk-promotion-actions">
        <Button
          onPress={() => {
            services.change(2);
            setStore(2);
          }}
        >
          Перейти до магазину 2
        </Button>
        <Button onPress={() => services.finish()}>Завершити старий запит</Button>
      </div>
      <Studio
        api={services.labels}
        catalog={services.catalog}
        priceStore={store}
        priceContext={{ storeId: store, storeName: `Обліковий магазин ${store}` }}
        initialMemory={services.memory}
        onDirty={() => {}}
        onChanged={() => {}}
        onMemory={() => {}}
      />
    </QueryClientProvider>
  );
}
const meta = {
  title: 'Цінники/Контекст ціни магазину',
  component: Harness,
  args: { onPrepare: fn() },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LateProofCannotCrossStores: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole('tab', { name: /Товари для друку/ }));
    await userEvent.click(c.getByRole('button', { name: 'Перевірити 3 цінників →' }));
    await waitFor(() => expect(args.onPrepare).toHaveBeenCalledWith(1));
    await userEvent.click(c.getByRole('button', { name: 'Перейти до магазину 2' }));
    await userEvent.click(c.getByRole('button', { name: 'Завершити старий запит' }));
    await expect(canvasElement.querySelector('.tk-studio-proof-pages')).toBeNull();
    await userEvent.click(c.getByRole('tab', { name: /Товари для друку/ }));
    await expect(c.getByLabelText(`Копій: ${catalogProducts[0]!.name}`)).toHaveValue('3');
    await userEvent.click(c.getByRole('button', { name: 'Перевірити 3 цінників →' }));
    await waitFor(() => expect(args.onPrepare).toHaveBeenCalledWith(2));
    await waitFor(() =>
      expect(canvasElement.querySelector('.tk-studio-proof-pages')).not.toBeNull(),
    );
    const proof = canvasElement.querySelector('.tk-studio-proof-pages')!;
    await expect(proof).toHaveTextContent('Обліковий магазин 2');
    await expect(proof).toHaveTextContent('Акція');
    await expect(proof).not.toHaveTextContent('Обліковий магазин 1');
    await expect(
      c.queryByText('Магазин ціни змінено. Підготуйте новий перегляд друку.'),
    ).not.toBeInTheDocument();
  },
};
