import { fixtureReferenceDirectory } from './referenceDirectoryFixtures';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Catalog } from './Catalog';
import { CatalogView } from './CatalogView';
import { ProductEditor } from './ProductEditor';
import { ApiError } from '../../shared/api/client';
import type { CatalogApi } from './api';
import { emptyFilters } from './api';
import { catalogPage, catalogProducts, catalogReferences, fixturePricePreview } from './fixtures';
import './catalog.css';
const product = catalogProducts[0]!;
const api: CatalogApi = {
  session: async () => ({ role: 'owner', csrf: 'synthetic' }),
  list: async (filters) => ({
    ...catalogPage,
    visibility: filters.visibility || 'active',
    items: filters.visibility === 'hidden' ? [{ ...product, hidden: true }] : catalogProducts,
  }),
  product: async () => ({ ...product, hidden: true, revision: 'fresh', barcode: 'server-barcode' }),
  visibility: fn(async () => {
    throw new ApiError(0, 'Відповідь загубилась. Прочитайте актуальний товар.');
  }),
  previewPrice: fixturePricePreview,
  save: fn(async () => product),
  remove: fn(async () => true),
  referenceDirectory: fixtureReferenceDirectory(async () => catalogReferences),
  references: async () => catalogReferences,
  createReference: async () => {
    throw new Error('Не використовується');
  },
};
const meta = {
  title: 'Catalogue/Hidden Products',
  component: ProductEditor,
  args: {
    product,
    api,
    defaultMarkup: '30',
    onClose: fn(),
    onSaved: fn(),
    onDeleted: fn(),
    onDirty: fn(),
  },
  render: function Render(args) {
    const [client] = useState(() => new QueryClient());
    return (
      <QueryClientProvider client={client}>
        <ProductEditor {...args} />
      </QueryClientProvider>
    );
  },
} satisfies Meta<typeof ProductEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LostVisibilityAckKeepsDraft: Story = {
  play: async () => {
    const form = within(within(document.body).getByRole('dialog'));
    await userEvent.clear(form.getByRole('textbox', { name: 'Назва товару' }));
    await userEvent.type(form.getByRole('textbox', { name: 'Назва товару' }), 'Моя нова назва');
    const confirm = window.confirm;
    window.confirm = () => true;
    try {
      await userEvent.click(form.getByRole('button', { name: 'Приховати товар' }));
    } finally {
      window.confirm = confirm;
    }
    await waitFor(() =>
      expect(form.getByRole('button', { name: 'Зберегти товар' })).toBeDisabled(),
    );
    await userEvent.click(form.getByRole('button', { name: 'Порівняти зміни' }));
    await waitFor(() =>
      expect(form.getByText(/Поточний стан на сервері: прихований/)).toBeVisible(),
    );
    await expect(form.getByRole('textbox', { name: 'Назва товару' })).toHaveValue('Моя нова назва');
    await userEvent.click(form.getByRole('button', { name: 'Застосувати узгоджені зміни' }));
    await expect(form.getByRole('textbox', { name: 'Назва товару' })).toHaveValue('Моя нова назва');
    await expect(form.getByRole('textbox', { name: 'Штрихкод' })).toHaveValue('server-barcode');
    await expect(form.getByRole('button', { name: 'Відновити товар' })).toBeEnabled();
    await expect(api.save).not.toHaveBeenCalled();
  },
};
export const EmptyHiddenList: Story = {
  render: () => (
    <CatalogView
      data={{ ...catalogPage, visibility: 'hidden', items: [], total: 0 }}
      filters={{ ...emptyFilters, visibility: 'hidden' }}
      onFilters={fn()}
      onEdit={fn()}
      onPromotion={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('heading', { name: 'Прихованих товарів не знайдено' }),
    ).toBeVisible();
  },
};
export const ModeKeyboardAndRequestError: Story = {
  render: function Render() {
    const [client] = useState(() => new QueryClient());
    return (
      <QueryClientProvider client={client}>
        <Catalog
          api={{
            ...api,
            list: async (filters) => {
              if (filters.visibility === 'hidden') throw new ApiError(503, 'Тимчасово недоступно');
              return catalogPage;
            },
          }}
          onChanged={fn()}
          onDirty={fn()}
          onFiltersChanged={fn()}
        />
      </QueryClientProvider>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: product.name });
    const select = await canvas.findByRole('button', { name: /Стан товарів/ });
    select.focus();
    await userEvent.keyboard('{Enter}');
    await within(document.body).findByRole('option', { name: 'Приховані товари' });
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(canvas.getByText('Тимчасово недоступно')).toBeVisible());
    await expect(canvas.queryByRole('button', { name: product.name })).not.toBeInTheDocument();
    const mode = canvas.getByRole('button', { name: /Стан товарів/ });
    mode.focus();
    await userEvent.keyboard('{Enter}');
    await within(document.body).findByRole('option', { name: 'Активні товари' });
    await userEvent.keyboard('{ArrowUp}{Enter}');
    await waitFor(() => expect(canvas.getByRole('button', { name: product.name })).toBeVisible());
  },
};
