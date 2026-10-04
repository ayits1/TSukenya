import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Finance } from './Finance';
import { FinanceModel } from './state';
import { fixtureApi, options } from './fixtures';
import { ApiError } from '../../shared/api/client';
function Workspace({
  failure = false,
  pagingFailure = false,
}: {
  failure?: boolean;
  pagingFailure?: boolean;
}) {
  const [model] = useState(() => {
    const api = fixtureApi();
    if (failure)
      api.read = async () => {
        throw new ApiError(503, 'Читання тимчасово недоступне.');
      };
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
    return new FinanceModel(api);
  });
  useEffect(() => {
    void model.activate({
      ...options,
      onRefresh: async () => {
        await model.refresh();
      },
    });
    return () => model.leave();
  }, [model]);
  return <Finance model={model} />;
}
const meta = {
  title: 'Trading/Finance',
  component: Workspace,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Workspace>;
export default meta;
type Story = StoryObj<typeof meta>;
export const WholeWorkspace: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByRole('region', { name: 'Грошові рахунки' });
    await expect(c.getAllByText('99 999 999 999 999,99 грн')[0]).toBeVisible();
    const next = c
      .getByRole('navigation', { name: 'Сторінки фінансів' })
      .querySelector<HTMLButtonElement>('[data-page=next]')!;
    next.focus();
    await userEvent.keyboard('{Enter}');
    await c.findByText('2 / 2 · записів 31');
    await expect(
      c.getByRole('navigation', { name: 'Сторінки фінансів' }).querySelector('[data-page-status]'),
    ).toHaveFocus();
    for (const name of ['Борги', 'Аванси', 'Рух коштів', 'Документи']) {
      const tab = c.getByRole('tab', { name });
      tab.focus();
      await userEvent.keyboard('{Enter}');
      await c.findByRole('heading', { name });
      await c.findByText('1 / 1 · записів 1');
    }
    await expect(c.queryByRole('button', { name: '+ Касове розходження' })).not.toBeInTheDocument();
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
    await c.findByRole('region', { name: 'Грошові рахунки' });
    const next = c
      .getByRole('navigation', { name: 'Сторінки фінансів' })
      .querySelector<HTMLButtonElement>('[data-page=next]')!;
    next.focus();
    await userEvent.keyboard('{Enter}');
    const retry = await c.findByRole('button', { name: 'Повторити читання' });
    await expect(retry).toHaveFocus();
    await expect(c.queryByRole('table')).not.toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    await c.findByText('2 / 2 · записів 31');
    await expect(
      c.getByRole('navigation', { name: 'Сторінки фінансів' }).querySelector('[data-page-status]'),
    ).toHaveFocus();
  },
};
