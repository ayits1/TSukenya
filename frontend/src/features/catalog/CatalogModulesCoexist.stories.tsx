import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, spyOn, userEvent, waitFor, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Catalog } from './Catalog';
import { catalogPage, catalogProducts, catalogReferences, fixturePricePreview } from './fixtures';
import type { CatalogApi } from './api';
import type { PromotionApi, PromotionContext } from '../promotions/api';
const context: PromotionContext = {
  storeId: null,
  storeName: null,
  stores: [],
  canManage: true,
  canViewHistory: true,
  canSelectNetwork: true,
  effectiveDay: '2026-10-04',
  csrf: 'synthetic',
};
function Harness({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const [services] = useState(() => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    // ReferenceManager has its own transport; the cache supplies synthetic read-only data.
    client.setQueryData(['catalog-reference-management'], {
      items: [],
      csrf: 'synthetic',
      canEdit: true,
    });
    const catalog: CatalogApi = {
      session: async () => ({ role: 'owner', csrf: 'synthetic' }),
      list: async () => catalogPage,
      product: async () => catalogProducts[0]!,
      save: async () => catalogProducts[0]!,
      remove: async () => true,
      previewPrice: fixturePricePreview,
      references: async () => catalogReferences,
      createReference: async () => {
        throw new Error('Not used');
      },
    };
    const promotions: PromotionApi = {
      context: async () => context,
      campaigns: async () => ({
        items: [],
        total: 0,
        page: 1,
        pages: 1,
        limit: 20,
      }),
      history: async () => ({
        items: [],
        total: 0,
        page: 1,
        pages: 1,
        limit: 20,
      }),
      campaign: async () => {
        throw new Error('Not used');
      },
      save: async () => {
        throw new Error('Not used');
      },
      archive: async () => {
        throw new Error('Not used');
      },
    };
    return { client, catalog, promotions };
  });
  return (
    <QueryClientProvider client={services.client}>
      <Catalog
        api={services.catalog}
        priceStore={null}
        priceContext={context}
        promotions={services.promotions}
        onDirty={onDirty}
        onChanged={() => {}}
        onFiltersChanged={() => {}}
      />
    </QueryClientProvider>
  );
}
const meta = {
  title: 'Каталог/Спільна робота модулів',
  component: Harness,
  args: { onDirty: fn() },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReferenceModalKeepsCampaignDraft: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(await c.findByRole('heading', { name: 'Каталог товарів' })).toBeVisible();
    await expect(c.getByRole('heading', { name: 'Акції та журнал цін' })).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: 'Створити акцію' }));
    await userEvent.type(
      c.getByRole('textbox', { name: 'Назва акції' }),
      'Акція — незбережена чернетка',
    );
    await waitFor(() => expect(args.onDirty).toHaveBeenLastCalledWith(true));
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === '/api/v1/catalog/references/manage')
        return new Response(JSON.stringify({ items: [], csrf: 'synthetic', canEdit: true }), {
          status: 200,
        });
      throw new Error('Unexpected synthetic HTTP: ' + String(input));
    });
    try {
      await userEvent.click(c.getByRole('button', { name: 'Довідники' }));
      const dialog = await within(document.body).findByRole('dialog', {
        name: 'Керування довідниками',
      });
      await expect(
        within(dialog).getByRole('heading', { name: 'Керування довідниками' }),
      ).toBeVisible();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Закрити довідники' }));
      await waitFor(() =>
        expect(
          within(document.body).queryByRole('dialog', {
            name: 'Керування довідниками',
          }),
        ).not.toBeInTheDocument(),
      );
      await expect(c.getByRole('textbox', { name: 'Назва акції' })).toHaveValue(
        'Акція — незбережена чернетка',
      );
      await expect(c.getByRole('heading', { name: 'Акції та журнал цін' })).toBeVisible();
      await expect(args.onDirty).toHaveBeenLastCalledWith(true);
    } finally {
      fetch.mockRestore();
    }
  },
};
