import type { Meta, StoryObj } from '@storybook/react-vite';
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
