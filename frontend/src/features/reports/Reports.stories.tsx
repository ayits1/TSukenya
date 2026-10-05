import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within, waitFor } from 'storybook/test';
import { I18nProvider } from 'react-aria-components';
import { Reports } from './Reports';
import { ReportsModel } from './state';
import { api, options, financeApi, abcApi, fixturePage } from './fixtures';
import type { ReportsApi } from './api';
import { ApiError } from '../../shared/api/client';
function Screen({ reader = api, manager = false }: { reader?: ReportsApi; manager?: boolean }) {
  const [model] = useState(
    () =>
      new ReportsModel(
        reader,
        {
          read: async (...args) => {
            const result = await financeApi.read(...args);
            return {
              ...result,
              policy: {
                ...result.policy,
                role: manager ? 'manager' : 'owner',
                canManageAccounts: !manager,
              },
            };
          },
        },
        abcApi,
      ),
  );
  useEffect(() => {
    const bootstrap = { ...options.bootstrap, ...(manager ? { role: 'manager' as const } : {}) };
    void model.activate({
      ...options,
      bootstrap,
      directoryApi: { ...options.directoryApi, bootstrap: async () => bootstrap },
    });
    return () => model.leave();
  }, [model, manager]);
  return (
    <I18nProvider locale="uk-UA">
      <Reports model={model} />
    </I18nProvider>
  );
}
const meta = {
  title: 'Trading/Reports',
  component: Screen,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Screen>;
export default meta;
type Story = StoryObj<typeof meta>;
export const WholeScreen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: 'Товари' });
    await expect(canvas.getAllByText(/99 999 999 999 999,99/)[0]!).toBeVisible();
    const balances = canvas.getByRole('tab', { name: 'Залишки на дату' });
    balances.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByRole('region', { name: 'Товарні залишки' });
    const payroll = canvas.getByRole('tab', { name: /Борги із зарплати/ });
    payroll.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByText('600,99');
    await expect(
      canvas.queryByRole('heading', { name: 'Поточна заборгованість' }),
    ).not.toBeInTheDocument();
  },
};
export const Manager: Story = {
  args: { manager: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: 'Товари' });
    await userEvent.click(canvas.getByRole('tab', { name: /Касири/ }));
    await canvas.findByText('Ірина Тестова');
    await expect(
      canvas.queryByRole('columnheader', { name: 'Бонус пізніх повернень' }),
    ).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('tab', { name: 'Залишки на дату' }));
    await canvas.findByRole('region', { name: 'Товарні залишки' });
    await expect(canvas.queryByRole('tab', { name: /Борги із зарплати/ })).not.toBeInTheDocument();
  },
};
export const Empty: Story = { args: { reader: { read: async (q, p) => fixturePage(q, p, true) } } };
export const RetryFocus: Story = {
  render: () => {
    let failed = true;
    return (
      <Screen
        reader={{
          read: async (q, p) => {
            if (failed) {
              failed = false;
              throw new ApiError(503, 'Тимчасова помилка читання.');
            }
            return fixturePage(q, p);
          },
        }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const retry = await canvas.findByRole('button', { name: 'Повторити читання' });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByRole('region', { name: 'Товари' });
    await waitFor(() => expect(canvas.getByText('Сторінка 1 із 1 · 1 рядків')).toHaveFocus());
  },
};
