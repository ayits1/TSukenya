import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Staff } from './Staff';
import { StaffModel } from './state';
import { fixtureApi, fixture, options, policy } from './fixtures';
import { ApiError } from '../../shared/api/client';
function Workspace({
  failure = false,
  pagingFailure = false,
  accountant = false,
}: {
  failure?: boolean;
  pagingFailure?: boolean;
  accountant?: boolean;
}) {
  const [model] = useState(() => {
    const api = fixtureApi();
    if (failure)
      api.read = async () => {
        throw new ApiError(503, 'Читання тимчасово недоступне.');
      };
    if (accountant)
      api.read = async (r, q, p = 1) =>
        fixture(r, q, p, 1, { ...policy, role: 'accountant', store: 1, canManageEmployees: false });
    if (pagingFailure) {
      const original = api.read;
      let fail = true;
      api.read = async (r, q, p = 1) => {
        if (p === 2 && fail) {
          fail = false;
          throw new ApiError(503, 'Не вдалося прочитати сторінку.');
        }
        return original(r, q, p);
      };
    }
    return new StaffModel(api);
  });
  useEffect(() => {
    void model.activate({
      ...options,
      bootstrap: accountant
        ? { ...options.bootstrap, role: 'accountant', storeId: 1 }
        : options.bootstrap,
      onRefresh: async () => {
        await model.refresh();
      },
    });
    return () => model.leave();
  }, [model, accountant]);
  return <Staff model={model} />;
}
const meta = {
  title: 'Trading/Staff',
  component: Workspace,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Workspace>;
export default meta;
type Story = StoryObj<typeof meta>;
export const WholeWorkspace: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByRole('region', { name: 'Працівники та умови оплати' });
    await expect(c.getAllByText('-75,98 грн')[0]).toBeVisible();
    const next = c
      .getByRole('navigation', { name: 'Сторінки команди' })
      .querySelector<HTMLButtonElement>('[data-page=next]')!;
    next.focus();
    await userEvent.keyboard('{Enter}');
    await c.findByText('2 / 2 · записів 31');
    await expect(
      c.getByRole('navigation', { name: 'Сторінки команди' }).querySelector('[data-page-status]'),
    ).toHaveFocus();
    const tab = c.getByRole('tab', { name: 'Табель' });
    tab.focus();
    await userEvent.keyboard('{Enter}');
    await c.findByRole('region', { name: 'Табель робочих змін' });
    await expect(c.getByText('415,00 грн')).toBeVisible();
    await expect(c.getByRole('button', { name: /Нарахування № 10/ })).toBeEnabled();
    c.getByRole('tab', { name: 'Документи' }).focus();
    await userEvent.keyboard('{Enter}');
    await c.findByRole('region', { name: 'Зарплатні документи' });
    await expect(c.getByText('99 999 999 999 999,99 грн')).toBeVisible();
  },
};
export const ScopedAccountant: Story = {
  args: { accountant: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByRole('region', { name: 'Працівники та умови оплати' });
    await expect(c.queryByRole('button', { name: 'Додати працівника' })).not.toBeInTheDocument();
    await expect(
      c.queryByRole('button', { name: /Редагувати працівника:/ }),
    ).not.toBeInTheDocument();
    await expect(c.getByRole('combobox', { name: 'Магазин' })).toBeDisabled();
    await expect(c.getByRole('button', { name: '+ Виплата зарплати / аванс' })).toBeEnabled();
  },
};
export const ReadFailure: Story = {
  args: { failure: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByRole('alert');
    await expect(c.queryByRole('table')).not.toBeInTheDocument();
    await expect(c.getByRole('button', { name: 'Повторити читання' })).toBeEnabled();
  },
};
export const PagingRetry: Story = {
  args: { pagingFailure: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByRole('region', { name: 'Працівники та умови оплати' });
    c.getByRole('navigation', { name: 'Сторінки команди' })
      .querySelector<HTMLButtonElement>('[data-page=next]')!
      .focus();
    await userEvent.keyboard('{Enter}');
    const retry = await c.findByRole('button', { name: 'Повторити читання' });
    await expect(retry).toHaveFocus();
    await expect(c.queryByRole('table')).not.toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    await c.findByText('2 / 2 · записів 31');
  },
};
