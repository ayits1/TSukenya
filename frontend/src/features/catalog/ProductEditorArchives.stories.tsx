import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProductEditor } from './ProductEditor';
import type { CatalogApi } from './api';
import { catalogProducts, catalogReferences, catalogPage, fixturePricePreview } from './fixtures';
import './catalog.css';
const product = catalogProducts[0]!;
const archivedPack = catalogReferences.items.find(
  (item) => item.field === 'pack' && item.value === product.pack,
)!;
const unit = catalogReferences.items.find((item) => item.field === 'unit' && item.value === 'шт')!;
const api: CatalogApi = {
  session: async () => ({ role: 'owner', csrf: 'synthetic' }),
  list: async () => catalogPage,
  product: async () => product,
  save: fn(async () => product),
  remove: async () => true,
  previewPrice: async (input) => fixturePricePreview(input),
  references: async () => ({
    ...catalogReferences,
    items: catalogReferences.items.filter((item) => item.id !== archivedPack.id),
    archivedItems: [archivedPack],
  }),
  createReference: async () => {
    throw new Error('Не використовується в цьому стані.');
  },
};
const meta = {
  title: 'Catalogue/Editor Archived References',
  component: ProductEditor,
  args: {
    product,
    defaultMarkup: '30',
    api,
    onClose: fn(),
    onSaved: fn(),
    onDirty: fn(),
    onDeleted: fn(),
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
const ui = () => within(within(document.body).getByRole('dialog'));
export const ExistingArchivedValue: Story = {
  play: async ({ args }) => {
    await waitFor(() =>
      expect(ui().getByRole('combobox', { name: 'Пакування' })).toHaveValue(
        `${product.pack} · Архівований`,
      ),
    );
    await expect(
      ui().getByText(
        `«${product.pack}» архівовано. Запис недоступний для нового вибору. Наявний товар може зберегти його без зміни.`,
      ),
    ).toBeVisible();
    await userEvent.clear(ui().getByRole('textbox', { name: 'Назва товару' }));
    await userEvent.type(
      ui().getByRole('textbox', { name: 'Назва товару' }),
      'Метадані товару з архівом',
    );
    await waitFor(() => expect(ui().getByRole('button', { name: 'Зберегти товар' })).toBeEnabled());
    await userEvent.click(ui().getByRole('button', { name: 'Зберегти товар' }));
    await expect(args.api.save).toHaveBeenCalledWith(
      expect.objectContaining({ pack: product.pack, name: 'Метадані товару з архівом' }),
      product.id,
    );
  },
};
export const NewProductRequiresActiveUnit: Story = {
  render: function Render(args) {
    const [client] = useState(() => new QueryClient());
    return (
      <QueryClientProvider client={client}>
        <ProductEditor
          defaultMarkup={args.defaultMarkup}
          api={args.api}
          onClose={args.onClose}
          onSaved={args.onSaved}
          onDirty={args.onDirty}
          onDeleted={args.onDeleted}
        />
      </QueryClientProvider>
    );
  },
  args: {
    api: {
      ...api,
      references: async () => ({
        ...catalogReferences,
        items: [
          ...catalogReferences.items.filter((item) => item.id !== unit.id),
          { id: 'unit_kg', field: 'unit', value: 'кг', parentType: '' },
        ],
        archivedItems: [unit],
      }),
      save: fn(async () => product),
    },
  },
  play: async ({ args }) => {
    await waitFor(() =>
      expect(ui().getByRole('combobox', { name: 'Одиниця' })).toHaveValue('шт · Архівований'),
    );
    await userEvent.type(
      ui().getByRole('textbox', { name: 'Назва товару' }),
      'Новий товар із активною одиницею',
    );
    await expect(ui().getByRole('button', { name: 'Зберегти товар' })).toBeDisabled();
    await expect(args.api.save).not.toHaveBeenCalled();
    await userEvent.clear(ui().getByRole('combobox', { name: 'Одиниця' }));
    await userEvent.type(ui().getByRole('combobox', { name: 'Одиниця' }), 'кг');
    await userEvent.click(within(document.body).getByRole('option', { name: 'кг' }));
    await waitFor(() => expect(ui().getByRole('button', { name: 'Зберегти товар' })).toBeEnabled());
  },
};
