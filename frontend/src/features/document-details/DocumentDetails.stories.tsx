import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { I18nProvider } from 'react-aria-components';
import { DocumentDetails } from './DocumentDetails';
import { DocumentModel } from './state';
import { api, fixture } from './fixtures';
import { ApiError } from '../../shared/api/client';
function Screen({ failure = false, empty = false }: { failure?: boolean; empty?: boolean }) {
  const [model] = useState(
    () =>
      new DocumentModel({
        initial: fixture,
        api: {
          ...api,
          page: async (q) => {
            if (failure) throw new ApiError(503, 'Не вдалося прочитати документ.');
            return api.page(
              { ...q, section: empty ? 'cash_movements' : q.section },
              { role: 'owner', scopeStore: null },
            );
          },
        },
        grant: async () => ({ role: 'owner', scopeStore: null }),
        isCurrent: () => true,
        onHeader: () => {},
        onDenied: () => {},
      }),
  );
  useEffect(() => {
    void model.read();
    return () => model.cancel();
  }, [model]);
  return (
    <I18nProvider locale="uk-UA">
      <DocumentDetails model={model} initial={fixture} />
    </I18nProvider>
  );
}
const meta = {
  title: 'Trading/Document details',
  component: Screen,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Screen>;
export default meta;
type Story = StoryObj<typeof meta>;
export const KeyboardAndExactMoney: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByText('999 999 999 999 999,99 грн');
    const next = c.getByRole('button', { name: 'Далі' });
    next.focus();
    await userEvent.keyboard('{Enter}');
    await expect(c.getByRole('status')).toHaveTextContent('2 / 2 · записів 35');
    await expect(c.getByRole('status')).toHaveFocus();
    await expect(c.getByRole('button', { name: 'Далі' })).toBeDisabled();
    const movements = c.getByRole('tab', { name: 'Складські рухи · 35' });
    movements.focus();
    await userEvent.keyboard('{Enter}');
    await c.findByRole('table', { name: 'Складські рухи' });
  },
};
export const Empty: Story = { args: { empty: true } };
export const Error: Story = {
  args: { failure: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByRole('alert');
    await expect(c.getByRole('button', { name: 'Повторити читання' })).toBeEnabled();
  },
};
