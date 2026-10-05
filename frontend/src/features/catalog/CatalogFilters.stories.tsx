import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Catalog } from './Catalog';
import { Button } from '../../shared/ui/Button';
import { catalogPage, catalogProducts, catalogReferences, fixturePricePreview } from './fixtures';
import type { CatalogApi } from './api';

const ignore = () => {};
function PendingFacets() {
  const [services] = useState(() => {
    let release: () => void = ignore;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const product = catalogProducts[0]!;
    return {
      client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      release: () => release(),
      api: {
        session: async () => ({ role: 'owner', csrf: 'synthetic' }),
        list: async (filters) => {
          if (!filters.type) return catalogPage;
          await gate;
          return {
            ...catalogPage,
            items: [product],
            total: 1,
            facets: { type: catalogPage.facets?.type || [], category: ['Кава'], pack: ['Стакан'] },
          };
        },
        product: async () => product,
        visibility: async (product, hidden) => ({ ...product, hidden }),
        previewPrice: fixturePricePreview,
        save: async () => product,
        remove: async () => true,
        references: async () => catalogReferences,
        createReference: async () => {
          throw new Error('Не використовується в цьому сценарії.');
        },
      } satisfies CatalogApi,
    };
  });
  return (
    <QueryClientProvider client={services.client}>
      <Catalog api={services.api} onChanged={ignore} onDirty={ignore} onFiltersChanged={ignore} />
      <Button onPress={services.release}>Завершити контрольний запит</Button>
    </QueryClientProvider>
  );
}
const meta = {
  title: 'Catalogue/Залежні фільтри',
  component: PendingFacets,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof PendingFacets>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PendingParentRequestBlocksStaleChildren: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    const group = await canvas.findByRole('combobox', { name: 'Група' });
    const category = canvas.getByRole('combobox', { name: 'Категорія' });
    const pack = canvas.getByRole('combobox', { name: 'Пакування' });
    await userEvent.click(canvas.getByRole('button', { name: /^Відкрити список: Група/ }));
    await userEvent.click(await page.findByRole('option', { name: 'Напої' }));
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('Оновлюємо список'));
    await expect(category).toBeDisabled();
    await expect(pack).toBeDisabled();
    await expect(
      canvas.getByRole('button', { name: /^Відкрити список: Категорія/ }),
    ).toBeDisabled();
    await expect(
      canvas.getByRole('button', { name: /^Відкрити список: Пакування/ }),
    ).toBeDisabled();
    await expect(group).toBeEnabled();
    await expect(canvas.getByRole('searchbox', { name: 'Пошук товару' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Скинути фільтри' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Завершити контрольний запит' }));
    await waitFor(() => expect(category).toBeEnabled());
    await expect(pack).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: /^Відкрити список: Категорія/ }));
    await expect(await page.findByRole('option', { name: 'Кава' })).toBeVisible();
    await expect(page.queryByRole('option', { name: 'Шоколад' })).not.toBeInTheDocument();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(category).toHaveValue('Кава');
    await userEvent.click(canvas.getByRole('button', { name: /^Відкрити список: Пакування/ }));
    await expect(await page.findByRole('option', { name: 'Стакан' })).toBeVisible();
    await expect(page.queryByRole('option', { name: 'Коробка' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await expect(pack).toHaveValue('Усе пакування');
  },
};
