import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ABCReport } from './ABCReport';
import { fixtureDirectories, fixtureFilters, fixtureReport } from './fixtures';
const meta = {
  title: 'Trading/ABC report',
  component: ABCReport,
  parameters: { layout: 'padded' },
  args: {
    api: { read: async (filters) => fixtureReport(filters) },
    directories: fixtureDirectories,
    initial: fixtureFilters,
  },
} satisfies Meta<typeof ABCReport>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Confirmed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Підтверджений контекст: Усі магазини')).toBeVisible();
    const a = canvas.getByRole('textbox', { name: 'Межа A, %' });
    a.focus();
    await userEvent.clear(a);
    await userEvent.type(a, '70');
    const submit = canvas.getByRole('button', { name: 'Показати ABC' });
    submit.focus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText(/Межі A 70.00%/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'CSV усієї вибірки' })).toHaveAttribute(
      'href',
      expect.stringContaining('aThreshold=70'),
    );
  },
};
export const Recovery503: Story = {
  args: {
    api: {
      read: (() => {
        let count = 0;
        return async (filters) => {
          if (++count === 2)
            throw Object.assign(Error('Не вдалося прочитати ABC-звіт.'), { status: 503 });
          return fixtureReport(filters);
        };
      })(),
    },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByText('Підтверджений контекст: Усі магазини');
    await userEvent.clear(c.getByRole('textbox', { name: 'Межа A, %' }));
    await userEvent.type(c.getByRole('textbox', { name: 'Межа A, %' }), '70');
    await userEvent.click(c.getByRole('button', { name: 'Показати ABC' }));
    await expect(await c.findByRole('alert')).toHaveTextContent('Не вдалося');
    await expect(c.queryByRole('link', { name: 'CSV усієї вибірки' })).not.toBeInTheDocument();
    await expect(c.getByRole('textbox', { name: 'Межа A, %' })).toHaveValue('70');
    await userEvent.click(c.getByRole('button', { name: 'Повторити читання ABC' }));
    await expect(await c.findByRole('link', { name: 'CSV усієї вибірки' })).toBeVisible();
  },
};
export const Forbidden: Story = {
  args: {
    api: {
      read: async () => {
        throw Object.assign(Error('ABC-звіт недоступний за чинними правами.'), { status: 403 });
      },
    },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(await c.findByRole('alert')).toHaveTextContent('чинними правами');
    await expect(c.queryByRole('link')).not.toBeInTheDocument();
  },
};
export const EmptyCoverage: Story = {
  args: {
    api: {
      read: async (filters) => {
        const data = fixtureReport(filters);
        return {
          ...data,
          items: [],
          total: 0,
          summary: {
            productCount: 0,
            positiveCount: 0,
            zeroCount: 0,
            negativeCount: 0,
            mixedUnitCount: 0,
            hiddenCount: 0,
            netRevenue: '0.00',
            positivePoolRevenue: '0.00',
            negativeRevenue: '0.00',
            netCogs: '0.00',
            grossProfit: '0.00',
            classes: {
              A: { count: 0, netRevenue: '0.00', share: null },
              B: { count: 0, netRevenue: '0.00', share: null },
              C: { count: 0, netRevenue: '0.00', share: null },
              unclassified: { count: 0, netRevenue: '0.00', share: null },
            },
          },
        };
      },
    },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(
      await c.findByText('Позитивного чистого виторгу немає. ABC-класи не визначено.'),
    ).toBeVisible();
    await expect(c.getByText('За цими умовами товарів немає.')).toBeVisible();
  },
};
export const UnavailableStore: Story = {
  args: {
    initial: { ...fixtureFilters, store: '99' },
    directories: {
      ...fixtureDirectories,
      details: async () => ({ items: [], unavailable: [{ type: 'stores', id: '99' }] }),
    },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const clear = await c.findByRole('button', { name: 'Очистити недоступний магазин' });
    clear.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(c.getByRole('button', { name: 'Показати ABC' }));
    await expect(await c.findByText('Підтверджений контекст: Усі магазини')).toBeVisible();
  },
};
