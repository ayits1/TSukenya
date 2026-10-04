import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, userEvent, within } from 'storybook/test';
import { Customers } from './Customers';
import { customerPage, customerProfile } from './fixtures';

const meta = {
  title: 'CRM/Customers',
  component: Customers,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Story />
      </QueryClientProvider>
    ),
  ],
  args: {
    api: { list: async () => customerPage, profile: async () => customerProfile },
    stores: [{ id: 1, name: 'Центральний магазин' }],
    store: 1,
    onEdit: async () => {},
    onHistory: async () => {},
  },
} satisfies Meta<typeof Customers>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const item = await canvas.findByRole('button', { name: /Олена Коваленко/ });
    item.focus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByRole('heading', { name: 'Олена Коваленко' })).toHaveFocus();
    await expect(canvas.getByText('25,00 грн')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'До списку клієнтів' }));
    await expect(item).toHaveFocus();
  },
};
export const Cashier: Story = {
  args: {
    api: {
      list: async () => ({ ...customerPage, canEdit: false }),
      profile: async () => ({ ...customerProfile, canEdit: false, debt: null }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /Олена Коваленко/ }));
    await canvas.findByRole('heading', { name: 'Олена Коваленко' });
    await expect(canvas.queryByRole('button', { name: 'Додати клієнта' })).not.toBeInTheDocument();
    await expect(canvas.queryByText(/Поточний борг/)).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole('button', { name: 'Редагувати клієнта' }),
    ).not.toBeInTheDocument();
  },
};
export const Empty: Story = {
  args: {
    api: {
      list: async () => ({ ...customerPage, items: [], total: 0 }),
      profile: async () => customerProfile,
    },
  },
};
export const LoadError: Story = {
  args: {
    api: {
      list: async () => {
        throw new Error('Немає з’єднання із сервером.');
      },
      profile: async () => customerProfile,
    },
  },
};
export const LongNames: Story = {
  args: {
    api: {
      list: async () => ({
        ...customerPage,
        items: [
          {
            ...customerProfile.customer,
            name: 'Клієнт із довгим українським ім’ям та важливою приміткою для обслуговування',
            email: 'verylongcontactaddress@example.invalid',
          },
        ],
      }),
      profile: async () => customerProfile,
    },
  },
};
