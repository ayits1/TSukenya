import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Purchases } from './Purchases';
import { PurchasesModel } from './state';
import { fixtureApi, options } from './fixtures';
import { ApiError } from '../../shared/api/client';
function Integrated({ failure = false }: { failure?: boolean }) {
  const [model] = useState(() => {
    const api = fixtureApi();
    if (failure)
      api.documents = async () => {
        throw new ApiError(503, 'Не вдалося завантажити документи.');
      };
    return new PurchasesModel(api);
  });
  useEffect(() => {
    void model.activate({
      ...options,
      onReplenishment: async () => {},
      onRefresh: async () => {
        await model.refresh();
      },
    });
    return () => model.leave();
  }, [model]);
  return <Purchases model={model} />;
}
const meta = {
  title: 'Trading/Purchases',
  component: Integrated,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Integrated>;
export default meta;
type Story = StoryObj<typeof meta>;
export const WholeWorkspace: Story = {
  render: () => <Integrated />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Журнал документів' });
    const next = canvas
      .getByRole('navigation', { name: 'Сторінки документів' })
      .querySelector<HTMLButtonElement>('[data-page=next]')!;
    next.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByText('2 / 3 · записів 67');
    const tab = canvas.getByRole('tab', { name: 'Поповнення запасів' });
    tab.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByText('Товарів: 205 · груп: 1');
    const part = canvas.getByRole('button', { name: 'Наступна частина' });
    part.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('button', { name: /частина 2 з 2/ })).toBeEnabled();
    const items = canvas.getByRole('button', { name: 'Переглянути товари (205)' });
    items.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByRole('region', { name: 'Потреба товарів' });
  },
};
export const ReadFailure: Story = { render: () => <Integrated failure /> };
