import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProductEditor } from './ProductEditor';
import type { CatalogApi, ReferenceItem } from './api';
import { catalogProducts, catalogReferences } from './fixtures';
import './catalog.css';

const product = catalogProducts[0]!;
const created: ReferenceItem[] = [];
const meta = {
  title: 'Catalogue/Product Editor',
  component: ProductEditor,
  args: {
    product,
    defaultMarkup: '30',
    api: {
      session: async () => ({ role: 'owner', csrf: 'synthetic' }),
      list: async () => {
        throw new Error('Not used in editor story');
      },
      product: async () => product,
      remove: async () => true,
      save: fn(async () => product),
      references: async () => ({
        ...catalogReferences,
        items: [...catalogReferences.items, ...created],
      }),
      createReference: fn(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        const existing = [...catalogReferences.items, ...created].find(
          (item) =>
            item.field === input.field &&
            item.value === input.value &&
            item.parentType === (input.parentType || ''),
        );
        if (existing) return existing;
        const item = {
          id: `fixture-created-${input.field}-${created.length}`,
          ...input,
          parentType: input.parentType || '',
        };
        created.push(item);
        return item;
      }),
    } satisfies CatalogApi,
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
export const SeparatePromotionPrice: Story = {
  play: async ({ args }) => {
    const dialog = within(document.body).getByRole('dialog');
    const form = within(dialog);
    await expect(form.getByRole('textbox', { name: 'Звичайна ціна: гривні' })).toHaveValue('35');
    const discounted = form.getByRole('textbox', { name: 'Акційна ціна: гривні' });
    const cents = form.getByRole('textbox', { name: 'Акційна ціна: копійки' });
    await expect(discounted).toHaveValue('29');
    await expect(cents).toHaveValue('99');
    await userEvent.clear(discounted);
    await userEvent.type(discounted, '27,');
    await expect(cents).toHaveFocus();
    await userEvent.clear(cents);
    await userEvent.type(cents, '5');
    await userEvent.tab();
    await expect(cents).toHaveValue('05');
    await userEvent.click(form.getByRole('button', { name: 'Зберегти товар' }));
    await expect(args.api.save).toHaveBeenCalledWith(
      expect.objectContaining({ price: '35', promotion: true, promotionPrice: '27.05' }),
      product.id,
    );
  },
};
export const LegacyPromotionNeedsPrice: Story = {
  args: { product: { ...product, promotionPrice: null, salePrice: product.regularPrice } },
  play: async ({ args }) => {
    const form = within(within(document.body).getByRole('dialog'));
    await expect(
      form.getByText('Для цієї акції ще не задано окрему ціну. Вкажіть її перед збереженням.'),
    ).toBeVisible();
    await userEvent.click(form.getByRole('button', { name: 'Зберегти товар' }));
    await expect(args.api.save).not.toHaveBeenCalled();
    await expect(form.getByRole('textbox', { name: 'Акційна ціна: гривні' })).toHaveFocus();
  },
};

export const SavedPromotionNeedsReview: Story = {
  args: { product: { ...product, regularPrice: '25.00', salePrice: '25.00' } },
  play: async () => {
    const form = within(within(document.body).getByRole('dialog'));
    await expect(
      form.getByText(
        'Збережена акційна ціна більше не є дійсною знижкою. Змініть її або вимкніть акцію.',
      ),
    ).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Акційна ціна: гривні' })).toHaveValue('29');
    await expect(form.getByRole('textbox', { name: 'Акційна ціна: копійки' })).toHaveValue('99');
  },
};
export const ReferenceSelectionAndCreation: Story = {
  play: async ({ args }) => {
    const form = within(within(document.body).getByRole('dialog'));
    const group = form.getByRole('combobox', { name: 'Група' });
    await waitFor(() => expect(group).toBeEnabled());
    await userEvent.clear(group);
    await userEvent.type(group, 'Цукерки');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(group).toHaveValue('Цукерки');
    const category = form.getByRole('combobox', { name: 'Категорія' });
    await expect(category).toHaveValue('');
    await userEvent.click(category);
    await expect(within(document.body).queryByRole('option', { name: 'Кава' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(form.getByRole('button', { name: 'Додати запис: Категорія' }));
    const input = form.getByRole('textbox', { name: 'Новий запис: Категорія' });
    await expect(input).toHaveFocus();
    await userEvent.type(input, 'Асорті');
    await userEvent.click(form.getByRole('button', { name: 'Додати й вибрати' }));
    await waitFor(() => expect(category).toHaveValue('Асорті'));
    await waitFor(() =>
      expect(form.getByRole('button', { name: 'Додати запис: Категорія' })).toHaveFocus(),
    );
    await expect(args.api.createReference).toHaveBeenCalledWith({
      field: 'category',
      value: 'Асорті',
      parentType: 'Цукерки',
    });
    await expect(args.api.save).not.toHaveBeenCalled();
  },
};
export const ReferenceCreationError: Story = {
  args: {
    api: {
      ...meta.args.api,
      createReference: fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('Не вдалося створити запис. Спробуйте ще раз.');
      }),
    },
  },
  play: async () => {
    const form = within(within(document.body).getByRole('dialog'));
    const add = form.getByRole('button', { name: 'Додати запис: Пакування' });
    await waitFor(() => expect(add).toBeEnabled());
    await userEvent.click(add);
    const input = form.getByRole('textbox', { name: 'Новий запис: Пакування' });
    await userEvent.type(input, 'Новий пакет');
    await userEvent.click(form.getByRole('button', { name: 'Додати й вибрати' }));
    await expect(await form.findByRole('alert')).toHaveTextContent('Не вдалося створити запис');
    await expect(input).toHaveValue('Новий пакет');
    await userEvent.click(form.getByRole('button', { name: 'Скасувати додавання' }));
    await waitFor(() =>
      expect(form.getByRole('button', { name: 'Додати запис: Пакування' })).toHaveFocus(),
    );
  },
};
export const ReferencesUnavailable: Story = {
  args: {
    api: {
      ...meta.args.api,
      references: async () => {
        throw new Error('Довідники тимчасово недоступні.');
      },
    },
  },
  play: async () => {
    const form = within(within(document.body).getByRole('dialog'));
    await expect(await form.findByRole('alert')).toHaveTextContent(
      'Довідники тимчасово недоступні',
    );
    await expect(form.getByRole('button', { name: 'Зберегти товар' })).toBeDisabled();
  },
};
