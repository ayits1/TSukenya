import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { CatalogView } from './CatalogView';
import { catalogPage } from './fixtures';
import { emptyFilters } from './api';
import './catalog.css';
const meta = {
  title: 'Catalogue/List',
  component: CatalogView,
  args: {
    data: catalogPage,
    filters: emptyFilters,
    onFilters: () => {},
    onEdit: () => {},
    onPromotion: () => {},
  },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof CatalogView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { data: { ...catalogPage, items: [], total: 0 } } };
export const ReadOnly: Story = {
  args: {
    data: {
      ...catalogPage,
      canEdit: false,
      items: catalogPage.items.map((product) => ({ ...product, cost: null, markup: null })),
    },
  },
};
export const Loading: Story = { args: { busy: true } };

export const PromotionPrices: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = canvas.getByRole('button', { name: 'Кава Американо' }).closest('tr')!;
    await expect(within(row).getByText('35,00 грн', { exact: true }).tagName).toBe('DEL');
    await expect(within(row).getByText(/29,99 грн/)).toBeVisible();
  },
};
export const PromotionWithoutPrice: Story = {
  args: {
    data: {
      ...catalogPage,
      items: [
        {
          ...catalogPage.items[0]!,
          promotionPrice: null,
          salePrice: catalogPage.items[0]!.regularPrice,
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('Акційна ціна не задана або вже не менша за звичайну'),
    ).toBeVisible();
    await expect(canvasElement.querySelector('del')).toBeNull();
  },
};

export const PromotionAfterRegularChange: Story = {
  args: {
    data: {
      ...catalogPage,
      items: [{ ...catalogPage.items[0]!, regularPrice: '25.00', salePrice: '25.00' }],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('Акційна ціна не задана або вже не менша за звичайну'),
    ).toBeVisible();
    await expect(canvasElement.querySelector('del')).toBeNull();
    await expect(canvasElement.querySelector('.tk-discount-price')).toBeNull();
    await expect(canvas.getByText('25,00 грн', { exact: true })).toBeVisible();
  },
};
