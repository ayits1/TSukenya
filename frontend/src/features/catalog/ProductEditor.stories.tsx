import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProductEditor } from './ProductEditor';
import type { CatalogApi } from './api';
import { catalogProducts } from './fixtures';
import './catalog.css';

const product = catalogProducts[0]!;
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
