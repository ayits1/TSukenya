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
export const LoadingEmpty: Story = {
  args: { busy: true, data: { ...catalogPage, items: [], total: 0 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Завантажуємо товари…' })).toBeVisible();
    await expect(canvas.queryByText('Товарів не знайдено')).not.toBeInTheDocument();
  },
};
export const ReadOnlyEmpty: Story = {
  args: { data: { ...catalogPage, canEdit: false, items: [], total: 0 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Змініть пошук або скиньте фільтри.')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Додати товар' })).not.toBeInTheDocument();
    await expect(canvas.queryByText(/додати|імпортувати/i)).not.toBeInTheDocument();
  },
};

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

export const PromotionButtonNames: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The accessible name contains the visible text (WCAG 2.5.3).
    const active = canvas.getByRole('button', { name: 'Акція: Кава Американо' });
    await expect(active).toHaveTextContent('Акція');
    await expect(active).toHaveAttribute('aria-pressed', 'true');
    // Enabling opens the editor for a promotion price, so it is not presented as a toggle.
    const inactive = canvas.getByRole('button', {
      name: `Без акції: ${catalogPage.items[1]!.name}`,
    });
    await expect(inactive).toHaveTextContent('Без акції');
    await expect(inactive).not.toHaveAttribute('aria-pressed');
    await expect(inactive).toHaveAttribute('aria-haspopup', 'dialog');
  },
};
export const FilterOutsideCurrentFacets: Story = {
  args: {
    filters: { ...emptyFilters, type: 'Морозиво', category: 'Пломбір', pack: 'Ріжок' },
    data: { ...catalogPage, items: [], total: 0 },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Товарів не знайдено')).toBeVisible();
    // Facets no longer list the active values; the fields still show what narrows the list.
    await expect(canvas.getByRole('combobox', { name: 'Група' })).toHaveValue('Морозиво');
    await expect(canvas.getByRole('combobox', { name: 'Категорія' })).toHaveValue('Пломбір');
    await expect(canvas.getByRole('combobox', { name: 'Пакування' })).toHaveValue('Ріжок');
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
