import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Sales } from './Sales';
import { SalesModel } from './state';
import { fixtureApi, options } from './fixtures';
import { ApiError } from '../../shared/api/client';
function Integrated({ failure = false }: { failure?: boolean }) {
  const [model] = useState(() => {
    const api = fixtureApi();
    if (failure)
      api.documents = async () => {
        throw new ApiError(503, 'Не вдалося завантажити продажі.');
      };
    return new SalesModel(api);
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
  return <Sales model={model} />;
}
const meta = {
  title: 'Trading/Sales',
  component: Integrated,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Integrated>;
export default meta;
type Story = StoryObj<typeof meta>;
export const KeyboardWorkspace: Story = {
  render: () => <Integrated />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Журнал продажів' });
    const next = canvas.getByRole('button', { name: 'Далі' });
    next.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByText('2 / 3 · записів 61');
    await expect(canvas.getByRole('button', { name: 'Далі' })).toHaveFocus();
    const tab = canvas.getByRole('tab', { name: 'Касові зміни' });
    tab.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByRole('button', { name: 'Закрити зміну № 1' });
    await expect(canvas.getByText('1 234,56')).toBeVisible();
  },
};
export const ReadFailure: Story = { render: () => <Integrated failure /> };
